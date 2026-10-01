# Design Doc — Movie Clipper（仮称）

ステータス: たたき台 v0.4 / 作成日: 2026-09-11 / 更新日: 2026-10-01 / 設計オーナー: 未定 / 対応する PRD: v1.1

## 1. 目的、参照する実装、記法

### 1.1 目的

[PRD](prd.md) v1.1 の要件を、拡張 `FigFingers/movieClipExtension` とサイト `FigFingers/react--site` の間で成立させる設計を記す。本書は次の3つを扱う。

1. 現行実装の構成と、両リポジトリ間の契約（メッセージ・API・保存データ）
2. PRD に適合させるための目標設計（【提案】）
3. 現行実装と要件の差分（§16）、統合順序と検証方法

動画ファイルは保存しない。対象動画サイトは Netflix と Disney+。

### 1.2 参照する実装とタグ

| タグ | 指すもの | 基準コミット | 状態 |
| --- | --- | --- | --- |
| 【develop】 | 拡張 `develop` | `1e64271` | マージ済み |
| 【#136】 | 拡張 PR #136 `123-fix/comment-playback-hardening` | `7ea5a6c` | 未マージ。サイト #62 の後に統合する |
| 【サイトdevelop】 | サイト `develop` | `7d8de67` | マージ済み |
| 【サイト#62】 | サイト PR #62 `feat/clip-comments-site-ui-squashed` | `a61dde1` | 未マージ |
| 【サイト#77】 | サイト PR #77 `fix/76-public-user-fields` | `f98f3a0` | 未マージ。付け直し前の #62 の上に積まれている |
| 【提案】 | 本書の設計提案 | — | 未実装 |

- タグの無い記述は、設計上の決定または両実装に共通する事実。「現行」は【develop】と【サイトdevelop】、「変更案」は未マージの PR を指す。
- 本書を含む PR #139 のブランチは古い `master`（`0254fc3`）から分岐しているため、本書が参照する `src/`・`test/` はそのブランチに無い。参照は上表の基準コミットで行う。
- 行番号はタグの基準コミットで確認した。#62 は 2026-09-20 にサイト develop `7d8de67` の上へ付け直され、旧 head `fa6709a` とは `src/` と `prisma/schema.prisma` が同一。
- サイトのローカル clone は `develop` だけを追跡する設定（`remote.origin.fetch`）のため、PR ブランチの head は `git ls-remote origin refs/heads/<branch>` または `gh pr view <n> --json headRefOid` で確認する。追跡ブランチが古いと `git branch -r --contains` は誤った結果を返す。

### 1.3 識別子と単位

| 名前 | 発行元・保存先 | 形式 | 用途 |
| --- | --- | --- | --- |
| `clientItemId` | 拡張が記録ごとに発行。`pendingClips` | UUID | 再送時の重複防止（サイト `sync_receipts`） |
| `clipId` | サイト `clips.id` | 正の安全な整数 | 一覧・再生・コメントの参照先 |
| `extensionInstanceId` | 拡張がインストールごとに発行。`chrome.storage.local` | UUID | 連携と API 認証の対象 |
| `linkedExtensionId` | サイト `linked_extensions.id` | 整数 | サイトでの解除操作の対象 |
| `extensionAuthToken` | サイトが発行。拡張の `chrome.storage.local` | 不透明な文字列（32 バイトの base64url） | Bearer 認証。サイトは SHA-256 ハッシュだけを保存する |
| `linkToken` | サイトが発行 | 不透明、10 分有効・1 回限り | 連携時の受け渡し |
| `playbackOwnerNonce` | 拡張の content が発行（【#136】） | UUID | 再生の引き継ぎと所有権の照合 |
| `requestId` | サイト（任意） | 1〜128 文字 | 引き継ぎ結果の対応付け |
| `clientRequestId` | 投稿側（【サイト#62】） | UUID | コメント投稿の冪等キー |

時間の単位は、拡張の内部とサイトへの送信が秒（小数可）、サイト DB が整数ミリ秒（`startMs`・`endMs`、`Math.round(秒 × 1000)`）。サイトから拡張への再生入力は秒（`startMs / 1000`）。

端末への記録完了、同期待ち、同期済みは別の状態とし、サイトの受理を確認する前に「同期済み」と表示しない（PRD §8）。

## 2. 全体構成

### 2.1 実行環境とモジュール

| 実行環境 | 主なファイル（ビルド後） | 役割 | 【develop】と【#136】の違い |
| --- | --- | --- | --- |
| Background（Service Worker） | `src/background/background.js`（`dist/background.js`） | サイト API との通信、認証状態、未同期キュー、再生所有権、Netflix の seek | 【#136】で `authMutex.js`・`authState.js`・`instanceId.js`・`request.js`・`clips.js`・`playbackOwnership.js`・`detachedTasks.js` を追加 |
| Netflix の content script | `src/content/content_netflix.js`（`dist/content.js`） | 録画ボタン、保存パネル、記録一覧、区間再生、コメントパネル | 【#136】で `playbackContext.js`・`playbackOwnership.js`・`clipList.js`・`netflixClipSelection.js` を使う |
| Netflix の MAIN world | `src/util/history_change.js`、`src/inject/inject_script.js`、Background の `chrome.scripting.executeScript` | SPA 内の遷移の通知（`historyChange`）、プレイヤー内部 API での seek | 【develop】は `history_change.js` を isolated world にも読み込む（ページの `history` を差し替えられず効果がない）。【#136】は MAIN world・`document_start` で注入する |
| Disney+ の content script | `src/content/content_disney.js`（`dist/content_disney.js`） | オーバーレイのボタン（録画・ループ・コメント）、区間再生 | 【#136】で Disney+ にも MAIN world の history hook を追加 |
| サイト上の content script | `src/content/extension_link.js`（`dist/extension_link.js`）、`src/content/getClipData.js` | 連携の橋渡し、再生の引き継ぎ | 【develop】は `getClipData.js` を直接読み込む。【#136】は webpack の bundle（`dist/getClipData.js`） |
| サイト上の MAIN world | `src/content/extension_present.js` | `window.__CLIP_EXTENSION_PRESENT__` を公開 | 同じ |
| サイト（Next.js） | `src/lib/extension/client.ts`、`src/lib/clips/playback.ts`、`PlaylistView.tsx`、`/account`、`/my_video` | 連携操作、再生の引き継ぎの送信、ライブラリ | 【サイト#62】で `ExtensionPlaybackHandoffStatus.tsx`・`handoffRequest.ts` を追加 |
| サイト API | `src/app/api/extension/*`、`src/app/api/v1/*` | 認証、同期、一覧、コメント | 【サイト#62】でコメント API、【サイト#77】で同期の競合修正と並び順 |
| DB | `prisma/schema.prisma`（PostgreSQL） | クリップ、連携、受理記録、プレイリスト、コメント | 【サイト#62】で `clip_comments` など、【サイト#77】で `clips_playlists.position` |

### 2.2 構成図

~~~mermaid
flowchart LR
  subgraph Browser["Chrome"]
    subgraph VOD["Netflix / Disney+ のタブ"]
      CS["content_netflix.js / content_disney.js"]
      MW["MAIN world: history_change.js と seek"]
    end
    subgraph Site["サイトのタブ"]
      Page["サイトのページ JS"]
      Bridge["extension_link.js / getClipData.js"]
    end
    BG["Background (Service Worker)"]
    LS[("chrome.storage.local")]
    SS[("chrome.storage.session")]
  end
  API["サイト API: /api/extension と /api/v1"]
  DB[("PostgreSQL")]

  MW -- "historyChange イベント" --> CS
  CS -- "chrome.runtime メッセージ" --> BG
  Page -- "postMessage と clipSelected" --> Bridge
  Bridge -- "chrome.runtime メッセージ" --> BG
  BG -- "fetch (Bearer)" --> API
  Page -- "fetch (セッション Cookie)" --> API
  API --> DB
  BG --- LS
  BG --- SS
  BG -- "executeScript (Netflix の seek)" --> MW
~~~

ネットワークは Background から使う。content script の `fetch` はページのオリジンの CORS に従いサイト API に拒否される。例外は【develop】の Netflix の記録一覧で、content から削除済みの API を直接呼んでいる（G-08）。

### 2.3 権限と読み込み対象

- `permissions`: `activeTab`、`storage`、`tabs`、`scripting`、`alarms`。`unlimitedStorage` は無く、`chrome.storage.local` の上限は既定の 10 MB。
- `host_permissions`: `http://localhost:3000/*`、`http://127.0.0.1:3000/*`、`https://www.netflix.com/*`、`https://www.disneyplus.com/*`。
- 拡張のポップアップ（`action`）やオプションページは無い。利用者が拡張の状態を見られる画面は、現状ではサイトの `/account` だけ。
- webpack の entry は【develop】が 4 件（`content`・`content_disney`・`extension_link`・`background`）、【#136】が 5 件（`getClipData` を追加）。
- 接続先は `src/api.js` の `http://localhost:3000/api/` に固定。インストール時の案内ページも `background.js` の `DEMO_BASE_URL`（`http://localhost:3000/`）に固定。本番 URL と許可 Origin への置き換えは未実装（G-14）。
- 拡張の名称は `Netflix Movie Clipper`、説明は `Movie clipping 001` で、アイコンは未設定（PRD §13 で確定する）。

## 3. データモデル

### 3.1 拡張が保存するデータ

