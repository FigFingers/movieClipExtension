# ローカル再生ブリッジ入力契約 v1

- バージョン: v1
- 最終更新日: 2026-08-24
- 対象オリジン: `http://localhost:3000`、`http://127.0.0.1:3000`
- 対象サービス: Netflix、Disney+

## 1. 目的

ローカルサイトから拡張機能へ渡される値は、すべて信頼できない入力として扱う。
入力をそのままストレージや再生所有権の状態へ保存せず、入口で検証・正規化・
最小化したデータだけを `BEGIN_PLAYBACK_HANDOFF` へ渡す。

この契約は次の3経路に共通して適用する。

| 入力経路 | 用途 | データの取得元 |
|---|---|---|
| `clipSelected` | 単体クリップ再生 | `CustomEvent.detail` と許可済み Cookie |
| `SET_CLIP_DATA` | 単体クリップ再生の互換経路 | `window.postMessage` |
| `PLAY_PLAYLIST_START` | プレイリスト再生 | `window.postMessage` と `localStorage.playQueue` |

## 2. 基本方針

- Content Script と Background の両方で同じ検証器を使う。
- 未知のキーは破棄し、正準データに定義したキーだけを残す。
- 正準クリップ / プレイリストの既知フィールドは全件成功または全件拒否とし、不正な必須フィールドや明示された既知フィールドを除外・補正して続行しない。
- 未知キー、不正な任意 `requestId`、malformed な任意 Cookie は正準データから省略できる。必須データが欠ける場合は入力全体を拒否する。
- 拒否時は直前の有効な所有者・スナップショット・再生状態を変更しない。
- 生の Cookie、URL、入力データ、認証トークンをログへ出さない。

## 3. 正準データ

入力後のキー名は camelCase に統一する。

### 3.1 単体クリップ

```ts
type CanonicalClip = {
  clipId: number; // 1以上の安全な整数
  service: "netflix" | "disneyplus";
  url: string; // 検証済みのHTTPS絶対URL
  startTime: number; // 有限数、0以上
  endTime: number; // 有限数、startTimeより大きい
  title?: string; // 最大500文字
  clipname?: string; // 最大500文字
  user?: string; // 最大200文字
  username?: string; // 最大200文字
  epnumber?: string; // 最大200文字
};
```

`clipId`、`service`、`url`、`startTime`、`endTime` は必須。
任意文字列は前後の空白を除き、空文字になった場合は保存しない。

### 3.2 プレイリスト項目

```ts
type CanonicalPlaylistItem = CanonicalClip & {
  id: number; // clipIdと同じ値を互換目的で保持
  order: number; // 0以上の安全な整数
};
```

同じクリップを複数回再生できるよう `clipId` の重複は許可する。
再生順を一意にするため、`order` の重複は拒否する。

## 4. 入力の検証と正規化

### 4.1 クリップID

- `clipId` または `id` を受け付ける。
- 数値、または10進数字だけの文字列を1以上の安全な整数へ変換する。
- 両方が指定された場合は、同じ値でなければ拒否する。
- `clipSelected` では `event.detail.clipId` を必須の正本とする。
- Cookie にも `clipId` がある場合は、正本と一致しなければ拒否する。

### 4.2 再生時刻

次の別名を受け付け、`startTime` と `endTime` に統一する。

| 正準キー | 受け付けるキー |
|---|---|
| `startTime` | `startTime`、`starttime`、`StartTime` |
| `endTime` | `endTime`、`endtime`、`EndTime` |

数値または数値文字列を有限数へ変換し、
`0 <= startTime < endTime` を満たすことを必須とする。
`NaN`、`Infinity`、空文字、別名間で値が異なる入力は拒否する。

### 4.3 サービス

大文字・小文字と空白を正規化したうえで、次の値だけを受け付ける。

| 入力 | 正準値 |
|---|---|
| `netflix` | `netflix` |
| `disneyplus` | `disneyplus` |
| `disney+`、`disney`、`DISNEY_PLUS` | `disneyplus` |

