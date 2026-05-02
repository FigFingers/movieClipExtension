# CODE_ISSUES_FOR_LLM

## Overview

このドキュメントは `READMEFORLLM.md` の補助資料です。

- `READMEFORLLM.md`: 構造と流れを理解するための資料
- `CODE_ISSUES_FOR_LLM.md`: 危険箇所と改善順を判断するための資料

最初に押さえるべき論点は次の 5 つです。

| 論点 | 何が起きているか | 先に見る場所 |
| --- | --- | --- |
| 単体 clip 再生の不整合 | clip 選択から再生開始までの handoff が 1 本化されていない | `src/content/content_netflix.js` |
| navigation 周りの壊れやすさ | history hook、`beforeunload`、自動遷移が複雑に絡む | `src/util/history_change.js`, `src/content/content_netflix.js`, `src/content/content_disney.js` |
| データ shape の揺れ | `id` / `clipId`、`url` / `URL` などが混在 | `src/content/*`, `src/util/services.js` |
| build と実行物のズレ | manifest は `dist/` を読むが、`dist/` は git 管理されていない | `manifest.json`, `webpack.config.js`, `.gitignore` |
| 外部依存の暗黙契約 | localhost page / backend 前提の処理が repo 単体では閉じていない | `src/content/getClipData.js`, `src/api.js`, `src/content/common.js` |

読み方の目安:

1. まず `High Risk Issues` を読む
2. 次に `LLM Danger Zones` を読む
3. 実際に直すときは `Quick Wins` と `Suggested Refactor Order` を使う

## High Risk Issues

### 1. Netflix の single-clip handoff が repo 内で閉じていない

- 問題: `src/content/content_netflix.js#selectClip()` は clip を選んだときに cookie と `playClipSystemKey` は書くが、`chrome.storage.local.clip` は書かない。一方、再生開始側の `init()` は `loadClipFromStorage()` で `clip` を読む前提になっている。
- なぜ危険か: 入口と出口で参照している state が一致していない。
- どう壊れるか: Netflix 一覧から clip を開いても、新規タブ側で clip ループ再生が始まらない可能性が高い。
- 改善方針: single-clip の handoff を 1 本に寄せる。最も自然なのは `chrome.storage.local.clip` を正本にする方法。

### 2. cookie relay が origin をまたいでいて repo 内だけでは成立しない

- 問題: `src/content/content_netflix.js#setClipDataOnCookies()` は Netflix origin の cookie に書き、`src/content/getClipData.js#getCookies()` は localhost origin の cookie を読む。
- なぜ危険か: 同じ `document.cookie` に見えても origin が違うので共有されない。
- どう壊れるか: `clipSelected` 経路で localhost 側が期待した clip 情報を読めない。外部 page 側に補完がなければ flow が成立しない。
- 改善方針: cookie relay をやめて storage / message に統一するか、外部 page を含む正式契約を明文化する。

### 3. history hook が多重注入される

- 問題: `src/util/history_change.js` が `manifest.json`、`src/inject/inject_script.js`、`src/content/content_netflix.js#injectHistoryHook()` の 3 経路から入りうる。
- なぜ危険か: `pushState` / `replaceState` を何重にもラップする構造になっている。
- どう壊れるか: `historyChange` が重複発火し、record state reset や `HISTORY_CHANGE` message が過剰に飛ぶ。症状が二次不具合に見えるので調査も難しくなる。
- 改善方針: まず `history_change.js` 自体に idempotency guard を入れ、その後に注入経路を整理する。

### 4. manifest が `dist/` を読むのに、`dist/` は git 管理されていない

- 問題: `manifest.json` は `dist/content.js` と `dist/content_disney.js` を読み込むが、`.gitignore` では `/dist` が無視されている。
- なぜ危険か: source を直しても build しなければ実行コードは変わらない。
- どう壊れるか: LLM が `src/content/*.js` を修正してもブラウザでは古い bundle が動き続ける。clean clone では extension が動かない可能性もある。
- 改善方針: `dist/` を追跡対象にするか、manifest を source 直読みに寄せるか、build 必須運用を強く固定する。