| キー | 保存場所 | 書く | 読む | 寿命・備考 |
| --- | --- | --- | --- | --- |
| `extensionInstanceId` | `chrome.storage.local` | Background（`getOrCreateInstanceId`） | 全体 | インストール中は不変。【#136】は UUID 形式を検証し、壊れていれば認証状態を消して再発行する |
| `extensionAuthToken`、`extensionTokenExpiresAt`、`extensionLinked` | 同上 | 【develop】サイト上の content、【#136】Background（`authState.js`） | Background、サイト上の content | 解除と 401 で削除。【#136】はトークンを 1〜4096 文字の印字可能な ASCII に限る |
| `extensionTokenRefreshBackoff` | 同上 | `tokenRefresh.js` | 同左 | `{tokenFingerprint, failureCount, nextAttemptAt, lastStatus}`。トークンの SHA-256 の先頭 8 バイトで紐付ける |
| `pendingClips` | 同上 | 【develop】content（追加）と Background（削除）、【#136】Background だけ | Background、サイト上の content | 未同期の記録の配列。アプリ独自の上限は無い。自動で消えるのは受理時と、【develop】の 400 時（G-03） |
| `lastSyncAt` | 同上 | `sync.js` | サイト上の content が読むが応答には含めない | 最後に 200 を受けた日時 |
| `extensionLoginPromptLastOpenedAt` | 同上 | `sync.js` | 同左 | ログインタブを自動で開いた日時（60 秒の間隔制限） |
| `lastSeenWelcomeVersion`、`lastSeenWhatsNewVersion`、`lastShownAt` | 同上 | `background.js` | 同左 | インストール・更新時の案内ページ |
| 再生互換キー `clip`、`playQueue`、`nextClip`、`currentClipOrder`、`currentClipId`、`playClipSystemKey`、`playlistSystemKey`、`playmode` | 同上 | 【develop】content と `getClipData.js`。【#136】Background の所有権マネージャーだけ | 【develop】全タブの content とコメントパネル。【#136】互換のための写しで、判断には使わない | 【develop】では全タブ共通の唯一の再生状態（FR-07 を満たせない） |
| `playbackOwnerNonce` | 同上 | 【#136】Background | — | 写しの所有者。所有者と保留中の引き継ぎが無くなると、上記の互換キーと一緒に消える |
| `activePlaybackTabsV1` | `chrome.storage.session` | 【#136】Background | Background | タブ別の再生所有権（§9.2）。ブラウザの終了で消え、`runtime.onStartup` でも初期化する |
| `dextPlaybackContextV1` | 視聴タブの `sessionStorage` | 【#136】content | コメントパネル | `{initialized, context: {mode, clipId}}`。そのタブの再生対象 |
| `dextPlaybackOwnerTab` | 同上 | 【#136】content | content | タブが持つ nonce。再読み込み後の再取得に使う |
| `extAutoNavigation` | 【develop】視聴タブの `sessionStorage` と `localStorage`、【#136】`sessionStorage` だけ | content | content | 自動遷移の目印。【#136】は `{ownerNonce, expectedRoute, reason, createdAt}` の JSON で、15 秒だけ有効 |
| `playQueue` | サイトの `localStorage` | サイト（`PlaylistView.tsx`） | `getClipData.js` | プレイリストの受け渡し |
| Cookie `name`・`title`・`username`・`starttime`・`endtime`・`url`（【サイト#62】で `service`・`clipId` を追加） | サイトのオリジン | サイト（`playback.ts`） | `getClipData.js` | 1 時間有効。単体再生の受け渡し |
| Cookie `title`・`user`・`startTime`・`endTime`・`url`・`service`・`clipId`・`username` | `www.netflix.com` | Netflix の記録一覧から再生するとき（`setClipDataOnCookies`） | なし | 読み手が無く、Netflix へのリクエストに毎回付く（G-26） |

### 3.2 未同期の記録と送信形式

拡張内の記録（`toExtensionClipPayload` の出力、`pendingClips` の要素）:

~~~js
{
  clientItemId: "UUID",          // 保存の再試行でも同じ値を保つ（G-13）
  title: "作品名",               // 取得できないと null
  url: "https://www.netflix.com/watch/81234567",
  startTime: 754.2,              // 秒
  endTime: 768.9,                // 秒
  service: "Netflix",            // または "Disney+"
  clipName: "作品名｜エピソード名", // 空なら null
  epnumber: "第3話",             // 無ければ null
  createdAt: "2026-10-01T03:21:00.000Z"
}
~~~

`POST /api/extension/sync` の本文（`toExtensionSyncItem`）と、サイト側の検証（`legacyClipCreateBodySchema`）・変換（`buildLegacyClipCreateData`）の対応:

| 拡張の値 | 送信キー | サイトの検証・変換 | 拡張側の現状 | 不一致の影響 |
| --- | --- | --- | --- | --- |
| `title` | `payload.title` | 必須、trim 後 1 文字以上 | 取得できないと `null` を送る（【#136】`extensionSync.js:123`、`sync.js:76`） | 一括全体が 400 |
| `clipName` | `payload.clipName`（空なら省略） | 任意、trim 後 1〜255 文字。省略時の名前は「切り抜き」 | 長さを検証しない | 256 文字以上で一括全体が 400 |
| `startTime` | `payload.StartTime` | 有限、0 以上。`Math.round(秒×1000)` で `startMs` | 有限数だけ確認する | — |
| `endTime` | `payload.EndTime` | 有限、0 以上、`StartTime` より大きい | Netflix は 1 秒以上を確認、Disney+ は確認しない | Disney+ で同じ秒に 2 回押すと一括全体が 400 |
| `url` | `payload.URL` | 必須、trim 後 1 文字以上 | Netflix は `pathname` を絶対 URL にする。Disney+ は `location.href` | — |
| `service` | `payload.service` | 必須。`vods` の code・name・alias に一致すること | `Netflix`、`Disney+` | 未登録の名前は 404 で一括全体が失敗 |
| `epnumber` | `payload.epnumber`（空なら省略） | 任意、1 文字以上 | — | — |
| `createdAt` | `createdAt` | ISO 8601（オフセット可） | `toISOString()` | — |
| — | 未知のキー | `.strict()` で 400 | 既知のキーだけを送る | — |

`items` の件数に上限は無く、拡張は未同期の記録をすべて 1 回の要求で送る（G-22）。

### 3.3 サイトのデータ

| テーブル | 主な列・制約 | 用途 |
| --- | --- | --- |
| `users` | `email`、`hashed_password`、`deleted_at`（論理削除） | 利用者 |
| `vods`、`vod_aliases` | `code`、`name`、`alias`（citext、一意） | サービス名の解決 |
| `clips` | `user_id`、`vod_id`、`name` varchar(255)、`title`、`start_ms`・`end_ms`（int）、`url`、`epnum`、`deleted_at` | 同期済みのクリップ |
| `sync_receipts` | `(linked_extension_id, client_item_id)` が一意 | 再送による二重作成の防止 |
| `linked_extensions` | `extension_instance_id`（uuid、`revoked_at IS NULL` の行の中で一意）、`extension_auth_hash`、`expires_at`（既定 90 日）、`revoked_at`、`last_seen_at` | 連携と拡張用トークン |
| `extension_link_tokens` | `token_hash`（一意）、`expires_at`、`used_at` | 連携の単回トークン |
| `playlists`、`clips_playlists` | 【サイトdevelop】は並び順の列が無い。【サイト#77】で `position integer NOT NULL DEFAULT 0` を追加 | プレイリスト |
| `clip_comments`【サイト#62】 | `body` varchar(500)、`client_request_id`（`(user_id, client_request_id)` が一意）、`at_ms`、`deleted_at` | コメント |
| `clip_comment_reports`【サイト#62】 | `(comment_id, reporter_id)` が一意、`reason`、`resolution` | 通報 |

`clientItemId` と `clipId` は別物。`POST /api/extension/sync` は `acceptedItemIds` だけを返し、両 ID の対応表は返さない。コメントに必要な `clipId` は、一覧などサイトが発行した値から得る。対応表を同期の応答に含めるのは将来の契約変更の候補であり、現行の仕様ではない。

## 4. メッセージ契約

### 4.1 サイトのページと拡張（`window.postMessage`・`CustomEvent`）

受信側は `event.source === window` とオリジン（`extension_link.js` は `SITE_ORIGIN` とその `127.0.0.1` 版、`getClipData.js` は `window.location.origin`）を確認する。`window.postMessage` は同じページの他のスクリプトからも送受信できるため、認証済みの経路とは見なさない。

| 型 | 向き | 主なフィールド | 拡張の処理 |
| --- | --- | --- | --- |
| `GET_EXTENSION_INSTANCE_ID` → `EXTENSION_INSTANCE_ID_RESPONSE` | ページ→拡張→ページ | `requestId`。応答は `ok` と `extensionInstanceId`、または `message` | `extension_link.js` が port `extensionInstanceId` で Background から取得する。サイトは 3 秒で打ち切る |
| `EXTENSION_AUTH_STATUS_REQUEST`（互換: `EXTENSION_CHECK_AUTH`）→ `EXTENSION_AUTH_STATUS` | 同上 | 応答は `requestId`、`loggedIn`（互換）、`linked`、`extensionInstanceId` | `handleExtensionAuthStatusRequest`。未同期の件数は返さない（G-07） |
| `EXT_LINK_WITH_AUTH_TOKEN` | ページ→拡張 | `extensionInstanceId`、`extensionAuthToken`、`token`（互換）、`expiresAt` | instanceId が一致すれば保存して同期を起動する。【develop】は content が直接保存、【#136】は `SAVE_EXTENSION_AUTH_TOKEN` で Background が検証・保存する。応答は返さない |
| `EXTENSION_UNLINKED` | ページ→拡張 | `extensionInstanceId` | 一致すれば認証状態を消す（【#136】は `UNLINK_EXTENSION`） |
| `clipSelected`（`CustomEvent`） | ページ→拡張 | `detail`: `name`・`username`・`starttime`・`endtime`、【サイト#62】で `requestId`・`clipId`。値の本体は Cookie | 【develop】Cookie を `clip` に写し、全体の再生状態を書く。【#136】§9.3 の検証と引き継ぎ |
| `SET_CLIP_DATA` | ページ→拡張 | `payload.clip`、`requestId` | 【develop】検証せず `chrome.storage.local` へ書く。【#136】検証して引き継ぐ。サイトは送っていない |
| `PLAY_PLAYLIST_START` | ページ→拡張 | `requestId`（【サイト#62】）。値の本体はサイトの `localStorage.playQueue` | 【develop】`order` を補い全体の再生状態を書いて遷移する。【#136】検証→引き継ぎ→nonce 付き URL へ遷移 |
| `EXTENSION_PLAYBACK_HANDOFF_RESULT` | 拡張→ページ | `source`、`ok`、`reason`、`field`、`index`、`requestId` | 【#136】で追加。【サイト#62】の `ExtensionPlaybackHandoffStatus.tsx` が固定の文言で表示する |

引き継ぎの入力契約の正典は `docs/localhost-playback-bridge-contract-v1.md`（v1、2026-08-24）。このファイルは `134-fix-clip-list-api` などのブランチにだけ存在し、【develop】と【#136】には無い。【#136】の `test/README.md` はこのファイルにリンクしている（§17.4）。

### 4.2 content script から Background（`chrome.runtime`）

| 型 | 送信元 | 処理 | 備考 |
| --- | --- | --- | --- |
| `GET_OR_CREATE_INSTANCE_ID`（port `extensionInstanceId` も同じ） | サイト上の content | instanceId の取得・生成を直列化する | 【#136】は壊れた ID を修復する |
| `ENQUEUE_PENDING_CLIP` | 視聴タブの content | 未同期キューへ追加する | 【#136】で追加。キュー専用の直列化を通す |
| `SYNC_PENDING_CLIPS` | 視聴タブ・サイト上の content | 同期を起動して結果を返す | `options.openLoginIfMissingToken` |
| `SAVE_EXTENSION_AUTH_TOKEN`、`UNLINK_EXTENSION` | サイト上の content | 認証状態の保存・消去 | 【#136】で追加。認証の排他を通す |
| `FETCH_CLIP_LIST` | Netflix の content | 記録一覧の取得 | 【#136】で追加。認証しない（G-01） |
| `FETCH_CLIP_COMMENTS`、`POST_CLIP_COMMENT` | 視聴タブの content | コメント API | 認証の排他を通す |
| `OPEN_LOGIN_TAB` | コメントパネル | `/login` を開く | 【develop】は間隔制限を無視、【#136】は間隔制限あり |
| `seek` | Netflix の content | MAIN world で Netflix のプレイヤーを seek する | 送信元タブが `netflix.com/watch/` のときだけ |
| `BEGIN_PLAYBACK_HANDOFF`、`CLAIM_PLAYBACK_OWNERSHIP`、`UPDATE_PLAYBACK_OWNERSHIP`、`PREPARE_PLAYBACK_NAVIGATION`、`RELEASE_PLAYBACK_OWNERSHIP` | content | 再生所有権の操作（§9.2） | 【#136】で追加。タブ ID は `sender.tab.id` を使い、ページの申告を使わない |

