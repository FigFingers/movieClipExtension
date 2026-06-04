# READMEFORLLM

このファイルは人間向け README ではなく、LLM / AI コーディングエージェント向けの運用資料です。目的は「この README を読めば、どの実行面に何が載っていて、どの状態や契約を壊すと危険か」を短時間で把握できるようにすることです。

## Project Overview

このリポジトリは Chrome Extension (Manifest V3) です。主な用途は、Netflix / Disney+ 上で動画クリップを記録し、`http://localhost:3000` のローカル API / ローカル Web アプリと連携してクリップ保存・単体再生・プレイリスト再生を行うことです。

この repo に含まれるのは拡張機能の frontend 側だけです。backend / localhost ページ本体は含まれていません。したがって API 応答 shape や `window.postMessage` の送信元仕様は、frontend が実際に読んでいる範囲だけを事実として扱い、それ以外は `未確認` または `推定` として扱う必要があります。

実装は 1 つのアプリではなく、次の 4 実行面に分かれています。

- Background service worker
- Netflix 向け content script bundle
- Disney+ 向け content script bundle
- `localhost:3000` 向け bridge content script

## Execution Surfaces

| Surface | Loaded from | Trigger | Main entry / handlers | Notes |
|---|---|---|---|---|
| Background service worker | `src/background/background.js` | extension install/update, runtime message | `handleInstalledDemo()`, `chrome.runtime.onMessage` (`seek`, `HISTORY_CHANGE`) | Netflix seek を page `MAIN` world で実行する唯一の場所 |
| Netflix bundle | `dist/content.js` generated from `src/content/content_netflix.js` | `https://www.netflix.com/*`, `document_idle` | `initializeNetflixPlayback()`, `bootstrapRecordControls()`, `init()`, `startPlaylistMode()` | 録画、一覧表示、clip/playlist 再生が 1 file に密集 |
| Netflix history/page hook | `src/util/history_change.js`, `src/inject/inject_script.js`, and runtime injection from `content_netflix.js` | `https://www.netflix.com/*`, `document_end` + runtime injection | `history.pushState` / `replaceState` patch, `historyChange` event dispatch | 同じ hook が複数経路で入る |
| Disney+ bundle | `dist/content_disney.js` generated from `src/content/content_disney.js` | `https://www.disneyplus.com/*`, `document_idle` | top-level IIFE, `UI.bootstrap()`, `Mode.bootstrap()` | Netflix よりモジュール分割されている |
| Localhost bridge | `src/content/getClipData.js` | `http://localhost:3000/*`, `document_idle` | `window.addEventListener("message")`, `clipSelected`, `playQueue()` | 外部 localhost ページと拡張の接続面 |

重要:

- manifest が読むのは `src/content/*.js` ではなく `dist/content.js` / `dist/content_disney.js`
- `webpack.config.js` は `dist/` を出力先にする
- `.gitignore` は `/dist` を無視する
- `git ls-files dist` は空で、現在の `dist/` は git 追跡対象ではない

つまり、この拡張は「生成物が必要なのに、その生成物は repo で安定管理されていない」構成です。source を直しても build しない限り manifest 実行コードは変わりません。

## Important Files and Dependency Map

```text
manifest.json
webpack.config.js
src/api.js
src/background/background.js
src/content/common.js
src/content/content_netflix.js
src/content/content_disney.js
src/content/getClipData.js
src/util/services.js
src/util/history_change.js
src/util/cookies.js
src/image/{recordSVG.js, moreDetailSVG.js, LoopButtonSVG.js}
```

依存関係の実態:

- `src/content/content_netflix.js`
  - imports `../css/content_button.css`
  - imports `../image/recordSVG.js`, `../image/moreDetailSVG.js`, `../image/LoopButtonSVG.js`
  - imports `../api.js`
  - imports `./common.js`
  - imports `../util/cookies.js`
  - imports `../util/services.js`
- `src/content/content_disney.js`
  - imports `./common.js`
  - URL 組み立ては `util/services.js` を使わず、内部で clip 正規化を持つ
- `src/content/common.js`
  - imports `../api.js`
- `src/content/getClipData.js`
  - imports なし
  - `src/util/services.js` とほぼ同じ service URL helper を内部に再実装している
- `src/background/background.js`
  - standalone
  - Netflix player API に直接触る page-world 実行担当
- `src/util/history_change.js`
  - standalone side-effect script
  - `historyChange` CustomEvent を発火するだけ
- `src/image/*.js`
  - ES module import されるが、実態は `window.createSVG`, `window.createMoreDetailSVG`, `window.LoopButtonSVG` を登録する副作用モジュール

## Entry Points

### `manifest.json`

```json
{
  "background": {
    "service_worker": "src/background/background.js"
  },
  "content_scripts": [
    {
      "matches": ["https://www.netflix.com/*"],
      "run_at": "document_end",
      "js": ["src/inject/inject_script.js", "src/util/history_change.js"]
    },
    {
      "matches": ["https://www.netflix.com/*"],
      "run_at": "document_idle",
      "js": ["dist/content.js"]
    },
    {
      "matches": ["https://www.disneyplus.com/*"],
      "run_at": "document_idle",
      "js": ["dist/content_disney.js"]
    },
    {
      "matches": ["http://localhost:3000/*"],
      "run_at": "document_idle",
      "js": ["src/content/getClipData.js"]
    }
  ]
}
```