### 5. background seek が active tab 前提になっている

- 問題: `src/background/background.js` の seek bridge は `sender.tab` ではなく `chrome.tabs.query({ active: true, currentWindow: true })` の結果に対して実行する。
- なぜ危険か: message を送った tab と seek 対象 tab が一致しない。
- どう壊れるか: 再生中タブが非アクティブなら seek されず、別タブがアクティブなら誤ったタブに処理が飛ぶ。
- 改善方針: `sender.tab.id` を優先して使う。必要なら tab id を message payload へ含める。

### 6. playlist の cross-service 継続が壊れやすい

- 問題: `src/content/getClipData.js#playQueue()` は最初の遷移で `service` を見て URL を組むが、その後の Netflix `playlistNextClip()` は `https://www.netflix.com${next.url}` を直書きし、Disney `buildClipUrl()` は current origin を基準に relative URL を組む。
- なぜ危険か: 後続遷移で `next.service` が見られていない。
- どう壊れるか: Netflix -> Disney+、Disney+ -> Netflix、Prime / YouTube 混在 playlist が誤 URL に飛ぶ可能性が高い。
- 改善方針: 全 hop で service-aware な URL builder を通す。

### 7. API / page 由来の文字列を `innerHTML` に入れている

- 問題: `src/content/content_netflix.js#renderClipList()` と `src/content/common.js#openMemoSidebar()` が API / page 由来の値を `innerHTML` に入れている。
- なぜ危険か: HTML エスケープがなく、extension DOM にそのまま注入される。
- どう壊れるか: backend データや page 文字列に HTML が混ざると、意図しない DOM 注入が起きる。
- 改善方針: `textContent` と DOM ノード組み立てに置き換える。

### 8. localhost の全 cookie を `chrome.storage.local.clip` に移している

- 問題: `src/content/getClipData.js#getCookies()` は必要 key のみを抜かず、localhost origin の cookie を丸ごと object 化して `chrome.storage.local.clip` に保存する。
- なぜ危険か: clip data と無関係な cookie まで state に混ざる。
- どう壊れるか: clip shape が汚染される。推定だが、非 `HttpOnly` な localhost セッション cookie まで保存される可能性がある。
- 改善方針: whitelist 方式に変更し、必要 key だけを抽出する。

## Medium Risk Issues

### 1. `sendData()` が `response.ok` を見ずに `response.json()` を呼ぶ

- 問題: `src/content/common.js#sendData()` が HTTP status を見ない。
- なぜ危険か: backend が非 2xx や非 JSON を返したとき、失敗原因が分かりにくい。
- どう壊れるか: 保存失敗が `JSON parse error` に見え、障害切り分けが難しくなる。
- 改善方針: `response.ok` と JSON parse を分けて扱う。

### 2. 保存失敗でも memo sidebar が閉じる

- 問題: `src/content/common.js#openMemoSidebar()` は `.catch(...).finally(...)` で必ず sidebar を閉じ、動画再生を再開する。
- なぜ危険か: 失敗時の再入力導線が消える。
- どう壊れるか: ユーザーは保存に失敗したことに気づきにくい。
- 改善方針: 成功時のみ close し、失敗時は form を残す。

### 3. `SET_SESSION_DATA` fallback message に受信側がない

- 問題: `src/content/getClipData.js#safeSetStorage()` の fallback message は `SET_SESSION_DATA` だが、repo 内に receiver が見当たらない。
- なぜ危険か: fallback があるように見えて、実質 no-op になっている。
- どう壊れるか: `chrome.storage.local.set()` 失敗時に silent failure になる。
- 改善方針: 受信側を実装するか、fallback 自体を削る。

### 4. `setStorageAsync()` が Netflix file 内で二重定義されている

