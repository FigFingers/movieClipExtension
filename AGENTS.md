# AGENTS.md

このファイルはリポジトリ全体のコーディングエージェント向け作業ガイド。
ユーザーの明示的な指示を優先し、作業対象の下位ディレクトリに追加の `AGENTS.md` があれば併せて確認する。
説明・コミット・PR 本文は原則として日本語で書く。

## プロジェクトと情報源

Netflix / Disney+ の動画シーンをクリップし、ローカルのサイトと連携・同期する Chrome 拡張（Manifest V3）。
このリポジトリにサイト本体やバックエンドは含まれない。

- 最初に `git status --short` と現在のブランチを確認し、既存の未コミット変更を保持する。
- 実行構成は `manifest.json` と `webpack.config.js`、コマンドは `package.json`、CI は `.github/workflows/ci.yml` を確認する。
- セットアップは `README.md`、実装の概観は `READMEFORLLM.md` を参照する。説明とコードが食い違う場合は現在のコードを根拠にし、古い説明をそのまま転記しない。
- `CLAUDE.md`、`.claude/`、`docs/`、`CODE_ISSUES_FOR_LLM.md` は現在 Git 管理外。存在する環境での補助資料として扱い、必須手順や契約の唯一の根拠にしない。追跡状態は `git ls-files` で確認する。

## セットアップと検証

CI に合わせて Node.js 24 と npm を使う。依存関係の初回導入は `npm ci`。
PowerShell で `npm.ps1` が実行ポリシーに拒否される場合は、各コマンドの `npm` を `npm.cmd` に置き換える。

| コマンド | 用途 |
| --- | --- |
| `npm ci` | `package-lock.json` に従う依存関係の導入 |
| `npm run dev` | webpack の watch ビルド（実行を継続する） |
| `npm run lint` | Biome の lint |
| `npm test` | Node 標準のテストランナー（`node --test`） |
| `npm run build` | `dist/` に本番用バンドルを生成 |

- PR 作成前に CI と同じ `npm run lint` → `npm test` → `npm run build` を実行する。実行できなければ理由を報告する。
- テストは `test/` にある。テスト件数は固定値を信用せず、実行結果の成功・失敗・スキップ数を報告する。
- Biome は formatter が無効で、lint 対象は `src/**/*.js` / `*.json` / `webpack.config.js`。`chrome` はグローバル宣言済み。既存の書式を維持し、無関係な一括整形を避ける。
- warning と error を区別し、変更前からある問題を今回の変更による問題と混同しない。
- ロジックの修正では影響する挙動を既存のテスト方式で検証する。ブラウザの実動作まで自動テストで確認済みとは扱わない。

## 読み込み経路と主なファイル

`dist/` は Git 管理外の生成物。直接編集・コミットせず、ソースを修正してビルドする。
現在の webpack entry は以下の4つ。entry やその依存ソースを変えたらビルドが必要。

| ソース | manifest が読み込む出力 | 役割 |
| --- | --- | --- |
| `src/background/background.js` | `dist/background.js` | Service Worker、runtime メッセージ、alarm、Netflix seek |
| `src/content/content_netflix.js` | `dist/content.js` | Netflix の記録 UI・クリップ／プレイリスト再生 |
| `src/content/content_disney.js` | `dist/content_disney.js` | Disney+ の記録 UI・クリップ／プレイリスト再生 |
| `src/content/extension_link.js` | `dist/extension_link.js` | localhost / 127.0.0.1 の認証・連携ブリッジ |

以下は manifest から直接読み込まれる通常のスクリプトで、webpack の entry ではない。
ここに実行時の `import` / `export` を追加する場合は、読み込み方式の変更も必要になる。

- `src/inject/inject_script.js` / `src/util/history_change.js`: Netflix のページ・履歴フック。
- `src/content/getClipData.js`: ローカルサイトからのクリップ／プレイリスト再生入力。
- `src/content/extension_present.js`: `MAIN` world でサイトに拡張の存在を公開。

これらだけの変更ではビルドで内容は変わらない。初回導入では4つのバンドルをビルドし、
ソース変更後は必要なビルドを済ませて Chrome の拡張と対象ページを再読み込みする。
manifest / entry を変えた場合は、生成物と直接参照ファイルがすべて存在することも確認する。

その他の主な境界:

