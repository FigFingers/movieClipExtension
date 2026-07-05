# Netflix Movie Clipper

A Chrome extension that allows you to easily clip scenes from Netflix videos.

## 🚀 Setup Instructions

### 1. Install dependencies

```bash
npm install
```

### 2. Build the project

```bash
npm run build   # 一回ビルド
npm run dev     # webpack --watch
```

`manifest.json` は `dist/` のバンドル（`background.js` / `content.js` / `content_disney.js` / `extension_link.js`）を参照するため、**ビルドせずに読み込むと拡張は動作しない**（`dist/` は git 管理外）。

### 3. Load as a Chrome Extension

1. Open `chrome://extensions/`
2. Enable "Developer Mode"
3. Click "Load unpacked" and select the `./` folder

### 4. サイト側にこの拡張の ID を登録する

クリップ同期とトークン自動更新は background service worker から `Origin: chrome-extension://<ID>` で
サイト API に届くため、サイト（react--site）側の `.env.local` に拡張 ID を登録しないと 403 で弾かれる:

1. `chrome://extensions/` で読み込んだ拡張の ID をコピー
2. react--site の `.env.local` に設定して dev サーバを再起動

```
CLIP_API_ALLOWED_ORIGINS=http://localhost:3000,chrome-extension://<拡張ID>
```

## 🌐 API Configuration

The API endpoint is defined in `src/api.js`:

```js
export const API_URL = 'http://localhost:3000/api/';
```

## 🔗 サイト連携の仕組み（概要）

- 連携: サイト `/account` の「拡張機能を連携する」→ `POST /api/extension/link` → `EXT_LINK_WITH_AUTH_TOKEN` postMessage で不透明トークン+有効期限（90日）を拡張が保存
- 同期: 保存ボタン → `pendingClips`（chrome.storage.local）に enqueue → background が `POST /api/extension/sync`（Bearer）。失敗時は 15 分毎の alarm と SW 起動時に再送
- トークン更新: background が 6 時間毎+SW 起動時に期限を確認し、残り 15 日未満で `POST /api/extension/token/refresh`（ローテーション）
- 連携解除: サイト `/account` の「連携を解除」→ `POST /api/extension/unlink` → `EXTENSION_UNLINKED` postMessage で拡張がトークン破棄（取り逃しても次回同期の 401 で自己修復）
