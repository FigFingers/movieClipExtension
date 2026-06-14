# 拡張機能 ⇄ React サイト連携 分析メモ (2026-06-14)

- 対象拡張: `h:\movieClipExtension`（ブランチ **`AuthExtension-draft`**）
- 対象サイト: `C:\dev\react--site`（Next.js / NextAuth / Prisma）
- 関連 Issue: **#110**

> ⚠️ 本ドキュメントは **`AuthExtension-draft` ブランチの実コード** を対象に分析している。
> 連携機能（`extension_link.js` / `extensionSync.js` ほか）は **既に実装済み**。
> 「未実装だから動かない」のではなく「**ビルドが古い**」「**実装が二系統で衝突**」が原因。

---

## 0. TL;DR（結論）

連携の仕組みはこのブランチに実装されている。動かない直接原因は次の2つ:

1. **ビルド成果物が古い** — manifest が読む `dist/extension_link.js` は 6/4 ビルド、ソースは 6/14。`npm run build` 未実行で現行ロジックが反映されていない。
2. **連携ハンドラが二系統で衝突** — `getClipData.js` と `extension_link.js`(+`extensionSync.js`) が同じ `EXTENSION_CHECK_AUTH` を二重処理し、別ストレージ・別 instanceId・別トークン判定を使う。サーバ発行トークンは **不透明トークン（非JWT）** なのに `getClipData.js` は `isJwtValid()` で判定するため常に `loggedIn:false` を返し、応答が二重化＆食い違う。

対応方針:
- まず `npm run build` で①を解消（これだけで改善する可能性あり）。
- 認証・連携を `extension_link.js` + `extensionSync.js` に一本化し、`getClipData.js` を再生専用に戻して②を根治。
- サイト側は `/api/extension/sync` の Origin 許可だけ要確認（後述）。

---

## 1. 連携の全体像（あるべきフロー）

```
[利用者] localhost にログイン → /account を開く
   │
   ├─ ExtensionLinker(自動) / 「拡張機能を連携する」ボタン
   │
1. サイト → postMessage  EXTENSION_CHECK_AUTH {requestId}
   拡張   → postMessage  EXTENSION_AUTH_STATUS {requestId, loggedIn, extensionInstanceId?}
   │   (無応答=available:false → "応答しませんでした")
   │
2. (instanceId 未知の経路) サイト → GET_EXTENSION_INSTANCE_ID
   拡張 → EXTENSION_INSTANCE_ID_RESPONSE {ok, extensionInstanceId}
   │
3. サイト → POST /api/extension/link-token  (Cookie)         → linkToken
4. サイト → POST /api/extension/link {instanceId, linkToken} → extensionAuthToken
   │
5. サイト → postMessage EXT_LINK_WITH_AUTH_TOKEN {instanceId, extensionAuthToken}
   拡張 → トークン保存（連携完了）
   │
── 以降 ──
6. Netflix で録画 → 拡張 → POST /api/extension/sync (Bearer)
```

