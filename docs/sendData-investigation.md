# sendData Investigation

## 1. 概要

`sendData` 自体は `localhost:3000/api/receive` へ JSON を `POST` する薄い送信関数です。  
ただし、現在の「クリップ保存フロー」は `sendData` 単体で完結しておらず、各サービスの録画 UI、共通メモサイドバー UI、そして `sendData` が分散して 1 つの保存導線を構成しています。

送信フローの実態は次の通りです。

```text
Netflix / Disney+ の録画ボタン 2 回目
  -> payload 生成
  -> video を pause
  -> openMemoSidebar(...)
  -> サイドバーの保存ボタン押下
  -> clipName を補完
  -> sendData(...)
  -> 成功/失敗に関係なく video を play, sidebar を close
```

## 2. 定義場所

### 2.1 `sendData`

- ファイルパス: `src/content/common.js:57-73`
- 関数シグネチャ: `export function sendData(dataToSend)`
- 内部処理の要約:
  - `getApiEndpoint('receive')` で URL を組み立てる (`src/content/common.js:58`, `src/api.js:1-4`)
  - `fetch(..., { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dataToSend) })`
  - `response.json()` をそのまま呼ぶ
  - 成功時は `console.log('Success:', data)` して返す
  - 失敗時は `console.error('Error:', error)` して再 throw する

### 2.2 `sendData` が依存する定義

- `getApiEndpoint(path)` in `src/api.js:3-4`
- `API_URL = 'http://localhost:3000/api/'` in `src/api.js:1`
- `fetch` / `JSON.stringify` / `response.json()` in browser runtime
- `manifest.json:14-15` の `host_permissions` に `http://localhost:3000/*`

### 2.3 `sendData` を包む UI 層

- ファイルパス: `src/content/common.js:76-164`
- 関数シグネチャ: `export function openMemoSidebar({ data = {}, videoPlayer, sidebarPct = 20, sidebarTitle = '録画メモ', onSave, onClose })`
- 役割:
  - サイドバー DOM を生成して表示する
  - `data.StartTime` / `data.EndTime` / `data.URL` / `data.title` を表示する (`src/content/common.js:120-131`)
  - `data.clipName` を入力欄に初期表示する (`src/content/common.js:134-140`)
  - 保存ボタン押下時に `clipName` を上書きした `enriched` payload を作る (`src/content/common.js:147-151`)
  - `onSave` があれば `onSave(enriched)`、なければ `sendData(enriched)` を呼ぶ (`src/content/common.js:152`)
  - 結果に関係なく `videoPlayer.play?.()` と `closeSidebar()` を `finally` で実行する (`src/content/common.js:153-158`)

## 3. 呼び出し元一覧

### 3.1 直接の呼び出し経路

| 呼び出し箇所 | 関数名 | 呼ばれるタイミング | 何を送るか |
| --- | --- | --- | --- |
| `src/content/common.js:147-152` | `saveBtn.onclick` | サイドバーの「保存」クリック時 | `data` を基に `clipName` を補完した `enriched` |
| `src/content/content_netflix.js:174-178` | `onSave: (data) => sendData(data)` | Netflix 録画ボタン 2 回目でサイドバーを開いた後、保存ボタン押下時 | Netflix で生成した payload + サイドバー入力済み `clipName` |
| `src/content/content_disney.js:315-319` | `onSave: (data) => sendData(data)` | Disney+ 左ボタン 2 回目でサイドバーを開いた後、保存ボタン押下時 | Disney+ で生成した payload + サイドバー入力済み `clipName` |

### 3.2 実際のコールスタック

#### Netflix

- 起点: `recordButton.addEventListener("click", ...)` in `src/content/content_netflix.js:129-191`
- 1 回目クリック:
  - `isRecording = true`
  - `startTime = videoPlayer.currentTime` (`src/content/content_netflix.js:181-185`)
- 2 回目クリック:
  - `endTime = videoPlayer.currentTime` (`src/content/content_netflix.js:139`)
  - バリデーション:
    - `startTime > endTime` は例外 (`src/content/content_netflix.js:140-142`)
    - 長さ 1 秒未満は例外 (`src/content/content_netflix.js:144-148`)
    - タイトル要素なしは例外 (`src/content/content_netflix.js:158-170`)
  - `payload` 構築 (`src/content/content_netflix.js:150-168`)
  - `videoPlayer.pause()` (`src/content/content_netflix.js:173`)
  - `openMemoSidebar(...)` (`src/content/content_netflix.js:174-179`)
  - 直後に `resetRecordState()` で録画 UI 状態をリセット (`src/content/content_netflix.js:180`, `src/content/content_netflix.js:228-233`)