Prime Video、YouTubeなどは、対応する Content Script と再生制御がないため
v1では拒否する。対応サービスを増やす場合は、Manifest、再生制御、テストと
本契約のバージョンを同時に更新する。

### 4.4 URL

- 入力は1〜4,096文字の文字列とする。
- 相対URLは、対象サービスのベースURLを使って絶対URLへ変換する。
- 正規化後のプロトコルは `https:` だけを許可する。
- ユーザー名、パスワード、明示的なポートを含むURLは拒否する。
- サービスとホスト名が一致しないURLは拒否する。

| サービス | 許可するホスト名 |
|---|---|
| `netflix` | `www.netflix.com` |
| `disneyplus` | `www.disneyplus.com` |

判定には文字列の前方一致を使わず、`URL` オブジェクトの
`protocol`、`hostname`、`port`、`username`、`password` を使う。

### 4.5 任意文字列

任意文字列は文字列型だけを受け付け、長さの上限を次のとおりとする。
上限判定後に前後の空白を除き、空文字は省略する。

| キー | 最大長 |
|---|---:|
| `title`、`clipname` | 500文字 |
| `user`、`username`、`epnumber` | 200文字 |

### 4.6 Cookie

`clipSelected` で読み取る Cookie 名は次のものだけとする。

- `title`
- `user`
- `url`
- `service`
- `clipId`
- `username`
- `startTime`、`starttime`
- `endTime`、`endtime`

各値は個別に `decodeURIComponent` で復号する。不正なパーセント
エンコーディングを含む値は無効として扱い、必須項目が欠けた場合は入力全体を
拒否する。許可リスト外の Cookie は読み捨てる。

### 4.7 プレイリスト

- 件数は1〜100件とする。
- `order` は数値、または10進数字だけの文字列で、0以上の安全な整数とする。
- `order` が欠けた旧形式だけ、配列のインデックスで補う。
- 明示された不正な `order` をインデックスへ置き換えない。
- 生の `localStorage.playQueue` と正規化後のJSONは、それぞれ512 KiB以下とする。
- 生データはサイズを確認してから `JSON.parse` する。

件数・順序・サイズのいずれかが不正な場合は、プレイリスト全体を拒否する。

## 5. 入力形式

### 5.1 `clipSelected`

```js
window.dispatchEvent(
  new CustomEvent("clipSelected", {
    detail: {
      clipId: 123,
      requestId: "optional-correlation-id",
    },
  }),
);
```

クリップ本体は許可済み Cookie と `detail.clipId` から組み立てる。
`requestId` は任意の1〜128文字の文字列で、結果との対応付けにだけ使う。
条件を満たさない `requestId` は再生を拒否せず、結果から省略する。

### 5.2 `SET_CLIP_DATA`

```js
window.postMessage(
  {
    type: "SET_CLIP_DATA",
    requestId: "optional-correlation-id",
    payload: {
      clip: {
        // CanonicalClipと互換性のある入力
      },
    },
  },
  window.location.origin,
);
```

`payload.clip` は通常のオブジェクトでなければならない。

### 5.3 `PLAY_PLAYLIST_START`

```js
localStorage.setItem("playQueue", JSON.stringify(items));
window.postMessage(
  {
    type: "PLAY_PLAYLIST_START",
    requestId: "optional-correlation-id",
  },
  window.location.origin,
);
```

`playQueue` は配列でなければならない。`Subtitles` など正準データに
含まれないキーは保存しない。`localStorage` の読み取りに失敗した場合も、
`handoff_failed` として安全側で拒否する。

## 6. 結果通知

入力元と同じ `window`、同じオリジンへ、成功・失敗の結果を1回だけ返す。

```js
window.postMessage(
  {
    type: "EXTENSION_PLAYBACK_HANDOFF_RESULT",
    requestId: "optional-correlation-id",
    source: "PLAY_PLAYLIST_START",
    ok: false,
    reason: "invalid_time_range",
    field: "endTime",
    index: 2,
  },
  window.location.origin,
);
```

