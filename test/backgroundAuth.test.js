import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  saveExtensionAuthTokenInBackground,
  unlinkExtensionInBackground,
} from '../src/background/authState.js';
import { openLoginTab, syncPendingQueue } from '../src/background/sync.js';
import { checkAndRefreshToken } from '../src/background/tokenRefresh.js';
import { saveExtensionAuthToken } from '../src/content/extensionSync.js';

async function withChromeState(state, { createTab } = {}, task) {
  const originalChrome = globalThis.chrome;
  const runtime = { lastError: null };
  globalThis.chrome = {
    runtime,
    storage: {
      local: {
        get(keys, callback) {
          const keyList = Array.isArray(keys) ? keys : [keys];
          callback(Object.fromEntries(
            keyList
              .filter((key) => Object.hasOwn(state, key))
              .map((key) => [key, state[key]])
          ));
        },
        set(items, callback) {
          Object.assign(state, items);
          callback();
        },
        remove(keys, callback) {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const key of keyList) delete state[key];
          callback();
        },
      },
    },
    tabs: {
      create: createTab || ((_options, callback) => callback({ id: 1 })),
    },
  };

  try {
    await task({ runtime });
  } finally {
    if (originalChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = originalChrome;
    }
  }
}

test('background auth save validates instance and token before writing', async () => {
  const state = { extensionInstanceId: 'instance-id' };

  await withChromeState(state, {}, async () => {
    assert.deepEqual(await saveExtensionAuthTokenInBackground({
      extensionInstanceId: 'another-instance',
      extensionAuthToken: 'token',
    }), { ok: false, reason: 'instance_mismatch' });
    assert.deepEqual(await saveExtensionAuthTokenInBackground({
      extensionInstanceId: 'instance-id',
      extensionAuthToken: '   ',
    }), { ok: false, reason: 'invalid_token' });
  });

  assert.equal(Object.hasOwn(state, 'extensionAuthToken'), false);
});

test('background auth save normalizes expiry and clears old refresh backoff', async () => {
  const state = {
    extensionInstanceId: 'instance-id',
    extensionTokenRefreshBackoff: { failureCount: 2 },
  };

  await withChromeState(state, {}, async () => {
    assert.deepEqual(await saveExtensionAuthTokenInBackground({
      extensionInstanceId: 'instance-id',
      extensionAuthToken: 'new-token',
      expiresAt: '2099-01-01T00:00:00Z',
    }), { ok: true });
  });

  assert.equal(state.extensionAuthToken, 'new-token');
  assert.equal(state.extensionTokenExpiresAt, '2099-01-01T00:00:00.000Z');
  assert.equal(state.extensionLinked, true);
  assert.equal(Object.hasOwn(state, 'extensionTokenRefreshBackoff'), false);
});

test('unlink and re-link operations are applied in mutex call order', async () => {
  const state = {
    extensionInstanceId: 'instance-id',
    extensionAuthToken: 'old-token',
    extensionLinked: true,
  };

  await withChromeState(state, {}, async () => {
    const unlinkFirst = unlinkExtensionInBackground({
      extensionInstanceId: 'instance-id',
    });
    const saveSecond = saveExtensionAuthTokenInBackground({
      extensionInstanceId: 'instance-id',
      extensionAuthToken: 'new-token',
    });
    assert.deepEqual(await unlinkFirst, { ok: true });
    assert.deepEqual(await saveSecond, { ok: true });
    assert.equal(state.extensionAuthToken, 'new-token');
    assert.equal(state.extensionLinked, true);

    const saveFirst = saveExtensionAuthTokenInBackground({
      extensionInstanceId: 'instance-id',
      extensionAuthToken: 'newer-token',
    });
    const unlinkSecond = unlinkExtensionInBackground({
      extensionInstanceId: 'instance-id',
    });
    assert.deepEqual(await saveFirst, { ok: true });
    assert.deepEqual(await unlinkSecond, { ok: true });
  });

  assert.equal(Object.hasOwn(state, 'extensionAuthToken'), false);
  assert.equal(state.extensionLinked, false);
});

