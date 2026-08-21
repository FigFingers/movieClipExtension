import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchJsonWithTimeout } from '../src/background/request.js';

async function withManualTimeout(fetchImpl, task) {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let fireTimeout;

  globalThis.fetch = fetchImpl;
  globalThis.setTimeout = (callback) => {
    fireTimeout = callback;
    return 1;
  };
  globalThis.clearTimeout = () => {};

  try {
    await task(() => fireTimeout());
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

function rejectOnAbort(signal, markStarted) {
  markStarted();
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
}

test('fetchJsonWithTimeout aborts while waiting for response headers', async () => {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });

  await withManualTimeout(
    async (_url, options) => rejectOnAbort(options.signal, markStarted),
    async (fireTimeout) => {
      const request = fetchJsonWithTimeout('/headers');
      await started;
      fireTimeout();
      const result = await request;
      assert.equal(result.ok, false);
      assert.equal(result.timedOut, true);
      assert.equal(result.error.name, 'AbortError');
    }
  );
});

test('fetchJsonWithTimeout aborts while consuming the response JSON body', async () => {
  let markBodyStarted;
  const bodyStarted = new Promise((resolve) => {
    markBodyStarted = resolve;
  });

  await withManualTimeout(
    async (_url, options) => ({
      status: 200,
      json: () => rejectOnAbort(options.signal, markBodyStarted),
    }),
    async (fireTimeout) => {
      const request = fetchJsonWithTimeout('/body');
      await bodyStarted;
      fireTimeout();
      const result = await request;
      assert.equal(result.ok, false);
      assert.equal(result.timedOut, true);
      assert.equal(result.error.name, 'AbortError');
    }
  );
});
