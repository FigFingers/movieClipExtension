# READMEFORLLM

このファイルは人間向け README ではなく、LLM / AI コーディングエージェント向けの運用資料です。目的は「どの実行面に何が載っていて、どの状態や契約を壊すと危険か」を短時間で把握できるようにすることです。

- 対象コミット: `b9d8fa5`（ブランチ `codex/comment-playback-hardening`）
- 最終更新: 2026-08-25
- 実測値: `src/` 34 ファイル / 約 7,800 行、`test/` 15 ファイル / 143 tests

この repo に含まれるのは拡張機能側だけです。サイト（`react--site`, Next.js）と backend は別リポジトリにあります。したがってサイト API の応答 shape や `window.postMessage` の送信元仕様は、拡張が実際に読んでいる範囲だけを事実として扱い、それ以外は `未確認` として扱ってください。

関連資料:

- `docs/localhost-playback-bridge-contract-v1.md` — サイト⇄拡張の再生ハンドオフ入力契約の**正典**
- `CODE_ISSUES_FOR_LLM.md` — 既知の問題と、再指摘してはいけない対応済み項目

## 前提: ビルドしないと何も変わらない

`manifest.json` が読むのは `dist/` のバンドルです。`.gitignore` は `/dist` を無視するため、clean clone 直後の `dist/` は存在しません。

```
npm install
npm run build     # 一回ビルド
npm run dev       # webpack --watch
```

`webpack.config.js` の entry は 5 つで、それぞれ `dist/<name>.js` を出力します。

| entry | 入力 | 出力 |
|---|---|---|
| `content` | `src/content/content_netflix.js` | `dist/content.js` |
| `content_disney` | `src/content/content_disney.js` | `dist/content_disney.js` |
| `extension_link` | `src/content/extension_link.js` | `dist/extension_link.js` |
| `getClipData` | `src/content/getClipData.js` | `dist/getClipData.js` |
| `background` | `src/background/background.js` | `dist/background.js` |

**source を直しても build しない限り、ブラウザで動くコードは変わりません。**

検証コマンド:

- `npm run lint` — `biome lint .`（linter のみ、formatter は無効）
- `npm test` — `node --test`。実テストがあり、変更後は必ず実行する
- `npm run build` — webpack production

## Execution Surfaces

`manifest.json` が定義する実行面は 7 つです。`world: MAIN` の 3 本は bundle されず、`src/` から直接読まれます。

| Surface | manifest が読むファイル | matches | run_at | world |
|---|---|---|---|---|
| Background service worker | `dist/background.js` | — | — | — |
| Netflix: page hook 注入器 | `src/inject/inject_script.js` | `netflix.com/*` | `document_end` | isolated |
| Netflix: 本体 | `dist/content.js` | `netflix.com/*` | `document_idle` | isolated |
| Disney+: history hook | `src/util/history_change.js` | `disneyplus.com/*` | `document_start` | **MAIN** |
| Disney+: 本体 | `dist/content_disney.js` | `disneyplus.com/*` | `document_idle` | isolated |
| localhost: 認証 + 再生ブリッジ | `dist/extension_link.js`, `dist/getClipData.js` | `localhost:3000/*`, `127.0.0.1:3000/*` | `document_idle` | isolated |
| localhost: 検知フラグ | `src/content/extension_present.js` | `localhost:3000/*`, `127.0.0.1:3000/*` | `document_start` | **MAIN** |

`web_accessible_resources` は Netflix に対して `src/util/history_change.js` を公開しています。`inject_script.js` がこれを `<script src=chrome-extension://...>` として MAIN world へ差し込みます。

permissions: `activeTab`, `storage`, `tabs`, `scripting`, `alarms`
host_permissions: `localhost:3000`, `127.0.0.1:3000`, `www.netflix.com`, `www.disneyplus.com`

**localhost の content script は `:3000` に限定されています。** 別ポートのローカルアプリからトークンを奪われないための境界なので、matches を広げてはいけません。

## モジュール構成

### `src/shared/` — content と background の両方から import される純粋モジュール