test('all login callers share one tab creation and then observe cooldown', async () => {
  const state = {};
  let createCalls = 0;
  let finishCreate;
  let markCreateStarted;
  const createStarted = new Promise((resolve) => {
    markCreateStarted = resolve;
  });

  await withChromeState(state, {
    createTab(_options, callback) {
      createCalls += 1;
      finishCreate = callback;
      markCreateStarted();
    },
  }, async () => {
    const first = openLoginTab();
    const second = openLoginTab();
    assert.equal(first, second);
    await createStarted;
    finishCreate({ id: 42 });

    assert.deepEqual(await first, { ok: true, tabId: 42 });
    assert.deepEqual(await second, { ok: true, tabId: 42 });
    assert.equal(createCalls, 1);
    assert.equal(typeof state.extensionLoginPromptLastOpenedAt, 'number');

    assert.deepEqual(await openLoginTab(), {
      ok: true,
      skipped: true,
      reason: 'cooldown',
    });
    assert.equal(createCalls, 1);
  });
});

test('failed login tab creation does not start cooldown and can retry', async () => {
  const state = {};
  let createCalls = 0;

  await withChromeState(state, {
    createTab(_options, callback) {
      createCalls += 1;
      if (createCalls === 1) {
        chrome.runtime.lastError = { message: 'tab failed' };
        callback();
        chrome.runtime.lastError = null;
        return;
      }
      callback({ id: 43 });
    },
  }, async () => {
    assert.deepEqual(await openLoginTab(), {
      ok: false,
      reason: 'tab_create_failed',
      error: 'tab failed',
    });
    assert.equal(Object.hasOwn(state, 'extensionLoginPromptLastOpenedAt'), false);

    assert.deepEqual(await openLoginTab(), { ok: true, tabId: 43 });
    assert.equal(createCalls, 2);
    assert.equal(typeof state.extensionLoginPromptLastOpenedAt, 'number');
  });
});

test('content auth bridge forwards writes and surfaces runtime errors', async () => {
  const originalChrome = globalThis.chrome;
  let sentMessage;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        sentMessage = message;
        callback({ ok: true });
      },
    },
  };

  try {
    assert.equal(await saveExtensionAuthToken(
      'instance-id',
      'token',
      '2099-01-01T00:00:00.000Z'
    ), true);
    assert.deepEqual(sentMessage, {
      type: 'SAVE_EXTENSION_AUTH_TOKEN',
      extensionInstanceId: 'instance-id',
      extensionAuthToken: 'token',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    chrome.runtime.sendMessage = (_message, callback) => {
      chrome.runtime.lastError = { message: 'service worker unavailable' };
      callback();
      chrome.runtime.lastError = null;
    };
    await assert.rejects(
      saveExtensionAuthToken('instance-id', 'token'),
      /service worker unavailable/
    );
  } finally {
    if (originalChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = originalChrome;
    }
  }
});

async function withStalledFetch(task) {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let abortRequest;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });

  globalThis.setTimeout = (callback) => {
    abortRequest = callback;
    return 1;
  };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = async (_url, options) => {
    markFetchStarted();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  };

  try {
    await task({ fetchStarted, abort: () => abortRequest() });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

test('a stalled clip sync times out and releases the auth mutex', async () => {
  const state = {
    extensionInstanceId: 'instance-id',
    extensionAuthToken: 'token',
    extensionLinked: true,
    pendingClips: [{
      clientItemId: 'client-item',
      url: 'https://www.netflix.com/watch/1',
      startTime: 1,
      endTime: 2,
    }],
  };

  await withChromeState(state, {}, async () => {
    await withStalledFetch(async ({ fetchStarted, abort }) => {
      const syncPromise = syncPendingQueue();
      await fetchStarted;
      abort();
      assert.deepEqual(await syncPromise, {
        ok: false,
        queued: true,
        reason: 'timeout',
      });
    });

    assert.deepEqual(await saveExtensionAuthTokenInBackground({
      extensionInstanceId: 'instance-id',
      extensionAuthToken: 'new-token',
    }), { ok: true });
  });

  assert.equal(state.extensionAuthToken, 'new-token');
  assert.equal(state.pendingClips.length, 1);
});

test('a stalled token refresh times out and releases the auth mutex', async () => {
  const state = {
    extensionInstanceId: 'instance-id',
    extensionAuthToken: 'token',
    extensionLinked: true,
    extensionTokenExpiresAt: '2020-01-01T00:00:00.000Z',
  };

  await withChromeState(state, {}, async () => {
    await withStalledFetch(async ({ fetchStarted, abort }) => {
      const refreshPromise = checkAndRefreshToken();
      await fetchStarted;
      abort();
      const result = await refreshPromise;
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'timeout');
    });

    assert.deepEqual(await saveExtensionAuthTokenInBackground({
      extensionInstanceId: 'instance-id',
      extensionAuthToken: 'new-token',
    }), { ok: true });
  });

  assert.equal(state.extensionAuthToken, 'new-token');
  assert.equal(state.extensionLinked, true);
});