`field` は問題のあるキーが分かる場合、`index` はプレイリスト内の位置が
分かる場合だけ返す。`reason` は次の固定値に限定する。

- `invalid_payload`
- `invalid_clip_id`
- `clip_id_mismatch`
- `invalid_service`
- `invalid_url`
- `invalid_time_range`
- `invalid_order`
- `duplicate_order`
- `empty_playlist`
- `queue_too_large`
- `payload_too_large`
- `handoff_failed`
- `background_unavailable`

失敗時のログは `source`、`reason`、`field`、`index` だけを含める。
利用者向けメッセージはサイト側で固定文言へ変換し、成功時は
`role="status"`、失敗時は `role="alert"` で表示する。

## 7. 拒否時の動作

1項目でも不正な場合は、次の処理を行わない。

- `BEGIN_PLAYBACK_HANDOFF` の実行
- 所有権レジストリの更新
- `chrome.storage.local` の更新
- `sessionStorage` の再生コンテキスト更新
- NetflixまたはDisney+への画面遷移

Background は Content Script の検証結果を信用せず、受け取った
クリップ、プレイリスト、件数、JSONサイズ、`context.clipId` の整合を
同じ規則で再検証する。

所有者と保留中の引き継ぎがどちらもなくなった場合は、モードフラグだけでなく
`clip`、`playQueue`、`nextClip` も消去する。

## 8. 受け入れ条件とテスト状況

- 3つの入力経路が同じ共通検証器を通る。
- Content Script で不正入力を拒否し、Background へ直接送られた不正な
  スナップショットも拒否する。
- 現行サイトの正しい入力が正準データへ変換される。
- 拒否時にストレージ、所有権レジストリ、画面遷移が部分更新されない。
- 正常系、不正入力、上限値、競合を自動テストで固定する。

現行テストは validator、background ownership、bridge の入力拒否・失敗経路を固定している。一方、`getClipData.test.js` は `clipSelected` listener の実行、正常な `SET_CLIP_DATA`、成功する playlist handoff、成功通知後の nonce 付き遷移を直接テストしていない。これらの経路を変更するときは、不足する成功系テストを追加してから契約適合を判断する。

主な実装とテスト:

- 共通検証器: [playbackBridgeValidation.js](../src/shared/playbackBridgeValidation.js)
- ローカルサイトとの橋渡し: [getClipData.js](../src/content/getClipData.js)
- Background の再検証: [playbackOwnership.js](../src/background/playbackOwnership.js)
- 入力検証テスト: [playbackBridgeValidation.test.js](../test/shared/playbackBridgeValidation.test.js)
- 所有権テスト: [playbackOwnership.test.js](../test/background/playbackOwnership.test.js)
- 経路テスト: [getClipData.test.js](../test/content/getClipData.test.js)

## 9. 互換性と変更ルール

- 旧サイトの `starttime` と `endtime` は互換入力として維持する。
- サイトの `DISNEY_PLUS` は `disneyplus` へ変換する。
- `SET_CLIP_DATA` は現在のサイトで未使用でも、将来互換のため維持する。
- コメント対象の解決には、1以上のサーバー側クリップIDを必須とする。

### 9.1 サイト側実装との照合記録

現行サイトの実装は、別リポジトリ `react--site` のリビジョン
`9f591862fddc9a71d88590c489ac47ffd311c6a9` で実ペイロードと照合済み。
ローカルの配置場所は環境ごとに異なるため、この契約では固定しない。

- 単体再生は `clipSelected` と旧形式 Cookie（小文字の `starttime` / `endtime`）を使う。
- プレイリスト項目は `{ id, order, clipname, title, service, Subtitles, url, startTime, endTime }`
  の形で、`service` には `NETFLIX` または `DISNEY_PLUS` が入る。
- 照合時に判明した単体再生の `service` Cookie 欠落はサイト側で修正し、
  `DISNEY_PLUS` を実サービスコードとして検証器へ追加した。

実データが本契約と異なる場合は、検証を無条件に緩めない。サイト側の入力を
修正するか、影響範囲とテストを確認したうえで契約バージョンを更新する。