### Netflix boot sequence

1. `dist/content.js` が `document_idle` で読み込まれる
2. `src/content/content_netflix.js` の side-effect import で CSS と SVG helper が `window.*` に登録される
3. `initializeNetflixPlayback()` が 1 回だけ動く
4. `clearAutoNavigation()` を呼んで `extAutoNavigation` をクリアする
5. `bootstrapRecordControls()` が録画 UI 用 `MutationObserver` を開始する
6. `onWindowLoad(...)` の中で mode 復元を実行する
7. `chrome.storage.local` の `playmode`, `playClipSystemKey`, `playlistSystemKey` を見て `init()` または `startPlaylistMode()` を選ぶ
8. `beforeunload` で mode key を落とす。ただし `isAutoNavigation()` が true なら cleanup をスキップする

### Disney+ boot sequence

1. `dist/content_disney.js` が `document_idle` で読み込まれる
2. top-level IIFE が immediately 実行される
3. `UI.bootstrap()` が UI 注入用 `MutationObserver` と history hook をセットする
4. `Mode.bootstrap()` が `window.load` 後に `startPreferredMode()` を呼ぶ
5. `startPreferredMode()` は `autoNav` -> `playmode` -> `playClipSystemKey` / `playlistSystemKey` の順に mode を解決する
6. `beforeunload` で mode key を落とす。ただし `isAutoNavigation()` または `autoNavCache` が有効なら cleanup をスキップする

### Localhost boot sequence

1. `src/content/getClipData.js` が `localhost:3000` 上に注入される
2. `clipSelected` CustomEvent listener と `window.message` listener が登録される
3. 外部 page からの `SET_CLIP_DATA`, `PLAY_PLAYLIST_START`, `EXT/SET_SESSION` を受けて extension state を更新する
4. playlist 開始時だけは `playQueue()` が即座に service URL に遷移する

### Background boot sequence

1. `chrome.runtime.onInstalled` が `handleInstalledDemo()` を呼ぶ
2. install/update 時に `http://localhost:3000/` を開く
3. `chrome.runtime.onMessage` が `seek` を受けると Netflix player API へシークする
4. `chrome.runtime.onMessage` が `HISTORY_CHANGE` を受けるとログだけ出す

## Core Architecture

### 1. Clip recording

Netflix と Disney+ は録画 UI が別実装ですが、保存 UI は `src/content/common.js#openMemoSidebar()` を共用します。

Netflix:

- `bootstrapRecordControls()` が録画ボタンを作る
- `recordObserver` が Netflix player control DOM を監視してボタンを差し込む
- 1 回目クリックで `startTime = video.currentTime`
- 2 回目クリックで `EndTime`, `URL`, `service`, `title`, `epnumber`, `user` を payload 化する
- `openMemoSidebar({ data, videoPlayer, onSave: sendData })` を開く

Disney+:

- `UI` 内の `myCustomActionLeft()` が 2 段階トグルで開始/終了を記録する
- `Service.DPlusTime.get()` が shadow DOM から現在秒数を取得する
- 2 回目クリックで `clipName`, `StartTime`, `EndTime`, `URL`, `title`, `epnumber`, `service`, `user` を payload 化する
- その payload を `openMemoSidebar()` に渡す

設計意図:

- 録画開始/終了の DOM 取得方法はサービスごとに違う
- ただし「クリップ名入力 + 保存 POST」の UI は両サービスで同じ

### 2. Netflix clip list and single-clip playback

この機能は `src/content/content_netflix.js` 独自です。`common.js#openMemoSidebar()` とは別に、Netflix 専用の「記録一覧サイドバー」を持ちます。

- `createLoopButton()` / `createPlayNextClipButton()` でプレイヤー右側 UI を生成
- `openSidebar()` が `nf-memo-sidebar` を生成し、`fetchDataAndRender()` を呼ぶ
- `fetchDataAndRender()` は `GET /api/random10` を呼び、`data.allReceivedData || []` を `renderClipList()` に渡す
- `renderClipList()` は各 item の `title`, `epnumber`, `user`, `startTime`, `endTime`, `id` を使って一覧 UI を描画する
- ジャンプボタンから `selectClip(clipId)` を呼ぶ
- `selectClip()` は `GET /api/fetchClip?id=...` を呼び、response text を `JSON.parse()` する
- 取得データを `setClipDataOnCookies()` で current origin cookie に書き、`redirectToClip()` で新規タブを開く

重要な不整合:

- `selectClip()` は `chrome.storage.local.clip` を書かない
- しかし Netflix の `init()` は `loadClipFromStorage()` 経由で `chrome.storage.local.clip` を読む
- repo 内で `clip` を書くのは `src/content/getClipData.js` の `clipSelected` と `SET_CLIP_DATA` だけ
- さらに `setClipDataOnCookies()` は Netflix / current origin cookie に書く一方、`getClipData.js#getCookies()` は `localhost:3000` cookie を読む

したがって、この repo だけを見る限り、

- `selectClip()` -> 新規 Netflix タブ -> `init()` の end-to-end clip 復元は確認できない
- `clipSelected` cookie 経路も origin が一致しないため、同一 repo 内だけでは接続していない

この部分は `未確認` ではなく「repo 内実装として不整合がある」と読むのが安全です。

