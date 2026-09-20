/**
 * content script から background へメッセージを送る唯一の入口。
 *
 * 拡張のリロード直後やテスト環境では `chrome.runtime` 自体が無い / 応答ポートが閉じる
 * ため、呼び出し側が try-catch を書かずに済むよう失敗も解決値として返す。
 *
 * @param {Record<string, unknown>} message
 * @returns {Promise<Record<string, unknown>>}
 */
export function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) {
      resolve({ ok: false, reason: 'background_unavailable' });
      return;
    }

    try {
      runtime.sendMessage(message, (response) => {
        if (runtime.lastError) {
          resolve({
            ok: false,
            reason: 'background_unavailable',
            message: runtime.lastError.message,
          });
          return;
        }
        resolve(response || { ok: false, reason: 'request_failed' });
      });
    } catch (error) {
      resolve({
        ok: false,
        reason: 'background_unavailable',
        message: error?.message,
      });
    }
  });
}