#### Disney+

- 起点: `myCustomActionLeft()` in `src/content/content_disney.js:277-325`
- 1 回目クリック:
  - `clickStateLeft++`
  - `starttime = Service.DPlusTime.get()?.currentSeconds` (`src/content/content_disney.js:280-283`)
- 2 回目クリック:
  - `endtime = Service.DPlusTime.get()?.currentSeconds` (`src/content/content_disney.js:286-288`)
  - `videoPlayer?.pause()` (`src/content/content_disney.js:290-291`)
  - `payload` 構築 (`src/content/content_disney.js:295-313`)
  - `openMemoSidebar(...)` (`src/content/content_disney.js:315-320`)
  - 直後に `clickStateLeft = 0` へ戻す (`src/content/content_disney.js:323`)

### 3.3 未使用だが残っている直接送信経路

- `openMemoSidebar` は `onSave` 未指定時に `sendData(enriched)` を直接呼ぶ実装です (`src/content/common.js:152`)
- ただし、現行の呼び出し元 2 箇所はいずれも `onSave: (data) => sendData(data)` を明示しているため、この fallback は実運用では未使用です

## 4. payload の実態

### 4.1 送信時 payload の実例

#### Netflix 側の生成値

根拠: `src/content/content_netflix.js:150-168`

```js
{
  StartTime: startTime,
  EndTime: endTime,
  URL: window.location.pathname,
  service: detectService(),
  user: "test_user",
  title: "...",
  epnumber: "..." // あれば
}
```

保存ボタン押下後は `openMemoSidebar` が `clipName` を追加します (`src/content/common.js:147-152`)。

#### Disney+ 側の生成値

根拠: `src/content/content_disney.js:304-313`

```js
{
  clipName: `${title}${subtitle ? `｜${subtitle}` : ""}`,
  user: "testUser",
  service: detectService(),
  StartTime: starttime,
  EndTime: endtime,
  URL: location.href,
  title: title,
  epnumber: subtitle
}
```

保存ボタン押下後は、同じ `clipName` キーが入力欄の値で上書きされます (`src/content/common.js:147-152`)。

### 4.2 フィールド一覧

| キー | Netflix 送信 | Disney+ 送信 | 備考 |
| --- | --- | --- | --- |
| `StartTime` | あり | あり | 送信時は PascalCase。再生側は `startTime` / `starttime` を読む |
| `EndTime` | あり | あり | 送信時は PascalCase。再生側は `endTime` / `endtime` を読む |
| `URL` | あり | あり | Netflix は pathname、Disney+ は absolute URL |
| `service` | あり | あり | `detectService()` 由来 |
| `user` | `"test_user"` | `"testUser"` | 固定値がサービスごとに不一致 |
| `title` | あり | あり | Netflix は title が取れないと送信前に例外。Disney+ は空文字許容 |
| `epnumber` | 任意 | あり得る | subtitle/episode 表示用 |
| `clipName` | サイドバーで追加 | 初期値あり + サイドバーで上書き | 送信側のみ camelCase |

### 4.3 表記ゆれ

このリポジトリ内だけで、少なくとも次のゆれがあります。

| 意味 | 送信側 | 読み側/再生側 | 根拠 |
| --- | --- | --- | --- |
| 開始時刻 | `StartTime` | `startTime`, `starttime` | `src/content/content_netflix.js:151`, `src/content/content_disney.js:308`, `src/content/content_netflix.js:524`, `src/content/content_disney.js:616` |
| 終了時刻 | `EndTime` | `endTime`, `endtime` | `src/content/content_netflix.js:152`, `src/content/content_disney.js:309`, `src/content/content_netflix.js:525`, `src/content/content_disney.js:617` |
| URL | `URL` | `url`, `URL`, `Url` | `src/content/content_netflix.js:153`, `src/content/content_disney.js:310`, `src/content/content_disney.js:619-624` |
| クリップ名/表示名 | `clipName` | `clipname`, `title` | `src/content/common.js:139-152`, `src/content/content_disney.js:305`, `src/content/content_netflix.js:589,646`, `src/content/content_disney.js:618,785` |
| ユーザー | `user` 固定値が不一致 | `user`, `username` | `src/content/content_netflix.js:155`, `src/content/content_disney.js:306`, `src/content/content_netflix.js:479` |
| 識別子 | 送信時にはなし | `id`, `clipId` | `src/content/content_netflix.js:417,479` |

### 4.4 必須っぽいもの / 任意っぽいもの

コードから判断できる範囲では次の通りです。

