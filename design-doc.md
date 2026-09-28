# Design Doc — Movie Clipper（仮称）

ステータス: たたき台 v0.3 / 作成日: 2026-09-11 / 設計オーナー: 未定

## 1. 目的、参照する実装、記法

[PRD](prd.md) の「区間を記録し、同期し、後で元の動画サイトで再生する」体験を、拡張 `FigFingers/movieClipExtension` とサイト `FigFingers/react--site` の間で成立させる設計を記す。動画ファイルは保存しない。対象動画サイトはNetflixとDisney+。

**参照基準:** ファイルパスと現行APIは両リポジトリの `develop` を基準とする。PR #139 の作業ブランチ自体は古い構成から分岐しているため、この文書中の `src/background/*` 等がそのブランチに存在するとは限らない。再生所有権の詳細は未マージの拡張PR #136（`123-fix/comment-playback-hardening`）の変更案を明示して参照する。「現行」は `develop`、「変更案」は実装・統合前の契約である。

本書では `clientItemId` は拡張が記録ごとに発行するUUID、`clipId` はサイトのDBが発行するクリップID、`extensionInstanceId` は拡張インストールの識別子を指す。記録の時間は拡張の `startTime/endTime`（秒）からサイトのAPI境界で変換する。保存完了表示、同期待ち表示、同期済み表示は別の状態とし、サイトへの受理前に「同期済み」と表示しない。

## 2. 全体構成と流れるデータ

### 記録と同期

~~~mermaid
flowchart TD
    A["Netflix / Disney+ 動画ページ"] -->|"作品URL・タイトル・開始/終了秒"| B["src/content/content_netflix.js / content_disney.js"]
    B -->|"clipName・区間・clientItemId"| C["src/content/extensionSync.js"]
    C -->|"pendingClips に記録"| D["chrome.storage.local"]
    C -->|"SYNC_PENDING_CLIPS"| E["src/background/background.js → sync.js"]
    E -->|"POST /api/extension/sync: Bearer・instanceId・items"| F["react--site API"]
    F -->|"acceptedItemIds またはエラー"| E
    E -->|"受理IDだけキューから除去・結果通知"| D
~~~

`src/content/common.js` の保存操作は `extensionSync.js#enqueueClip` に渡す。保存した記録は `src/shared/storage.js` のキー `pendingClips` に置く。`src/background/sync.js` は `src/api.js` の接続先へ送信し、サイトの `src/app/api/extension/sync/route.ts` が `src/server/schemas/extension.schema.ts` で入力を検証し、`src/server/services/extensions.ts` が認証・重複排除・DB登録を行う。ネットワークはBackgroundから使用する。キューへの書き込みとサイトへの同期は別の成功条件である。

### 連携、一覧、再生、コメント

| データの流れ | 送信内容 | 受信側・実ファイル | 戻り値または状態 |
| --- | --- | --- | --- |
| サイト `/account` → 拡張連携 | サイトのセッションで発行した単回リンクトークン、`extensionInstanceId` | サイト `/api/extension/link-token`・`/api/extension/link`、拡張 `src/content/extension_link.js` → `extensionSync.js` | 不透明な `extensionAuthToken`、`expiresAt`。拡張の `chrome.storage.local` に保存 |
| 拡張 → サイトの記録一覧 | Bearerトークン、検索する作品名など | 拡張PR #136の `src/content/clipList.js` → Background、サイト `GET /api/v1/clips?title=` | サイトの `{data,meta}` を一覧に表示。PR #136の経路は未マージ |
| サイト → 拡張の単体再生 | `clipSelected`、`clipId`、`service`、URL、開始・終了秒、任意の`requestId` | `src/content/getClipData.js` と拡張PR #136の `src/shared/playbackBridgeValidation.js` | 検証結果 `EXTENSION_PLAYBACK_HANDOFF_RESULT`。これは再生開始の確証ではない |
| サイト → 拡張のリスト再生 | `PLAY_PLAYLIST_START` とサイトの `localStorage.playQueue`（順序付き項目） | `src/content/getClipData.js` → Netflix/Disney+のcontent script | 最初の項目へ遷移。リスト内の順序と現在項目を追跡 |
| 拡張 → コメントAPI | `clipId`、本文、ページング、Bearerと`extensionInstanceId` | `src/background/comments.js`、サイトPR #62の `/api/extension/clips/{clipId}/comments` | コメント一覧または投稿結果。サイトPR #62は未マージ |