DOM にも `chrome.*` にも依存しないため、両実行面で同じ規則を適用できます。**信頼境界の要なので、片側だけ変更してはいけません。**

| ファイル | 役割 |
|---|---|
| `playbackBridgeValidation.js` | 再生ハンドオフ入力の検証・正規化。契約 v1 の実装本体 |
| `storage.js` | `STORAGE_KEYS`、`storageGet/Set/Remove`、`normalizePendingClips`、`clearExtensionAuthState` |
| `authValidation.js` | `isValidExtensionInstanceId` / `isValidExtensionAuthToken` / `normalizeExtensionTokenExpiry` |
| `commentText.js` | `COMMENT_BODY_MAX_CODE_POINTS = 500`、`isValidCommentBody`（UTF-16 長ではなく code point 数で判定） |

### `src/background/`

| ファイル | 役割 |
|---|---|
| `background.js` | 全リスナーの配線のみ。ロジックは各モジュールへ委譲 |
| `playbackOwnership.js` | `createPlaybackOwnershipManager()`。タブ単位の再生所有権レジストリ |
| `sync.js` | `enqueuePendingClipInBackground` / `syncPendingQueue` / `openLoginTab` |
| `comments.js` | `fetchClipComments` / `postClipComment` と応答 shape 検証 |
| `tokenRefresh.js` | `checkAndRefreshToken`。期限判定・ローテーション・失敗バックオフ |
| `authState.js` | トークン保存・連携解除を `runExclusive` 内で実行 |
| `instanceId.js` | `getOrCreateInstanceId`。instanceId の唯一の発行元 |
| `authMutex.js` | `runExclusive`。認証状態の直列化 |
| `request.js` | `fetchJsonWithTimeout`（15 秒。本文読み込みも Abort 対象） |
| `detachedTasks.js` | `runDetachedTask` / `runPlaybackCleanupTask` |

### `src/content/`

| ファイル | 行数 | 役割 |
|---|---:|---|
| `commentPanel.js` | 1,303 | コメントパネル UI・取得・投稿・下書き保持 |
| `content_disney.js` | 1,134 | Disney+ の録画 UI・clip / playlist 再生 |
| `content_netflix.js` | 1,001 | Netflix の録画 UI・一覧・clip / playlist 再生 |
| `common.js` | 506 | メモサイドバー、`detectService`、seek、自動遷移マーカー |
| `extensionSync.js` | 195 | instanceId / トークン / 同期の content 側窓口 |
| `playbackOwnership.js` | 193 | 所有権 client（nonce 生成・claim・update・release） |
| `getClipData.js` | 188 | localhost → 拡張の**再生**ブリッジ |
| `playbackContext.js` | 146 | タブ固有の再生対象 context |
| `extension_link.js` | 80 | localhost → 拡張の**認証**ブリッジ |
| `netflixClipSelection.js` | 42 | 選択クリップの正規化と原子的 commit |
| `domUpdates.js` | 5 | `setTextContentIfChanged`（同値 DOM 更新の抑制） |
| `extension_present.js` | 4 | MAIN world の検知フラグ |

### `src/util/` / `src/ui/` / `src/types/`

- `util/services.js` — `SERVICE_BASE_URL`、`normalizeService`、`buildServiceUrl`
- `util/cookies.js` — `setCookie` / `parseCookies` / `getCookie`
- `util/history_change.js` — `pushState` / `replaceState` / `popstate` を `historyChange` CustomEvent に変換
- `ui/icons.js` — `createIcon(name)`。SVG は**このファイル内の定数のみ**を `innerHTML` に通す
- `types/clip.js` — JSDoc typedef のみ（実行時コードなし）

## Core Architecture

### 1. 再生所有権（最重要）

この拡張で最も理解が必要な仕組みです。**複数タブが同じ `chrome.storage.local` を共有しても、再生状態が混線しないようにするための層**です。

構成要素:

