# テスト一覧

`npm test`（`node --test`）で実行する。依存追加なし、DOM は各テストが必要な分だけスタブする。
現在 **17 ファイル / 170 tests**。

フォルダ構成は `src/` をミラーする。`manifest.test.mjs` だけは対応する src モジュールが
無いため直下に置く。拡張子が `.js` と `.mjs` で混在しているが、`package.json` に
`"type": "module"` が無いため、いずれも Node の module 検出で ESM として読まれる。

---

## background

### `background/auth.test.js` (25)

対象: `authState.js` / `instanceId.js` / `tokenRefresh.js` / `sync.js`

認証状態の書き込みがすべて同じ mutex を通ることと、順序が入れ替わっても
トークンを失わないことを固定する。

- 保存・解除・401・リフレッシュが mutex の呼び出し順に適用される
- 古い 401 が、再連携で保存された新しいトークンを消さない（sync / refresh の両方）
- instance ID の破損を検出したら認証解除して再生成する。有効な ID の読み取りは
  実行中の認証リクエストにブロックされない
- 通信が応答しないとき、タイムアウトして mutex を解放する（sync / refresh）
- sync は成功応答が受理した ID だけをキューから消す。応答が壊れていれば全件残す
- sync 中に追加されたクリップが消えない
- ログインタブは全呼び出しで 1 枚に集約され、作成失敗時はクールダウンを開始しない

### `background/comments.test.js` (18)

対象: `comments.js`

コメント API の入力検証、応答スキーマ検証、認証競合、タイムアウト。

- clipId / limit / cursor の型と範囲、本文の trim と 1〜500 文字
- GET は 200・POST は 201 だけを成功とし、応答の全フィールドを型検証する
- 429 を `rate_limited` として返す
- 古い 401 が新しいトークンを消さない。401 処理中に入った再連携は完了後に保存される
- 締切は排他キューの待ち時間を含む。完了済みの応答は、時計が締切を越えただけでは
  タイムアウトにしない

### `background/clips.test.js` (16)

対象: `clips.js`

記録一覧 API のリクエスト組み立てと、応答行の正規化。

- title / limit をサイトが受け付ける範囲へ丸める。title が無ければ絞り込まない
- 応答行から再生 handoff に必要な項目だけを取り出す（サイトが返す user の余分な列を
  持ち込まない）
- 文字列の切り詰めがサロゲートペアを壊さない
- 壊れた行は一覧ごと落とさず、その行だけ捨てる
- status / 非配列 / 通信失敗 / 無応答をそれぞれ固定の理由で返す

### `background/playbackOwnership.test.js` (21)

対象: `background/playbackOwnership.js`

タブ別の再生所有権。この PR で最も分岐が多い箇所。

- handoff を claim できるのは、発行元タブと opener の子タブだけ
- nonce 無しの claim は opener に紐づく handoff を 1 件だけ拾う。候補が複数なら拒否
- 明示された不正な nonce は、nonce 無し経路へフォールバックしない
- registry の継承プロパティを読み書きしない（プロトタイプ汚染対策）
- 再読み込みは所有者を維持し、手動遷移は解除、事前登録した遷移先は維持
- 所有者の解除・失効後は、残っている最新スナップショットを復元する
- ストレージ書き込みが片側だけ失敗したら両方を元に戻す

### `background/request.test.js` (3)

対象: `request.js`

`fetchJsonWithTimeout` が、応答ヘッダー待ちと JSON 本文の読み込みの両方で中断すること。
中断タイマーが実際に発火するまでは、完了した応答を受理する。

### `background/detachedTasks.test.js` (3)

対象: `detachedTasks.js`

完了を待たないタスクが、失敗しても未処理の Promise 拒否にならないこと。
再生クリーンアップの失敗は同じアラームを再登録する。リカバリ自体の失敗も封じ込める。

---

## content

### `content/commentPanel.test.js` (14)

対象: `commentPanel.js`

- 再生中クリップの解決（単体 / プレイリスト、旧形式の state へのフォールバック）
- サーバー ID を持たないローカル録画クリップは `null` にする
- 送信中に書き換えた次の下書きを消さない
- 投稿成否が不明な失敗は、一覧を取り直して確認させる
- IME 変換中の Escape でパネルを閉じない
- 投稿中の認証変更が成功応答を stale 扱いにしない