- `src/content/common.js`: 共通 seek・保存・メモサイドバー・タブ表示制御。
- `src/content/extensionSync.js`: content 側の保存キューと連携状態。同期実行は background に依頼する。
- `src/background/sync.js` / `src/background/tokenRefresh.js`: API 同期とトークン更新。
- `src/shared/storage.js`: content / background 共用。`window`・`document`・`location` への依存を持ち込まない。
- `src/api.js`: API / サイト URL。`src/util/services.js`: サービス別の再生 URL。
- `src/ui/icons.js` / `src/css/content_button.css`: 共通アイコンと拡張 UI のスタイル。

## 変更時に守る境界

- 同期・トークン更新の `fetch` は background に置く。content 側へ移すとページのオリジンによる CORS の影響を受ける。
- 同期とトークン更新は `runExclusive` を共有する。トークンのローテーション、再試行 backoff、401 時の認証解除、再連携との競合を考慮する。
- 未送信クリップは `pendingClips` に残して再送する。同期失敗時にキューを消さず、`clientItemId` による重複排除を維持する。
- `extensionInstanceId` の生成は background に集約されている。content 側で別の ID を作らない。
- ページからのメッセージは信頼境界。送信元 window・origin・メッセージ型・payload を検証し、任意の payload をそのまま storage に書き込まない。トークンや Authorization をログやページへの状態応答に含めない。
- Netflix の seek は runtime メッセージから background 経由でページの `MAIN` world に届く。秒とプレイヤー側のミリ秒を混同せず、isolated world からプレイヤー API を直接呼ばない。
- 再生モードや遷移を変えるときは、`getClipData.js`、両サービスの content script、共通処理の読み書きを追う。`playmode`、`playClipSystemKey`、`playlistSystemKey`、`playQueue`、`currentClipOrder`、`extAutoNavigation` の一部だけを変更しない。
- UI の再初期化や SPA 遷移では、listener・timer・MutationObserver の重複登録と解除漏れを確認する。メモ入力中のキー操作、フォーカス、二重送信、タブ非表示時の UI も影響に応じて確認する。
- サイト API やメッセージ契約を変更する場合は、サイト側の実ファイルとその変更を含む commit / branch を確認し、PR に根拠を書く。ローカル未マージの実装を対応済みと断定しない。未対応なら拡張側で機能を gate する。

実機確認は `README.md` の手順に従い、サイト側の拡張 ID 登録も確認する。
変更範囲に応じて Netflix / Disney+ の記録・保存・再生・画面遷移、サイト連携・解除・同期再試行を確認し、未実施の項目は明記する。

## Git と PR

- 既定の統合先は `develop`。ユーザーが別の base を指定したらその指示を優先し、リモート上の実在を確認する。
- `git fetch origin` 後、目的の base から作業ブランチを作る。issue があれば `<issue番号>-<スラッグ>`、なければ `docs/<スラッグ>` や `fix/<スラッグ>` など内容が分かる名前を使う。
- コミットは `fix:` / `feat:` / `docs:` / `chore:` + 日本語の要約。実在する関連 issue がある場合だけ `Refs #N` / `Closes #N` を付ける。
- ステージするファイルを明示し、`git diff --cached` と `git diff --check` で対象外の変更や秘密情報が混入していないか確認する。
- GitHub 操作前に `git remote -v` と `gh auth status` を確認する。認証情報や remote 設定を無断で変更しない。
- ユーザーが PR 作成を依頼した場合は、必要なコミット・作業ブランチの push・PR 作成まで進める。同じ許可を繰り返し求めない。マージやブランチ削除はその依頼に含めない。
- PR は base を明示する。本文には問題と変更後の挙動、変更範囲、実行した検証と未確認事項を書く。複数行の本文を CLI で渡す場合は一時ファイルと `gh pr create --body-file` を使う。
- 最後に PR URL と検証結果を報告する。失敗した操作は完了と扱わず、残っている作業と原因を伝える。

## ガイドの保守

コマンド、entry、CI、連携契約を変更したら、このガイドの関連箇所も更新する。
共有指示はこの `AGENTS.md` に置き、端末固有の絶対パスや認証情報を書かない。
Codex の読み込み規則は [公式の AGENTS.md ガイド](https://learn.chatgpt.com/docs/agent-configuration/agents-md) を参照する。