`manifest.json` はNetflix・Disney+ページにコンテンツスクリプト、開発サイトに `dist/extension_link.js` と `src/content/getClipData.js` を読み込ませる。`webpack.config.js` は `src/background/background.js` などを `dist/` にビルドする。接続先は現行 `src/api.js` の `http://localhost:3000/api/` であり、本番環境のURL・許可Originへの置換は未実装の配布課題。

## 3. 主な設計判断

| 判断 | 処理箇所・理由 | 守る条件 |
| --- | --- | --- |
| 動画ではなく区間メタデータを保存 | `extensionSync.js` が作品URL・タイトル・開始/終了秒を記録する | 元サイトで作品を視聴できない場合は再生できない |
| 端末キューを先に書き、その後同期する | `chrome.storage.local.pendingClips` に残せば通信断後に再送できる | サイト受理前の表示は「同期待ち」。同期結果を返せる場合は受理IDを照合して表示する |
| API通信とトークン更新をBackgroundに集める | `src/background/sync.js` と `tokenRefresh.js` が同じ排他処理を使う | 古い401応答で新しいトークンを消さない。認証失効後もキューを保持する |
| APIごとに認証・認可を行う | サイトの `/api/extension/*` はBearerとインスタンスIDを照合し、`/api/v1/*` はセッションを確認する。サービス層は対象クリップの所有者・閲覧権限を確認する | `userId` や `clipId` をUIが送ったという理由だけで許可しない。クリップ・コメントは初期設定で非公開 |
| 再生対象をタブに結び付ける | 拡張PR #136の `src/background/playbackOwnership.js` がタブID、nonce、経路、snapshotを管理する案 | 他タブ・古い遷移から現在の対象を上書きしない |
| サービスごとの再生処理を分ける | `content_netflix.js` と `content_disney.js` がそれぞれプレイヤーを操作する | 共通の入力検証と終了・ループ規則を適用する |

上の「守る条件」は実装確認項目でもある。とくに現行 `develop` の同期400処理とサイト側の論理削除ユーザー判定には未解決Issueがあり、設計条件を満たしたことを意味しない。

## 4. データの意味と保存場所

| 用語 | 何を表すか | 実装上の識別子・場所 |
| --- | --- | --- |
| 同期済みClip | サイトDBに登録された一つの区間。所有者、作品、時間範囲、名前を持つ | サイトの `clips.id` が `clipId`。閲覧・再生・コメントの参照先 |
| 未同期Clip（旧称PendingClip） | 拡張には記録したが、サイトが受理したと確認できていない区間。通信失敗時もこれを残す | `chrome.storage.local.pendingClips` の配列要素。`clientItemId` は再送時も同じ |
| 同期receipt | 同じ記録の再送による二重作成を防ぐサーバー側の受理記録 | サイトの `sync_receipts`。`linked_extension_id + client_item_id` が一意 |
| 利用者 | サイトにログインし、保存済みClipを所有する人 | サイトの `users.id`。`extensionInstanceId` とは別 |
| 拡張連携 | 拡張インストールと利用者を結び、API用トークンを管理する状態 | サイトの `linked_extensions`、拡張の `extensionInstanceId`、`extensionAuthToken`、`extensionTokenExpiresAt` |
| Playlist / 項目 | 保存済みClipの再生順を持つリストと、その中のClip参照 | サイトのPlaylistと紐づけデータ。再生時に順序付き `playQueue` へ変換 |
| Comment | サイトに保存された、特定の`clipId`に紐づく本文と投稿者 | サイトPR #62のコメントAPIとDB。拡張のコメント入力はサーバーIDを持つClipに限る |
| 再生所有権 / snapshot | 今どのタブがどのClip・リストを再生しているか、その時点の確定データ | 拡張PR #136の `activePlaybackTabsV1`（`chrome.storage.session`）と `playbackOwnerNonce`。現行 `develop` のグローバルな`clip/playQueue/playmode`とは区別 |