### `content/common.test.mjs` (15)

対象: `content/common.js`

メモサイドバーのライフサイクルと、共通フォーマッタ。

- 古い保存完了が、開き直したサイドバーを書き換えない
- 別プレイヤーで開き直しても元のプレイヤー幅を正確に復元する（空文字含む）
- 保存失敗時は下書きを保持して再試行できる（同期 throw も含む）
- サイト側の DOM 差し替えで外された場合もリスナーを解除して幅を戻す
- Enter は名前入力欄からのみ送信。Escape は IME 変換を尊重する
- `formatSeconds` は 1 時間未満 `m:ss` / 以上 `h:mm:ss`、不正値は 0 に丸める
- `cleanTitleText` / `buildClipName`

### `content/clipList.test.mjs` (5)

対象: `content/clipList.js`

記録一覧パネルの非同期整合。

- 失敗したリクエストを重複クリックなしで再試行できる
- 閉じたパネルは、成功・失敗どちらの遅延応答も無視する
- 古い応答が新しいリクエストを上書きしない
- 応答が壊れていたら空一覧ではなく再試行を出す

### `content/playbackOwnership.test.js` (8)

対象: `content/playbackOwnership.js`

- URL の nonce が明示されていれば opener handoff へフォールバックしない
- nonce 生成は `randomUUID` が無ければ安全な乱数から作り、乱数源が無ければ拒否する
- 古いタブ内 nonce は、遅れて届いた handoff へフォールバックする

### `content/playbackContext.test.js` (8)

対象: `content/playbackContext.js`

タブ単位の再生コンテキストが、他タブのグローバル状態を borrow しないこと。

- 初期化時に「明示的な null」を記録する（未初期化との区別）
- 同じ値の書き込みは通知を合流させる
- `sessionStorage` が書けない環境でもモジュール内スナップショットでタブ分離を維持する
- ページ側によるストレージ改竄を後から拾わない

### `content/getClipData.test.js` (5)

対象: `content/getClipData.js`

サイトから受け取る再生ハンドオフ入力の入口。

- payload 欠落・別 origin / source からの window message を background へ渡さない
- 不正なプレイリストはストレージにも遷移にも到達しない
- `BEGIN_PLAYBACK_HANDOFF` の失敗時は遷移しない

### `content/integrationHelpers.test.mjs` (5)

対象: `common.js` / `content_netflix.js` / `content_disney.js` の結合部分

- 自動遷移マーカーが、別タブの teardown を抑制しない
- Disney+ の自動遷移マーカーは 2 回目の SPA 遷移より前に消費される
- キャンセルされた Netflix の video 待機が Observer を解除して解決する
- Disney+ のボタンラベルが同じ値なら text node を書き換えない（DOM 監視の自己再発火防止）

---

## shared

### `shared/playbackBridgeValidation.test.js` (14)

対象: `shared/playbackBridgeValidation.js`

サイト⇄拡張の再生ハンドオフ入力契約。正典は
[`docs/localhost-playback-bridge-contract-v1.md`](../docs/localhost-playback-bridge-contract-v1.md)。

- Cookie は許可リスト方式で読み、値の `=` を保持する。不正な percent encoding は
  そのキーだけ無効にする
- `clipSelected` は detail の clipId を正とし、Cookie 側と食い違えば拒否する
- 対象サービスと一致する HTTPS URL だけを許可する
- プレイリストは `order` の重複・件数上限・JSON 不正・バイト上限を拒否する
- 1 項目でも不正なら、スナップショット全体を拒否する

---

## その他

### `manifest.test.mjs` (4)

`manifest.json` と `dist/` の整合。

- Disney+ は content bundle より前に、MAIN world へ history hook を注入する
- Netflix に isolated world の重複 hook を入れない
- manifest が参照する webpack bundle がすべて存在し、未バンドルの localhost bridge
  ソースを直接参照していない
- permissions と web_accessible_resources がレビュー済みの範囲を出ていない

### `util/historyChange.test.mjs` (1)

`util/history_change.js` が二重フックされず、pushState / replaceState / popstate の
URL を正しく通知すること。

### `ui/icons.test.js` (5)

`ui/icons.js` のアイコン名バリデーション。`createIcon()` は正常系で
`document.createElement` を使うため、node 上では未知名の throw 経路だけを検証する。
