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

## E2E テスト（配信サービス・サイトのモック）

Node.js 24 を使用します。モックのソースは `e2e/mock/` に同梱しているため、このリポジトリだけで実行できます。
初回はルートで依存パッケージと Playwright の Chromium を準備してください。

```powershell
npm.cmd ci
npm.cmd run test:e2e:install
npm.cmd run test:e2e
```

`test:e2e` は現在のソースをビルドしてから、拡張を読み込んだ Chromium を画面なしで起動します。
モックは空きポートで起動し、配信サービスへのアクセスと `localhost:3000` の API をモックに振り分けます。
本物の配信サービスへのログインや、サイトの開発サーバーの起動は不要です。

ブラウザーを表示したい場合:

```powershell
$env:E2E_HEADED = '1'
npm.cmd run test:e2e
```

検証するのは Netflix のシリーズ・映画の保存、保存のキャンセル、短すぎる区間の拒否と再録画、
Disney+ の作品時刻による保存、未連携のキューから連携後の同期、500 後の alarm 再送、401 後の認証解除とキュー保持です。
各テストでブラウザープロファイルとサーバーを作り直すため、普段使う拡張の保存データには触れません。

失敗時には `out/e2e/run-*/<ケース名>/` にスクリーンショット、`trace.zip`、`diagnostics.json` を残します（全テストが通った実行のフォルダーは消します）。
トレースはルートで `npx playwright show-trace <trace.zip のパス>` を実行して確認できます。
生成する 60 秒の WebM は `out/e2e/media/` にキャッシュします（`MOVIE_CLIPPER_MOCK_CACHE` が設定済みならその場所）。

通常の `npm test` は単体テストのみを実行し、Chromium のインストールは不要です。
CI では単体テストと E2E の両方を実行し、E2E 失敗時の診断ファイルを artifact に保存します。

## 使用画面の画像を自動生成する

E2E と同じ準備をしたあと、次のコマンドで拡張を実際に操作してスクリーンショットを生成できます。

```powershell
npm.cmd run screenshots
```

`out/screenshots/` に Netflix の視聴・録画中・保存パネル、Disney+ の保存パネル、
サイトの連携後・同期済みクリップ一覧の PNG を出力します。`index.html` で画像を閲覧でき、
`overview.png` は 6 画面をまとめた一覧画像です。各画面は 1440 × 900 px で撮影します。
動画・配信サービス・サイトにはテスト用モックを使います。