### 3. Playlist playback

Playlist 再生は Netflix と Disney+ の両方にありますが、構造が異なります。

Netflix:

- `startPlaylistMode()` が `playQueue` を読む
- `currentClipOrder` に対応する clip を `clipData` に詰める
- `setupPlayer("playlist")` -> `monitorClipEnd(...)`
- end 到達後 `playlistNextClip(playQueue, currentOrder)` を呼ぶ
- `playlistNextClip()` は next clip を計算し、`currentClipOrder` / `currentClipId` を保存する
- `handleClipTransition({ currentUrl, nextUrl, ... })` で same-URL / cross-URL を分岐する
- same-URL の場合は `requestSeek()` をリトライし、`startUIWarmer()` で UI 表示を補助する
- cross-URL の場合は `markAutoNavigation("playlist")` 後に `window.location.href` を変更する

Disney+:

- `Mode.startPlaylistMode()` が `playQueue` を sort し current clip を選ぶ
- `Clip.play(clipData, { onEnd })` が再生制御の最小単位
- `handlePlaylistEnd()` -> `playlistNextClip(playQueue, currentOrder)`
- same-URL は次の `Clip.play()` を直接開始
- cross-URL は `beginAutoNavigation({ mode, nextUrl, nextOrder, nextId })` で `autoNav` を保存してから `window.location.href` を変更する

### 4. Cross-page auto navigation recovery

なぜ `extAutoNavigation` や `autoNav` があるのか:

- Netflix も Disney+ も `beforeunload` で `playClipSystemKey`, `playlistSystemKey`, `playmode` をリセットする
- そのまま cross-page playlist 遷移すると、次ページ到達前に mode が消えてしまう
- それを防ぐため、明示的に「これは手動離脱ではなく自動遷移」と印を残して cleanup をスキップしている

実装差:

- 共通フラグ: `src/content/common.js`
  - `markAutoNavigation(reason)`
  - `isAutoNavigation()`
  - `clearAutoNavigation()`
  - `sessionStorage` と `localStorage` の両方に `extAutoNavigation` を置く
- Disney+ 追加フラグ:
  - `autoNav` を `chrome.storage.local` に `{ ts, mode, nextUrl, nextOrder, nextId }` で保存
  - `loadAutoNav()` が TTL 15 秒で検証する
  - `startPreferredMode()` が次ページで mode を復元する

### 5. Netflix seek bridge

Netflix の seek は content script だけでは完結しません。

- `common.js#requestSeek({ service: "Netflix", seconds })`
- `chrome.runtime.sendMessage({ type: "seek", sec })`
- `background.js` が受信し、`chrome.scripting.executeScript({ world: "MAIN" })` を使う
- injected function 内で `window.netflix.appContext.state.playerApp.getAPI()` を辿って internal player を取得する

なぜ background + `MAIN` world なのか:

- Netflix の player API は page world 側にあり、isolated content script から直接触れない
- そのため `background.js` が bridge になっている

## Data Structures

### Raw clip payloads observed in code

この repo は field 名の揺れを前提に実装されています。以下は frontend が実際に扱っている raw shape です。

```ts
type RawClipPayload = {
  title?: string;
  clipName?: string;
  clipname?: string;
  user?: string;
  username?: string;
  epnumber?: string;
  service?: string;
  id?: string | number;
  clipId?: string | number;
  startTime?: string | number;
  starttime?: string | number;
  StartTime?: string | number;
  endTime?: string | number;
  endtime?: string | number;
  EndTime?: string | number;
  url?: string;
  URL?: string;
  Url?: string;
};
```

この raw shape を読む具体的な場所:

- `common.js#openMemoSidebar()`
  - `StartTime`, `EndTime`, `URL`, `title`, `epnumber`, `service`, `clipName`
- `content_netflix.js#loadClipFromStorage()`
  - `startTime ?? starttime`
  - `endTime ?? endtime`
  - `title`
- `content_disney.js#normalizeClipData()`
  - `startTime ?? starttime`
  - `endTime ?? endtime`
  - `clipname ?? title`
  - `url ?? URL ?? Url`
- `content_disney.js#normalizeClipUrl()`
  - `url ?? URL ?? Url`

### Normalized clip shape used internally

Netflix と Disney+ で完全統一はされていませんが、再生系が欲しがる最小 shape は次です。

```ts
type NormalizedClip = {
  startTime: number;
  endTime: number;
  title: string;
  url?: string;
};
```

### Playlist item

```ts
type PlaylistItem = RawClipPayload & {
  order: number;
};
```

`order` は playlist 内の並び順です。少なくとも次の関数が前提にしています。

- `getClipData.js#playQueue()`
- `content_netflix.js#startPlaylistMode()`
- `content_netflix.js#playlistNextClip()`
- `content_disney.js#startPlaylistMode()`
- `content_disney.js#playlistNextClip()`

### `chrome.storage.local` state

```ts
type ExtensionState = {
  clip?: RawClipPayload;
  playQueue?: PlaylistItem[];
  currentClipOrder?: number;
  currentClipId?: string | number; // writer only in current repo
  playClipSystemKey?: 0 | 1;
  playlistSystemKey?: 0 | 1;
  playmode?: "clip" | "playlist" | null;
  autoNav?: {
    ts: number;
    mode: "clip" | "playlist";
    nextUrl: string;
    nextOrder?: number;
    nextId?: string | number;
  };
  nextClip?: PlaylistItem; // writer only in current repo
  lastSeenWelcomeVersion?: string;
  lastSeenWhatsNewVersion?: string;
  lastShownAt?: number;
};
```