| 要素 | 置き場所 | 生存範囲 |
|---|---|---|
| owner nonce | URL query `dextPlaybackOwner` / `sessionStorage.dextPlaybackOwnerTab` | タブ |
| ownership registry | `chrome.storage.session.activePlaybackTabsV1` | ブラウザセッション |
| 再生スナップショット | `chrome.storage.local`（`clip` / `playQueue` ほか） | 永続 |
| playback context | `sessionStorage.dextPlaybackContextV1` | タブ |

フロー:

1. 再生を始めたい側（localhost ブリッジ or Netflix 一覧）が `createPlaybackOwnerNonce()` で nonce を作る
2. `beginPlaybackHandoff({ nonce, mode, clipId, snapshot })` を background へ送る
3. background が `normalizePlaybackSnapshot()` で**再検証**し、registry の `pending` へ TTL 30 秒で登録する
4. 遷移先 URL に `addPlaybackOwnerToUrl()` で nonce を付けて遷移する
5. 遷移先タブの content script が `claimPlaybackOwnership({ nonce })` を呼ぶ
6. background が nonce・タブ・ルートの一致を確認し、`pending` から `active` へ移して snapshot を返す
7. content は返ってきた snapshot だけを正本として再生を始める

重要な性質:

- **content の検証結果を background は信用しません。** 同じ規則で再検証します。
- 拒否時は storage・registry・画面遷移のいずれも部分更新しません。
- owner も pending も無くなった場合、mode フラグだけでなく `clip` / `playQueue` / `nextClip` も消去します。
- `chrome.alarms`（`playback-handoff-cleanup:<nonce>`、30 秒後）が期限切れの pending を回収します。
- `chrome.tabs.onRemoved` / `onCreated` / `onUpdated` が registry を追従させます。

### 2. 再生コンテキストとコメント対象の解決

`playbackContext.js` は「このタブが今どのクリップを再生しているか」を `sessionStorage` に持ちます。

```ts
type PlaybackContext = { mode: 'clip' | 'playlist'; clipId: number };  // clipId は正の safe integer
type Snapshot = { initialized: boolean; context: PlaybackContext | null };
```

- `initialized: true, context: null` は「このタブは初期化済みで、再生対象は無い」を意味します。**他タブの global state を借りてはいけない**ため、この 2 状態を区別しています。
- `sessionStorage` が使えない環境ではモジュールローカル値にフォールバックしますが、**global storage へは決してフォールバックしません**（fail closed）。
- 値が変わると `ext:playback-context-changed` CustomEvent を発火します。

`commentPanel.js#resolveCurrentClipId()` はこの context だけを見ます。これにより、タブ A でコメントパネルを開いたままタブ B で別クリップを再生しても、タブ A の投稿先は変わりません。

### 3. クリップ記録と同期キュー

録画 UI はサービスごとに別実装ですが、保存 UI は `common.js#openMemoSidebar()` を共用します。

Netflix: `bootstrapRecordControls()` が `MutationObserver` で録画ボタンを差し込み、1 回目クリックで開始秒、2 回目で終了秒を確定します。
Disney+: `UI.myCustomActionLeft()` が 2 段階トグルで同じことをします。再生位置は shadow DOM 越しに取得します。

保存経路:

1. `common.js#sendData()` → `extensionSync.js#enqueueClip()`
2. `toExtensionClipPayload()` が `clientItemId`（UUID）付きの正規化 payload を作る
3. `ENQUEUE_PENDING_CLIP` で background へ送り、`chrome.storage.local.pendingClips` へ積む
4. `SYNC_PENDING_CLIPS` → `sync.js#syncPendingQueue()` が `POST /api/extension/sync`（Bearer）
5. 失敗しても queue に残り、15 分毎の alarm と SW 起動時に再送される

**content から直接サイト API を fetch しません。** ページオリジンの CORS で弾かれるため、fetch は必ず background 側です。

`syncPendingQueue()` の応答分岐:

| status | 判定 | queued |
|---|---|---|
| 200 + 有効な `acceptedItemIds` | 受理分だけ queue から削除 | — |
| 200 + 応答 shape 不正 | `invalid_response` | 残す |
| 400 | `validation_error` | 内容により残す/捨てる |
| 401 | `unauthorized` / `stale_unauthorized` | 残す |
| 403 | `forbidden` | 残す |
| その他 | `sync_failed` | 残す |