### 4.3 ページ内のイベント

| イベント | 発生元 | 用途 |
| --- | --- | --- |
| `historyChange` | MAIN world の `history_change.js`（`pushState`・`replaceState`・`popstate`） | content が SPA 内の遷移を検知し、録画状態の解除と再生所有権の解放を判断する |
| `ext:playback-context-changed` | 【#136】`playbackContext.js` | コメントパネルが投稿先を更新する |
| `ext:close-comment-panel`、`ext:comment-panel-open-state` | `common.js`、`commentPanel.js` | 保存パネルとコメントパネルの排他、ボタン表示の同期 |

## 5. 連携と認証（FR-04、NFR-02）

### 5.1 連携の流れ（現行）

連携の交換（`/api/extension/link`）を呼ぶのは拡張ではなく、サイトのページ JS である。拡張はページから受け取ったトークンを保存するだけ。

~~~mermaid
sequenceDiagram
  actor U as 利用者
  participant P as サイトのページ /account
  participant B as extension_link.js
  participant BG as Background
  participant API as サイト API
  U->>P: 「拡張機能を連携する」
  P->>B: GET_EXTENSION_INSTANCE_ID（postMessage）
  B->>BG: port extensionInstanceId
  BG-->>B: extensionInstanceId
  B-->>P: EXTENSION_INSTANCE_ID_RESPONSE
  P->>API: POST /api/extension/link-token（セッション Cookie）
  API-->>P: linkToken と expiresAt（10分）
  P->>API: POST /api/extension/link（extensionInstanceId と linkToken）
  API-->>P: extensionAuthToken と expiresAt（90日）
  P->>B: EXT_LINK_WITH_AUTH_TOKEN（postMessage）
  B->>BG: SAVE_EXTENSION_AUTH_TOKEN（PR136）
  BG->>BG: instanceId を照合して保存
  B->>BG: SYNC_PENDING_CLIPS
~~~

- サイトの実装: `src/lib/extension/client.ts`（【サイトdevelop】`linkExtensionToCurrentUser`、【サイト#62】`linkExtensionToCurrentUserFromUserAction`）、`src/components/ExtensionLinkButton.tsx`、`src/app/(site_data)/(protected)/account/page.tsx`。
- 【サイトdevelop】には画面の表示時に自動で連携する `ExtensionLinker.tsx` があるが、どこからも使われていない。【サイト#62】で削除し、連携をボタン操作に限った（解除した連携が画面の表示で黙って復活するのを防ぐため）。
- 解除: `ExtensionUnlinkButton.tsx` が `POST /api/extension/unlink {linkedExtensionId}` の後に `EXTENSION_UNLINKED` を送る。通知を取り逃しても、次の API 要求が 401 になり、拡張は認証状態を消す。

### 5.2 トークンのライフサイクル

| 項目 | 値・規則 | 実装 |
| --- | --- | --- |
| 連携トークン | 10 分有効、1 回限り（`used_at` を条件付きで更新） | サイト `extensions.ts#consumeLinkTokenAndLinkExtension` |
| 拡張用トークン | 90 日有効。サイトは SHA-256 だけを保存し、`timingSafeEqual` で照合する | 同 `authenticateLinkedExtension` |
| 更新の時期 | 期限まで 15 日以内、または期限が保存されていないとき | 拡張 `tokenRefresh.js`（`RENEWAL_THRESHOLD_MS`） |
| 更新の契機 | 6 時間ごとのアラームと Service Worker の起動時 | `background.js`（`TOKEN_REFRESH_PERIOD_MINUTES`） |
| 更新に失敗したとき | 15 分 × 2^(n−1)、上限 24 時間。404 は 6 時間以上。失敗はトークンごとに記録する | `tokenRefresh.js` |
| 更新の競合 | 旧ハッシュが一致するときだけ置き換える。負けた側は 401 | サイト `rotateExtensionAuthToken` |
| 古い 401 | 要求に使ったトークンが現在のトークンと違えば消さない | 【#136】`sync.js`、`tokenRefresh.js`、`comments.js` |
| 更新応答の検証 | `ok: true`、正しい形式のトークン、未来の `expiresAt` | 【#136】`normalizeRefreshSuccess` |
| 退会した利用者 | 認証、連携トークンの発行、同期を拒否する | 【サイト#77】（サイト Issue #81） |

### 5.3 認証に関わる API

| API | 認証 | 入力 | 成功時 | 主な失敗 |
| --- | --- | --- | --- | --- |
| `POST /api/extension/link-token` | Origin、セッション | なし | `{linkToken, expiresAt}` | 401 未ログイン、403 Origin |
| `POST /api/extension/link` | Origin | `{extensionInstanceId, linkToken}` | `{ok, extensionAuthToken, expiresAt}` | 401 不明なトークン、409 使用済み、400 期限切れ（`LINK_TOKEN_EXPIRED`）・入力不正 |
| `POST /api/extension/token/refresh` | Origin、Bearer | `{extensionInstanceId}` | `{ok, extensionAuthToken, expiresAt}` | 401 不一致・失効・期限切れ・競合負け |
| `POST /api/extension/unlink` | Origin、セッション | `{linkedExtensionId}` | `{ok, extensionInstanceId}` | 404 対象なし、401 未ログイン |
| `GET /api/extension/session` | Origin、セッション | — | `{loggedIn}` | 拡張からは使っていない |

Origin の確認（`src/server/http/cors.ts#isAllowedClipWriteOrigin`）は、`AUTH_URL`・`NEXTAUTH_URL`・`CLIP_API_ALLOWED_ORIGINS` との完全一致か、`<scheme>://*` 形式（開発用の `chrome-extension://*` など）で行う。`Origin` ヘッダーの無い要求は許可する。Origin の許可と利用者の認証は別の検査であり、Bearer またはセッションの確認が必ず要る。

### 5.4 instanceId の生成と修復【#136】

- 生成は Background の 1 経路に集約し、実行中の生成を共有する。port の経路と content の経路が同時に別の UUID を作らない。
- 保存済みの ID が UUID の形式でなければ、認証状態を消してから新しい ID を作る。古いトークンを残すと「連携済み」と誤表示され、401 になるまで失敗し続けるため。
- 認証の排他の中から呼ぶ場合は `getOrCreateInstanceIdWhileExclusive` を使い、排他を取り直さない。

### 5.5 課題と方針

- **連携時にトークンがページ JS を通る（G-12）。** 90 日有効のトークンが `fetch` の応答と `window.postMessage` でサイトのページに露出し、同じページの他のスクリプトからも読める。【提案】ページは `linkToken` と `extensionInstanceId` だけを拡張へ渡し、Background が `/api/extension/link` を呼んで交換する。ページを通るのは 10 分・1 回限りのトークンだけになる。サイトと拡張を同時に変える必要があるため、互換期間は両方の方式を受け付ける。
- **連携先のアカウントが替わる（G-10）。** サイトの連携は `ON CONFLICT (extension_instance_id) WHERE revoked_at IS NULL DO UPDATE SET user_id = …` で、同じ instanceId の連携先を別の利用者に付け替える。このとき、以前の利用者として記録した未同期の記録が、新しい利用者のクリップとして同期される。また解除してから再連携すると `linked_extensions` の行が変わるため、受理記録（`sync_receipts`）の照合範囲が切れ、応答を失った記録が二重に作られうる。【提案】連携の応答に利用者を識別する不透明な値（例: 利用者 ID の HMAC である `accountKey`）を含め、拡張は記録時の値を各記録に保存する。値が変われば該当する記録の送信を止め、利用者に確認する。扱いは PRD §13 で決める。
- **未連携で保存するとログインタブを開く（G-21）。** `sendData` は `openLoginIfMissingToken: true` で同期を呼び、未連携だと Background が `/login` を新しいタブ（前面）で開く。【提案】自動で開かず、通知に「連携する」操作を出す（PRD FR-04-2）。

## 6. 記録と保存（FR-01、FR-02、FR-10）

### 6.1 サービス別の記録方法

| 項目 | Netflix（`content_netflix.js`） | Disney+（`content_disney.js`） |
| --- | --- | --- |
| ボタン | 音量ボタンの横の録画ボタン（ネイティブの `button`） | オーバーレイの「録画」（【develop】は表示名が `Left Button` のまま） |
| 時刻の取得 | `video.currentTime`（秒、小数） | 進行バーの `aria-valuenow`（秒、整数） |
| 区間の検証 | 開始 > 終了と 1 秒未満を拒否し、`alert` で理由を出す（【#136】`:254-262`） | 検証しない（【#136】`:412-455`）。同じ秒に 2 回押すと長さ 0 になる |
| 作品名 | `[data-uia="video-title"]` の `h4`（無ければ要素全体）。【#136】は不可視文字を除く（Issue #122） | `title-bug` の shadowRoot の `.title-field` |
| エピソード | 1 番目の `span`（話数）を `epnumber`、2 番目を名前の一部にする | `.subtitle-field` を `epnumber` にする |
| URL | `location.pathname`（後で絶対 URL にする） | `location.href` |
| `service` | `Netflix` | `Disney+`（サイトの VOD 名に合わせる） |
| 名前の初期値 | 「作品名｜エピソード名」（【#136】`buildClipName`） | 「作品名｜サブタイトル」 |
| 記録中の遷移 | `historyChange` で録画状態を解除する | 解除しない。遷移をまたぐ区間を作れる（G-24） |

### 6.2 保存パネルの処理（現行）

`common.js#openMemoSidebar` がプレイヤーの幅を縮めてパネルを表示し、保存時に `sendData` を呼ぶ。`sendData` は `enqueueClip`（端末への記録）の後、`syncPendingQueue({openLoginIfMissingToken: true})` の結果を待つ。