### Message payloads

```ts
type SeekMessage = { type: "seek"; sec: number };
type HistoryChangeMessage = { type: "HISTORY_CHANGE"; data: { method?: string; url?: string } };
type SetClipDataMessage = {
  type: "SET_CLIP_DATA";
  payload: { clip: RawClipPayload; playClipSystemKey?: number };
};
type PlayPlaylistStartMessage = { type: "PLAY_PLAYLIST_START" };
type ExtSetSessionMessage = { type: "EXT/SET_SESSION"; payload: Record<string, unknown> };
```

## State Management

### `chrome.storage.local`

| Key | Writers | Readers | Notes |
|---|---|---|---|
| `clip` | `getClipData.js` `clipSelected`, `getClipData.js` `SET_CLIP_DATA` | `content_netflix.js#loadClipFromStorage()`, `content_disney.js#loadClipData()` | clip mode の正本。Netflix `selectClip()` はここを書かない |
| `playQueue` | `getClipData.js` `PLAY_PLAYLIST_START`, `getClipData.js` `EXT/SET_SESSION` (任意) | Netflix `startPlaylistMode()`, Netflix `monitorClipEnd()`, Disney `loadPlaylistClip()`, Disney `startPlaylistMode()`, Disney `handlePlaylistEnd()` | playlist mode の正本 |
| `currentClipOrder` | `getClipData.js` `PLAY_PLAYLIST_START`, `getClipData.js#playQueue()`, Netflix `playlistNextClip()`, Disney `beginAutoNavigation()`, Disney `startPlaylistMode()`, Disney `playlistNextClip()`, Netflix/Disney `beforeunload` cleanup | Netflix `startPlaylistMode()`, Netflix `monitorClipEnd()`, Disney `loadPlaylistClip()`, Disney `startPlaylistMode()`, Disney `playlistNextClip()` | playlist 継続位置 |
| `currentClipId` | Netflix `playlistNextClip()`, Disney `beginAutoNavigation()`, Disney `startPlaylistMode()`, Disney `playlistNextClip()` | reader は repo 内に見当たらない | write-only。将来用か未完成の可能性あり |
| `playClipSystemKey` | `getClipData.js` `clipSelected`, `SET_CLIP_DATA`; Netflix `init()` 直前や mode 解決; Disney `startClipMode()` / `startPreferredMode()` / `beginAutoNavigation()`; `beforeunload` cleanup | Netflix 初期化ガード, `loadClipFromStorage()`, mode 解決; Disney `loadClipData()`, `resolvePlayMode()`, `startPreferredMode()` | clip mode ON/OFF |
| `playlistSystemKey` | `getClipData.js` `PLAY_PLAYLIST_START`; Netflix `startPlaylistMode()`, `beforeunload`; Disney `startPlaylistMode()`, `beginAutoNavigation()`, `beforeunload` | Netflix mode 解決; Disney `resolvePlayMode()`, `startPreferredMode()` | playlist mode ON/OFF |
| `playmode` | `getClipData.js` `clipSelected`, `SET_CLIP_DATA`, `PLAY_PLAYLIST_START`, `playQueue()`, `EXT/SET_SESSION`; Netflix `init()` / `startPlaylistMode()` / mode 補正 / `beforeunload`; Disney `startClipMode()` / `startPlaylistMode()` / `beginAutoNavigation()` / mode 補正 / `beforeunload` | Netflix 初期化ガード, mode 解決; Disney `resolvePlayMode()`, `startPreferredMode()` | `"clip"`, `"playlist"`, `null` |
| `autoNav` | Disney `beginAutoNavigation()` | Disney `loadAutoNav()` | Disney 専用。TTL 15 秒 |
| `nextClip` | `getClipData.js#playQueue()` | reader は repo 内に見当たらない | write-only。現在はデバッグ/将来用に見える |
| `lastSeenWelcomeVersion` | `background.js#handleInstalledDemo()` | 同左 | install/update 時の localhost デモ表示制御 |
| `lastSeenWhatsNewVersion` | `background.js#handleInstalledDemo()` | 同左 | 同上 |
| `lastShownAt` | `background.js#handleInstalledDemo()` | 同左 | localhost タブ連打防止 |

### `sessionStorage` / `localStorage`

| Storage | Key | Writers | Readers | Notes |
|---|---|---|---|---|
| `sessionStorage` | `nfClipInitialized` | Netflix 初期化ガード | 同じガード処理 | 1 tab 内で不要 reset を防ぐ |
| `sessionStorage` + `localStorage` | `extAutoNavigation` | `common.js#markAutoNavigation()` | `common.js#isAutoNavigation()` | cross-page cleanup 回避 |
| `localStorage` | `playQueue` | 外部 localhost page | `getClipData.js` `PLAY_PLAYLIST_START` | extension state ではない。外部 page state |
| `localStorage` | `ext_fallback` | `getClipData.js#safeSetStorage()` fallback | reader は repo 内に見当たらない | write-only fallback |

### In-memory local state

