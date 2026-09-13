export const BACKGROUND_REQUEST_TIMEOUT_MS = 15 * 1000;

async function parseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return null;
  }
}

/**
 * Bound both receipt of response headers and consumption of the JSON body.
 * Native fetch observes AbortSignal, so callers holding the background mutex
 * cannot leave it permanently pending on an unresponsive API request.
 */
export async function fetchJsonWithTimeout(
  url,
  options = {},
  timeoutMs = BACKGROUND_REQUEST_TIMEOUT_MS
) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: abortController.signal,
    });
    const data = await parseJson(response);
    if (abortController.signal.aborted) {
      const error = new Error('Request timed out');
      error.name = 'AbortError';
      return { ok: false, error, timedOut: true };
    }
    return { ok: true, response, data };
  } catch (error) {
    const timedOut = abortController.signal.aborted;
    return {
      ok: false,
      error,
      timedOut,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