| 観点 | 【develop】 | 【#136】 |
| --- | --- | --- |
| 端末への記録 | content が `pendingClips` を読んで書く。Background の削除と競合しうる | `ENQUEUE_PENDING_CLIP` で Background がキュー専用の直列化の中で書く |
| 保存の結果 | 成否にかかわらずパネルを閉じる | 端末に記録できればパネルを閉じる。できなければ入力を残して「再試行」 |
| 結果の表示 | なし | 失敗時の文言だけ。同期済み・同期待ちを示さない（G-06） |
| 閉じるまでの時間 | 同期の結果を待つ | 同期の結果を待つ（最大 15 秒と、排他の待ち時間） |
| キー操作 | Enter で保存（IME 変換中とリピートを除く）。パネル内のキーをサイトへ渡さない | Escape でキャンセル、`stopImmediatePropagation`、ダイアログの ARIA 属性 |
| フォーカス | 外れたら入力欄へ戻す（1 秒あたり 30 回まで） | 同じ。閉じたら元の要素へ戻す |
| 二重送信 | `submitting` フラグ | 同じ。ただし再試行のたびに新しい `clientItemId` を発行する（G-13） |

### 6.3 目標設計【提案】

**記録の検証を共通にする。** `src/shared/clipRecordValidation.js`（仮）に、サイトの `legacyClipCreateBodySchema` と PRD を合わせた規則を置き、両サービスの録画処理、保存パネル、同期前の確認（§7.4）で同じ関数を使う。

| 規則 | 理由 |
| --- | --- |
| 開始位置・終了位置が有限数で、開始位置が 0 以上 | サイトの検証 |
| 終了位置 − 開始位置 ≥ 1 秒 | PRD FR-01。サイトは「より大きい」だけを検証する |
| 作品名が trim 後 1 文字以上 | サイトの必須項目。無ければ保存パネルを開かず理由を示す |
| 名前が trim 後 255 文字以内（UTF-16 の長さ） | サイトの Zod の `max(255)` は UTF-16 の長さで数える。DB の varchar(255) より厳しい側に合わせる |
| URL が対象サービスのホストの HTTPS | 再生時の検証（`playbackBridgeValidation.js`）と揃える |
| `service` が `Netflix` または `Disney+` | サイトの VOD 解決で失敗しない値に限る |

**記録 ID をパネルを開いた時点で決める。** パネルを開くときに `clientItemId` を発行し、保存の再試行でも同じ値を使う。`ENQUEUE_PENDING_CLIP` は同じ ID の要素を置き換えるため、前回の書き込みが成功して応答だけが失われた場合も 1 件のままになる。

**保存の結果を 2 段階で示す。** 端末への記録が終わった時点でパネルを閉じ、プレイヤー上の通知（フォーカスを奪わない `aria-live` 領域）で同期の結果を後から更新する。

~~~mermaid
stateDiagram-v2
  state "入力中" as editing
  state "端末へ記録中" as writing
  state "保存できない" as writeFailed
  state "同期中" as syncing
  state "同期済み" as synced
  state "同期待ち" as queued
  state "連携待ち" as needsLink
  state "送信できない" as blocked
  [*] --> editing
  editing --> writing: 保存
  editing --> [*]: キャンセル
  writing --> writeFailed: 書き込み失敗
  writeFailed --> writing: 再試行
  writeFailed --> [*]: キャンセル
  writing --> syncing: 書き込み成功、パネルを閉じて通知へ
  syncing --> synced: acceptedItemIds に含まれる
  syncing --> queued: 通信断、タイムアウト、5xx、不正な応答
  syncing --> needsLink: 未連携または 401
  syncing --> blocked: 項目の拒否
~~~

通知の文言（案）:

| 状態 | 文言 |
| --- | --- |
| 同期中 | 端末に記録しました。サイトへ送信しています… |
| 同期済み | サイトに保存しました。 |
| 同期待ち | 端末に記録しました。通信が回復したら自動で送信します。 |
| 連携待ち | 端末に記録しました。サイトで連携すると送信されます。［連携する］ |
| 送信できない | サイトに保存できない記録があります。［確認する］ |
| 保存できない（パネル内） | 保存できませんでした。入力は保持されています。 |

**Disney+ の記録を Netflix と揃える。** 録画中の表示、区間の検証、遷移時の録画状態の解除を共通の処理にする。Disney+ の時刻は整数秒のため、秒の境界をまたぐ操作で長さ 1 秒の区間になることを受け入れ条件の確認に含める。

## 7. 同期（FR-03、FR-12、NFR-03）

### 7.1 起動の契機と排他

- 起動の契機は、保存の直後、連携トークンの保存後、Service Worker の起動時（トークン更新の後）、15 分ごとのアラーム（`extension-sync-retry`）。
- 実行中の同期があれば新しい要求はそれに合流し、終了後にもう 1 回だけ実行する（`syncInFlight`、`syncRequestedAfterCurrent`）。
- 認証の排他（`runExclusive`。【#136】は `authMutex.js`）は、同期・トークン更新・コメント・トークン保存・解除が通る。古いトークンでの同期中に新しいトークンを書き込む競合を防ぐ。
- 【#136】`pendingClips` の読み書きは専用の直列化（`runPendingQueueMutation`）で行う。同期は通信中も認証の排他を持ち続けるため、新しい記録の追加をそれと切り離す。
- タイムアウトは、【#136】が応答ヘッダーと本文の読み込みを合わせて 15 秒（`request.js`）。【develop】には無く、排他を持ったまま止まりうる。
- Service Worker が停止すると、メモリ上の排他と合流の状態は失われる。キューとトークンは保存データに残り、次の起動時の同期で再開する。

### 7.2 要求と応答

~~~json
POST /api/extension/sync
Authorization: Bearer <extensionAuthToken>

{
  "extensionInstanceId": "UUID",
  "items": [
    {
      "clientItemId": "UUID",
      "type": "clip",
      "createdAt": "2026-10-01T03:21:00.000Z",
      "payload": {
        "service": "Netflix",
        "title": "作品名",
        "StartTime": 754.2,
        "EndTime": 768.9,
        "URL": "https://www.netflix.com/watch/81234567",
        "clipName": "作品名｜エピソード名",
        "epnumber": "第3話"
      }
    }
  ]
}
~~~

成功すると `200 {ok: true, acceptedItemIds: [...]}` を返す（サイト `src/app/api/extension/sync/route.ts:41-44`）。サイトの処理（`src/server/services/extensions.ts#syncExtensionItems`）は次のとおり。

1. Bearer、instanceId、期限、失効を確認する。失敗は 401。
2. トランザクションの前に全項目の VOD を解決する。未登録のサービス名は 404 で全体が失敗する。
3. 1 つのトランザクションで、受理記録の無い項目だけ `sync_receipts` とクリップを作る。どれかが失敗すれば全体を戻す。受理済みの項目も `acceptedItemIds` に含める。
4. 【サイト#62】トランザクションの最後に、トークンがまだ有効で失効していないことを条件に `last_seen_at` を更新する。条件を満たさなければ 401 で全体を戻す（解除・更新と競合したときに書き込まない）。
5. 【サイト#77】受理記録を `ON CONFLICT DO NOTHING` で作り、項目を `clientItemId` の順に並べてロックの順序を揃える（サイト Issue #80: 同時の再送で 500 になる問題の修正）。利用者の行を共有ロックし、退会済みなら 401（Issue #81）。応答の `acceptedItemIds` は要求の全項目。

サイトの実装は「全件受理か全件拒否」で、一部だけの受理は起きない。拡張は防御のため一部の受理も扱う。

### 7.3 応答ごとの扱い

| 観測した結果 | 【develop】 | 【#136】 | 目標【提案】 |
| --- | --- | --- | --- |
| 200、送信した ID だけの `acceptedItemIds` | 受理 ID を削除 | 受理 ID を削除。重複・未知の ID が 1 つでもあれば全件を保持 | 同じ |
| 200、空配列または一部 | 受理 ID だけを削除 | 同じ | 同じ。残りは同期待ち |
| 200、`acceptedItemIds` が無い・不正 | **送信した全件を削除**（`sync.js:181-185`） | 全件を保持し `invalid_response` | 同じ |
| 400（入力の不正） | 項目の ID を探し、見つからなければ**送信した全件を削除**（`:190-202`）。サイトは ID を返さないため、実際には常に全件を削除する | 項目を特定できなければ全件を保持（`:293-303`）。次回も同じ一括を送り、以後の記録も含めて永久に送れない | §7.4 |
| 401 | 認証状態を消し、キューは保持 | 要求に使ったトークンが現在と同じときだけ消す | 同じ。連携待ちを表示 |
| 403（Origin の不許可） | 保持 | 保持 | 保持。設定の問題として理由コードを記録し、利用者の権限不足と区別する |
| 404（VOD が不明） | 保持（`sync_failed`）。同じ一括を送り続ける | 同じ | §7.4（項目の問題として扱う） |
| 通信断、タイムアウト、5xx | 保持 | 保持（タイムアウトは `timeout`） | 保持。アラームで再送 |
| 端末への書き込み失敗 | 例外を記録してパネルを閉じる | 入力を残して再試行 | 同じ |

### 7.4 送れない記録が全体を止める問題と目標設計（G-03）

サイトは一括の中に 1 件でも不正な項目があると全体を 400（または 404）で拒否し、どの項目かを返さない。本番は `details` を返さず、開発時も Zod の `flatten()` のメッセージだけを返す。その結果、

- 【develop】は 400 のたびに送信した全件を削除する。不正な 1 件のために有効な記録まで失われる。
- 【#136】は全件を保持するが、同じ一括を送り続けて毎回 400 になり、その後の記録も含めて一切同期されない。

実際に起こる例: Disney+ で同じ秒に録画ボタンを 2 回押す（長さ 0）、作品名の要素が描画される前に保存する（`title: null`）、256 文字以上の名前を入力する。

目標設計【提案】:

1. **保存前に防ぐ。** §6.3 の共通の検証を通らない記録は端末に記録しない。
2. **同期前に分ける。** 同期のたびに各記録を同じ検証にかけ、通らない記録は状態を「送信できない」（`status: 'blocked'`、`lastError.code`）にして一括から外す。
3. **一括の大きさを制限する。** 1 回の要求は 50 件までとし、残りは続けて送る。
4. **サイトが拒否した項目を特定する。** サイトの 400 応答に項目ごとの結果（`{code: "INVALID_ITEMS", invalidItems: [{clientItemId, field, code}]}`）を本番でも返す【提案・サイト】。サイトが対応するまでは、拡張が一括を半分に分けて送り直し、単独で 400 になる項目を特定する。
5. **404（VOD が不明）も項目の問題として扱う。** サービス名ごとにまとめて送り、404 になったサービスの記録を「送信できない」にする。
6. **送信できない記録を自動で消さない。** 理由とともに残し、利用者が確認して削除する（PRD FR-12）。

`pendingClips` の要素に次の任意項目を足す。既存の要素は項目が無ければ `queued` と見なすため、移行処理は要らない。