Netflix:

- `videoPlayer`
- `clipData`
- `isLooping`
- `togglekey`
- `countdownIntervalId`
- `uiWarmerInterval`

Disney+:

- `autoNavCache`
- `Playlist.state`
- `Mode.stopCurrent`
- `Mode.loopEnabled`
- `clickStateLeft`
- `starttime`
- `observer`

これらはページ遷移で消えるため、永続化が必要な情報は `chrome.storage.local` 側に寄せられています。

### Server state

frontend が見る server state は次の 3 API だけです。

- `POST /api/receive`
- `GET /api/random10`
- `GET /api/fetchClip?id=...`

一覧や詳細は毎回 fetch され、frontend 内に長期キャッシュはありません。

## Data Flow Deep Dive

### 1. Netflix 録画保存

1. `bootstrapRecordControls()` が録画ボタンを生成する
2. `recordObserver` が Netflix controls DOM にそのボタンを差し込む
3. 1 回目クリックで `startTime = video.currentTime`
4. 2 回目クリックで payload を組み立てる
5. payload 例:

```js
{
  StartTime,
  EndTime,
  URL: window.location.pathname,
  service: detectService(),
  user: "test_user",
  title,
  epnumber
}
```

6. `openMemoSidebar({ data: payload, videoPlayer, onSave: (data) => sendData(data) })`
7. `openMemoSidebar()` が `clipName` 入力欄を追加する
8. 保存で `sendData()` が `POST /api/receive` を呼ぶ
9. 成功/失敗に関わらず `videoPlayer.play()` とサイドバー close が走る

### 2. Netflix 一覧から clip 再生

1. `openSidebar()` が Netflix 専用一覧サイドバーを作る
2. `fetchDataAndRender()` が `GET /api/random10` を呼ぶ
3. response から `data.allReceivedData || []` を取り出す
4. `renderClipList()` が item ごとのジャンプボタンを作る
5. ジャンプで `selectClip(item.id)` を呼ぶ
6. `selectClip()` が `GET /api/fetchClip?id=...` を呼ぶ
7. response text を `JSON.parse(raw)` する
8. `setClipDataOnCookies(data)` が current origin cookie に次の key を書く

```text
title
user
startTime
endTime
url
service
clipId
username
```

9. `redirectToClip(data)` が `buildServiceUrl(service, url, Math.floor(startTime), "t")` を作る
10. `window.open(finalUrl, "_blank")` で新規タブを開く
11. 期待される次段は新規タブ側 `init()` だが、`init()` は `chrome.storage.local.clip` を読む

注意:

- この flow だけでは `chrome.storage.local.clip` が埋まらない
- したがって README を読んだ LLM は、この flow を「完成済み」と仮定してはいけない

### 3. Localhost から playlist 開始

1. 外部 localhost page が `window.postMessage({ type: "PLAY_PLAYLIST_START" })` を送る
2. `getClipData.js` がそれを受ける
3. `localStorage.getItem("playQueue")` から page-local playlist JSON を読む
4. `safeSetStorage({ playQueue: queue, currentClipOrder: 0, playmode: "playlist" })`
5. `playQueue(queue)` が最小 `order` の clip を選ぶ
6. `buildServiceUrl(normalizedService, nextClip.url, startTime, "t")` を作る
7. 追加で `safeSetStorage({ playmode: "playlist", nextClip })` を書く
8. `chrome.storage.local.set({ playClipSystemKey: 0, playlistSystemKey: 1 })`
9. `chrome.storage.local.set({ currentClipOrder: 0 })`
10. `window.location.href = url`

注意:

- `nextClip` はこの flow でしか書かれず、repo 内 reader は見当たらない

### 4. Disney+ の same-URL playlist 継続

1. `Clip.play()` が current clip 再生を開始する
2. `startEndMonitor()` が `clipData.endTime` 到達を監視する
3. 到達すると `handlePlaylistEnd()` が呼ばれる
4. `playlistNextClip(playQueue, currentOrder)` が next clip を決める
5. `normalizeClipData(next)` で `startTime`, `endTime`, `title`, `url` を正規化する
6. `normalizeClipUrl(current)` と `normalizeClipUrl(next)` が同じなら `playPlaylistClip(nextClipData)` を直接呼ぶ
7. page 遷移は発生せず、同一ページ内で次 clip に移る

### 5. Disney+ の cross-URL playlist 継続

1. `handlePlaylistEnd()` -> `playlistNextClip(playQueue, currentOrder)`
2. current URL と next URL が異なる
3. `beginAutoNavigation({ mode: "playlist", nextUrl, nextOrder, nextId })`
4. `beginAutoNavigation()` が `autoNav`, `playmode`, `playClipSystemKey`, `playlistSystemKey`, `currentClipOrder`, `currentClipId` を保存する
5. 同時に `markAutoNavigation("playlist")` が `extAutoNavigation` を立てる
6. `window.location.href = url`
7. 次ページで `loadAutoNav()` が `autoNav.ts` の TTL を検証する
8. `startPreferredMode()` が `autoNav.mode === "playlist"` を見て playlist mode を復元する
9. `clearAutoNavState()` が `autoNav` と `extAutoNavigation` を片付ける

## API Contracts (Frontend-Observed)

backend は repo 外です。以下は frontend が実際に読んでいる shape だけを記述します。