`clientItemId` と `clipId` は別物。現行 `POST /api/extension/sync` は `acceptedItemIds` のみを返し、両IDの対応表は返さない。コメントを付けるにはサイト側で発行された `clipId` を一覧などから取得する必要がある。対応表を同期応答に含めるのは将来の契約変更案であり、現行仕様として記さない。

| 保存場所 | 実際の内容 | 寿命と失敗時の扱い |
| --- | --- | --- |
| サイトDB | `clips`、`sync_receipts`、利用者・連携・プレイリスト・コメント | サイト側の削除・失効規則に従う |
| `chrome.storage.local` | `pendingClips`、拡張ID、トークン・期限、`lastSyncAt`、現行の再生互換キー | ブラウザ終了後も保持。未同期Clipにアプリ独自の件数・期間上限は設けない。Chromeの実容量・書込失敗は検知し、入力を保持して失敗を示す。未同期Clipを自動削除しない |
| `chrome.storage.session` | PR #136案のタブ別再生所有権・30秒の保留中引き継ぎ | ブラウザセッションとタブの寿命に従い解放 |
| 動画ページのメモリ・`sessionStorage` | 入力パネル、再生中のnonce、遷移補助 | タブ・画面の終了時に破棄。認証トークンを動画ページへ渡さない |

初期版では別アカウントへの連携し直しを利用フローとして設けない。端末データの保持量を無制限と保証するわけではなく、プラットフォームの容量制約に達した場合は保存失敗として扱う。

## 5. シーン記録と同期（FR-01〜04）

### 保存操作の順序

1. `content_netflix.js` / `content_disney.js` が現在の作品URL・タイトル・区間を得る。`extensionSync.js#toExtensionClipPayload` で `clientItemId` を発行し、有限数・時間の前後関係・対象URLを検証する。現行の検証が最短1秒を満たすかは別途確認する。
2. 入力名と区間を維持したまま `extensionSync.js#enqueueClip` で `pendingClips` に書く。ここは**端末への記録成功**であり、サイトへの同期成功ではない。
3. `SYNC_PENDING_CLIPS` を `background.js` に送り、`sync.js` が `POST /api/extension/sync` を試みる。未連携なら記録を残して「連携待ち」、通信不能なら「同期待ち」とする。
4. サイトが200と `acceptedItemIds` を返したら、要求時の `clientItemId` に照らして受理項目を確定する。**同期結果が判明してから**UIへ保存操作の結果を返す。受理された項目は「同期済み」、残りは「同期待ち」と表示する。無応答・不正応答は受理とみなさない。
5. 受理されたIDだけ `pendingClips` から外す。通信が切れて受理の有無が不明なら同じIDで再送する。`sync_receipts` によりサイト側で二重登録を防ぐ。

「保存できた」は端末への記録とサイトへの反映を区別して示す。通信待ちで操作を無期限に止めないため、同期の応答期限を設け、期限内に確定できなければ「端末に記録済み・サイトへの同期は保留」と返す。UIを同期の判定前に「同期済み」にしない。現行 `common.js` と `sync.js` がこの表示・応答順を満たすかは実装確認事項。

### 同期応答の扱い