| 項目 | 値 | 用途 |
| --- | --- | --- |
| `status` | `queued`（既定）または `blocked` | 送信対象かどうか |
| `lastError` | `{code, at}` | 送信できない理由、最後の失敗 |
| `attempts` | 整数 | 送信回数（`clip_sync_accepted` の属性） |
| `queuedAt` | ISO 8601 | 24 時間を超えた同期待ちの判定と計測 |
| `accountKey` | 文字列 | 記録時の連携先（§5.5。PRD §13 の決定後） |

### 7.5 未同期の記録の状態遷移

~~~mermaid
stateDiagram-v2
  state "queued（同期待ち）" as queued
  state "sending（送信中）" as sending
  state "needs_link（連携待ち）" as needsLink
  state "blocked（送信できない）" as blocked
  [*] --> queued: 端末に記録
  queued --> sending: 同期の開始
  sending --> [*]: 受理されキューから削除
  sending --> queued: 通信断、タイムアウト、5xx、不正な応答、403
  sending --> needsLink: 401 でトークンを消す
  queued --> needsLink: トークンが無い
  needsLink --> queued: 連携の完了
  queued --> blocked: 事前の検証に失敗
  sending --> blocked: 400 または 404 で項目を特定
  blocked --> queued: 修正（P1）
  blocked --> [*]: 利用者が削除
~~~

`needs_link` は保存データには持たず、トークンの有無から求める。

### 7.6 状態を利用者に示す（FR-12）【提案】

- `EXTENSION_AUTH_STATUS` の応答に `queue: {pending, needsLink, blocked, oldestQueuedAt}` と `lastSync: {at, result}` を加える。件数と日時だけを返し、記録の中身は返さない。現行の `getExtensionConnectionState` はすでに `pendingClips` と `lastSyncAt` を読んでいる。
- サイトの `/account` の「Chrome拡張機能」欄に、件数、最後に同期した日時、24 時間を超えた件数を表示する。現行の「最終同期」は `linked_extensions.last_seen_at` を表示している。この値は連携・同期・トークン更新で更新され、【サイト#62】ではコメントの投稿でも更新されるため、記録の同期日時とは一致しない。
- 送信できない記録の内容の確認と削除は、拡張が持つページ（例: `chrome-extension://<id>/queue.html`）で行い、サイトのボタンから `OPEN_QUEUE_PAGE` で開く。記録の中身をサイトのページ JS に渡さず、削除を拡張の画面上の操作に限るため。
- 視聴ページの通知（§6.3）からも同じページを開ける。

## 8. 一覧とライブラリ（FR-06、FR-13、NFR-01）

### 8.1 現行

| 画面 | 取得方法 | 備考 |
| --- | --- | --- |
| サイトの「マイビデオ」（`/my_video`） | `ClipList` が `GET /api/v1/clips?userId=<自分>` を cursor で取得する | 読み込み中・取得失敗・0 件を表示する。自分のクリップ内で作品名を絞り込む機能は無い |
| サイトのホーム（`/`）・検索（`/search`） | `GET /api/v1/clips`、`GET /api/v1/clips?title=` | 全利用者のクリップの公開一覧 |
| 拡張の記録一覧（Netflix） | 【develop】content から `random10`・`fetchClip?id=` を直接呼ぶ | サイトから削除済みの API で、動作しない（Issue #134） |
| 同上 | 【#136】`FETCH_CLIP_LIST` で Background が `GET /api/v1/clips?title=<作品名>&limit=10` を**認証なしで**取得する | 全利用者のクリップと「ユーザー: <名前>」を表示する。行は再生に必要な項目だけに正規化する（`clips.js#normalizeClipListItem`） |
| 同上（Disney+） | なし | 記録一覧のボタンが無い |

`GET /api/v1/clips` は【サイトdevelop】で認証を要求しない（`src/app/api/v1/clips/route.ts:16-31`。`requireUserId` は POST だけ）。`userId` を指定すれば任意の利用者のクリップを取得できる。さらに `include: {vod: true, user: true}`（`src/server/repositories/clips.ts:83`）で、作成者の `users` 行をメールアドレスとパスワードハッシュの列を含む全列で返す（サイト Issue #76）。【サイト#77】で `user` を `{id, name}` に限るが、認証なしの公開一覧であることは変わらない。

### 8.2 目標設計【提案】

PRD の「保存クリップは非公開」（§13）に合わせ、クリップを返すすべての経路を本人に限る（G-01）。

| 経路 | 変更 |
| --- | --- |
| サイトのライブラリ | `GET /api/v1/me/clips?title=&cursor=&limit=` を追加する（セッション必須、本人のクリップだけ）。`/my_video` はこれを使い、作品名・クリップ名での絞り込みを付ける |
| `GET /api/v1/clips` | セッションを必須にし、本人以外の `userId` の指定は拒否する。ホームと検索の公開一覧は、PRD に合わせて本人の範囲に変えるか、提供範囲から外す |
| 拡張の記録一覧 | `GET /api/extension/clips?extensionInstanceId=&title=&limit=` を追加する（Bearer、連携先の利用者のクリップだけ）。`FETCH_CLIP_LIST` はコメントと同じく認証の排他とトークンを使い、401 は連携待ちとして表示する |
| 応答の項目 | `id`、`name`、`title`、`epnum`、`startMs`、`endMs`、`url`、`vod.code`、`createdAt` に限る。利用者の属性は返さない |
| 拡張の一覧の表示 | 自分のクリップだけになるため「ユーザー」の行を外し、クリップ名と区間を表示する |

記録一覧は Disney+ にも用意する（FR-13、P1）。

## 9. 再生の引き継ぎと制御（FR-05、FR-07、FR-08）

### 9.1 【develop】のモデル

- 再生状態は `chrome.storage.local` の全体共通のキー（`clip`、`playQueue`、`currentClipOrder`、`playClipSystemKey`、`playlistSystemKey`、`playmode`）が唯一の正。
- サイトの `clipSelected` を受けると、`getClipData.js` が Cookie を `clip` に写して `playmode: 'clip'` を書く。サイトは同時に新しいタブで作品を開き、そのタブの content が全体のキーを読んで区間再生を始める。
- 視聴タブを開いた content はすべて同じキーを読むため、引き継ぎの後に手動で開いた別の Netflix タブも区間再生を始めうる。コメントの投稿先も全体のキーから決まる。FR-07 を満たせない。
- 視聴タブの `beforeunload` で全体のキーを消す（自動遷移の目印があれば残す）。

### 9.2 【#136】のタブ別の所有権モデル

Background の `createPlaybackOwnershipManager`（`src/background/playbackOwnership.js`）が、`chrome.storage.session` の `activePlaybackTabsV1` を管理する。

~~~js
{
  active: {    // タブ ID → 所有権
    "123": { nonce, context: { mode, clipId }, snapshot, route, expectedRoute,
             autoNavigationRoute, revision, updatedAt }
  },
  pending: {   // nonce → 引き継ぎ（30 秒で失効）
    "<nonce>": { expiresAt, sourceTabId, targetTabId, context, snapshot, revision, updatedAt }
  },
  revision: 42
}
~~~

- `snapshot` は再生に必要な確定データ（`clip`、または `playQueue` と `currentClipOrder` など）で、書き込みのたびに `normalizePlaybackSnapshot` で再検証する。content の検証結果は信用しない。
- 全体共通のキーには、互換のための写しとして最新の所有者の snapshot を書く。所有者と保留中の引き継ぎが無くなれば消す。`chrome.storage.session` と `chrome.storage.local` の片方の書き込みが失敗した場合は両方を元に戻す。
- 操作はマネージャーの中で直列化する。タブ ID は `sender.tab.id` を使う。

| 操作 | 契機 | 条件・効果 |
| --- | --- | --- |
| `beginHandoff` | `BEGIN_PLAYBACK_HANDOFF`（サイトのタブ、記録一覧） | nonce、送信元タブ、context、snapshot を検証し、`pending` に 30 秒登録する。失効のアラームを設定する |
| `bindTarget` | `tabs.onCreated`（`openerTabId` あり） | 送信元タブの未紐付けの引き継ぎがちょうど 1 件なら、新しいタブを `targetTabId` にする |
| `claim` | 視聴タブの読み込み時の `CLAIM_PLAYBACK_OWNERSHIP` | nonce（URL の `dextPlaybackOwner` またはタブの `sessionStorage`）で照合する。nonce が無い場合は、送信元タブまたは opener が一致する引き継ぎが 1 件だけのときに限る。要求したタブが引き継ぎの送信元・opener・紐付け先のいずれかで、URL の経路（origin と pathname）が snapshot と一致すれば `active` へ移す |
| `update` | 次の項目への移動 | 所有者の nonce が一致し、更新後の snapshot が検証を通るときだけ |
| `prepareNavigation` | 別の作品の項目へ移る前 | 遷移先の経路を `expectedRoute` に登録する |
| `handleTabNavigation` | `tabs.onUpdated`（URL の変更） | 同じ経路か予定した経路なら維持し、それ以外は所有権を解放する |
| `release`、`removeTab` | 区間再生の終了、タブを閉じる | 所有権を解放する |
| `cleanupExpired`、`reset` | アラーム、`runtime.onStartup` | 失効した引き継ぎを消す。ブラウザの起動時は全体を初期化する（FR-07-5） |

content 側（`src/content/playbackOwnership.js`、`playbackContext.js`）:

- URL に nonce が無い場合（サイトからの単体再生）は、`claim` を 50 ミリ秒間隔で最大 20 回試す。サイトが新しいタブを開いてから `clipSelected` を送るため、引き継ぎの登録がタブの読み込みより遅れうる。
- 取得した所有権の `{mode, clipId}` を `sessionStorage` の `dextPlaybackContextV1` に書く。コメントパネルはこれだけを見て投稿先を決め、他のタブの状態を使わない。
- 手動の遷移（`historyChange` で予定外の経路）では所有権を解放し、区間再生とコメントパネルを止める。自動遷移は `extAutoNavigation`（15 秒有効、nonce と遷移先の経路が一致するときだけ）で区別する。

### 9.3 引き継ぎの流れ

**サイトから単体クリップ（【サイト#62】と【#136】）**

~~~mermaid
sequenceDiagram
  participant P as サイトのページ
  participant G as getClipData.js
  participant BG as Background
  participant T as 新しい視聴タブ
  P->>T: window.open で URL と t（開始秒）を開く
  P->>P: Cookie（service、clipId、starttime など）を書く
  P->>G: clipSelected（clipId と requestId）
  G->>G: Cookie と detail.clipId を照合して検証
  G->>BG: BEGIN_PLAYBACK_HANDOFF（nonce、context、snapshot）
  BG-->>G: ok（pending に 30 秒登録）
  G-->>P: EXTENSION_PLAYBACK_HANDOFF_RESULT（ok と requestId）
  T->>BG: CLAIM_PLAYBACK_OWNERSHIP（nonce なし、最大 20 回）
  BG->>BG: opener と送信元タブで 1 件に特定し、経路を照合
  BG-->>T: snapshot
  T->>T: 区間の監視を開始
