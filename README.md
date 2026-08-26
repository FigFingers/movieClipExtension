# Netflix Movie Clipper

A Chrome extension for recording clips on Netflix and Disney+, replaying clips and
playlists from the companion site, syncing clip metadata, and reading or posting clip comments.

## 🚀 Setup Instructions

### 1. Install dependencies

Node.js 18.12 以上が必要です（CI は Node.js 24 を使用）。

```bash
npm ci
```

### 2. Build the project

```bash
npm run build   # 一回ビルド
npm run dev     # webpack --watch
```

`manifest.json` が参照する5つの webpack bundle（`background.js` / `content.js` /
`content_disney.js` / `extension_link.js` / `getClipData.js`）は `dist/` に生成されます。
`dist/` は Git 管理外なので、clean clone を初めて読み込む前と、これらの entry または
依存ソースを変更した後は build が必要です。

一方、`src/inject/inject_script.js`、`src/util/history_change.js`、
`src/content/extension_present.js` は manifest から直接読み込まれるため webpack の対象外です。
いずれの変更後も `chrome://extensions/` で拡張を再読み込みし、対象ページも再読み込みしてください。

変更後の検証:

```bash
npm run lint
npm test
npm run build   # clean clone、または webpack entry / import 先 / config の変更時
```

### 3. Load as a Chrome Extension

1. Open `chrome://extensions/`
2. Enable "Developer Mode"
3. Click "Load unpacked" and select the repository root

### 4. サイト側にこの拡張の ID を登録する

クリップ同期とトークン自動更新は background service worker から `Origin: chrome-extension://<ID>` で
サイト API に届きます。サイト側でもこの origin を許可してください。react--site の現在想定する
local development 設定例は次のとおりです（実際の変数名は対象 commit / branch でも確認してください）:

1. `chrome://extensions/` で読み込んだ拡張の ID をコピー
2. react--site の `.env.local` に設定して dev サーバを再起動

```
CLIP_API_ALLOWED_ORIGINS=http://localhost:3000,chrome-extension://<拡張ID>
```

## 🌐 API Configuration

API endpoint の基点は `src/api.js` で定義されています:

```js
export const API_URL = 'http://localhost:3000/api/';
```

接続先は単一設定ではありません。origin または port を変更するときは、次も同時に確認してください:

- `manifest.json` の `host_permissions` と localhost 用 `content_scripts.matches`
- `src/background/background.js` の `DEMO_BASE_URL`
- サイト側の許可 origin と拡張 ID の設定

## 🔗 サイト連携の仕組み（概要）

- 連携: サイトから受け取った `EXT_LINK_WITH_AUTH_TOKEN` message の token 文字列は内部形式を解釈せず保存し、`expiresAt` は ISO 文字列へ正規化する（欠落・不正なら `null`）
- 同期: 保存ボタン → `pendingClips`（`chrome.storage.local`）に enqueue → background が Bearer token 付きで同期。一時的な失敗は 15 分毎の alarm と service worker 起動時に再送するが、`400` で項目を特定できた不正データは queue から除外
- トークン更新: background が 6 時間毎と service worker 起動時に期限を確認し、期限情報が無い場合または残り 15 日以下で refresh を試行
- 連携解除: サイトから `EXTENSION_UNLINKED` message を受けるとトークンを破棄。message を取り逃した場合も、次に認証付き API が `401` を返した時点でローカル認証を消去

サイト側の画面、endpoint、token 有効期間は別リポジトリの契約です。変更時は、対象サイトの
実ファイルと、それを含む commit / branch を合わせて確認してください。
