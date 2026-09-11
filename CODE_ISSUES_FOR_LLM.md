# CODE_ISSUES_FOR_LLM

## Overview

このドキュメントは `READMEFORLLM.md` の補助資料です。

- `READMEFORLLM.md`: 構造と流れを理解するための資料
- `CODE_ISSUES_FOR_LLM.md`: 危険箇所と改善順を判断するための資料

- 最終検証: 2026-08-25（コミット `b9d8fa5` / ブランチ `codex/comment-playback-hardening`）
- 検証方法: 各項目を実コードに対して再確認。解決済みは「対応済み」区画へ移動した

最初に押さえるべき論点は次の 4 つです。

| 論点 | 何が起きているか | 先に見る場所 |
| --- | --- | --- |
| build と実行物のズレ | webpack bundle は Git 管理外の `dist/`、3 script は `src/` から直接読む | `manifest.json`, `webpack.config.js`, `.gitignore` |
| 巨大ファイルへの責務集中 | 1 ファイルに録画・一覧・再生・UI が同居している | `src/content/content_netflix.js`, `src/content/content_disney.js`, `src/content/commentPanel.js` |
| データ shape の揺れ | `id` / `clipId`、`url` / `URL` などが外部入力に残る | `src/shared/playbackBridgeValidation.js`, `src/content/*` |
| service enum の drift | `detectService()` と URL builder と再生契約の対応表がずれている | `src/content/common.js`, `src/util/services.js`, `src/shared/playbackBridgeValidation.js` |

読み方の目安:

1. まず `High Risk Issues` を読む
2. 次に `LLM Danger Zones` を読む
3. 実際に直すときは `Quick Wins` と `Suggested Refactor Order` を使う
4. **「対応済み」区画の項目は再指摘しない**

## 対応済み (PR #115: 拡張⇄サイト連携の認証)

以下は PR #115 で解決済み。**再指摘しないこと**。詳細はコミットと該当ファイルを参照。

| 内容 | 状態 | commit | 主な該当箇所 |
| --- | --- | --- | --- |
| localhost content script が全ポートに注入され、無関係なローカルアプリからインスタンスID取得・トークン上書きが可能だった | ✅ 対応済み | `e27a4d5` | `manifest.json`(`:3000` 限定), `src/content/extension_link.js`(`isTrustedOrigin` 許可リスト) |
| 401(トークン失効)時に再ログイン導線が出ず同期が無言で停滞 | ✅ 対応済み | `e27a4d5` | `src/background/sync.js#performSyncPendingQueue()` |
| sync 200 + `acceptedItemIds: []`(受理ゼロ)でキュー全削除 | ✅ 対応済み | `82a9042` | `src/background/sync.js` (フィールド有無を区別) |
| 初回リンク時 instanceID を永続化前に応答し、トークン往復で不一致拒否 | ✅ 対応済み | `d317c1a` | `src/background/instanceId.js` (`set` callback 待ち) |
| 検知フラグ `__CLIP_EXTENSION_PRESENT__` が isolated world でページから不可視 | ✅ 対応済み | `3766adc` | `src/content/extension_present.js`(MAIN world), `manifest.json`, `src/content/extension_link.js` |
| auth-status 経路(content)と port 経路(background)が別 UUID を生成する instanceID 二重生成 | ✅ 対応済み | `7f09db5` | `src/background/instanceId.js`(単一生成器+in-flight Promise), `src/content/extensionSync.js#getOrCreateExtensionInstanceId()` |
| `getTokenExpiryMs()` が base64url(`-`/`_`)を `atob` に渡して throw | ✅ 対応済み（当時は復号修正、その後に旧 JWT 復号経路を削除） | `7f09db5`（修正） / `ac781ae`（削除） | `src/background/tokenRefresh.js`, `src/shared/authValidation.js` |

## 対応済み (feature/token-lifecycle-and-bg-sync: トークンライフサイクル+background同期)