- 問題: `src/content/content_netflix.js` に同名関数 `setStorageAsync()` が 2 回ある。
- なぜ危険か: 後勝ちで上書きされるため、どちらが有効か読みづらい。
- どう壊れるか: 片方だけ修正しても実行結果が変わらない。
- 改善方針: 1 つに統合する。

### 5. 未使用の入り口が残っている

- 問題: `src/content/content_netflix.js#getLoopPlaylist()`、`src/content/content_disney.js#loadPlaylistClip()` など、定義はあるが repo 内で実フローに乗っていない関数がある。
- なぜ危険か: 「まだ使われている正式ルート」と誤認しやすい。
- どう壊れるか: そこを修正しても挙動が変わらず、逆に本流の修正を見落とす。
- 改善方針: write/read path を確認し、未使用なら削除か TODO 明記に寄せる。

### 6. Disney+ の loop 切り替えが playlist state と噛み合っていない

- 問題: `src/content/content_disney.js#toggleLoop()` は playlist state ではなく clip state 寄りの `loadClipData()` を使う。
- なぜ危険か: loop と playlist mode が別系統の実装になっている。
- どう壊れるか: playlist 再生中に loop toggle すると single clip 前提の状態に寄る可能性がある。
- 改善方針: loop の責務を `Mode` / `Playlist` に寄せて一元化する。

### 7. clip 一覧が `item.id` に依存しすぎている

- 問題: `src/content/content_netflix.js#renderClipList()` は `item.id` しか見ない。
- なぜ危険か: repo 内には `id` と `clipId` の両形が存在する。
- どう壊れるか: backend が `clipId` だけ返した場合、`fetchClip?id=undefined` になる。
- 改善方針: `item.id ?? item.clipId` を使うか、contract を固定する。

### 8. Netflix UI observer が空 wrapper / spacer を残す

- 問題: `src/content/content_netflix.js` の UI observer / record observer はボタンだけ外し、wrapper や spacer を掃除しない。
- なぜ危険か: DOM だけ少しずつ蓄積する。
- どう壊れるか: 再描画のたびに見た目崩れや diff 誤判定の原因になる。
- 改善方針: wrapper / spacer も管理対象に含める。

### 9. localhost URL が複数箇所に散っている

- 問題: `src/api.js`、`content_netflix.js#selectClip()`、`src/background/background.js#DEMO_BASE_URL`、`manifest.json#host_permissions` に localhost 設定が分散している。
- なぜ危険か: host / port 変更時に更新漏れが出やすい。
- どう壊れるか: 一部だけ別 port を見て通信に失敗する。
- 改善方針: frontend 側だけでも共通定数へ寄せる。

### 10. `playQueue` / `clip` の shape validation がない

- 問題: 外部 localhost page や backend から来る payload をほぼそのまま信じている。
- なぜ危険か: 欠損 field や型崩れがそのまま runtime error になる。
- どう壊れるか: `startTime` 欠落、`order` 欠落、`url` 型不正で再生・遷移が壊れる。
- 改善方針: read 時に正規化と必須 field validation を入れる。

## Low Risk Issues

### 1. 明らかな placeholder / stale 設定が残っている

- `src/background/background.js` の `let playClipSystemKey = "initialValue";` は未使用。
- `src/content/content_disney.js#myCustomActionRight2()` は console 出力だけで実機能を持たない。
- `package.json` の `main: "index.js"` は実態と合っていない。
- `npm test` はダミー失敗のままで、検証コマンドとして機能していない。

なぜ問題か:

- 直接の壊れ方は弱いが、「これは何かで使われているはず」という誤読を生む。

改善方針:

- placeholder は TODO 化するか削除し、stale 設定は実態に合わせる。

### 2. Disney+ 側の UI 文言が機能を表していない

- 問題: `Left Button`, `Right Button 1`, `Right Button 2` のような generic label が残っている。
- なぜ問題か: UI と内部動作の対応が追えない。
- どう壊れるか: 直接の runtime error ではないが、仕様理解コストが高い。
- 改善方針: 動作ベースの名前に変える。