| 観測した結果 | キューと画面の扱い | 再試行・実装上の注意 |
| --- | --- | --- |
| 200、送信IDと一致する `acceptedItemIds` が全件 | 該当項目だけキューから除き「同期済み」 | IDの重複・未知ID・欠落を検証してから削除 |
| 200、一部のIDのみ受理／空配列 | 受理IDだけ除き、残りは「同期待ち」 | 現行サイトは通常トランザクション単位で処理する。部分受理は拡張側の防御的な契約 |
| 200だが `acceptedItemIds` が欠落・不正 | 全件保持し「同期結果を確認できない」 | 現行 `sync.js` はフィールド欠落時に全件削除するため修正が必要 |
| 400、入力検証に失敗 | 全件保持し「送信できない記録がある」と表示 | 現行APIはバッチ全体の400で項目別の受理・拒否形式がない。問題項目を特定するか、個別再試行できる仕組みを設計する。現行 `sync.js` の400時削除は修正が必要 |
| 401、トークン期限切れ・失効 | 記録を保持し連携状態の確認を案内 | 新しいトークンが保存された後に古い要求の401で消さない |
| 403、Origin不許可 | 記録を保持し、接続設定の問題として扱う | 利用者のClip権限不足とは区別する。`CLIP_API_ALLOWED_ORIGINS` と拡張IDを確認し、同じ要求を無制限に繰り返さない |
| 通信断・タイムアウト・5xx | 記録を保持して「同期待ち」 | Backoffで再送する。サーバー受理後の応答消失も同じIDで再送 |
| 端末への書込失敗 | まだキューに記録されていない。入力を残し「保存できない」 | 成功と報告しない。容量不足等を確認して再試行 |

再送は保存後、連携完了後、Background起動時と `chrome.alarms` による周期処理で行う。現行は15分間隔。キューの読み書きと同期を直列化し、同期中の追加・編集を古い応答で消さない。サイトIssue #80の並行receipt競合が解消するまでは、二重送信時の500が残る。

## 6. 認証とサイトAPI

`/account` のログイン済みセッションで `POST /api/extension/link-token` を呼び、10分有効の単回リンクトークンを得る。`src/content/extension_link.js` がサイトの `window.postMessage` を受け取り、`extensionSync.js` が `extensionInstanceId` とトークンを `POST /api/extension/link` へ送る。サイトは90日有効の不透明な拡張用トークンと期限を返す。拡張はトークンの中身を解釈せず `chrome.storage.local` に保管する。

同期・コメント・更新のリクエストは `Authorization: Bearer <extensionAuthToken>` と `extensionInstanceId` を使う。サイトの `src/server/services/extensions.ts` はトークンのハッシュ、インスタンスID、失効・期限を照合する。`src/background/tokenRefresh.js` は同期と排他に更新する。解除はサイトの `POST /api/extension/unlink` で対象連携を失効させ、拡張には `EXTENSION_UNLINKED` を通知する。通知を取り逃した場合も次の認証要求で拒否する。

| API | 認証と検証の担当 | 応答と利用箇所 |
| --- | --- | --- |
| `POST /api/extension/link-token` | サイトのセッション。`src/app/api/extension/link-token/route.ts` | `linkToken`、`expiresAt` |
| `POST /api/extension/link` | OriginとZod入力、単回使用・期限をサービス層で検証 | `extensionAuthToken`、`expiresAt` |
| `POST /api/extension/sync` | Origin、Bearer、`extensionSyncBodySchema`、連携の有効性 | `{ok:true,acceptedItemIds}`。現行は`clipId`を返さない |
| `POST /api/extension/token/refresh` | Origin、Bearer、インスタンスID、旧トークンとの一致 | 新トークンと期限。旧トークンは以後使えない |
| `POST /api/extension/unlink` | サイトのセッションと連携所有者 | 失効した`extensionInstanceId` |
| `GET /api/v1/clips?title=` | サイトのクリップ閲覧規則、検索・ページング条件 | `{data,meta}`。認証・公開範囲は初期非公開のPRDに合わせる |

サイトIssue #81の論理削除ユーザー拒否、#86のリンク・ローテーション・解除の競合テストは未完了。サイトPR #62/#77の未マージ修正と混同しない。

## 7. 再生の引き継ぎと制御（FR-05・07・08）

### サイトから単体クリップを選んだとき