- 必須っぽいもの:
  - `StartTime` / `EndTime`
  - `URL`
  - `service`
  - `title`
- 任意っぽいもの:
  - `epnumber`
  - `clipName`

ただし、これは frontend 実装上の推定です。backend の `receive` 実装はこのリポジトリに存在しないため、サーバーの真の必須項目は未確認です。

### 4.5 型の揺れ

- `StartTime` / `EndTime`
  - Netflix は `video.currentTime` 由来なので数値
  - Disney+ は `Service.DPlusTime.get()` が `null` を返し得るため、`undefined` 相当が入り得る (`src/content/content_disney.js:281,287-288`, `src/content/content_disney.js:445-460`)
- `URL`
  - Netflix は `/watch/...` の path だけ (`src/content/content_netflix.js:153`)
  - Disney+ は `https://...` を含む完全 URL (`src/content/content_disney.js:295,310`)
- `clipName`
  - Disney+ は初期値あり
  - Netflix は入力欄デフォルトが空文字 (`src/content/common.js:139`)

### 4.6 型定義とのズレ

- `src/types/clip.js:1-12` の `ClipDataProps` は `startTime`, `endTime`, `url`, `clipId`, `username` などの camelCase を想定しています
- しかし送信側は `StartTime`, `EndTime`, `URL`, `clipName` を送っています
- つまり、型定義は「送信 payload の実態」を表していません

## 5. 依存関係

### 5.1 `sendData` の内部依存

- `getApiEndpoint('receive')` -> `http://localhost:3000/api/receive` (`src/content/common.js:58`, `src/api.js:1-4`)
- `fetch`
- `response.json()`
- `console.log` / `console.error`

### 5.2 送信前の依存

#### Netflix 側

- `detectService()` in `src/content/common.js:6-13`
- DOM selector:
  - `videoPlayer: '.watch-video--player-view video'`
  - `videoTitle: '[data-uia="video-title"]'`
  - `controlForward10: '[data-uia="control-forward10"]'`
  - `controlsStandard`, `controlVolume`
  - 根拠: `src/content/content_netflix.js:97-106`

#### Disney+ 側

- `detectService()` in `src/content/common.js:6-13`
- `Service.DPlusTime.get()` で再生位置取得 (`src/content/content_disney.js:428-475`)
- Disney+ 固有 DOM:
  - `.title-bug-container .title-field span`
  - `.title-bug-container .subtitle-field span`
  - `video`
  - 根拠: `src/content/content_disney.js:290-313`

### 5.3 送信後フローが依存する別 API

`sendData` のレスポンス自体は後続で使っていません。  
一方、保存済み clip を再生する導線は別 API に依存しています。

- 一覧取得: `GET /api/random10` (`src/content/content_netflix.js:424-435`)
- 個別取得: `GET /api/fetchClip?id=...` (`src/content/content_netflix.js:451-468`)

### 5.4 再生系が期待しているデータ契約

- Netflix 一覧 UI は `item.id`, `item.title`, `item.user`, `item.startTime`, `item.endTime` を使う (`src/content/content_netflix.js:402-418`)
- Netflix 再生開始前の Cookie 化は `title`, `user`, `startTime`, `endTime`, `url`, `service`, `clipId`, `username` を使う (`src/content/content_netflix.js:478-490`)
- Netflix / Disney+ の再生系は `startTime ?? starttime`, `endTime ?? endtime`, `url ?? URL ?? Url`, `clipname ?? title` を読む (`src/content/content_netflix.js:523-527,587-646`, `src/content/content_disney.js:613-624,748-785`)

## 6. 副作用

### 6.1 保存前の UI 副作用

- Netflix:
  - 2 回目クリック時に `videoPlayer.pause()` (`src/content/content_netflix.js:173`)
  - `openMemoSidebar` 表示後に `resetRecordState()` 実行 (`src/content/content_netflix.js:174-180`)
- Disney+:
  - 2 回目クリック時に `videoPlayer?.pause()` (`src/content/content_disney.js:290-291`)
  - `openMemoSidebar` 表示後に `clickStateLeft = 0` (`src/content/content_disney.js:315-323`)
- 共通サイドバー:
  - プレーヤー幅を `calc(100% - ${sidebarPct}%)` に縮める (`src/content/common.js:92-99`)
  - 閉じると元の幅へ戻す (`src/content/common.js:111-115`)

### 6.2 保存ボタン押下後の副作用