`acceptedItemIds` は「送った `clientItemId` の集合に含まれ、重複しない文字列」であることまで検証します。**受理ゼロと field 欠落を区別する**ため、緩めてはいけません。

### 4. 認証・連携・トークンライフサイクル

サイト `/account` からの連携は `extension_link.js`（isolated world）が受けます。

```
site → GET_EXTENSION_INSTANCE_ID          → ext: port 'extensionInstanceId' で background から取得
ext  → EXTENSION_INSTANCE_ID_RESPONSE
site → EXTENSION_CHECK_AUTH               → ext: 連携状態を返す
ext  → EXTENSION_AUTH_STATUS
site → EXT_LINK_WITH_AUTH_TOKEN           → ext: SAVE_EXTENSION_AUTH_TOKEN で background が保存
site → EXTENSION_UNLINKED                 → ext: UNLINK_EXTENSION でトークン破棄
```

境界:

- `extension_link.js` は `TRUSTED_ORIGINS`（`SITE_ORIGIN` と `127.0.0.1` 版のみ）を検証します。manifest を絞っていても多層防御として残します。
- 検知フラグ `window.__CLIP_EXTENSION_PRESENT__` は MAIN world の `extension_present.js` が設定します。isolated world で代入してもページからは見えません。
- instanceId の発行元は `background/instanceId.js` の 1 箇所だけです。content 側で `randomUUID()` してはいけません。
- トークンは**不透明トークン（非 JWT）**です。JWT としてデコードしようとしてはいけません。

トークン更新（`tokenRefresh.js`）:

- 6 時間毎の alarm と SW 起動時に `checkAndRefreshToken()`
- 期限まで 15 日未満なら `POST /api/extension/token/refresh`（Bearer・ローテーション）
- 失敗時は `extensionTokenRefreshBackoff` に記録して抑制（基準 15 分、未実装応答なら 6 時間）
- バックオフは現トークンの fingerprint と一致するときだけ有効。再連携で差し替わったら破棄する

### 5. コメント機能

`commentPanel.js` が UI を持ち、通信は background の `comments.js` が行います。

- `GET /api/extension/clips/{clipId}/comments?extensionInstanceId=...&limit=...&cursor=...`
- `POST /api/extension/clips/{clipId}/comments`

応答検証（`isValidCommentsSuccessResponse`）は HTTP 成功だけでは足りず、次を全て要求します。

- `ok === true`
- 各 comment の `id` が正の safe integer
- `clipId` が要求した clipId と一致
- `userId` が正の safe integer **または `null`**（退会ユーザーは `null` で返る契約）
- `username` が文字列または `null`
- `body` が `isValidCommentBody`（code point 500 以下）
- `createdAt` が往復一致する ISO 文字列

**匿名化された 1 件で一覧全体を `invalid_response` にしないこと**が要件です。

### 6. Netflix seek bridge

Netflix の player API は page world にあり、isolated content script から触れません。

1. `common.js#requestSeek({ service: 'Netflix', seconds })`
2. `chrome.runtime.sendMessage({ type: 'seek', sec })`
3. `background.js#handleSeekMessage()` が **`sender.tab` を優先**して対象タブを決める（取れないときだけ active tab へフォールバック）
4. 対象 URL が `https://www.netflix.com/watch/` でなければ `not_netflix_watch` を返して何もしない
5. `chrome.scripting.executeScript({ world: 'MAIN' })` で `window.netflix.appContext.state.playerApp.getAPI()` を辿る
6. player が取れるまで 200ms × 30 回リトライ

Disney+ は `requestSeek` の `adapter` / `videoElement` 経路を使うため background を経由しません。

### 7. 自動遷移マーカー

playlist の cross-URL 継続では、遷移先で「これは手動離脱ではなく自動遷移」と判定する必要があります。

```ts
// sessionStorage['extAutoNavigation']
{ ownerNonce: string; expectedRoute: string; reason: string; createdAt: number }
```