1. サイトの `src/lib/clips/playback.ts` が選んだ`clipId`、`service`、URL、開始/終了秒を再生ブリッジへ渡す。現行経路ではCookieと `clipSelected` イベントを併用する。PR #136案は `service` と `clipId` の整合を必須にするため、サイトPR #62を先に統合する。
2. 拡張の `src/content/getClipData.js` が受信する。PR #136案では `src/shared/playbackBridgeValidation.js` がサービスとURLホスト、HTTPS、時間範囲、Clip ID、文字列・入力サイズを正規化・検証する。不正なら再生状態を更新せず、`EXTENSION_PLAYBACK_HANDOFF_RESULT` に理由と`requestId`を返す。
3. 有効な要求ではnonceとsnapshotを `BEGIN_PLAYBACK_HANDOFF` でBackgroundへ送る。`src/background/playbackOwnership.js` 案は送信元タブID・nonce・対象`clipId`・再生先の経路・30秒の期限を保留レジストリに記録する。登録失敗なら遷移しない。
4. 登録成功後、サイト側が元の動画サイトへ遷移する現行方式で進める。URLに`dextPlaybackOwner`を付け、開始秒`t`を渡す。拡張がタブを新規作成する方式への変更はこのPRの前提にしない。
5. 遷移先の `content_netflix.js` / `content_disney.js` が `CLAIM_PLAYBACK_OWNERSHIP` を送り、BackgroundがタブID（必要ならopenerTabId）、nonce、URL経路と保留snapshotを照合する。合致したタブだけ`clip/playmode`等を適用する。プレイヤー準備後に開始位置へseekし、終了位置で停止する。単体ループONなら開始位置へ戻す。
6. Backgroundの「引き継ぎ受理」、遷移先の「所有権取得」、実プレイヤーの「再生開始」を別の結果として扱う。前二者が成功しても再生開始を計測しない。seek失敗、作品なし、ログイン切れ、期限切れはそれぞれ失敗として表示・記録する。

### プレイリストの次項目と通常遷移

サイトの `PLAY_PLAYLIST_START` は `localStorage.playQueue` の順序付き配列を読み、拡張が最大件数、各項目のID・URL・時間・`order`重複を検査してからsnapshotにする。現行 `develop` の `getClipData.js` はこれらを十分検証せず、PR #136案で強化する。再生時は現在の`order`を基準に次項目を決め、同じ作品ならseek、異なる作品なら`PREPARE_PLAYBACK_NAVIGATION`で予期する経路をBackgroundに記録してから遷移する。別タブのリストを上書きしない。末尾は停止し、明示的なリストループONのときだけ先頭に戻る。

ユーザーが通常の作品へ移動する、タブを閉じる、再生を終了する場合は `RELEASE_PLAYBACK_OWNERSHIP` またはタブ削除イベントで所有権を解放する。古いページの `UPDATE_PLAYBACK_OWNERSHIP` はタブID・nonce・経路が合わなければ拒否する。コメントパネルの投稿先は同じタブの現在の`clipId`に固定する。

**実装段階:** `develop` にはCookie/`playQueue`とグローバル再生キーが残る。ここに書いたnonce・タブ所有権の詳細は拡張PR #136で提案中のもの。サイトPR #62→拡張PR #136の統合順と、Netflix・Disney+の実機確認が必要。

## 8. ライブラリ・プレイリスト・コメント・UI（FR-06・09〜11）

サイトのライブラリは自分のクリップを一覧・作品名で探せる入口とする。読み込み中、結果なし、通信失敗を別状態にし、再取得を可能にする。取得結果は表示に必要な情報だけを含める。

プレイリストは順序付きのクリップ参照として保存する。並べ替えの保存には更新版を用い、別画面での変更を黙って上書きしない。再生開始時に参照可能なクリップを解決し、途中で参照不能な項目があれば開始前に知らせる。再生中は開始時点のsnapshotを使い、別画面の編集で順序を突然変えない。