### `POST http://localhost:3000/api/receive`

- Caller:
  - `common.js#sendData()`
- Call sites:
  - Netflix `openMemoSidebar(... onSave: sendData ...)`
  - Disney+ `openMemoSidebar(... onSave: sendData ...)`
- Body:
  - `openMemoSidebar()` に渡された payload に `clipName` を追加したもの
  - 具体的には `StartTime`, `EndTime`, `URL`, `service`, `user`, `title`, `epnumber`, `clipName` が観測される
- Response:
  - `response.json()` で消費
  - field の中身は frontend で参照していないため `未確認`

### `GET http://localhost:3000/api/random10`

- Caller:
  - `content_netflix.js#fetchDataAndRender()`
- Response:
  - `const data = await res.json()`
  - `const items = data.allReceivedData || []`
- `items[n]` から実際に読む field:
  - `title`
  - `epnumber`
  - `user`
  - `startTime`
  - `endTime`
  - `id`

### `GET http://localhost:3000/api/fetchClip?id=...`

- Caller:
  - `content_netflix.js#selectClip(clipId)`
- Response:
  - `const raw = await res.text()`
  - `const data = JSON.parse(raw)`
- `redirectToClip(data)` が必須で読む field:
  - `url`
  - `service`
  - `startTime`
- `setClipDataOnCookies(data)` が optional に読む field:
  - `title`
  - `user`
  - `endTime`
  - `clipId`
  - `username`
- これ以外の response field は `未確認`

## Message and Event Contracts

| Contract | Sender | Receiver | Payload | Effect |
|---|---|---|---|---|
| `chrome.runtime.sendMessage({ type: "seek", sec })` | `common.js#requestSeek()` | `background.js` | `sec: number` | Netflix player を seek |
| `chrome.runtime.sendMessage({ type: "HISTORY_CHANGE", data })` | Netflix `window.addEventListener("historyChange", ...)` | `background.js` | `{ method, url }` | 現状は log only |
| `chrome.runtime.sendMessage({ type: "nf:init-bridge" })` | `content_netflix.js` | receiver は repo 内に見当たらない | none | no-op に見える |
| `chrome.runtime.sendMessage({ type: "SET_SESSION_DATA", payload })` | `getClipData.js#safeSetStorage()` fallback | receiver は repo 内に見当たらない | arbitrary object | fallback が実際には接続されていない |
| `window.postMessage({ type: "SET_CLIP_DATA", payload })` | 外部 localhost page | `getClipData.js` | `{ clip, playClipSystemKey? }` | `clip`, `playmode`, mode key を保存 |
| `window.postMessage({ type: "PLAY_PLAYLIST_START" })` | 外部 localhost page | `getClipData.js` | none | `localStorage.playQueue` を extension state にコピーして遷移 |
| `window.postMessage({ type: "EXT/SET_SESSION", payload })` | 外部 localhost page | `getClipData.js` | arbitrary object | 任意 key を `chrome.storage.local` へ保存 |
| `CustomEvent("historyChange")` | `src/util/history_change.js` | `content_netflix.js` | `{ method, url }` | record state reset + `HISTORY_CHANGE` message |
| `Event("locationchange")` | Disney `UI.hookHistory()` | Disney `UI.scheduleInjection()` | none | button reinjection |
| `CustomEvent("clipSelected")` | 外部 localhost page | `getClipData.js` | none | `document.cookie` を読んで `clip` に保存 |
| `CustomEvent("clipListElementsRendered")` | 外部 localhost page | `getClipData.js` | none | listener はあるが中身なし |

## URL / Navigation Model

### Service URL building

この repo には 2 系統の URL builder があります。

- `src/util/services.js`
- `src/content/getClipData.js` 内の重複実装

両方ともやっていること:

- service alias を lowercase に正規化
- relative URL を service base URL に変換
- `t` query param を付与

両者のズレ:

- `common.js#detectService()` は `Hulu` を返しうる
- しかし `util/services.js` と `getClipData.js` の URL builder は Hulu を扱わない
- `util/services.js` は `amazon` を base URL に持つが、`getClipData.js` にはない

### Same-URL vs cross-URL

- 共通判定:
  - `common.js#decideClipTransition(currentUrl, nextUrl)`
  - 実装は単純に `currentUrl === nextUrl`
- Netflix:
  - same-URL は `requestSeek()` をリトライ
  - cross-URL は `window.location.href = https://www.netflix.com${next.url}?t=...`
- Disney+:
  - same-URL は `Clip.play(nextClipData)`
  - cross-URL は `buildClipUrl(nextUrl, startTime)` 後に `window.location.href`

### Cookie scope

`setCookie()` は単に `document.cookie = ...` を行うだけです。domain 指定も cross-origin 共有もありません。したがって、

- Netflix で書いた cookie は Netflix origin の cookie
- `localhost:3000` で `getCookies()` が読む cookie は localhost origin の cookie

この 2 つは repo 内コードだけでは共有されません。

## Async Model

### Netflix

- `onWindowLoad(callback)` が load 完了待ちを吸収する
- `bootstrapRecordControls()` は `MutationObserver` で録画ボタン差し込みを維持する
- `waitForVideoElement()` も `MutationObserver` で `<video>` 出現待ちをする
- `monitorClipEnd()` は `timeupdate` で clip 終端を監視する
- `startCountdownLogger()` は 1 秒ごとの `setInterval`
- playlist same-URL seek は `for (;;)` + `await requestSeek()` + `await new Promise(r => setTimeout(r, 300))`
- `beforeunload` cleanup は `isAutoNavigation()` で抑制される