## Naming / Data Inconsistencies

### field 名の揺れ

| 概念 | 実際に出てくる名前 | 何が危険か |
| --- | --- | --- |
| 開始時刻 | `StartTime`, `startTime`, `starttime` | writer / reader が暗黙正規化に依存する |
| 終了時刻 | `EndTime`, `endTime`, `endtime` | 比較や保存の入口が増えて壊れやすい |
| URL | `URL`, `url`, `Url` | playlist 遷移や URL 比較がずれやすい |
| タイトル | `title`, `clipName`, `clipname` | 表示名が経路ごとに変わる |
| ID | `id`, `clipId` | `fetchClip?id=...` が壊れやすい |
| ユーザー名 | `user`, `username` | 表示と保存内容がずれる |

改善の方向:

- 外部入力は多形でもよいが、内部表現は 1 つに固定する。
- 正規化は read の入口で行い、途中の関数には統一 shape だけを渡す。

### service 名の揺れ

確認できた service 文字列は `Netflix`, `DisneyPlus`, `Prime Video`, `prime`, `disney+`, `amazonprime`, `Hulu` などに分かれている。

- なぜ問題か: `detectService()` と URL builder の対応表がずれている。
- どう壊れるか: support 判定や URL 生成で意図しない分岐に入る。
- 改善方針: internal enum を 1 つ決め、外部入力時だけマッピングする。

## Architectural Problems

### Netflix 実装が大きすぎて責務が混ざっている

- 対象: `src/content/content_netflix.js`
- 問題: 録画 UI、clip 一覧、playlist、seek 補助、history hook、cleanup が 1 file に同居している。
- なぜ問題か: 1 箇所の修正が他機能へ波及しやすい。
- 改善方針: 少なくとも「録画」「一覧」「single clip mode」「playlist mode」「navigation」に分けたい。

### Disney+ は分割されているが責務境界がまだ曖昧

- 対象: `src/content/content_disney.js`
- 問題: `Playlist` と `Mode` が似たことを別々に持っている。
- なぜ問題か: loop 用ロジックと通常 playlist ロジックが別経路になっている。
- 改善方針: playlist 遷移ロジックを 1 系統に寄せる。

### state の正本が 1 つに定まっていない

- 対象: `chrome.storage.local`, `sessionStorage`, `localStorage`, `document.cookie`
- 問題: mode / clip / playlist が複数ストアに分散している。
- なぜ問題か: どの state を直せば挙動が変わるのか判断しづらい。
- 改善方針: 永続状態は `chrome.storage.local`、一時状態だけを session/localStorage に限定する。

### 外部 localhost page / backend との契約が暗黙

- 対象: `src/content/getClipData.js`, `src/api.js`, `src/content/common.js`
- 問題: repo 単体では成立しない flow があるが、契約がコード内に散っている。
- なぜ問題か: dead code に見えるものを削ると、外部連携が壊れる可能性がある。
- 改善方針: API、message、cookie 契約を別資料として固定する。

## Fragile Areas

### DOM selector 依存

- Netflix:
  - `[data-uia="controls-standard"]`
  - `[data-uia="control-forward10"]`
  - `[data-uia="video-title"]`
- Disney+:
  - `.controls__footer__wrapper`
  - `progress-bar`
  - `.progress-bar__seekable-range`

なぜ危険か:

- サービス側 UI 変更に直接影響される。

### 非公開 API 依存

- `src/background/background.js` は `window.netflix.appContext.state.playerApp.getAPI()` を使う。

なぜ危険か:

- 完全に Netflix 内部実装依存で、破壊的変更を検知しづらい。

### `beforeunload` cleanup と auto navigation flag の組み合わせ

- 対象: Netflix / Disney+ 両方
- なぜ危険か: 一見不要に見える cleanup が、自動遷移の成立条件になっている。
- 壊れ方: flag を雑に消すと playlist 継続が止まる。