- `markAutoNavigation()` は **owner nonce と正規化済み遷移先ルートに束縛**して書きます。どちらか欠けると `false` を返して書きません。
- `isAutoNavigation()` は nonce・route・TTL（15 秒）の**すべて**が一致した場合だけ true です。
- `consumeAutoNavigation()` は判定後に必ず消します（one-shot）。
- **`localStorage` は使いません。** origin 共有の marker はタブ A の自動遷移でタブ B の手動遷移を誤判定させるため、意図的に `sessionStorage` のみです。

## State Model

### `chrome.storage.local`

| キー | 用途 | 主な writer |
|---|---|---|
| `clip` | 単体再生の対象クリップ | ownership manager |
| `playQueue` | プレイリスト | ownership manager |
| `currentClipOrder` / `currentClipId` | 再生位置 | ownership manager |
| `nextClip` | 次クリップ | ownership manager |
| `playClipSystemKey` / `playlistSystemKey` | モードフラグ（0/1） | ownership manager |
| `playmode` | `'clip'` / `'playlist'` / `null` | ownership manager |
| `playbackOwnerNonce` | 現在の所有者 nonce | ownership manager |
| `extensionInstanceId` | 拡張インスタンス ID（UUID） | `instanceId.js` |
| `extensionAuthToken` | 不透明トークン | `authState.js` |
| `extensionTokenExpiresAt` | 期限（ISO） | `authState.js` / `tokenRefresh.js` |
| `extensionTokenRefreshBackoff` | 更新失敗の抑制記録 | `tokenRefresh.js` |
| `extensionLinked` | 連携済みフラグ | `authState.js` |
| `pendingClips` | 未同期クリップ | `sync.js` |
| `lastSyncAt` | 最終同期時刻 | `sync.js` |
| `extensionLoginPromptLastOpenedAt` | ログインタブ連打防止（60 秒） | `sync.js` |
| `lastSeenWelcomeVersion` / `lastSeenWhatsNewVersion` / `lastShownAt` | install/update デモ表示制御 | `background.js` |

**再生系 9 キーは ownership manager 以外が書いてはいけません。** 直接 `storage.local.set()` すると所有権チェックを迂回します。

### `chrome.storage.session`

| キー | 内容 |
|---|---|
| `activePlaybackTabsV1` | `{ active: {tabId: entry}, pending: {nonce: handoff}, revision: number }` |

### `sessionStorage`（タブ固有）

| キー | 内容 |
|---|---|
| `dextPlaybackContextV1` | `{ initialized, context: { mode, clipId } \| null }` |
| `dextPlaybackOwnerTab` | このタブの owner nonce |
| `extAutoNavigation` | 自動遷移マーカー（TTL 15 秒） |

### URL query parameter

- `dextPlaybackOwner` — 遷移先へ owner nonce を運ぶ

## Message Contracts

### `chrome.runtime.sendMessage` → background

| type | 送信元 | 効果 |
|---|---|---|
| `seek` | `common.js#requestSeek()` | Netflix player を MAIN world で seek |
| `ENQUEUE_PENDING_CLIP` | `extensionSync.js` | `pendingClips` へ追加 |
| `SYNC_PENDING_CLIPS` | `extensionSync.js` | `POST /api/extension/sync` |
| `FETCH_CLIP_COMMENTS` | `commentPanel.js` | コメント取得 |
| `POST_CLIP_COMMENT` | `commentPanel.js` | コメント投稿 |
| `SAVE_EXTENSION_AUTH_TOKEN` | `extensionSync.js` | トークン保存 |
| `UNLINK_EXTENSION` | `extensionSync.js` | 連携解除 |
| `OPEN_LOGIN_TAB` | `sync.js` 経由 | ログインタブを開く |
| `GET_OR_CREATE_INSTANCE_ID` | `extensionSync.js` | instanceId 取得 |
| `BEGIN_PLAYBACK_HANDOFF` | `playbackOwnership.js`(content) | 再生ハンドオフ登録 |
| `CLAIM_PLAYBACK_OWNERSHIP` | 同上 | 所有権取得 |
| `UPDATE_PLAYBACK_OWNERSHIP` | 同上 | 所有権下での状態更新 |
| `PREPARE_PLAYBACK_NAVIGATION` | 同上 | 遷移先ルートの事前登録 |
| `RELEASE_PLAYBACK_OWNERSHIP` | 同上 | 所有権解放 |