コメント本文はtrim後1〜500 Unicodeコードポイントを仮上限とする。投稿開始時のclipIdと本文を固定し、再生対象が変わっても別クリップへ投稿しない。応答は要求元のクリップに紐づけ、失敗時は下書きを保持する。投稿要求IDを再送時にも維持し、timeout後の再試行で重複投稿しない。

UIはパネル開閉時の幅・フォーカスを復元し、イベント・タイマーを解除する。名前入力中のキー操作をプレイヤーへ誤伝播させない。パネル再オープン後に古い非同期処理が完了しても、新しい入力や再生状態を変更しない。

ページ再読み込みを超える下書き保持、コメント編集・削除、削除されたクリップのリスト内表示は、提供範囲と合わせて決定する。

## 9. 信頼境界と検証責務

| 境界・入力 | 検証する側と実ファイル | 拒否・保護する条件 |
| --- | --- | --- |
| サイトのページJS → 拡張の連携content script | `src/content/extension_link.js` が `event.source === window`、許可された`event.origin`、メッセージ`type`を確認。`extensionSync.js` がinstanceId・トークンの形式を確認 | 別Origin、未知の型、異なるinstanceIdのトークンを拒否。`window.postMessage`自体を認証済みAPIと見なさない |
| サイトのページJS → 再生ブリッジ | `src/content/getClipData.js` のsource/origin/type確認。PR #136の `playbackBridgeValidation.js` がClip ID、サービスとURLホスト、HTTPS、認証情報・明示ポート、時間、最大100項目・512KiBを確認 | 不正入力では既存の再生状態を壊さず失敗理由を返す。現行`develop`にはこの強化が未統合 |
| 動画ページcontent script → Background | `src/background/background.js` のメッセージ分岐、PR #136の `playbackOwnership.js` がChrome提供のsender.tab.id、nonce、経路、snapshotを照合 | ページ側が申告したタブIDだけで所有権を決めない。別タブ・古いnonce・期限切れを拒否 |
| Background → サイトの拡張API | `src/api.js` の接続先、`manifest.json` のhost permissions、サイト `src/server/http/cors.ts` と各`src/app/api/extension/*/route.ts` | Origin未許可は403。Bearerが無い・不正・期限切れ・失効済みは401。Originの許可とユーザー認証は別の検査 |
| JSON → サイトDB | `src/server/schemas/extension.schema.ts` のZod、`src/server/services/extensions.ts` の連携認証・receipt、クリップ・コメントのサービス層の所有者判定 | UUID、重複ID、時間・URL、対象Clipの権限を検証。リクエスト内のuserIdで所有者を上書きしない。初期非公開をAPI経路でも守る |
| API結果 → 拡張のstorage/UI | `src/background/sync.js` がHTTP状態と `acceptedItemIds` を検査し、`src/content/clipList.js` 等が表示 | 不正な受理IDでキューを消さない。外部由来のタイトル・コメントはHTMLとして挿入せずテキスト表示する |

認証トークンは拡張の `chrome.storage.local` とBackgroundからのHTTP Authorizationに限定し、Netflix・Disney+のページDOM、再生URL、通常ログ、分析イベントへ渡さない。サイトのセッションCookieは拡張用Bearerと別の資格情報。ログにはトークン、作品URL、Clip名、コメント本文を含めない。

**未解決の実装差:** サイトIssue #80（同時再送で500）、#81（論理削除後も同期・リンク発行可能）、#86（リンク・更新・失効の振る舞いテスト）に加え、現行拡張の400時キュー削除・不正200応答時の全件削除を解消する。各境界の拒否ケースを自動テストと実DBスモークで確かめる。

## 10. 品質・計測・検証

PRD第8節のSLOを品質目標とする。端末保存の応答、同期受理までの時間、再生開始位置、記録の保全を別々に計測する。端末への書込完了をサイト同期完了や実再生開始と数えない。診断ログは`requestId`、処理段階、固定の失敗コードに限定する。