- `clipName` を payload へ注入する (`src/content/common.js:147-151`)
- `onSave` / `sendData` を実行する (`src/content/common.js:152`)
- 失敗時は `console.error('保存エラー:', error)` のみ (`src/content/common.js:153-154`)
- 成功/失敗に関係なく:
  - `videoPlayer?.play?.()` (`src/content/common.js:155-156`)
  - `closeSidebar()` (`src/content/common.js:156-157`)

### 6.3 state 変更

- 送信経路そのものでは `chrome.storage.local` / `localStorage` / `sessionStorage` への書き込みはありません
- 送信前の録画 UI 状態だけが更新されます
  - Netflix: `isRecording`, `startTime`, `endTime`, SVG 色 (`src/content/content_netflix.js:125-128,228-233`)
  - Disney+: `clickStateLeft`, `starttime` (`src/content/content_disney.js:275-323`)

### 6.4 storage 操作

- `sendData` 呼び出し前後で storage 書き込みはありません
- storage を使うのは再生導線側です
  - `getClipData.js` が localhost ページから `clip` / `playQueue` / `playmode` を `chrome.storage.local` へ保存 (`src/content/getClipData.js:20-31,62-90`)
  - Netflix / Disney+ 再生モードがその storage を読む (`src/content/content_netflix.js:517-528,568-593`, `src/content/content_disney.js:737-785`)

### 6.5 レスポンス依存処理

- `sendData` は JSON レスポンスを返しますが、呼び出し元は値を使っていません
- `openMemoSidebar` も結果に応じた UI 分岐をしていません
- したがって、現在の frontend には「送信レスポンス内容に依存する分岐」は見当たりません

## 7. 問題点

### 7.1 queue 化の障害になる点

1. 送信前に正規化されていない
   - 送信時のキーは `StartTime` / `EndTime` / `URL` / `clipName`
   - 再生時の読み取りは `startTime` / `starttime` / `url` / `URL` / `Url` / `clipname`
   - `queueClip()` で保存する前に canonical 形へ揃えないと、後続で別名吸収が増え続けます

2. 送信前提の UX になっている
   - 保存後に成功/失敗を問わず sidebar が閉じ、動画が再開されます (`src/content/common.js:153-158`)
   - queue 保存失敗時もユーザーには失敗が見えにくいです

3. unsynced clip を参照するローカル導線がない
   - 一覧 UI は `random10` API 依存 (`src/content/content_netflix.js:424-435`)
   - 個別再生は `fetchClip?id=...` 依存 (`src/content/content_netflix.js:451-468`)
   - queued clip を server 未送信のまま見せたい場合、既存 UI だけでは足りません

4. サーバー採番 ID 前提の箇所がある
   - 一覧は `item.id` を押して `selectClip(item.id)` します (`src/content/content_netflix.js:415-417`)
   - Cookie 化では `clipId` を扱います (`src/content/content_netflix.js:479`)
   - queue 保存直後のローカル clip にはこの ID がない可能性があります

### 7.2 責務分離できていない点

- `src/content/common.js` に DOM UI (`openMemoSidebar`) と通信 (`sendData`) が同居しています
- `openMemoSidebar` の保存ボタンが transport 実装 (`sendData`) を知っています (`src/content/common.js:152`)
- 各サービス側は payload 生成、video pause、sidebar 表示、record state reset まで同一関数で担っています

### 7.3 データ正規化不足

- `ClipDataProps` と実 payload が一致していません (`src/types/clip.js:1-12`)
- `clipName` と `clipname` の変換責務が frontend 上に明示されていません
- `URL` が relative と absolute で混在しています
- `user` の固定値が `test_user` / `testUser` で不一致です

### 7.4 即時送信前提の危険箇所

- `sendData` は `response.ok` を見ていません (`src/content/common.js:58-66`)
- 4xx/5xx でも JSON が返れば success 扱いになります
- 送信エラーはコンソールログだけで UI 再試行がありません (`src/content/common.js:153-158`)
- Disney+ 側には Netflix のような送信前バリデーションがありません
  - `starttime` / `endtime` が取れない場合でも payload 生成へ進み得ます (`src/content/content_disney.js:281,287-313`)

### 7.5 「sendData は単なる送信関数か？」

結論:

- `sendData` 単体を見ると、単なる送信関数です
- ただし現行の保存フロー全体では、`sendData` は UI フローの末尾に埋め込まれています
- そのため、実際に差し替える対象は `sendData` 単体ではなく、`openMemoSidebar` を中心にした「保存ユースケース」です

## 8. queue 化する際の置換候補

### 8.1 `sendData` を `queueClip()` に差し替えるべき箇所

1. `src/content/content_netflix.js:177`
   - `onSave: (data) => sendData(data)`
   - 最小変更ならここを `queueClip(data)` に差し替える