### Disney+

- `UI.startObserver()` が UI 再注入用 `MutationObserver`
- `UI.scheduleInjection()` は `requestAnimationFrame` で連打を抑える
- `Clip.play()` は `setInterval` で再生位置取得可能になるまで待ち、その後 `startEndMonitor()` を開始する
- `startEndMonitor()` は 500ms interval で end 到達を監視する
- `loadAutoNav()` は `chrome.storage.local` から非同期復元し TTL を検証する
- `beforeunload` cleanup は `isAutoNavigation()` または `autoNavCache` 有効時に抑制される

### Localhost bridge

- `window.addEventListener("message", async ...)`
- `safeSetStorage()` は `chrome.storage.local.set()` を試し、失敗時は background relay または `localStorage.ext_fallback` へ逃がす
- playlist 開始は `setTimeout(..., 300)` 後に遷移する

## Risky / Fragile Areas

### `src/content/content_netflix.js` が巨大で副作用密度が高い

- 録画 UI
- 一覧サイドバー
- API fetch
- clip 再生
- playlist 再生
- history hook 注入
- beforeunload cleanup

が 1 file に同居しています。小さな変更でも副作用範囲を広く見積もる必要があります。

### history hook が多重注入される

`src/util/history_change.js` は次の 3 経路で入りえます。

- `manifest.json` の Netflix `document_end`
- `src/inject/inject_script.js`
- `content_netflix.js#injectHistoryHook("src/util/history_change.js")`

`history_change.js` 自体に idempotency guard はありません。history API の二重パッチ前提で編集してはいけません。

### `dist/` が manifest 実行物なのに git ignore されている

- manifest は `dist/content.js` と `dist/content_disney.js` を直接読む
- しかし `.gitignore` は `/dist` を無視する
- `git ls-files dist` は空

README を読んだ LLM は、「source 修正だけで extension が動く」と思ってはいけません。

### Netflix `selectClip()` flow と `loadClipFromStorage()` flow が接続していない

- `selectClip()` は cookie を書くが `clip` storage は書かない
- `init()` は `clip` storage を読む
- `clipSelected` cookie reader は localhost origin 側

これは改修時に見落としやすい、実フロー上の大きな不整合です。

### `currentClipId` と `nextClip` は writer はあるが reader がない

- `currentClipId`
- `nextClip`

今の repo では write-only です。安易に「重要 state」と仮定して使わないこと。

### Netflix seek は active tab 前提

`background.js` は `sender.tab` を使わず、`chrome.tabs.query({ active: true, currentWindow: true })` の tab に対して seek します。対象タブが非アクティブなら no-op / 誤対象の可能性があります。

### 名前が似ているが責務が違う関数がある

- `common.js#openMemoSidebar()`
  - 録画保存用
- `content_netflix.js#openSidebar()`
  - 記録一覧表示用

同じ「sidebar」でも役割が違うため、統合や共通化を前提にしてはいけません。

## Editing Guidelines for LLMs

### Safe to edit first

次は比較的安全です。とはいえ影響確認は必要です。

- `src/api.js`
  - API base URL の変更
- `src/css/content_button.css`
  - 録画ボタン hover 見た目
- Disney+ のボタン見た目
  - `content_disney.js` の `ensureStyle()` 内 CSS
- 文言変更
  - ボタン label, サイドバー title, console message

### High-risk areas

- storage key 名
  - `clip`, `playQueue`, `currentClipOrder`, `currentClipId`, `playClipSystemKey`, `playlistSystemKey`, `playmode`, `autoNav`
- history / navigation
  - `history_change.js`, `inject_script.js`, `content_netflix.js`, `content_disney.js`
- Netflix seek bridge
  - `common.js#requestSeek()`, `background.js`, `content_netflix.js`
- URL builder
  - `src/util/services.js`, `src/content/getClipData.js`
- side-effect `window.*` SVG module
  - `src/image/*.js`

### Mandatory checklist before editing

#### 1. Field 名を変える前

最低でも次を全検索すること。

```text
startTime
starttime
StartTime
endTime
endtime
EndTime
url
URL
Url
clipName
clipname
user
username
id
clipId
```

更新対象:

- `openMemoSidebar()`
- `content_netflix.js#loadClipFromStorage()`
- `content_netflix.js#setClipDataOnCookies()`
- `content_disney.js#normalizeClipData()`
- `content_disney.js#normalizeClipUrl()`
- `getClipData.js#getCookies()`

#### 2. Service 名を変える前

最低でも次をセットで見ること。

- `common.js#detectService()`
- `util/services.js#normalizeService()`
- `util/services.js#buildServiceUrl()`
- `getClipData.js` 内の `normalizeService()` / `buildServiceUrl()`

片側だけ直すと service enum drift が拡大します。

#### 3. Playback mode を変える前

次の key をすべて横断検索すること。

```text
playClipSystemKey
playlistSystemKey
playmode
currentClipOrder
currentClipId
autoNav
extAutoNavigation
```