~~~

- 単体再生の URL には nonce を付けない（タブを開くのはサイト）。照合は opener と送信元タブで行い、候補が 2 件以上なら拒否する（`ambiguous_handoff`）。
- 【#136】は `detail.clipId` と `service` の Cookie を必須にする（`playbackBridgeValidation.js:292-311`）。【サイトdevelop】の `openClipPlayback`（`src/lib/clips/playback.ts:109-135`）はどちらも送らないため、【#136】を先に統合するとサイトからの単体再生の引き継ぎがすべて拒否される（G-09）。【サイト#62】は `service`（`:156`）、`clipId`（`:160`）、`detail.clipId`（`:176`）を送り、先にタブを開いて（`:138`）ポップアップが阻止されたら引き継がない。

**プレイリストの開始**

1. サイトが `localStorage.playQueue` に項目（【サイト#62】で `order` を付ける）を書き、`PLAY_PLAYLIST_START` を送る。
2. `getClipData.js` が `normalizePlaylistJson` で検証する（1〜100 件、生のデータと正規化後の JSON がそれぞれ 512 KiB 以下、`order` の重複なし、全項目が単体クリップの規則を満たす）。1 項目でも不正なら全体を拒否し、保存も遷移もしない。
3. 最小の `order` の項目で引き継ぎを登録し、成功したら 300 ミリ秒後に、サイトのタブ自体を `URL?t=開始秒&dextPlaybackOwner=<nonce>` へ遷移させる。

**次の項目**

- 同じ作品（URL が同じ）: ページを移動せずに seek する。Netflix は ±1 秒に収まるまで 300 ミリ秒ごとに seek を送り、10 秒で打ち切る（Issue #103）。
- 別の作品: `update` で snapshot を進め、`prepareNavigation` で遷移先を登録し、`extAutoNavigation` を書いてから nonce 付きの URL へ移る。

**Netflix の記録一覧から**

`selectClip` が nonce を作って引き継ぎを登録し、nonce 付きの URL を新しいタブで開く。このとき `setClipDataOnCookies` が Netflix のオリジンにクリップの Cookie を書くが、読み手は無い（G-26）。

### 9.4 サービス別のプレイヤー制御

| 項目 | Netflix | Disney+ |
| --- | --- | --- |
| 開始位置 | URL の `t` だけで決める。単体再生では読み込み後に seek しない。サイトの単体再生は `startMs/1000` の小数を `t` に入れる | 時刻が取れた時点で開始位置へ seek する（100 ミリ秒ごとに確認） |
| seek の方法 | Background が MAIN world で `window.netflix.appContext` 配下の `videoPlayer` の `seek` を呼ぶ。作品の長さが 1e5 を超えればミリ秒と見なす | 進行バーの `.progress-bar__seekable-range` へ、比率から求めた座標で `pointerdown`・`pointerup` を送る |
| 終了の検知 | `timeupdate` で `currentTime + 0.05 ≥ 終了位置` | 500 ミリ秒ごとに `aria-valuenow ≥ 終了位置` |
| 精度の懸念 | 公開されていない内部 API の変更に弱い | 1 ピクセルあたりの秒数（作品の長さ ÷ バーの幅）より細かく seek できない。2 時間の作品で幅が 1,200 ピクセルなら約 6 秒になり、SLO の ±1 秒を満たせない可能性がある（G-15） |

### 9.5 終了とループの規則

| 場面 | PRD | Netflix の現行（【develop】【#136】） | Disney+ の現行 |
| --- | --- | --- | --- |
| 単体再生の終わり | 一時停止。区間ループがオンのときだけ繰り返す | 常に開始位置へ戻って繰り返す（【#136】`:945-953`） | 監視を止めるだけで一時停止しない。「ループ」をオンにすると繰り返す |
| ループの切替 | 再生中に切り替えられ、状態が見える | 切替が無い。「ループ」の ID を持つボタン（`nf-loop-toggle-btn`）は記録一覧の開閉 | 「ループ」ボタン。オフにすると監視を止める |
| プレイリストの末尾 | 停止。リストループがオンのときだけ先頭へ | 常に先頭へ戻る（`:771`） | 常に先頭へ戻る（`:990-992`。コメントで明記） |
| 次へ | 両サービスで提供 | 「次のクリップを再生」ボタン（Issue #121） | 無い |
| 区間の外へのシーク | 区間再生を終える | 終了位置より後へ移ると開始位置へ戻される | 終了位置より後へ移ると終了と判定する |

目標設計【提案】（G-05）:

- 所有権の snapshot に `clipLoop` と `listLoop`（既定は `false`）を加え、タブごとに持つ。別の作品への遷移後も引き継ぐ。`normalizePlaybackSnapshot` は真偽値だけを受け付け、契約の版を上げる（§17.4）。
- 終了時の処理を共通にする。プレイリストなら次の項目へ進み、次が無ければ `listLoop` で先頭へ、オフなら一時停止して所有権を解放する。単体なら `clipLoop` で開始位置へ戻り、オフなら一時停止して所有権を解放する。
- 利用者が終了位置 + 1 秒より後、または開始位置 − 1 秒より前へシークしたら区間再生を終える。
- Netflix は記録一覧の開閉とループの切替を別のボタンにする。Disney+ に「次へ」を加える。

### 9.6 再生開始の観測【提案】

主指標と SLO は、引き継ぎの受付ではなく再生開始で数える（PRD §11）。content は所有権を取得した後、プレイヤーの準備ができてから 10 秒以内に「再生中、かつ現在位置と開始位置の差が 1 秒以内」になった時点を `playback_started` とする。10 秒以内に条件を満たさない場合、`video` の `error`、seek の失敗は `playback_failed`（理由コード付き）とする。送信先は PRD §13 の決定に従う（§14）。

### 9.7 統合の条件

- 【サイト#62】を先に統合し、その後に【#136】を統合する（§17.1）。
- Netflix と Disney+ の混在プレイリストは、項目ごとに検証を通るため引き継ぎは可能。提供するかは実機確認で決める（PRD FR-08-7）。

## 10. コメント（FR-09）

### 10.1 拡張

| 観点 | 【develop】 | 【#136】 |
| --- | --- | --- |
| 投稿先 | 全体共通の再生キーから決める | タブの `dextPlaybackContextV1` だけから決める。サーバーの `clipId` を持たない記録は対象外 |
| 本文の検証 | trim 後 1〜500（UTF-16 の長さ） | trim 後 1〜500 コードポイント（サイトと同じ数え方） |
| 応答の検証 | 成功時は内容を検証しない | GET は 200、POST は 201 だけを成功とし、全項目の型、`clipId`、カーソルの整合を確認する |
| タイムアウト | 無し | 排他の待ち時間を含めて 15 秒 |
| 401 | 認証状態を消す | 要求に使ったトークンが現在と同じときだけ消す（Issue #137） |
| 429 | `request_failed` | `rate_limited` |
| 結果が不明な失敗 | — | 一覧を取り直し、投稿されていなければ利用者が再投稿する |
| 投稿先の変化 | — | 投稿の直前に再確認し、変わっていれば中止する。対象が変わると下書きを消す |

### 10.2 サイト API【サイト#62】

| API | 認証 | 内容 |
| --- | --- | --- |
| `GET /api/extension/clips/{clipId}/comments?extensionInstanceId=&cursor=&limit=` | Origin、Bearer | `{ok, clipId, comments: [{id, clipId, userId, username, body, atMs, createdAt}], hasNext, nextCursor}`（`route.ts:70-91`）。`id` の降順、`limit` は 1〜100（既定 20） |
| `POST /api/extension/clips/{clipId}/comments` | Origin、Bearer | `{extensionInstanceId, body, atMs, clientRequestId}`（後の 2 つは任意）→ `201 {ok, comment}`（`:145-160`） |
| `GET`・`POST /api/v1/clips/{clipId}/comments`、`DELETE …/comments/{commentId}`、通報の API | セッション | サイト内の UI（`CommentModal.tsx`） |

規則: 本文は NUL を含まない 1〜500 コードポイント。投稿は 1 分あたり 30 件まで（429 `COMMENT_RATE_LIMITED`）。`clientRequestId` が使用済みなら同じ投稿を返し、内容が違うか削除済みなら 409 `IDEMPOTENCY_KEY_REUSED`。`atMs` はクリップの区間内（外れたら 400 `AT_MS_OUT_OF_RANGE`）。退会した所有者のクリップへの新規投稿は 409 `CLIP_OWNER_RETIRED`。

### 10.3 公開範囲の不一致と目標設計（G-02）

【サイト#62】では、連携済み・ログイン済みの任意の利用者が、任意の有効なクリップのコメントを読み、投稿できる（`listExtensionClipComments` と `createCommentWithPolicies` に所有者の確認が無い）。通報の宛先がクリップの所有者であるなど、複数の利用者が書き込む前提の設計である。PRD は「本人が自分のクリップに付けたコメントだけを本人が閲覧できる」と定めている。

【提案】一覧と投稿の両 API（拡張と v1）で、クリップの所有者が要求者本人であることを確認し、違えば 404 にする（存在を明かさない）。初期版では通報とモデレーションの UI を出さない。PRD を公開型に改める場合は §18 の決定とし、本書とテストを合わせて変える。

### 10.4 冪等な投稿【提案】（G-11）

【#136】の POST の本文は `{extensionInstanceId, body}` だけで、`clientRequestId` を送らない（`comments.js:241-245`）。投稿ボタンを押した時点で UUID を作り、結果が不明な失敗の再試行では同じ値を送る。本文を変えたら新しい値にする。サイトが同じ投稿を返すため、現在の「一覧を取り直して利用者に判断させる」処理は不要になり、PRD FR-09-4 を満たす。

### 10.5 時刻アンカー

【サイト#62】は `atMs`（動画内の位置、ミリ秒）を受け付け、応答にも含める。拡張は送らず、表示もしない。最初の提供範囲に含めるかは PRD §13 で決める。含める場合、拡張は投稿時の再生位置を区間内に丸めて送る。

## 11. UI・キーボード・アクセシビリティ（FR-10、NFR-08）