以下は本ブランチで解決済み。**再指摘しないこと**。サイト側 (`react--site`) の対応とセットで機能する。

| 内容 | 状態 | 主な該当箇所 |
| --- | --- | --- |
| 同期 fetch が content script 実行のため、Netflix/Disney オリジンからはサイト API の Origin 許可リストに弾かれて恒久失敗(CORS 403 → クリップが `pendingClips` に永久滞留) | ✅ 対応済み | 同期 fetch を background へ移設: `src/background/sync.js`, `src/content/extensionSync.js#syncPendingQueue()`(runtime message 化), `manifest.json`(`dist/background.js`)。サイト側は `chrome-extension://<拡張ID>` origin の許可が必要だが、具体的な設定名は対象 site revision で確認する |
| トークン自動更新が非機能(旧 Medium Risk #11) | ✅ 対応済み | 拡張は `src/background/tokenRefresh.js` が 6 時間毎+SW 起動時に期限情報なし、または残り 15 日以下で更新を試行。旧 JWT 復号コード(`decodeBase64Url`/`getTokenExpiryMs`/`checkAndRenewToken`)は全廃(issue #99 も消滅) |
| `EXT/SET_SESSION` がペイロードを無検証で `chrome.storage.local` に丸ごと書き込み(issue #98) | ✅ 対応済み(削除) | `src/content/getClipData.js`（この repo 内に producer が無い旧 fallback をハンドラごと削除） |
| 連携解除通知を受けた後もローカル token が残る | ✅ 対応済み | 拡張は `EXTENSION_UNLINKED` postMessage で即時トークン破棄(`src/content/extension_link.js`)。取り逃した場合は、次に認証付き API が 401 を返した時点でローカル認証を消去 |
| 同期の再送機会が「次の保存操作」しか無い | ✅ 対応済み | `chrome.alarms`(15 分毎)+ SW 起動時に `pendingClips` を flush(`src/background/background.js`) |

このリポジトリから確認できる token 契約: 拡張は link message / refresh 応答から受け取った token 文字列を内部解釈せず、`expiresAt` とともに `chrome.storage.local` に保存する。background 内の `runExclusive` が sync と refresh を直列化する。token の生成方式・形式・有効期間、サイト UI、endpoint 実装は別リポジトリの仕様なので、対象 commit / branch を示さずに現行仕様として断定しない。

## 対応済み (コメント機能 / 再生所有権ブランチ: 2026-08-25 実コード検証)

以下は旧 High / Medium / Low Risk に載っていたが、実コードで解決を確認した。**再指摘しないこと**。

| 旧番号 | 内容 | 解決方法 | 確認箇所 |
| --- | --- | --- | --- |
| High #1 | Netflix の single-clip handoff が repo 内で閉じていない（`selectClip()` は cookie を書くが `clip` storage を書かず、再生側は `clip` を読む） | 再生所有権モデルへ統一。`selectClip()` → `commitSelectedClip()` → `beginPlaybackHandoff()` で snapshot を background へ登録し、遷移先は claim で受け取った snapshot だけを読む | `src/content/netflixClipSelection.js`, `src/content/content_netflix.js#selectClip()` / `#loadClipFromSession()` |
| High #2 | cookie relay が origin をまたいでいて repo 内だけでは成立しない | localhost cookie は「サイト → 拡張」の正式契約として明文化し、許可リスト方式で読む。Netflix 側の再生復元は cookie ではなく snapshot 経由になった | `docs/localhost-playback-bridge-contract-v1.md` §4.6, `src/shared/playbackBridgeValidation.js#parsePlaybackCookies()` |
| High #3 | history hook が多重注入され `historyChange` が重複発火する | `history_change.js` に `__extHistoryChangeHooked__` guard を追加。Netflix には manifest と動的挿入の2経路があるが二重フックしない | `src/util/history_change.js` 冒頭 |
| High #5 | background seek が active tab 前提で誤タブに飛ぶ | `sender.tab` を優先し、取れないときだけ active tab へフォールバック。さらに対象 URL が `netflix.com/watch/` でなければ `not_netflix_watch` で中断 | `src/background/background.js#handleSeekMessage()` |
| High #7 | API / page 由来の文字列を `innerHTML` に入れている（XSS / issue #96・#97） | `textContent` + DOM 組み立てへ置換。`innerHTML` が残るのは `src/ui/icons.js` のファイル内定数のみ | `src/content/common.js:198`, `src/content/content_netflix.js:548`, `src/ui/icons.js:81` |
| High #8 | localhost の全 cookie を `chrome.storage.local.clip` に移している | 許可リスト方式へ変更。契約 v1 に列挙されたキーだけを個別に `decodeURIComponent` する。malformed percent encoding は該当キーを無効化し、必須 field の欠落・不正や optional 文字列の上限超過は message 全体を拒否する | `src/shared/playbackBridgeValidation.js#parsePlaybackCookies()` |
| Medium #1 | `sendData()` が `response.ok` を見ずに `response.json()` を呼ぶ | 保存同期の直接 fetch を廃止。`sendData()` は queue へ積んで background 同期を要求し、通信は `fetchJsonWithTimeout` + status 分岐が担う。記録一覧も `FETCH_CLIP_LIST` で background に移し、content からのサイト API 直接 fetch は無くなった | `src/content/common.js#sendData()`, `src/background/sync.js`, `src/background/request.js`, `src/content/content_netflix.js` |
| Medium #3 | `SET_SESSION_DATA` fallback message に受信側がない | fallback 経路ごと削除。`getClipData.js` は storage を直接触らず `BEGIN_PLAYBACK_HANDOFF` のみ送る | `src/content/getClipData.js` |
| Medium #4 | `setStorageAsync()` が Netflix file 内で二重定義されている | 定義自体が消滅（storage 書き込みは ownership manager 経由に一本化） | `src/content/content_netflix.js` |
| Medium #5 | 未使用の入り口が残っている（`getLoopPlaylist()` / `loadPlaylistClip()`） | 両関数とも削除済み | `src/content/content_netflix.js`, `src/content/content_disney.js` |
| Medium #10 | `playQueue` / `clip` の shape validation がない | 共通検証器を新設し、content と background の両方で同じ規則を適用。必須 canonical field の失敗は message 全体を拒否し、未知 field は除去する。Cookie の decode 失敗はキー単位で記録するが、その後の必須 field 検証は省略しない | `src/shared/playbackBridgeValidation.js` |
| Low #1 の一部 | `background.js` の `let playClipSystemKey = "initialValue"` が未使用のまま残る | 削除済み | `src/background/background.js` |
| Low #1 の一部 | `npm test` がダミー失敗のままで検証コマンドとして機能しない | `test/` に 15 ファイル・143 tests を追加。CI でも実行される | `test/`, `.github/workflows/ci.yml` |

補足（部分的に改善したが完全解決ではないもの）:

- 旧 High #6「playlist の cross-service 継続が壊れやすい」— Netflix 側の cross-URL 遷移は `buildServiceUrl(next.service, ...)` で service-aware になり、URL は入口で絶対 HTTPS + ホスト名一致まで検証されるようになった。ただし **Netflix と Disney+ が混在する playlist の実機確認は未了**。Medium Risk #1 として残す。
- 旧 Medium #8「Netflix UI observer が空 wrapper / spacer を残す」— `buttonMargin` は撤去されるようになったが `wrapButton` は残る。Low Risk #1 として残す。

## High Risk Issues

### 1. webpack bundle を置く `dist/` は git 管理されていない

- 問題: `manifest.json` が読む5 bundle は Git 管理外の `dist/` に生成される。一方、`inject_script.js` / `history_change.js` / `extension_present.js` は `src/` から直接読む。
- なぜ危険か: bundle entry または依存ソースを直しても build しなければブラウザでは古い bundle が動く。直接参照3 script は反対に build しても変換されない。
- どう壊れるか: clean clone は bundle が無いため拡張全体が動かない。変更種別を誤ると、build または Chrome 側の再読込が抜ける。
- 改善方針: webpack 対象の変更後は build、すべての実行コード変更後は拡張と対象ページの再読込を行う（`/build-check` は bundle と manifest の整合を確認）。`dist/` の追跡は現オーナー方針では行わない。

## Medium Risk Issues

### 1. サービス混在 playlist の挙動が未確認

- 問題: 再生ブリッジ契約 v1 は playlist の各項目ごとに `netflix` / `disneyplus` を許すため、混在 playlist が成立しうる。
- なぜ危険か: Netflix の `playlistNextClip()` は service-aware になったが、Disney+ の `buildClipUrl()` は相対 URL を `location.origin` 基準で解決する実装が残る。
- どう壊れるか: 検証器が絶対 URL を保証しているため現状は通るはずだが、実機確認が無い。将来相対 URL を許すと Disney+ 側だけ誤 URL になる。
- 改善方針: 混在 playlist の実機確認を行うか、契約側で「1 playlist 1 service」に絞る。

### 2. 保存失敗でも memo sidebar が閉じる

- 問題: `src/content/common.js#openMemoSidebar()` の `submit` が `.catch(() => console.error(...)).finally(() => closeSidebar())` になっている。
- なぜ危険か: 失敗時にユーザーへ何も表示されない。
- どう壊れるか: enqueue 後の同期失敗なら `pendingClips` に残るが、enqueue 自体の runtime error / background 拒否では永続化されない。どちらでも sidebar が閉じるため、後者は入力を失う。
- 改善方針: enqueue 成功を確認してから閉じる。enqueue 失敗時は入力を残して理由と再試行手段を UI に出す。同期失敗は queued 状態として表示する。

### 3. Disney+ の loop 切り替えが playlist state と噛み合っていない

- 問題: `src/content/content_disney.js#toggleLoop()` は playlist state ではなく `loadClipData()`（clip state 寄り）を使う。
- なぜ危険か: loop と playlist mode が別系統の実装になっている。
- どう壊れるか: playlist mode では `loadClipData()` が clip を返さず、loop toggle が実質 no-op になる。
- 改善方針: loop の責務を `Mode` / `Playlist` に寄せて一元化する。

### 4. clip 一覧が `item.id` にしか依存していない（解消済み）

- 対応: `background/clips.js#normalizeClipListItem()` が `id` と `clipId` の両方を必ず埋めた形へ正規化し、`renderClipList()` は clip オブジェクトごと `onSelect` へ渡すようになった。単体取得（旧 `fetchClip`）自体が無くなったため `id=undefined` の経路も消えている。

### 5. localhost URL が複数箇所に散っている

- 問題: `src/api.js#API_URL`、`src/background/background.js#DEMO_BASE_URL`、`manifest.json` の `host_permissions` / `matches` に localhost 設定が分散している。
- なぜ危険か: host / port 変更時に更新漏れが出る。
- どう壊れるか: 一部だけ別 port を見て通信に失敗する。manifest は静的なので特に忘れやすい。
- 改善方針: `src/` 側だけでも共通定数へ寄せ、manifest との対応をテストで固定する。

## Low Risk Issues

### 1. Netflix UI observer が空 wrapper を残す

- 問題: 録画ボタン撤去時に `buttonMargin` と `recordButton` は消えるが、`wrapButton` は残る。
- どう壊れるか: 通常の observer 再描画だけで毎回増えるわけではないが、button 撤去後に空 wrapper が残り、再初期化時の見た目崩れや DOM 判定の原因になりうる。
- 改善方針: wrapper も撤去対象に含める。

### 2. placeholder / stale 設定が残っている

- `package.json` の `main: "index.js"` は実在しないファイルを指す。
- `package.json` の `description` / `author` / `keywords` が空。
- `manifest.json` の `"description": "Movie clipping 001"` はプレースホルダのまま Chrome の拡張一覧に出る。

改善方針: placeholder は TODO 化するか削除し、配布用メタデータは実態に合わせる。

### 3. Disney+ 側の UI 文言が機能を表していない

- 問題: `Left Button`, `Right Button 1` のような generic label が残っている。
- どう壊れるか: runtime error ではないが、UI と内部動作の対応が追えず仕様理解コストが高い。
- 改善方針: 動作ベースの名前に変える。

## Naming / Data Inconsistencies

### field 名の揺れ

外部入力（サイト / backend）には依然として複数形が来る。**ただし再生経路については `src/shared/playbackBridgeValidation.js` が入口で camelCase へ正規化するようになった。**

| 概念 | 外部入力に出てくる名前 | 正規化後 | 正規化される経路 |
| --- | --- | --- | --- |
| 開始時刻 | 再生は `StartTime`, `startTime`, `starttime`、保存は `startTime`, `StartTime` | `startTime` | 再生ブリッジ / Netflix clip 選択 / 保存同期 |
| 終了時刻 | 再生は `EndTime`, `endTime`, `endtime`、保存は `endTime`, `EndTime` | `endTime` | 同上 |
| URL | 再生ブリッジは `url`、Netflix 選択は `url`, `URL`, `Url`、保存は `url`, `URL` | `url` | 同上 |
| ID | `id`, `clipId` | `clipId`（playlist は `id` も併記） | 再生ブリッジ / Netflix clip 選択 |
| タイトル | playback は `title`, `clipname`、保存同期は `title`, `clipName` | 契約ごとのキーを保持 | 再生ブリッジ / 保存同期 |
| ユーザー名 | `user`, `username` | 両方保持 | 再生ブリッジのみ（保存同期 payload では破棄） |

入口で契約が固定されていない経路:

- なし（`GET /api/v1/clips` の応答は `background/clips.js#normalizeClipListItem()` で正規化してから content へ渡す）

`toExtensionClipPayload()` は `startTime` / `StartTime` などの alias を受けるが、保存同期用の canonical payload を返す正規化境界である。再生ブリッジとは別契約なので、`clipName` と `clipname` を一律に置換しない。

改善の方向: 新しい経路を足すときは必ず共通検証器を通し、途中の関数には正規化済み shape だけを渡す。

### service 名の揺れ

3 つの対応表がずれている。

| 場所 | 扱う値 |
| --- | --- |
| `src/content/common.js#detectService()` | `Netflix`, `Disney+`, `Prime Video`, `YouTube`, `Hulu`, `Unknown` |
| `src/util/services.js#SERVICE_BASE_URL` | `netflix`, `prime`, `disneyplus`, `amazon`, `youtube`（**Hulu なし**） |
| `src/shared/playbackBridgeValidation.js` | `netflix`, `disneyplus` のみ（それ以外は拒否） |

- なぜ問題か: helper は Hulu を識別できるが、manifest は Hulu に content script を注入せず、再生契約も拒否する。「識別可能」と「対応済み」が一致していない。
- 改善方針: internal enum を 1 つ決める。対応サービスを増やすときは manifest・再生制御・validator・契約バージョンを同時に更新する。

## Architectural Problems

### 巨大ファイルに責務が集中している

| ファイル | 行数 | 同居している責務 |
| --- | ---: | --- |
| `src/content/commentPanel.js` | 1,303 | パネル UI、取得、投稿、下書き、認証状態監視、フォーカス制御 |
| `src/content/content_disney.js` | 1,134 | 録画 UI、overlay、clip 再生、playlist、loop、自動遷移 |
| `src/content/content_netflix.js` | 1,001 | 録画 UI、一覧サイドバー、clip 再生、playlist、seek 補助、history hook |

- なぜ問題か: 1 箇所の修正が他機能へ波及しやすい。
- 改善方針: 少なくとも「録画」「一覧」「single clip mode」「playlist mode」「navigation」に分けたい。ただし再生所有権の呼び出し順は壊しやすいので、分割は所有権モデルを理解してから行う。

### Disney+ の `Playlist` と `Mode` の境界が曖昧

- 問題: `Playlist` と `Mode` が似たことを別々に持ち、loop 用ロジックと通常 playlist ロジックが別経路になっている。
- 改善方針: playlist 遷移ロジックを 1 系統に寄せる（Medium Risk #3 と同根）。

### state の正本は定まったが、投影先が多い

- 現状: 再生状態の正本は **background の ownership registry**（`chrome.storage.session.activePlaybackTabsV1`）に定まった。`chrome.storage.local` はその投影。
- 残る複雑さ: `sessionStorage` に `dextPlaybackContextV1` / `dextPlaybackOwnerTab` / `extAutoNavigation` の 3 つ、URL に `dextPlaybackOwner` があり、生存範囲がそれぞれ違う。
- なぜ問題か: どれを直せば挙動が変わるのか、モデルを理解しないと判断できない。
- 改善方針: 構造は妥当なので、統合ではなく `READMEFORLLM.md` の「再生所有権」節を先に読ませる運用で対処する。

### サイトとの契約は明文化されたが、拡張側にしか無い部分が残る

- 対応済み: 再生ハンドオフは `docs/localhost-playback-bridge-contract-v1.md` に、認証連携は PR #115 で明確化。
- 対応済み: 記録一覧はサイトの `GET /api/v1/clips` へ移行し、拡張が依存する項目は `background/clips.js#normalizeClipListItem()` と `test/background/clips.test.js` に固定した。
- 未対応: サイト側は Prisma の `include: { user: true }` をそのまま返すため、応答には拡張が使わない user の全カラムが含まれる（サイト issue #55）。正規化で捨てているが、サイト側が絞れば正規化も追随させる。

## Fragile Areas

### DOM selector 依存

- Netflix: `[data-uia="controls-standard"]`, `[data-uia="control-forward10"]`, `[data-uia^="control-volume-"]`, `[data-uia="video-title"]`
- Disney+: overlay root / title bug / progress bar 系（shadow DOM 越しの取得を含む）

なぜ危険か: サービス側 UI 変更に直接影響される。自動テストでは検知できない。

### 非公開 API 依存

`src/background/background.js` は `window.netflix.appContext.state.playerApp.getAPI()` を使う。完全に Netflix 内部実装依存で、破壊的変更を検知しづらい。

### 所有権 / context / 自動遷移マーカーの組み合わせ

- 対象: `src/background/playbackOwnership.js`, `src/content/playbackOwnership.js`, `src/content/playbackContext.js`, `src/content/common.js` の marker 3 関数
- なぜ危険か: どれも「fail closed」で設計されている。片方だけ緩めると、他タブの状態を借りる方向へ静かに退行する。
- 壊れ方: タブ A の再生状態でタブ B のコメントが投稿される、といった検知しにくい混線になる。

### `window.open()` と `window.location.href` 依存

同じコードでも「新規タブ」「既存タブ」「localhost 経由」で挙動が変わる。playlist 開始、Netflix 一覧、cross-URL 自動遷移は owner nonce を URL に載せるため、その経路では query param を保持する。一方、localhost の `clipSelected` / `SET_CLIP_DATA` は意図的に URL 遷移と nonce 付与をせず、background が source tab または opener tab に一致する唯一の pending から legacy nonce を解決する。`targetTabId` は明示 nonce を事前束縛した claim の許可条件であり、legacy 解決には使わない。この2系統を一律化しない。

## LLM Danger Zones

### ここは雑に触らない方がいい

- `src/shared/playbackBridgeValidation.js`
  - 理由: content と background の両方が同じ規則で二重検証する前提。片側だけ変えると信頼境界が崩れる。
- `src/background/playbackOwnership.js`
  - 理由: storage 更新はロールバック付きのトランザクションになっている。途中で return を足すと部分更新が残る。
- `src/content/playbackContext.js`
  - 理由: `initialized: true, context: null` と未初期化の区別が、他タブ状態の borrow を防いでいる。
- `src/content/common.js` の `markAutoNavigation` / `isAutoNavigation` / `consumeAutoNavigation`
  - 理由: nonce + route 束縛の one-shot marker。`localStorage` へ戻すとタブ間で誤判定する。
- `src/content/getClipData.js` / `src/content/extension_link.js`
  - 理由: サイトとの契約面。未使用に見えるコード（`SET_CLIP_DATA` など）でも将来互換のため残す約束になっている。
- `src/background/background.js#handleSeekMessage()`
  - 理由: isolated world と MAIN world の境界。単純 refactor が全停止につながる。

### 触る前に最低限やること

1. reader / writer を横断検索する
2. 関連する storage key と message type を確認する
3. `docs/localhost-playback-bridge-contract-v1.md` に該当する規則が無いか確認する
4. `npm run lint` と `npm test` を通す。webpack entry / import 先を変えた場合は `npm run build` も通す
5. サイト依存かどうかを切り分け、サイトリポの実パス・branch・commit を確認する

## Quick Wins

短時間で効果が出やすいものです。

1. Netflix の `wrapButton` を撤去対象に含める
   理由: ボタン撤去後の orphan wrapper を残さずに済む。影響範囲が狭い。
2. `manifest.json` の `description` と `package.json` のメタデータを実態に合わせる
   理由: 配布時に見える文言なので、コストの割に効果が分かりやすい。
3. Disney+ のボタン label を動作ベースの名前に変える
   理由: 仕様理解コストが下がる。

## Suggested Refactor Order

1. 表面的な誤読要因を消す
   対象: `wrapButton` cleanup、placeholder メタデータ、Disney+ label
2. サービス enum を 1 本化する
   対象: `src/content/common.js#detectService()`、`src/util/services.js`、`src/shared/playbackBridgeValidation.js`
3. Disney+ の loop と playlist を 1 系統に寄せる
   対象: `content_disney.js` の `Mode` / `Playlist`
4. 巨大ファイルを分割する
   対象: `content_netflix.js` → 録画 / 一覧 / clip / playlist / navigation
5. 保存失敗のユーザー通知を足す
   対象: `common.js#openMemoSidebar()`

**再生所有権・入力検証・認証まわりは現状で意図した設計になっている。リファクタ対象に入れない。**

## 最優先で直すべき3つ

### 1. build と再読込の境界を守る

- 理由: これだけが「拡張がまったく動かない」を起こしうる。
- 具体箇所: `manifest.json`, `webpack.config.js`, `.gitignore`, `/build-check` スキル
- 対応: webpack 対象の変更後は `npm run build` を行い、その後 Chrome の拡張と対象ページを再読み込みする。直接参照 script の変更では build は不要だが、同じ再読み込みが必要。

### 2. サービス混在 playlist の実機確認

- 理由: 契約上は成立しうるのに、動作を誰も確認していない。
- 具体箇所: `content_netflix.js#playlistNextClip()`, `content_disney.js#playlistNextClip()`, `buildClipUrl()`

### 3. `renderClipList()` の ID フォールバック

- 理由: 1 行で防げるのに、当たると一覧からの再生が全滅する。
- 具体箇所: `src/content/content_netflix.js#renderClipList()`

## 今は触らない方がいい3つ

### 1. `SET_CLIP_DATA` 経路の削除

- 理由: この repo 内に producer は無く、契約 v1 が「将来互換のため維持する」と定めている。site 側 producer の有無は対象 site revision で別途確認する。

### 2. `currentClipId` / `nextClip` の削除

- 理由: 所有権 snapshot のキーとして background が読み書きしている。かつての「write-only」ではない。

### 3. 二重検証（content + background）の一本化

- 理由: content は page 由来データを受け取る信頼境界であり、buggy / compromised な extension context から runtime message が来る可能性もある。background 側の再検証を外すと、未検証の `BEGIN_PLAYBACK_HANDOFF` が権限の強い処理へ到達する。