port `extensionInstanceId`（`chrome.runtime.connect`）でも instanceId を返します。

### `window.postMessage`（サイト ⇄ 拡張）

| 方向 | type | 受け手 |
|---|---|---|
| site → ext | `GET_EXTENSION_INSTANCE_ID` | `extension_link.js` |
| site → ext | `EXTENSION_CHECK_AUTH` / `EXTENSION_AUTH_STATUS_REQUEST` | `extension_link.js` |
| site → ext | `EXT_LINK_WITH_AUTH_TOKEN` | `extension_link.js` |
| site → ext | `EXTENSION_UNLINKED` | `extension_link.js` |
| site → ext | `SET_CLIP_DATA` | `getClipData.js` |
| site → ext | `PLAY_PLAYLIST_START` | `getClipData.js` |
| ext → site | `EXTENSION_INSTANCE_ID_RESPONSE` | サイト |
| ext → site | `EXTENSION_AUTH_STATUS` | サイト |
| ext → site | `EXTENSION_PLAYBACK_HANDOFF_RESULT` | サイト |

### CustomEvent

| event | 発火元 | 受け手 |
|---|---|---|
| `clipSelected` | サイト | `getClipData.js`（Cookie + `detail.clipId` から組み立て） |
| `historyChange` | `history_change.js`（MAIN） | Netflix / Disney+ content |
| `ext:playback-context-changed` | `playbackContext.js` | `commentPanel.js` |
| `ext:comment-panel-open-state` | `commentPanel.js` | 各 content |
| `ext:close-comment-panel` | `common.js` | `commentPanel.js` |

`EXTENSION_PLAYBACK_HANDOFF_RESULT` の `reason` は固定 13 値です。詳細と全パラメータは正典 `docs/localhost-playback-bridge-contract-v1.md` を参照してください。**このファイルの記述と契約書が食い違う場合は契約書が正です。**

## API Contracts

`src/api.js` の `API_URL = 'http://localhost:3000/api/'` が基点です。

| メソッド | パス | 呼び出し元 | 認証 |
|---|---|---|---|
| GET | `random10` | `content_netflix.js#fetchDataAndRender()` | なし |
| GET | `fetchClip?id=...` | `content_netflix.js#selectClip()` | なし |
| POST | `extension/sync` | `background/sync.js` | Bearer |
| POST | `extension/token/refresh` | `background/tokenRefresh.js` | Bearer |
| GET | `extension/clips/{clipId}/comments` | `background/comments.js` | instanceId query |
| POST | `extension/clips/{clipId}/comments` | `background/comments.js` | instanceId query |

サイトページ側:

- `/login` — `openLoginTab()`
- `/` — install / update 時のデモタブ（`background.js#handleInstalledDemo()`）

**`POST /api/receive` は現在使われていません。** クリップ保存は `extension/sync` に一本化されています。

拡張 ID をサイトの `CLIP_API_ALLOWED_ORIGINS` に登録しないと、background からの fetch は `Origin: chrome-extension://<ID>` で 403 になります（README.md 参照）。

## Boot Sequences

### Background

1. モジュール読み込み時に `createPlaybackOwnershipManager()` を生成
2. 全リスナーを登録（message / alarms / tabs / connect / installed / startup）
3. SW 起動ごとに `checkAndRefreshToken()` → `syncPendingQueue()` を直列実行（refresh 先行で旧トークンの 401 を避ける）
4. `onInstalled` / `onStartup` で alarm を再作成し、`onStartup` では ownership を `reset()`

### Netflix

1. `dist/content.js` が `document_idle` で読み込まれる
2. `initializeNetflixPlayback()` が 1 回だけ動く
3. `onWindowLoad()` 内で `injectHistoryHook()`（MAIN world へ history hook）と録画 UI の `MutationObserver` を開始
4. URL / sessionStorage から owner nonce を取り、`claimPlaybackOwnership()` を試みる
5. 成功したら返ってきた snapshot で `init()`（clip）または `startPlaylistMode()`（playlist）を選ぶ
6. `historyChange` で `handleOwnedPlaybackRouteChange()` を通し、自動遷移でなければ context を deactivate する