特に `beforeunload` cleanup と自動遷移抑制は一緒に確認すること。

#### 4. Netflix seek を変える前

次をまとめて確認すること。

- `common.js#requestSeek()`
- `background.js` `onMessage("seek")`
- `content_netflix.js#playlistNextClip()`
- `content_netflix.js#monitorClipEnd()`
- `content_netflix.js#startUIWarmer()`

#### 5. Source を変えた後

- `npx webpack` が必要
- manifest は `dist/*` を読む
- `dist/` が git ignore されているので、working tree だけ見ても反映物が管理されない可能性がある

### Things you should not “clean up” casually

- field casing の統一
- `window.*` SVG helper の撤去
- `history_change.js` の削除や注入経路整理
- `clipSelected` / cookie 経路の削除
- `nextClip`, `currentClipId` の削除

これらは見た目には負債でも、外部 localhost page や未同梱 backend 契約にぶら下がっている可能性があります。削除ではなく、まず read/write 実態と外部依存を確認すること。

## Anti-Patterns / Smells

- URL builder が二重実装
  - `src/util/services.js`
  - `src/content/getClipData.js`
- history hook の多重注入
  - `manifest.json`
  - `src/inject/inject_script.js`
  - `content_netflix.js#injectHistoryHook()`
- callback と async/await が混在
  - Netflix / Disney / background 全体
- hardcoded user 名
  - Netflix: `"test_user"`
  - Disney+: `"testUser"`
- write-only state
  - `currentClipId`
  - `nextClip`
- receiver が存在しない message
  - `nf:init-bridge`
  - `SET_SESSION_DATA`
- side-effect import 依存
  - `window.createSVG`
  - `window.createMoreDetailSVG`
  - `window.LoopButtonSVG`
- field casing の揺れ
  - `StartTime` vs `startTime` vs `starttime`
  - `URL` vs `url` vs `Url`
  - `clipName` vs `clipname`
- service enum drift
  - `detectService()` は `Hulu` を返しうる
  - URL builder は Hulu 未対応
- 生成物依存なのに `/dist` が ignore
- placeholder / 未使用コード
  - `content_netflix.js#ensureClipTagInURL()`
  - `content_netflix.js#reloadPageFromScript()`
  - `content_netflix.js#getLoopPlaylist()`
  - `content_disney.js#myCustomActionRight2()`
  - `background.js` の `let playClipSystemKey = "initialValue"`
  - `content_netflix.js` の `togglekey` は見た目以外の動作に接続していない

## API / UI / Playback Boundaries You Should Respect

- 録画保存 UI 共通化境界:
  - `common.js#openMemoSidebar()`
- サービス固有録画境界:
  - Netflix `bootstrapRecordControls()`
  - Disney `myCustomActionLeft()`
- URL 遷移境界:
  - `services.js` / `getClipData.js` URL builder
  - `handleClipTransition()`
- Netflix player 直アクセス境界:
  - `background.js` only
- 外部 localhost page 契約境界:
  - `getClipData.js`

## Known Unknowns / External Contracts

- `http://localhost:3000` の page 実装は repo にない
- `/api/receive`, `/api/random10`, `/api/fetchClip` の backend 実装は repo にない
- `clipSelected` / `clipListElementsRendered` / `window.postMessage(...)` の送信元 page は repo にない
- `nf:init-bridge` と `SET_SESSION_DATA` の receiver は repo 内にない
- Netflix cookie -> localhost cookie の橋渡しは repo 内にない

したがって、次は `推定` 扱いにすること。

- `clipSelected` cookie 経路が外部 page で補完されているかどうか
- `nextClip` / `currentClipId` を参照する外部コードの有無
- backend が受け取る / 返す追加 field の意味

## Recommended Reading Order for LLMs

### 1. Execution map を固める

1. `manifest.json`
2. `webpack.config.js`

ここで「どのファイルが実際にブラウザで動くか」を確定する。

### 2. Shared contract を読む

3. `src/content/common.js`
4. `src/api.js`
5. `src/util/services.js`

ここで API base URL、seek 契約、自動遷移フラグ、service 正規化を把握する。

### 3. Netflix flow を読む

6. `src/content/content_netflix.js`
7. `src/util/history_change.js`
8. `src/inject/inject_script.js`
9. `src/image/*.js`

ここで最も壊れやすい monolith の挙動を読む。

### 4. Disney flow を読む

10. `src/content/content_disney.js`

ここでより整理された clip / playlist state machine を読む。

### 5. External bridge と background bridge を読む

11. `src/content/getClipData.js`
12. `src/background/background.js`
13. `src/util/cookies.js`
14. `src/types/clip.js`

ここで localhost 契約、Netflix MAIN-world bridge、field shape を確認する。

## Quick Mental Model for Safe Changes

この repo を安全に触るときの最短モデルは次です。

1. mode の正本は `chrome.storage.local`
2. DOM へのボタン差し込みは `MutationObserver`
3. 動画終端監視は Netflix は `timeupdate`、Disney+ は `setInterval`
4. same-URL 遷移は seek、cross-URL 遷移は storage 更新後 `window.location.href`
5. cleanup から mode を守るために `extAutoNavigation` / `autoNav` がある
6. Netflix の player 直操作は background `MAIN` world bridge でしかできない
7. `localhost:3000` 契約は repo 外で、ここが最も不確定