> サイト側の発火点: [ExtensionLinker.tsx](file:///C:/dev/react--site/src/components/ExtensionLinker.tsx) / [ExtensionLinkButton.tsx](file:///C:/dev/react--site/src/components/ExtensionLinkButton.tsx) / 本体 [client.ts](file:///C:/dev/react--site/src/lib/extension/client.ts)
> タイムアウト: ExtensionLinker=1000ms / client.ts=3000ms。応答は storage 読み出し後すぐ返すこと。

### サイトが期待するメッセージ契約

| サイトが送る | 拡張が返す | 主フィールド |
|---|---|---|
| `EXTENSION_CHECK_AUTH` | `EXTENSION_AUTH_STATUS` | `{requestId, loggedIn, extensionInstanceId?}` |
| `GET_EXTENSION_INSTANCE_ID` | `EXTENSION_INSTANCE_ID_RESPONSE` | `{requestId, ok, extensionInstanceId}` |
| `EXT_LINK_WITH_AUTH_TOKEN` | （応答不要・保存） | payload: `{extensionInstanceId, extensionAuthToken, token}` |

- `extensionInstanceId` は **UUID** 必須（サーバが `z.uuid()` + `::uuid`）。
- `loggedIn` の意味: ExtensionLinker は `if (!available || loggedIn) return;` のため **「連携済みなら true」**（自動連携をスキップさせる）。

---

## 2. このブランチの実装状況（現状）

### 拡張機能側（実装済み）

manifest の localhost 用 content script（[manifest.json](../manifest.json)）:
```jsonc
{ "matches": ["http://localhost/*", "http://127.0.0.1/*"],
  "run_at": "document_idle",
  "js": ["dist/extension_link.js", "src/content/getClipData.js"] }
```

| ファイル | 役割 | 状態 |
|---|---|---|
| [extension_link.js](../src/content/extension_link.js) | `GET_EXTENSION_INSTANCE_ID` / `EXTENSION_CHECK_AUTH` / `EXT_LINK_WITH_AUTH_TOKEN` を処理（→ extensionSync.js 委譲） | ✅ 実装 |
| [extensionSync.js](../src/content/extensionSync.js) | instanceId・トークン保存・`/api/extension/sync` 同期 | ✅ 実装 |
| [background.js](../src/background/background.js) | `chrome.runtime.onConnect`(`extensionInstanceId` port) で instanceId 発行 | ✅ 実装 |
| [getClipData.js](../src/content/getClipData.js) | 再生（`SET_CLIP_DATA`/`PLAY_PLAYLIST_START`）**＋ 認証系も重複実装** | ⚠️ 重複 |

ストレージ・instanceId の出所:
- `extensionSync.js` / `background.js` … **フラットキー** `extensionInstanceId`, `extensionAuthToken`, `extensionLinked`。`GET_EXTENSION_INSTANCE_ID` は background port 経由でこのフラット ID を返す（サイトが連携するのはこの ID）。
- `getClipData.js` … **ネスト** `extensionConnectionState = {extensionInstanceId, extensionAuthToken, linked, ...}`。独自に `crypto.randomUUID()` を発行。

---

## 3. 根本原因

### 原因① ビルド成果物が古い
- manifest は **`dist/extension_link.js`**（webpack バンドル）を読み込む。
- タイムスタンプ: `dist/extension_link.js` = **6/4 ビルド** / `src/content/extension_link.js`・`extensionSync.js` = **6/14 更新**。
- `dist/` は `.gitignore` 対象（コミットされない）。→ checkout 後は **`npm run build` 必須**。
- webpack entry には `extension_link` が登録済み（[webpack.config.js](../webpack.config.js)）。ビルドさえすれば成果物は出る。

```
npm run build   # production
# or
npm run watch   # 開発時
```

### 原因② 連携ハンドラが二系統で衝突
`EXTENSION_CHECK_AUTH` を **2 つの content script が両方処理**する:

| | extension_link.js / extensionSync.js | getClipData.js |
|---|---|---|
| storage | フラット (`extensionInstanceId` / `extensionAuthToken`) | ネスト (`extensionConnectionState`) |
| instanceId | background port 発行（サイトと一致） | 独自 `randomUUID()`（別物） |
| トークン判定 | `Boolean(token)` | `isJwtValid()` ← **JWT 前提** |
| `EXT_LINK_*` | `EXT_LINK_WITH_AUTH_TOKEN`（サイトが送る型） | `EXT_LINK_WITH_TOKEN`（サイトは送らない＝デッドコード） |

問題点:
1. **トークン形式の不一致**: サーバ [extensions.ts](file:///C:/dev/react--site/src/server/services/extensions.ts) の `generateOpaqueToken()` は `randomBytes(32).toString('base64url')`＝**不透明トークン**。JWT ではない。よって `getClipData.js` の `isJwtValid()` は常に false → `checkStoredAuthState()` が `{loggedIn:false}` を返し、トークンを破棄する。
2. **二重応答 / レース**: 同一 `requestId` に対し `getClipData.js`(=常に false) と `extensionSync.js`(=実際の状態) の **2 つの `EXTENSION_AUTH_STATUS`** が飛ぶ。サイトは最初に届いた方で resolve するため挙動が不安定。
3. **instanceId の二重化**: フラット ID（サイトが連携する側）とネスト ID が別物。`getClipData.js` の `EXT_LINK_WITH_TOKEN` 経路はネスト ID を使うが、現行サイトはこの型を送らないため死んでいる。

→ **対応**: 認証・連携を `extension_link.js` + `extensionSync.js` に一本化し、
`getClipData.js` から `EXTENSION_CHECK_AUTH` / `EXT_LINK_WITH_TOKEN` / `extensionConnectionState` / `isJwtValid` / `checkStoredAuthState` を **削除**。
`getClipData.js` は再生専用（`clipSelected` / `SET_CLIP_DATA` / `PLAY_PLAYLIST_START` / `EXT/SET_SESSION` / `playQueue`）に戻す。

---

## 4. サイト側で要確認（1点）

`POST /api/extension/sync` も `isAllowedClipWriteOrigin`（[cors.ts](file:///C:/dev/react--site/src/server/http/cors.ts)）で Origin 検査を通る。
許可リストは `AUTH_URL` / `NEXTAUTH_URL` / `CLIP_API_ALLOWED_ORIGINS`。
background service worker からの fetch は `Origin: chrome-extension://<id>` が付与され、**許可外で 403** になる懸念。

対応案（いずれか）:
- **(推奨)** sync は Bearer 認証なので Origin 検査（Cookie 用 CSRF 対策）は不要。sync ルートだけ Origin 検査を外す / Bearer があれば素通し。
- `CLIP_API_ALLOWED_ORIGINS` に `chrome-extension://<拡張ID>` を追加。

> link-token / link / session はサイト自身（同一オリジン）から呼ぶため許可済み。問題は sync のみ。

---

## 5. メッセージ契約 早見表（このブランチ実装）

| 方向 | type | 処理担当 | 状態 |
|---|---|---|---|
| サイト→拡張 | `EXTENSION_CHECK_AUTH` | extension_link.js **＋ getClipData.js（重複）** | ⚠️ 二重 |
| 拡張→サイト | `EXTENSION_AUTH_STATUS` | 上記両方が送出 | ⚠️ 二重 |
| サイト→拡張 | `GET_EXTENSION_INSTANCE_ID` | extension_link.js → background port | ✅ |
| 拡張→サイト | `EXTENSION_INSTANCE_ID_RESPONSE` | extension_link.js | ✅ |
| サイト→拡張 | `EXT_LINK_WITH_AUTH_TOKEN` | extension_link.js → extensionSync.js | ✅ |
| （未使用） | `EXT_LINK_WITH_TOKEN` | getClipData.js（サイトは送らない） | 🪦 dead |
| サイト→拡張 | `SET_CLIP_DATA` / `PLAY_PLAYLIST_START` / `EXT/SET_SESSION` | getClipData.js | ✅ |
| サイト(event) | `clipSelected` / `clipListElementsRendered` | getClipData.js | ✅ |

---

## 6. 動作確認手順（修正後）

1. `npm run build` 実行 → `dist/extension_link.js` が最新になることを確認。
2. 拡張を unpacked で再読み込み。
3. サイトにログインし `/account` を開く → DevTools で `EXTENSION_CHECK_AUTH` → `EXTENSION_AUTH_STATUS` が **1 回だけ** 往復することを確認。
4. 「拡張機能を連携する」→「連携が完了しました」。DB `linked_extensions` に行が増え、`chrome.storage.local.extensionAuthToken`（フラット）が入る。
5. Netflix で録画 → `POST /api/extension/sync` が 200／`acceptedItemIds` を返す。同一 `clientItemId` 再送で重複しない（冪等）。

---

## 7. 残課題（→ Issue #110 で追跡）

- [ ] `npm run build` を CI / 手順書に明記（dist は gitignore のため必須）。
- [ ] `getClipData.js` の認証系重複を削除し、認証は extension_link/extensionSync に一本化。
- [ ] `/api/extension/sync` の Origin 許可（サイト側）を決定。
- [ ] `loggedIn` 意味（=連携済み）の実機確認。
- [ ] 本番 / トンネル URL を manifest matches・host_permissions・CORS 許可に追加。

> 本ドキュメントは分析のみ。実コード修正（①ビルド・②一本化）は別ブランチ / 別 PR で対応する。

---

## 参照ファイル

拡張: [manifest.json](../manifest.json) / [webpack.config.js](../webpack.config.js) / [extension_link.js](../src/content/extension_link.js) / [extensionSync.js](../src/content/extensionSync.js) / [getClipData.js](../src/content/getClipData.js) / [background.js](../src/background/background.js)

サイト: [client.ts](file:///C:/dev/react--site/src/lib/extension/client.ts) / [ExtensionLinker.tsx](file:///C:/dev/react--site/src/components/ExtensionLinker.tsx) / [ExtensionLinkButton.tsx](file:///C:/dev/react--site/src/components/ExtensionLinkButton.tsx) / [extensions.ts](file:///C:/dev/react--site/src/server/services/extensions.ts) / [cors.ts](file:///C:/dev/react--site/src/server/http/cors.ts) / [extension.schema.ts](file:///C:/dev/react--site/src/server/schemas/extension.schema.ts) / [legacy-clips.schema.ts](file:///C:/dev/react--site/src/server/schemas/legacy-clips.schema.ts)