| 対応要件 | 自動・統合検証 | 実機確認 |
| --- | --- | --- |
| FR-01〜04 | 区間・重複保存、同期200/400/401/403/5xx、空・部分・不正な`acceptedItemIds`、受理後の応答消失、キューの保持 | NetflixとDisney+で記録、未連携→連携、通信断→回復 |
| FR-05・07・08 | ハンドオフ登録・タブ取得・遷移・解放、nonceと経路不一致、期限切れ、単体／リストループ | 両サイトで単体・混在リスト、複数タブ、通常遷移、Background再起動 |
| FR-06・09〜11 | 一覧とコメントの認証・認可、対象切替、投稿失敗時の下書き、並べ替え保存 | サイト一覧、コメント入力、キーボード、フルスクリーン |

実DBスモークで同じ `clientItemId` の並行再送、リンクトークンの並行消費、トークン更新後の旧トークン拒否を確認する。サイトPR #62/#77と拡張PR #136の未統合部分は、各PRの検証結果と統合後の結果を分けて記録する。

## 11. 実装・提供の進め方

1. **契約の確定:** PRDの初期非公開、保存表示の意味、同期200/400の形式、再生ブリッジの現在の遷移担当を両リポジトリで合意する。
2. **既存の不整合修正:** サイト#80・#81と拡張の不正応答／400時のキュー保全を直す。サイトPR #62を先に、拡張PR #136を後に統合する。
3. **障害・競合検証:** 通信断・認証失効・複数タブ・遷移中操作・Background再起動からの復帰を実DBと実機で確認し、サイト#86のライフサイクルテストを追加する。
4. **限定利用:** PRDのSLOの対象試行数と失敗事例を集計し、保存から後日の再視聴までを確かめる。

APIや端末データ形式を変えるPRでは、既存の `pendingClips`、Cookie、`playQueue`、再生キーをどう移行するか記す。サイトと拡張の片側だけ先に更新しても再生・同期が破綻しないよう、統合順と互換期間を確認する。

## 12. 未決定事項とリスク

| 論点 | 判断・確認する内容 |
| --- | --- |
| 同期の400と部分受理 | 現行バッチ全体400に対して不正項目をどう特定し、正常項目を再送するか。200の`acceptedItemIds`以外に項目別結果を導入するか |
| UIの応答期限 | サイト同期を待って結果を返す際のタイムアウトと、端末記録済み／同期待ちの表示文言 |
| 端末容量 | アプリ独自上限は設けない。Chromeの書込失敗時の再試行導線と、未同期データを利用者が確認・削除する機能 |
| 再生契約 | PR #136のnonce方式を統合する際のサイトPR #62との順序、Cookieと`playQueue`の互換期間、再生開始の結果通知 |
| 対象サイト | Netflix/Disney+のプレイヤー変更とサービス混在リストの実機結果 |
| 提供・運用 | 本番URL、許可Origin、拡張の配布方法、SLO計測とログ保持期間 |

保存クリップとコメントの初期非公開はPRDで確定済み。初期版に別アカウントへの再連携フローを追加しない。

## 13. 現行実装と設計差分の参照先

- 拡張 `develop`: `manifest.json`、`webpack.config.js`、`src/api.js`、`src/shared/storage.js`、`src/content/extensionSync.js`、`src/background/sync.js`、`src/background/tokenRefresh.js`、`src/content/getClipData.js`。
- 拡張PR #136: `src/shared/playbackBridgeValidation.js`、`src/content/playbackOwnership.js`、`src/background/playbackOwnership.js`、`src/content/clipList.js`。未マージの契約として扱う。
- サイト `develop`: `src/app/api/extension/{link-token,link,sync,token/refresh,unlink}/route.ts`、`src/server/schemas/extension.schema.ts`、`src/server/services/extensions.ts`。
- サイトPR #62/#77: コメントAPIと同期・認証の修正案。未マージのコードを現行`develop`と取り違えない。

本書で要求するキュー保全、厳密な受理ID確認、同期後の結果表示、初期非公開のAPI認可は、記述しただけで実装完了とはならない。各変更PRの差分と実行結果を別に追跡する。