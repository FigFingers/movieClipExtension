// MAIN world で実行され、拡張の存在をページ本体の window に公開する。
// isolated world で代入してもページからは見えないため、検知フラグはこちらで設定する。
// 実際のリンク処理・認証応答は isolated world の extension_link.js が postMessage で担う。
window.__CLIP_EXTENSION_PRESENT__ = true;