- **保存パネル**（`common.js`）: パネル内のキー入力を捕捉段階で止め、サイトのショートカットを作動させない。Enter（IME 変換中とリピートを除く）で保存し、【#136】では Escape（IME 変換中を除く）でキャンセルする。Netflix はプレイヤーへフォーカスを戻すため、外れたら入力欄へ戻す（1 秒あたり 30 回まで）。閉じたら元のフォーカスとプレイヤーの幅を戻す。【#136】はサイトが DOM を差し替えてパネルが外れた場合もリスナーを解除する。
- **コメントパネル**（`commentPanel.js`）: Shadow DOM の中に描画し、開閉ボタンに `aria-expanded` と `aria-controls` を付ける。IME 変換中の Escape では閉じない。
- **Disney+ のボタン**: Disney+ はプレイヤー全面のマスクでクリックを奪うため、マスクより上に独自のオーバーレイを置く。各ボタンは `role="button"`・`tabindex="0"` で Enter と Space に反応し、`:focus-visible` で枠を出す。
- **フォーカスの奪い合い**: プレイヤー内の UI を Shadow DOM のオーバーレイに統一する（Issue #119）。保存フォームと記録一覧をオーバーレイのパネルへ移す（Issue #120）。
- **通知**【提案】: 保存結果の通知（§6.3）は全画面表示の対象要素の内側に置き、`role="status"`（失敗は `role="alert"`）でフォーカスを奪わない。
- **タブの表示状態**: タブが非表示の間は拡張のボタンを隠し、戻ったらフェードインする（`startTabVisibilityToggle`）。

## 12. 信頼境界と検証責務（NFR-01、NFR-02、NFR-04）

| 境界・入力 | 検証する側と実ファイル | 拒否・保護する条件 |
| --- | --- | --- |
| サイトのページ JS → 連携の content script | `extension_link.js` が source、origin、`type` を確認する。【#136】は Background が instanceId とトークンの形式を検証する | 別のオリジン、未知の型、異なる instanceId のトークンを拒否する。`window.postMessage` を認証済みの経路と見なさない |
| サイトのページ JS → 再生ブリッジ | `getClipData.js` が source、origin、型を確認する。【#136】は `playbackBridgeValidation.js` が clipId、サービスと URL のホスト、HTTPS、認証情報・明示ポートの禁止、時間、件数 100・512 KiB、文字列の長さを確認する | 不正な入力では既存の再生状態を変えず、理由を返す。【develop】の `SET_CLIP_DATA` は検証せずに保存する |
| 視聴タブの content → Background | `background.js` のメッセージの分岐、【#136】は `playbackOwnership.js` が `sender.tab.id`・nonce・経路・snapshot を照合する | ページが申告したタブ ID で所有権を決めない。別のタブ、古い nonce、期限切れを拒否する。登録簿の継承プロパティを読み書きしない |
| Background → サイト API | `src/api.js` の接続先、`manifest.json` の `host_permissions`、サイトの `cors.ts` と各 route | Origin の不許可は 403。Bearer が無い・不正・期限切れ・失効は 401。Origin の許可と利用者の認証は別の検査 |
| JSON → サイト DB | `extension.schema.ts` の Zod、`extensions.ts` の連携認証と受理記録、クリップとコメントのサービス層 | UUID、重複 ID、時間、URL を検証する。要求に含まれる userId で所有者を上書きしない。非公開を API の経路でも守る（G-01、G-02） |
| サイト API → 拡張の保存データと画面 | 【#136】`sync.js` が `acceptedItemIds` を照合し、`comments.js` と `clips.js` が応答を検証・正規化する | 不正な受理 ID でキューを消さない。外部由来のタイトルやコメントは `textContent` で表示し、HTML として挿入しない（Issue #96・#97） |
| サイトの v1 の書き込み API | 【サイト#77】`src/server/http/csrf.ts` | 別オリジンからの書き込みを拒否する（サイト Issue #78） |

- 認証トークンは拡張の `chrome.storage.local` と、Background の `Authorization` ヘッダーに限る。Netflix・Disney+ のページ、再生 URL、通常のログ、分析イベントへ渡さない。ただし連携の時点ではサイトのページ JS を通る（§5.5、G-12）。
- サイトのセッション Cookie は、拡張用の Bearer とは別の資格情報。
- ログにはトークン、作品 URL、名前、コメント本文を含めない。【#136】の `getClipData.js` は拒否の際に `source`・`reason`・`field`・`index` だけを出す。【develop】は Netflix の一部のログにクリップのタイトルや URL を出す。
- 記録の内容を配信サービスの Cookie に書かない（G-26、NFR-04）。

## 13. 障害と回復（NFR-03、NFR-07）

| 事象 | 現行（【#136】） | 守る条件 |
| --- | --- | --- |
| Service Worker の停止と再開 | メモリ上の排他と合流は消える。起動時にトークン更新→同期を実行する。所有権は `chrome.storage.session` に残る | キューとトークンは保存データだけを正とする |
| ブラウザの再起動 | `onStartup` でアラームを作り直し、所有権を初期化する | 以前の区間再生を再開しない（FR-07-5） |
| 拡張の更新・再読み込み | 開いていたページの content は Background に接続できない（`background_unavailable`） | 端末への記録に失敗したら入力を残す。同期は次の起動で再開する |
| `chrome.storage.local` の書き込みの失敗（上限 10 MB） | 追加の失敗として再試行を表示する | 成功と報告しない。容量不足を理由コードで記録する |
| 通信断・無応答 | 15 秒で打ち切り、保持する | アラームで再送する |
| サイトの 5xx | 保持する | 同じ ID で再送し、受理記録で重複を防ぐ |
| 時計のずれ | トークンの更新時期は端末の時計で判断する | 最終的な有効性はサイトが判断する（401 で連携待ち） |
| 別のブラウザ | instanceId と連携は別々 | 一方の解除が他方に影響しない |

## 14. 品質・計測

PRD §11 の SLO を品質目標とする。端末への記録の応答、同期の受理までの時間、再生開始位置、記録の保全を別々に計測し、端末への記録の完了をサイトの同期の完了や再生開始と数えない。

| SLI・イベント | 計測点 |
| --- | --- |
| 端末への記録結果の時間、`clip_queued`、`clip_queue_failed` | `common.js` の保存処理（保存操作から `ENQUEUE_PENDING_CLIP` の応答まで） |
| 同期の時間、`clip_sync_accepted` | `sync.js` の受理時（`queuedAt` からの時間） |
| `clip_sync_blocked` | §7.4 で `blocked` にした時点 |
| `playback_handoff_accepted`、`playback_handoff_rejected` | `getClipData.js` と記録一覧の引き継ぎの結果 |
| 再生開始位置、`playback_started`、`playback_failed` | §9.6 |
| 記録の保全、操作の分離 | 自動テストと障害注入（§15） |

イベントの送信先、識別子、保持期間は PRD §13 の決定事項。限定利用までは端末内で集計して利用者の操作で書き出す方法と、Bearer で受け付けるサイトの API（`POST /api/extension/events`）を候補とする。診断ログは `requestId`、処理段階、固定の失敗コードに限る。

## 15. テストと検証

### 15.1 現行の自動テスト

2026-10-01 に各ブランチで `node --test` を実行した結果:

| 対象 | ファイル数 | テスト数 | 結果 |
| --- | --- | --- | --- |
| 【develop】 | 4 | 23 | すべて成功 |
| 【#136】 | 17 | 170 | すべて成功 |

【#136】の内訳は `test/README.md` にある。認証状態の直列化と古い 401（25）、コメント API（18）、記録一覧 API（16）、再生所有権（21）、通信の打ち切り（3）、完了を待たないタスク（3）、保存パネル（15）、コメントパネル（14）、記録一覧の非同期の整合（5）、content の所有権（8）、再生コンテキスト（8）、ブリッジの入口（5）、結合部分（5）、入力契約の検証（14）、manifest の整合（4）、history hook（1）、アイコン（5）。

サイト側では、【サイト#62】に拡張リポの実クライアントを動かす結合スモーク（`tests/smoke/extension-client.contract.mts`）とコメントのスモークがある。【サイト#77】に同期の重複と退会のテスト（`tests/extension/sync.test.mjs`、`tests/smoke/extension-sync-checks.mts`）がある。

### 15.2 追加するテスト

| 対象 | テスト |
| --- | --- |
| G-03 | 不正な項目を含むキューで、有効な記録だけが受理される。400 の分割送信で問題の項目を特定する。404 をサービス単位で扱う。送信できない記録が自動で消えない |
| G-04、§6.3 | Disney+ の録画の区間検証、作品名が無い場合、名前 255 文字の境界 |
| G-05 | 単体・プレイリストの終了時の一時停止とループの切替、区間の外へのシーク |
| G-13 | 保存の再試行で `clientItemId` が変わらない |
| G-11 | 結果が不明な失敗の後の再投稿で、同じ `clientRequestId` を送る |
| G-01、G-02 | 他人の `userId` や `clipId` を指定した一覧とコメントが取得できない（サイト） |
| 引き継ぎの成功系 | `clipSelected` の成功、正常な `SET_CLIP_DATA`、プレイリストの成功と nonce 付きの遷移（正典の §8 が不足として挙げる経路） |

### 15.3 実機確認

`/smoke-checklist` で差分から影響するフローを選ぶ。最低限の項目は次のとおり。

- Netflix と Disney+ で記録と保存（未連携から連携、通信断から回復、名前の空欄、1 秒未満）。
- サイトからの単体再生とプレイリスト再生（混在を含む）、2 つのタブでの別々の再生、再生中の手動の遷移、Service Worker の再起動（`chrome://serviceworker-internals`）。
- コメントの表示と投稿、失敗時の下書き、キーボードだけでの保存、全画面での操作。

### 15.4 実 DB での確認

同じ `clientItemId` の並行の再送、連携トークンの並行の使用、トークン更新後の旧トークンの拒否、解除してからの再連携、退会後の同期の拒否を確認する。未統合の PR は、各 PR の検証結果と統合後の結果を分けて記録する。

## 16. 要件適合の差分一覧

重要度は issue の接頭辞と同じく、【must】（初期版までに必須）と【better】（改善）で示す。