### `window.open()` と `window.location.href` 依存

- なぜ危険か: tab 状態、active tab、origin に強く依存する。
- 壊れ方: 同じコードでも「新規タブ」「既存タブ」「localhost 経由」で挙動が変わる。

## LLM Danger Zones

### ここは雑に触らない方がいい

- `src/content/content_netflix.js#selectClip()`
  - 理由: 見た目は完結しているが、実際は storage / cookie / tab 遷移の境界にいる。
- `src/util/history_change.js` と `src/inject/inject_script.js`
  - 理由: 二重注入の問題があるので、1 箇所だけ直すとさらに分かりにくくなる。
- `src/background/background.js#onMessage("seek")`
  - 理由: isolated world と MAIN world の境界で、単純 refactor が全停止につながる。
- `src/content/getClipData.js`
  - 理由: repo 外 contract が濃い。未使用に見えるコードでも即削除しない方がいい。
- `src/image/*.js`
  - 理由: utility ではなく side-effect import 前提。module 化で初期化順を壊しやすい。

### 触る前に最低限やること

1. reader / writer を横断検索する
2. 関連する storage key と message type を確認する
3. `dist/` 実行物に build が必要か確認する
4. localhost page / backend 依存かどうかを切り分ける

## Quick Wins

短時間で効果が出やすいものです。

1. `background.js` の seek target を `sender.tab.id` に変える
   理由: 影響範囲が狭く、誤動作を減らしやすい。
2. `history_change.js` に idempotency guard を入れる
   理由: 多重注入の被害をすぐに抑えられる。
3. `renderClipList()` と `openMemoSidebar()` から `innerHTML` を外す
   理由: 安全性を上げつつ、機能変更が比較的小さい。
4. `selectClip()` の clip handoff を明示する
   理由: single-clip 再生の根本不整合に直接効く。
5. dead message を明示する
   理由: `SET_SESSION_DATA` や `nf:init-bridge` のようなノイズを減らせる。

## Suggested Refactor Order

1. 再生 correctness を壊している部分を直す
   対象: `selectClip()` handoff、cookie relay mismatch、active-tab seek
2. navigation / history の多重副作用を止める
   対象: `history_change.js` guard、auto navigation 整理
3. data shape と URL 生成を正規化する
   対象: `services.js`、`getClipData.js`、field casing
4. playlist を service-aware にする
   対象: Netflix `playlistNextClip()`、Disney `buildClipUrl()`
5. UI / DOM 注入の安全性を上げる
   対象: `innerHTML` 排除、wrapper / spacer cleanup
6. dead code と placeholder を整理する
   対象: 未使用関数、二重定義、暫定 state

## 最優先で直すべき3つ

### 1. Netflix の single-clip handoff 不整合

- 理由: ユーザー機能そのものが成立していない可能性が高い。
- 具体箇所: `src/content/content_netflix.js#selectClip()`, `#loadClipFromStorage()`, `#init()`

### 2. active-tab 前提の seek bridge

- 理由: multi-tab 環境で壊れやすく、再現もしやすい。
- 具体箇所: `src/background/background.js`

### 3. history hook の多重注入

- 理由: 他の問題の症状を増幅し、デバッグを難しくする。
- 具体箇所: `src/util/history_change.js`, `src/inject/inject_script.js`, `src/content/content_netflix.js#injectHistoryHook()`

## 今は触らない方がいい3つ

### 1. `clipSelected` / cookie 経路の削除

- 理由: repo 内だけ見ると不整合だが、外部 localhost page 側の契約で補われている可能性がある。

### 2. `currentClipId` / `nextClip` の削除

- 理由: repo 内 reader は見えないが、外部 page / backend / 今後の機能で使われている可能性がある。

### 3. `src/image/*.js` の module 化

- 理由: 見た目は単純整理だが、Netflix 側の初期化順と `window.*` 依存を壊しやすい。