### Disney+

1. `src/util/history_change.js` が `document_start` の MAIN world で hook を張る
2. `dist/content_disney.js` が `document_idle` で読み込まれ、top-level IIFE が走る
3. `UI.bootstrap()` が UI 注入 observer を、`Mode.bootstrap()` が `startPreferredMode()` を設定
4. Netflix と同じく nonce → claim → snapshot の順で再生モードを復元する

### localhost

1. `src/content/extension_present.js` が MAIN world で `__CLIP_EXTENSION_PRESENT__` を立てる
2. `dist/extension_link.js` が認証系 postMessage を待つ
3. `dist/getClipData.js` が `clipSelected` / `SET_CLIP_DATA` / `PLAY_PLAYLIST_START` を待つ
4. どの経路も検証 → `BEGIN_PLAYBACK_HANDOFF` → 結果 postMessage の順で処理する

## Risky / Fragile Areas

### `dist/` が実行物なのに git 管理外

manifest は `dist/*` を読みますが `.gitignore` は `/dist` を無視します。source を直しただけでは反映されません。

### 巨大ファイル 3 本

`commentPanel.js`（1,303 行）、`content_disney.js`（1,134 行）、`content_netflix.js`（1,001 行）は責務が密集しています。小さな変更でも副作用範囲を広く見積もってください。

### DOM selector 依存

- Netflix: `[data-uia="controls-standard"]`、`[data-uia="control-forward10"]`、`[data-uia="control-volume-*"]`、`[data-uia="video-title"]`
- Disney+: overlay root / title bug / progress bar 系（shadow DOM 越しの取得を含む）

サービス側 UI 変更で即座に壊れます。

### 非公開 API 依存

`background.js` の seek は `window.netflix.appContext.state.playerApp.getAPI()` に依存します。Netflix 内部実装なので破壊的変更を検知できません。

### history hook の注入経路が 2 本

Netflix では `inject_script.js`（`document_end`）と `content_netflix.js#injectHistoryHook()` の両方から入ります。`history_change.js` 側に `__extHistoryChangeHooked__` guard があるため二重フックにはなりませんが、**この guard を消してはいけません。**

### Netflix の `setClipDataOnCookies()` に repo 内 reader がいない

`selectClip()` は Netflix origin へ Cookie を書きますが、遷移先の再生は ownership snapshot から復元されるため、この Cookie を読むコードは repo 内にありません。サイト側が読んでいる可能性があるので、確認せずに削除しないでください。

### service enum の drift

`detectService()` は `Netflix` / `Disney+` / `Prime Video` / `YouTube` / `Hulu` / `Unknown` を返します。一方 `services.js#SERVICE_BASE_URL` に Hulu はなく、再生ブリッジ契約 v1 は `netflix` / `disneyplus` しか受け付けません。**対応サービスを増やすときは manifest・再生制御・validator・契約バージョンを同時に更新してください。**

## Editing Guidelines

### 比較的安全

- `src/api.js` の base URL
- `src/css/content_button.css`、Disney+ の `ensureStyle()` 内 CSS
- ボタン label、サイドバー title、console message

### 高リスク

| 領域 | 一緒に確認するファイル |
|---|---|
| 再生所有権 | `shared/playbackBridgeValidation.js`、`background/playbackOwnership.js`、`content/playbackOwnership.js`、`content/playbackContext.js` |
| 入力契約 | 上記 + `content/getClipData.js` + `docs/localhost-playback-bridge-contract-v1.md` |
| 認証 | `background/authState.js`、`authMutex.js`、`instanceId.js`、`content/extension_link.js`、`content/extensionSync.js` |
| 同期 | `background/sync.js`、`request.js`、`shared/storage.js` |
| コメント | `content/commentPanel.js`、`background/comments.js`、`shared/commentText.js` |
| seek | `content/common.js#requestSeek()`、`background/background.js#handleSeekMessage()` |
| 自動遷移 | `content/common.js` の marker 3 関数、両 content の route change 処理 |