| ID | 重要度 | 内容 | 根拠 | 対応案 | 担当 |
| --- | --- | --- | --- | --- | --- |
| G-01 | must | クリップの一覧 API が認証なしで全利用者のクリップを返し、拡張の記録一覧も他人のクリップを表示する。【サイトdevelop】は作成者の `users` 行を全列返す | サイト `src/app/api/v1/clips/route.ts:16-31`、`src/server/repositories/clips.ts:83`、Issue #76。【#136】`clips.js:94-95` | §8.2 | サイト、拡張 |
| G-02 | must | コメントを任意の利用者が読み書きできる | 【サイト#62】`src/server/services/comments.ts`（`listExtensionClipComments`、`createCommentWithPolicies`） | §10.3 | サイト |
| G-03 | must | 1 件の不正な記録で全件が同期できない。【develop】は全件を削除する | §7.3、§7.4 | §7.4 | 拡張（サイトは任意） |
| G-04 | must | Disney+ の録画に区間と作品名の検証が無い | 【#136】`content_disney.js:412-455` | §6.3 | 拡張 |
| G-05 | must | 終了とループの規則が PRD と違う | §9.5 | §9.5 | 拡張 |
| G-06 | must | 保存の結果（同期済み・同期待ち）を表示しない。同期を待ってからパネルを閉じる | 【#136】`common.js:249-291` | §6.3 | 拡張 |
| G-07 | must | 未同期の記録と送信できない記録を確認する画面が無い | §7.6 | §7.6 | 拡張、サイト |
| G-08 | must | 【develop】の記録一覧が削除済みの API を呼ぶ | 【develop】`content_netflix.js:447,474`、Issue #134 | 【#136】で解消（G-01 の対応は別途必要） | 拡張 |
| G-09 | must | 【#136】を先に統合すると、サイトからの単体再生の引き継ぎがすべて拒否される | §9.3 | 【サイト#62】を先に統合する | 両方 |
| G-10 | must | 連携先の利用者が替わると、以前の利用者の未同期の記録が新しい利用者に同期される | サイト `extensions.ts#consumeLinkTokenAndLinkExtension` | §5.5 | 両方（PRD §13 の決定後） |
| G-11 | better | コメントの冪等キーを送らない | 【#136】`comments.js:241-245` | §10.4 | 拡張 |
| G-12 | better | 連携時に 90 日有効のトークンがページ JS を通る | サイト `src/lib/extension/client.ts` | §5.5 | 両方 |
| G-13 | better | 保存の再試行で新しい `clientItemId` を発行する | 【#136】`extensionSync.js#toExtensionClipPayload` | §6.3 | 拡張 |
| G-14 | must（配布前） | 接続先、権限、案内ページが localhost に固定。拡張の名称・説明・アイコンが仮 | `src/api.js:1`、`manifest.json`、【#136】`background.js:24` | 環境ごとのビルド設定と manifest の生成 | 拡張 |
| G-15 | better | Disney+ の seek の精度が SLO を満たさない可能性 | §9.4 | seek の後に位置を読み直して補正する。実機で誤差を測る | 拡張 |
| G-16 | better | Netflix の単体再生は URL の `t` だけで開始位置を決め、サイトは小数の `t` を送る | §9.4 | 準備後に開始位置を確かめ、必要なら seek する。小数の `t` の扱いを実機で確認する | 拡張、サイト |
| G-17 | better | 引き継ぎ契約の正典が【develop】と【#136】に無い | §4.1 | §17.4 | 拡張 |
| G-18 | better | ライブラリで自分のクリップを作品名で絞り込めない | サイト `/my_video` | §8.2 | サイト |
| G-19 | better | プレイリストの並び順が保存されない | サイト Issue #66 | 【サイト#77】で解消 | サイト |
| G-20 | better | 同時の再送で 500 になり、退会後も同期できる | サイト Issue #80・#81 | 【サイト#77】で解消 | サイト |
| G-21 | better | 未連携で保存するとログインタブを自動で開く | 【#136】`common.js:119`、`sync.js#openLoginTab` | §5.5 | 拡張 |
| G-22 | better | 一括送信の件数に上限が無い | §3.2 | §7.4 | 拡張 |
| G-23 | better | 再生開始を観測しない | §9.6 | §9.6 | 拡張 |
| G-24 | better | 記録中に遷移しても Disney+ は録画状態を解除しない | §6.1 | §6.3 | 拡張 |
| G-25 | better | Netflix の seek が公開されていない内部 API と単位の推定に依存する | `background.js#handleSeekMessage` | 実機での回帰確認を手順にする | 拡張 |
| G-26 | better | Netflix の記録一覧から再生すると、クリップの内容を Netflix の Cookie に書く（読み手なし） | 【#136】`content_netflix.js:651-664` | `setClipDataOnCookies` を削除する | 拡張 |

【#136】で解消済みの主な差分: 不正な 200 応答での全件削除、古い 401 による新しいトークンの消去（Issue #137）、`SET_CLIP_DATA` の無検証の保存、コメント本文の数え方、Netflix の seek の打ち切り（Issue #103）・タイトルの取得（Issue #122）・「次へ」（Issue #121）、Disney+ のボタン名（Issue #124）、固定のテストユーザー名（Issue #106）、記録一覧の API（Issue #134）。

## 17. 統合順序・互換性・移行

### 17.1 統合順序

1. 【サイト#62】をサイトの `develop` へ統合する（単体再生の `service`・`clipId`・`requestId`、コメント API、連携をボタン操作に限定）。
2. 【#136】を拡張の `develop` へ統合する。PR 本文の「サイト側 API 契約」の develop の基準は、`3f29d55` から `7d8de67` に更新する（引用している行は変わらない）。
3. 【サイト#77】を付け直した #62 の上に積み直して統合する（同期の競合と退会、v1 の CSRF、並び順、利用者属性の制限）。
4. 非公開化（G-01、G-02）をサイトと拡張で行う。拡張の記録一覧は、新しい API が使えるようになるまで機能フラグで止め、未実装の API を呼ばない。
5. 拡張の保存と同期の改善（G-03、G-04、G-06、G-07、G-13、G-21、G-22）。
6. 再生の終了とループの統一（G-05）、再生開始の観測（G-23）。
7. 配布の設定（G-14）。

### 17.2 互換性

| 拡張 \ サイト | 【サイトdevelop】 | 【サイト#62】 |
| --- | --- | --- |
| 【develop】 | 単体再生は動くが、再生状態が全タブ共通。記録一覧は動かない（G-08） | 単体再生は動く（`detail.clipId` を使う）。コメントの投稿先は全タブ共通 |
| 【#136】 | 単体再生の引き継ぎが `invalid_clip_id` で拒否され、タブは開くが区間再生しない。プレイリストは `order` を補って動く | 想定の組み合わせ |

### 17.3 保存データの移行

- `pendingClips` の形式は【develop】と【#136】で同じ。§7.4 の追加項目は任意で、無ければ `queued` と見なす。
- 再生の全体共通キーは、【#136】でも互換の写しとして残す。所有権の登録簿（`activePlaybackTabsV1`）とタブの `sessionStorage` のキーは新規で、移行は要らない。
- `extAutoNavigation` は、【develop】の文字列（`sessionStorage` と `localStorage`）から【#136】の JSON（`sessionStorage` だけ）に変わる。【#136】は起動時に `sessionStorage` の目印を消すため古い値は使わない。【develop】が `localStorage` に残した値は読まれないまま残る。
- サイトと拡張の片方だけを先に更新しても再生と同期が壊れないよう、§17.1 の順序と §17.2 を守る。API や保存データの形式を変える PR では、移行と互換期間を PR 本文に書く。

### 17.4 正典ドキュメントの配置

`docs/localhost-playback-bridge-contract-v1.md` は `.gitignore` で追跡の対象として残しているが、【develop】と【#136】には存在しない（`134-fix-clip-list-api` の `e9b3be3` が最新）。【#136】の統合時に同じ内容を取り込む。§9.5 のループの項目を加えるときは、契約の版を上げて反映する。

## 18. 未決定事項とリスク

| 論点 | 選択肢 | 推奨 |
| --- | --- | --- |
| クリップとコメントの公開範囲 | (a) PRD どおり非公開にし、サイトの公開一覧と他者のコメントの閲覧をやめる (b) PRD を公開型へ改訂する | (a)。PRD §13 で確定した方針で、現行の公開一覧は利用者属性の露出（Issue #76）も伴う |
| 同期の 400 で項目を特定する方法 | (a) サイトが項目ごとの結果を返す (b) 拡張が分割して送り直す | (a) を本命とし、サイトが対応するまで (b) で補う |
| 連携先アカウントの変更 | (a) 記録に連携先の値を持たせ、違えば保留して確認する (b) 未同期の記録があれば連携を止める (c) 何もしない | (a)。扱いは PRD §13 で決める |
| 連携トークンの受け渡し | (a) 現行どおりページを経由する (b) 単回トークンだけをページから渡し、Background が交換する | (b)。サイトと拡張の両方の変更が要る |
| 送信できない記録の確認画面 | (a) 拡張のページ (b) サイトのページ（ブリッジで中身を渡す） | (a)。記録の中身と削除の操作を拡張の中に閉じる |
| 計測の送信先 | (a) 端末内の集計と書き出し (b) サイトの API | 限定利用は (a)。本番は PRD §13 で判断する |
| Disney+ の seek の精度 | (a) 進行バーの疑似操作を補正する (b) `video.currentTime` の直接代入を実機で検証する | (b) を検証し、使えなければ (a) |
| 対象サイトの画面変更 | — | Netflix と Disney+ の DOM や内部 API の変更で、記録と再生が止まりうる。実機確認の手順を定期的に回す |
| 提供・運用 | 本番 URL、許可 Origin、拡張の配布方法、SLO の計測、ログの保持期間 | PRD §13 で決める |

保存クリップとコメントの初期の非公開は PRD で確定済み。初期版に別アカウントへの再連携のフローは加えない。

## 19. 参照ファイル

- 拡張【develop】: `manifest.json`、`webpack.config.js`、`src/api.js`、`src/shared/storage.js`、`src/content/common.js`、`src/content/extensionSync.js`、`src/content/extension_link.js`、`src/content/getClipData.js`、`src/content/content_netflix.js`、`src/content/content_disney.js`、`src/content/commentPanel.js`、`src/background/background.js`、`src/background/sync.js`、`src/background/tokenRefresh.js`、`src/background/comments.js`。
- 拡張【#136】: 上記に加え、`src/background/{authMutex,authState,instanceId,request,clips,playbackOwnership,detachedTasks}.js`、`src/content/{clipList,playbackContext,playbackOwnership,runtimeMessage,netflixClipSelection}.js`、`src/shared/{playbackBridgeValidation,authValidation,commentText}.js`、`test/README.md`。
- 【サイトdevelop】: `src/app/api/extension/{link-token,link,sync,token/refresh,unlink,session}/route.ts`、`src/app/api/v1/clips/route.ts`、`src/server/schemas/{extension,legacy-clips,clips}.schema.ts`、`src/server/services/{extensions,legacy-clips,clips}.ts`、`src/server/repositories/clips.ts`、`src/server/http/cors.ts`、`src/lib/extension/client.ts`、`src/lib/clips/playback.ts`、`src/components/Extension{LinkButton,UnlinkButton,Linker}.tsx`、`src/app/(site_data)/(protected)/{account,my_video,playlists/[playlistId]}/`、`prisma/schema.prisma`。
- 【サイト#62】: `src/app/api/extension/clips/[clipId]/comments/route.ts`、`src/server/services/comments.ts`、`src/server/schemas/comments.schema.ts`、`src/lib/extension/handoffRequest.ts`、`src/components/ExtensionPlaybackHandoffStatus.tsx`、`openapi/v1.yaml`。
- 【サイト#77】: `src/server/services/extensions.ts`、`src/server/http/csrf.ts`、`src/server/repositories/{clips,playlists}.ts`、`tests/extension/sync.test.mjs`。

本書で求めるキューの保全、厳密な受理 ID の確認、同期結果の表示、非公開の API 認可は、記述しただけでは実装の完了にならない。各変更 PR の差分と実行結果を別に追跡する。
