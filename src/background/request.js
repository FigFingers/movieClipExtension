export const API_REQUEST_TIMEOUT_MS = 15_000;

// ヘッダーだけでなくJSON本文にも期限を適用。fetchがabortを無視しても排他処理を解放する。
export async function requestJson(url, options = {}, { timeoutMs = API_REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('API request timed out');
      error.name = 'TimeoutError';
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...options, signal: controller.signal });
        let data;
        try { data = await response.json(); }
        catch (error) {
          if (controller.signal.aborted) throw error;
          data = null;
        }
        return { response, data };
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