### 変更前チェックリスト

1. **入力契約を変える前** — `docs/localhost-playback-bridge-contract-v1.md` を先に読む。validator を緩めて実データに合わせるのではなく、サイト側を直すか契約バージョンを上げる
2. **storage キーを変える前** — 再生系 9 キーは ownership manager 経由でのみ書かれる前提を壊さない
3. **メッセージ型を変える前** — サイト側（`C:\dev\react--site`）の producer / consumer を実ファイルで確認する
4. **source を変えた後** — `npm run build` → `npm run lint` → `npm test` を必ず通す

### 雑に「整理」してはいけないもの

- `playbackContext.js` の `initialized` / `context: null` の 2 状態の区別
- `markAutoNavigation()` の nonce + route 束縛（`localStorage` へ戻さない）
- background 側の再検証（content を信用する形に簡略化しない）
- `acceptedItemIds` の厳密検証
- コメント応答の `userId: null` 許容
- `history_change.js` の idempotency guard
- `extension_link.js` の `TRUSTED_ORIGINS`

## テスト

`test/` に 15 ファイル・143 tests があります。`node --test` で全件実行されます。

| ファイル | 対象 |
|---|---|
| `playbackBridgeValidation.test.js` | 入力検証器 |
| `playbackOwnership.test.js` | background 所有権マネージャ |
| `playbackOwnershipClient.test.js` | content 所有権クライアント |
| `playbackContext.test.js` | タブ固有 context |
| `getClipData.test.js` | localhost 再生ブリッジ 3 経路 |
| `comments.test.js` / `commentPanel.test.js` | コメント通信と UI |
| `backgroundAuth.test.js` / `backgroundRequest.test.js` / `backgroundDetachedTasks.test.js` | 認証直列化・timeout・detached task |
| `manifest.test.mjs` | MAIN world hook の順序、Netflix の isolated hook 重複防止、bundle 参照、権限境界 |
| `content/common.test.mjs` | メモサイドバーのライフサイクル（再オープン・supersede・teardown） |
| `content/integrationHelpers.test.mjs` | 自動遷移マーカーのタブ間分離、video 待機のキャンセル、選択クリップの原子的 commit |
| `historyChange.test.mjs` / `icons.test.js` | history hook・アイコン |

新しい不変条件を入れたら、対応するテストも足してください。

## 推奨読解順

1. `manifest.json` と `webpack.config.js` — 何が実際に動くかを確定する
2. `docs/localhost-playback-bridge-contract-v1.md` — 外部入力の契約
3. `src/shared/playbackBridgeValidation.js` — その実装
4. `src/background/playbackOwnership.js` と `src/content/playbackOwnership.js` — 所有権モデル
5. `src/content/playbackContext.js` — タブ固有 context
6. `src/background/background.js` — 全体の配線
7. `src/content/getClipData.js` と `src/content/extension_link.js` — サイトとの 2 つの境界
8. `src/content/common.js` — 共有 UI とヘルパ
9. `src/content/content_netflix.js` / `content_disney.js` — サービス実装
10. `src/content/commentPanel.js` と `src/background/comments.js` — コメント機能
11. `src/background/sync.js` / `tokenRefresh.js` / `authState.js` — 同期と認証

## Quick Mental Model

1. 再生状態の正本は **background の ownership registry**。`chrome.storage.local` はその投影にすぎない
2. どのタブが再生中かは **owner nonce**（URL query → sessionStorage）で決まる
3. コメントの投稿先は **タブ固有 playback context** で決まり、global state からは決まらない
4. サイトからの入力はすべて信頼しない。content と background が**同じ検証器**で二重に弾く
5. サイト API への fetch は**必ず background**。content から直接叩くと CORS で落ちる
6. Netflix の player 直操作は background の MAIN world bridge でしかできない
7. 自動遷移マーカーは nonce + route に束縛された one-shot で、タブをまたがない