2. `src/content/content_disney.js:318`
   - `onSave: (data) => sendData(data)`
   - 最小変更ならここも同様に差し替える

3. `src/content/common.js:152`
   - `onSave ? onSave(enriched) : sendData(enriched)`
   - 共通 UI の fallback を残すなら、ここも `queueClip(enriched)` に合わせる必要がある

### 8.2 差し替え時の注意点

1. `queueClip()` は Promise を返す形に寄せた方が安全
   - `openMemoSidebar` は `Promise.resolve(result)` を前提にしているため (`src/content/common.js:153`)

2. queue 保存前に正規化が必要
   - 少なくとも `StartTime -> startTime`, `EndTime -> endTime`, `URL -> url`, `clipName -> clipName or clipname` の方針を決める必要があります

3. 失敗 UX を別途決める必要がある
   - 現在は失敗しても閉じる実装です (`src/content/common.js:153-158`)
   - queue 永続化失敗だけは sidebar を閉じない設計の方が自然です

4. unsynced データを見せるなら別導線が必要
   - `random10` / `fetchClip` は server 前提です
   - queue 保存だけでは一覧や再生はローカル参照できません

5. backend sync 時の変換責務が未確定
   - `clipName` が server で `clipname` になるのか、`title` と別管理なのかは未確認です
   - `receive` のレスポンス schema も未確認です

## 9. 推奨リファクタ順

1. 送信前 canonical data model を 1 つ定義する
   - 例: `startTime`, `endTime`, `url`, `service`, `title`, `epnumber`, `clipName`, `user`

2. Netflix / Disney+ ごとの capture payload を canonical 形へ変換する関数を切り出す
   - ここで relative URL / absolute URL の扱いも統一する

3. `openMemoSidebar` から transport の知識を外す
   - UI は `onSave(enrichedClip)` だけを呼び、`sendData` / `queueClip` は外で差し込む

4. `queueClip()` を先に実装し、既存 `onSave` の差し替えだけで capture 保存が成立する状態を作る

5. 後段で `flushQueuedClips()` を追加する
   - ログイン後一括送信はここで担う

6. queued clip を UI に見せる必要があるなら、一覧・再生導線を server repository と local queue repository の二層に分ける

## 最小変更で queue 化する場合の差し替えポイント

最小変更で進めるなら、まず触るのは次の 3 点です。

1. `src/content/content_netflix.js:177`
2. `src/content/content_disney.js:318`
3. `src/content/common.js:152`

ただし、この 3 点だけでは不十分です。  
同時に「queue 保存前の正規化」と「queue 保存失敗時の UI 挙動」だけは最低限入れる必要があります。  
逆に言うと、再生系 (`random10`, `fetchClip`, playlist, seek) はこの段階では触らない方が安全です。

## 全面的に責務整理する場合の理想構成

理想構成は次の分離です。

1. `capture adapters`
   - Netflix / Disney+ から raw 情報を取るだけ

2. `clip normalizer`
   - `StartTime` / `URL` などの揺れを canonical 形へ集約

3. `save use case`
   - `saveCapturedClip(clip, { mode: 'queue' | 'send' })`
   - UI からはこれだけを呼ぶ

4. `ui layer`
   - `openMemoSidebar` は表示と入力取得だけ

5. `repositories`
   - `queueClip`, `getQueuedClips`, `flushQueuedClips`
   - `fetchRemoteClips`, `fetchRemoteClipById`

この構成なら、送信責務と UI 責務、再生責務を切り離せます。

## 今すぐ触るべきでない箇所

最小変更を狙うなら、次は今すぐ触るべきではありません。

1. Netflix / Disney+ の playlist 再生ロジック
   - `playlistNextClip`, `monitorClipEnd`, `requestSeek`, auto navigation
   - 送信方式変更とは責務が違い、壊れると影響範囲が広いです

2. `src/content/getClipData.js`
   - localhost 側の再生開始連携であり、capture 保存の即時置換とは別系統です
   - queued clip を localhost UI に混ぜる段階までは温存でよいです

3. `buildServiceUrl` / `normalizeService`
   - 再生 URL 組み立ては後段の再生責務です
   - まずは保存前 canonical data model を固める方が先です

## 未確認 / 要追加調査

1. backend `POST /api/receive` の必須項目・検証ロジック
2. backend `receive` のレスポンス schema
3. backend が `clipName` を `clipname` に変換しているかどうか
4. `random10` / `fetchClip` の backend 側 schema の完全定義

この 4 点は frontend コードだけでは断定できません。
