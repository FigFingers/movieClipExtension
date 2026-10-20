# テスト

Node.js 24 と lockfile の依存関係を使います。初回にルートで `npm.cmd ci` を実行してください。
以下は PowerShell の表記です。その他のシェルでは `npm.cmd` を `npm` に置き換えられます。

## 単体テストと静的確認

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

`npm test` は Node のテストランナーで `test/` を実行します。Chromium やサイトサーバーは不要です。
保存パネルは最小DOM、同期処理は storage・fetch のモックで、成功・失敗・非同期処理の順序を検証します。
UIモジュールを直接 import し、テスト時のソース差し替えは行いません。`test-support/` は共通の storage モックで、テストとしては収集されません。
lint は Biome の検査のみで、自動整形や自動修正はしません。

## モック E2E

初回に Chromium をインストールします。

```powershell
npm.cmd run test:e2e:install
npm.cmd run test:e2e
```

`test:e2e` はビルド後、拡張を読み込んだ Chromium を起動します。
Netflix・Disney+ のページと localhost のサイトAPIは `e2e/mock/` のモックへ振り分けます。
テストごとにサーバーとブラウザープロファイルを作り、本物のサービスへのログインや普段の拡張データは使いません。

| 検証対象 | 主なケース |
|---|---|
| Netflix 録画 | シリーズ・映画の作品情報と区間、キャンセル、短すぎる区間の拒否と再録画 |
| Disney+ 録画 | メディア時刻のオフセットを除いた作品時刻での区間保存 |
| 保存エラー | 両サービスで次のローカル書込みを失敗させ、名前・区間の保持と再試行を確認 |
| サイト連携 | 未連携で保存したキューを、連携直後に一度だけ同期 |
| 同期エラー | 500・不正JSONの200・項目不明の400の後にキューを保持し、同じIDで alarm 再送 |
| 認証エラー | 401でトークンを破棄し、クリップを保持 |
| 同時保存 | NetflixとDisney+のパネルから同時に保存して両方を保持 |
| 応答停止 | 同期が応答しなくてもパネルを閉じ、通信期限後に同じIDで再送 |

ブラウザーを表示する場合:

```powershell
$env:E2E_HEADED = '1'
npm.cmd run test:e2e
Remove-Item Env:E2E_HEADED
```

失敗時は `out/e2e/run-*/<ケース名>/` に画面PNG・`trace.zip`・`diagnostics.json` が残ります。
全件成功した実行のディレクトリは削除されます。生成した動画は `out/e2e/media/` にキャッシュされます
（`MOVIE_CLIPPER_MOCK_CACHE` が設定されていれば、その場所を使用）。

```powershell
npx.cmd playwright show-trace <trace.zipのパス>
```

CI は `.github/workflows/ci.yml` で lint、単体テスト、ビルド付きE2Eを実行します。
失敗時の診断ファイルは artifact に保存します。

## 検証の限界

モックでの成功は、本物の配信サイトのDOM・DRM再生、別リポジトリのサイトAPIとの結合を保証しません。
実機確認では拡張をビルド・再読込し、対象ページも再読込してください。
サイト同期にはサイト側の許可Originへの拡張ID登録も必要です（[セットアップ](../README.md)）。
