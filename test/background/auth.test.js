import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  saveExtensionAuthTokenInBackground,
  unlinkExtensionInBackground,
} from '../../src/background/authState.js';
import {
  enqueuePendingClipInBackground,
  openLoginTab,
  runExclusive,
  syncPendingQueue,
} from '../../src/background/sync.js';
import { checkAndRefreshToken } from '../../src/background/tokenRefresh.js';
import { getOrCreateInstanceId } from '../../src/background/instanceId.js';
import {
  enqueueClip,
  getExtensionConnectionState,
  saveExtensionAuthToken,
} from '../../src/content/extensionSync.js';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

async function withChromeState(state, { createTab, getStorage } = {}, task) {
  const originalChrome = globalThis.chrome;
  const runtime = { lastError: null };
  globalThis.chrome = {
    runtime,
    storage: {
      local: {
        get: getStorage || function get(keys, callback) {
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
  const state = { extensionInstanceId: INSTANCE_ID };

  await withChromeState(state, {}, async () => {
    assert.deepEqual(await saveExtensionAuthTokenInBackground({
      extensionInstanceId: OTHER_INSTANCE_ID,
      extensionAuthToken: 'token',
    }), { ok: false, reason: 'instance_mismatch' });
    assert.deepEqual(await saveExtensionAuthTokenInBackground({
      extensionInstanceId: INSTANCE_ID,
      extensionAuthToken: '   ',
    }), { ok: false, reason: 'invalid_token' });
    assert.deepEqual(await saveExtensionAuthTokenInBackground({
      extensionInstanceId: INSTANCE_ID,
      extensionAuthToken: 'token\nwith-newline',
    }), { ok: false, reason: 'invalid_token' });
    assert.deepEqual(await saveExtensionAuthTokenInBackground({
      extensionInstanceId: 'not-a-uuid',
      extensionAuthToken: 'token',
    }), { ok: false, reason: 'instance_mismatch' });
    assert.deepEqual(await saveExtensionAuthTokenInBackground({
      extensionInstanceId: '00000000-0000-0000-0000-000000000000',
      extensionAuthToken: 'token',
    }), { ok: false, reason: 'instance_mismatch' });
  });

  assert.equal(Object.hasOwn(state, 'extensionAuthToken'), false);
});

test('instance ID generation coalesces concurrent calls and heals invalid storage', async () => {
  const state = {
    extensionInstanceId: 'corrupted-id',
    extensionAuthToken: 'stale-token',
    extensionTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    extensionTokenRefreshBackoff: { failureCount: 2 },
    extensionLinked: true,
  };
  let getCalls = 0;
  let releaseGet;
  let markGetStarted;
  const getStarted = new Promise((resolve) => {
    markGetStarted = resolve;
  });

  await withChromeState(state, {
    getStorage(keys, callback) {
      getCalls += 1;
      const keyList = Array.isArray(keys) ? keys : [keys];
      const respond = () => callback(Object.fromEntries(
        keyList
          .filter((key) => Object.hasOwn(state, key))
          .map((key) => [key, state[key]])
      ));
      if (getCalls > 1) {
        respond();
        return;
      }
      releaseGet = respond;
      markGetStarted();
    },
  }, async () => {
    const first = getOrCreateInstanceId();
    const second = getOrCreateInstanceId();
    assert.equal(first, second);
    await getStarted;
    assert.equal(getCalls, 1);
    releaseGet();

    const [firstId, secondId] = await Promise.all([first, second]);
    assert.equal(firstId, secondId);
    assert.match(firstId, /^[0-9a-f-]{36}$/i);
  });

  assert.notEqual(state.extensionInstanceId, 'corrupted-id');
  assert.equal(Object.hasOwn(state, 'extensionAuthToken'), false);
  assert.equal(Object.hasOwn(state, 'extensionTokenExpiresAt'), false);
  assert.equal(Object.hasOwn(state, 'extensionTokenRefreshBackoff'), false);
  assert.equal(state.extensionLinked, false);
});

test('instance ID generation re-reads storage after the in-flight operation settles', async () => {
  const state = { extensionInstanceId: INSTANCE_ID };

  await withChromeState(state, {}, async () => {
    assert.equal(await getOrCreateInstanceId(), INSTANCE_ID);

    delete state.extensionInstanceId;
    state.extensionAuthToken = 'stale-token';
    state.extensionLinked = true;

    const regenerated = await getOrCreateInstanceId();
    assert.notEqual(regenerated, INSTANCE_ID);
    assert.equal(state.extensionInstanceId, regenerated);
    assert.equal(Object.hasOwn(state, 'extensionAuthToken'), false);
    assert.equal(state.extensionLinked, false);
  });
});

test('a valid instance ID lookup is not blocked by an auth request in flight', async () => {
  const state = { extensionInstanceId: INSTANCE_ID };
  let releaseBlocker;
  let markBlockerStarted;
  const blockerStarted = new Promise((resolve) => {
    markBlockerStarted = resolve;
  });
  const blocker = runExclusive(() => new Promise((resolve) => {
    releaseBlocker = resolve;
    markBlockerStarted();
  }));
  await blockerStarted;

  try {
    await withChromeState(state, {}, async () => {
      const outcome = await Promise.race([
        getOrCreateInstanceId(),
        new Promise((resolve) => setImmediate(() => resolve('blocked'))),
      ]);
      assert.equal(outcome, INSTANCE_ID);
    });
  } finally {
    releaseBlocker();
    await blocker;
  }
});

test('background auth save normalizes expiry and clears old refresh backoff', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionTokenRefreshBackoff: { failureCount: 2 },
  };

  await withChromeState(state, {}, async () => {
    assert.deepEqual(await saveExtensionAuthTokenInBackground({
      extensionInstanceId: INSTANCE_ID,
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
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'old-token',
    extensionLinked: true,
  };

  await withChromeState(state, {}, async () => {
    const unlinkFirst = unlinkExtensionInBackground({
      extensionInstanceId: INSTANCE_ID,
    });
    const saveSecond = saveExtensionAuthTokenInBackground({
      extensionInstanceId: INSTANCE_ID,
      extensionAuthToken: 'new-token',
    });
    assert.deepEqual(await unlinkFirst, { ok: true });
    assert.deepEqual(await saveSecond, { ok: true });
    assert.equal(state.extensionAuthToken, 'new-token');
    assert.equal(state.extensionLinked, true);

    const saveFirst = saveExtensionAuthTokenInBackground({
      extensionInstanceId: INSTANCE_ID,
      extensionAuthToken: 'newer-token',
    });
    const unlinkSecond = unlinkExtensionInBackground({
      extensionInstanceId: INSTANCE_ID,
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
      INSTANCE_ID,
      'token',
      '2099-01-01T00:00:00.000Z'
    ), true);
    assert.deepEqual(sentMessage, {
      type: 'SAVE_EXTENSION_AUTH_TOKEN',
      extensionInstanceId: INSTANCE_ID,
      extensionAuthToken: 'token',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    chrome.runtime.sendMessage = (_message, callback) => {
      chrome.runtime.lastError = { message: 'service worker unavailable' };
      callback();
      chrome.runtime.lastError = null;
    };
    await assert.rejects(
      saveExtensionAuthToken(INSTANCE_ID, 'token'),
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

test('content auth status fails closed for an invalid stored token', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'invalid\ntoken',
    extensionLinked: true,
  };

  await withChromeState(state, {}, async () => {
    const connection = await getExtensionConnectionState();
    assert.equal(connection.extensionInstanceId, INSTANCE_ID);
    assert.equal(connection.extensionAuthToken, null);
    assert.equal(connection.extensionLinked, false);
  });
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
    extensionInstanceId: INSTANCE_ID,
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
      extensionInstanceId: INSTANCE_ID,
      extensionAuthToken: 'new-token',
    }), { ok: true });
  });

  assert.equal(state.extensionAuthToken, 'new-token');
  assert.equal(state.pendingClips.length, 1);
});

test('a stale sync 401 keeps a replaced token and the pending queue', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'old-token',
    extensionLinked: true,
    pendingClips: [{
      clientItemId: 'client-item',
      url: 'https://www.netflix.com/watch/1',
      startTime: 1,
      endTime: 2,
    }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    state.extensionAuthToken = 'new-token';
    return { status: 401, json: async () => null };
  };

  try {
    await withChromeState(state, {}, async () => {
      assert.deepEqual(await syncPendingQueue({ openLoginIfMissingToken: true }), {
        ok: false,
        queued: true,
        reason: 'stale_unauthorized',
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(state.extensionAuthToken, 'new-token');
  assert.equal(state.extensionLinked, true);
  assert.equal(state.pendingClips.length, 1);
  assert.equal(Object.hasOwn(state, 'extensionLoginPromptLastOpenedAt'), false);
});

test('clip sync removes only IDs confirmed by a valid success response', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'token',
    extensionLinked: true,
    pendingClips: [
      {
        clientItemId: 'accepted-item',
        url: 'https://www.netflix.com/watch/1',
        startTime: 1,
        endTime: 2,
      },
      {
        clientItemId: 'queued-item',
        url: 'https://www.netflix.com/watch/2',
        startTime: 3,
        endTime: 4,
      },
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({
      ok: true,
      acceptedItemIds: ['accepted-item'],
    }),
  });

  try {
    await withChromeState(state, {}, async () => {
      assert.deepEqual(await syncPendingQueue(), {
        ok: true,
        acceptedCount: 1,
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    state.pendingClips.map((clip) => clip.clientItemId),
    ['queued-item']
  );
  assert.match(state.lastSyncAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('a clip enqueued while sync removes accepted IDs is not lost', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'token',
    extensionLinked: true,
    pendingClips: [{
      clientItemId: 'accepted-item',
      url: 'https://www.netflix.com/watch/1',
      startTime: 1,
      endTime: 2,
    }],
  };
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });
  let releaseRemovalRead;
  let markRemovalReadStarted;
  const removalReadStarted = new Promise((resolve) => {
    markRemovalReadStarted = resolve;
  });
  let pendingOnlyReads = 0;

  globalThis.location = {
    href: 'https://www.netflix.com/watch/2',
    origin: 'https://www.netflix.com',
  };
  globalThis.fetch = async () => {
    markFetchStarted();
    return new Promise((resolve) => {
      releaseFetch = () => resolve({
        status: 200,
        json: async () => ({
          ok: true,
          acceptedItemIds: ['accepted-item'],
        }),
      });
    });
  };

  try {
    await withChromeState(state, {
      getStorage(keys, callback) {
        const keyList = Array.isArray(keys) ? keys : [keys];
        const snapshot = Object.fromEntries(
          keyList
            .filter((key) => Object.hasOwn(state, key))
            .map((key) => [key, structuredClone(state[key])])
        );
        if (keyList.length === 1 && keyList[0] === 'pendingClips') {
          pendingOnlyReads += 1;
          if (pendingOnlyReads === 1) {
            releaseRemovalRead = () => callback(snapshot);
            markRemovalReadStarted();
            return;
          }
        }
        callback(snapshot);
      },
    }, async () => {
      chrome.runtime.sendMessage = (message, callback) => {
        assert.equal(message?.type, 'ENQUEUE_PENDING_CLIP');
        enqueuePendingClipInBackground(message.clip).then(callback);
      };

      const syncPromise = syncPendingQueue();
      await fetchStarted;
      releaseFetch();
      await removalReadStarted;

      const enqueuePromise = enqueueClip({
        clientItemId: 'new-item',
        url: 'https://www.netflix.com/watch/2',
        startTime: 3,
        endTime: 4,
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        pendingOnlyReads,
        1,
        'enqueue must wait for the in-progress queue mutation before reading'
      );
      releaseRemovalRead();

      const [syncResult, queuedClip] = await Promise.all([
        syncPromise,
        enqueuePromise,
      ]);
      assert.deepEqual(syncResult, {
        ok: true,
        acceptedCount: 1,
      });
      assert.equal(queuedClip.clientItemId, 'new-item');
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) {
      delete globalThis.location;
    } else {
      globalThis.location = originalLocation;
    }
  }

  assert.deepEqual(
    state.pendingClips.map((clip) => clip.clientItemId),
    ['new-item']
  );
});

test('enqueue stays responsive during sync fetch and coalesces a follow-up sync', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'token',
    extensionLinked: true,
    pendingClips: [{
      clientItemId: 'first-item',
      url: 'https://www.netflix.com/watch/1',
      startTime: 1,
      endTime: 2,
    }],
  };
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  const requestItemIds = [];
  let releaseFirstFetch;
  let markFirstFetchStarted;
  const firstFetchStarted = new Promise((resolve) => {
    markFirstFetchStarted = resolve;
  });

  globalThis.location = {
    href: 'https://www.netflix.com/watch/2',
    origin: 'https://www.netflix.com',
  };
  globalThis.fetch = async (_url, options) => {
    const itemIds = JSON.parse(options.body).items.map((item) => item.clientItemId);
    requestItemIds.push(itemIds);
    if (requestItemIds.length === 1) {
      markFirstFetchStarted();
      return new Promise((resolve) => {
        releaseFirstFetch = () => resolve({
          status: 200,
          json: async () => ({
            ok: true,
            acceptedItemIds: ['first-item'],
          }),
        });
      });
    }
    return {
      status: 200,
      json: async () => ({
        ok: true,
        acceptedItemIds: ['second-item'],
      }),
    };
  };

  try {
    await withChromeState(state, {}, async () => {
      chrome.runtime.sendMessage = (message, callback) => {
        assert.equal(message?.type, 'ENQUEUE_PENDING_CLIP');
        enqueuePendingClipInBackground(message.clip).then(callback);
      };

      const firstSync = syncPendingQueue();
      await firstFetchStarted;

      const enqueueOutcome = await Promise.race([
        enqueueClip({
          clientItemId: 'second-item',
          url: 'https://www.netflix.com/watch/2',
          startTime: 3,
          endTime: 4,
        }).then((clip) => ({ type: 'queued', clip })),
        new Promise((resolve) => setImmediate(() => resolve({ type: 'blocked' }))),
      ]);
      assert.equal(enqueueOutcome.type, 'queued');
      assert.equal(enqueueOutcome.clip.clientItemId, 'second-item');

      const coalescedSync = syncPendingQueue();
      assert.equal(coalescedSync, firstSync);
      releaseFirstFetch();

      assert.deepEqual(await coalescedSync, {
        ok: true,
        acceptedCount: 1,
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) {
      delete globalThis.location;
    } else {
      globalThis.location = originalLocation;
    }
  }

  assert.deepEqual(requestItemIds, [['first-item'], ['second-item']]);
  assert.deepEqual(state.pendingClips, []);
});

test('malformed clip sync success keeps every pending clip queued', async () => {
  const invalidPayloads = [
    null,
    {},
    { ok: false, acceptedItemIds: ['client-item'] },
    { ok: true },
    { ok: true, acceptedItemIds: ['unknown-item'] },
    { ok: true, acceptedItemIds: ['client-item', 'client-item'] },
  ];

  for (const payload of invalidPayloads) {
    const state = {
      extensionInstanceId: INSTANCE_ID,
      extensionAuthToken: 'token',
      extensionLinked: true,
      pendingClips: [{
        clientItemId: 'client-item',
        url: 'https://www.netflix.com/watch/1',
        startTime: 1,
        endTime: 2,
      }],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      status: 200,
      json: async () => payload,
    });

    try {
      await withChromeState(state, {}, async () => {
        assert.deepEqual(await syncPendingQueue(), {
          ok: false,
          queued: true,
          reason: 'invalid_response',
        });
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(state.pendingClips.length, 1);
    assert.equal(Object.hasOwn(state, 'lastSyncAt'), false);
  }
});

test('a generic sync 400 keeps the attempted queue when no item is identified', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'token',
    extensionLinked: true,
    pendingClips: [
      {
        clientItemId: 'first-item',
        url: 'https://www.netflix.com/watch/1',
        startTime: 1,
        endTime: 2,
      },
      {
        clientItemId: 'second-item',
        url: 'https://www.netflix.com/watch/2',
        startTime: 3,
        endTime: 4,
      },
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 400,
    json: async () => ({
      message: 'Invalid request body',
      code: 'INVALID_BODY',
    }),
  });

  try {
    await withChromeState(state, {}, async () => {
      assert.deepEqual(await syncPendingQueue(), {
        ok: false,
        queued: true,
        reason: 'validation_error',
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    state.pendingClips.map((clip) => clip.clientItemId),
    ['first-item', 'second-item']
  );
});

test('a sync 400 drops only client item IDs explicitly identified by the server', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'token',
    extensionLinked: true,
    pendingClips: [
      {
        clientItemId: 'bad-item',
        url: 'https://www.netflix.com/watch/1',
        startTime: 1,
        endTime: 2,
      },
      {
        clientItemId: 'good-item',
        url: 'https://www.netflix.com/watch/2',
        startTime: 3,
        endTime: 4,
      },
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 400,
    json: async () => ({
      issues: [{ clientItemId: 'bad-item' }],
    }),
  });

  try {
    await withChromeState(state, {}, async () => {
      assert.deepEqual(await syncPendingQueue(), {
        ok: false,
        queued: false,
        reason: 'validation_error',
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    state.pendingClips.map((clip) => clip.clientItemId),
    ['good-item']
  );
});

test('clip sync heals an invalid stored instance ID before any fetch', async () => {
  const state = {
    extensionInstanceId: 'corrupted-id',
    extensionAuthToken: 'token',
    extensionLinked: true,
    pendingClips: [{
      clientItemId: 'client-item',
      url: 'https://www.netflix.com/watch/1',
      startTime: 1,
      endTime: 2,
    }],
  };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch must not run');
  };

  try {
    await withChromeState(state, {}, async () => {
      assert.deepEqual(await syncPendingQueue(), {
        ok: false,
        queued: true,
        reason: 'missing_token',
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls, 0);
  assert.notEqual(state.extensionInstanceId, 'corrupted-id');
  assert.equal(Object.hasOwn(state, 'extensionAuthToken'), false);
  assert.equal(state.extensionLinked, false);
  assert.equal(state.pendingClips.length, 1);
});

test('a stalled token refresh times out and releases the auth mutex', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
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
      extensionInstanceId: INSTANCE_ID,
      extensionAuthToken: 'new-token',
    }), { ok: true });
  });

  assert.equal(state.extensionAuthToken, 'new-token');
  assert.equal(state.extensionLinked, true);
});

test('token refresh accepts only a complete success payload and clears backoff', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'old-token',
    extensionLinked: true,
    extensionTokenExpiresAt: '2020-01-01T00:00:00.000Z',
    extensionTokenRefreshBackoff: {
      tokenFingerprint: 'superseded',
      failureCount: 3,
      nextAttemptAt: '2020-01-01T00:00:00.000Z',
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({
      ok: true,
      extensionAuthToken: 'rotated-token',
      expiresAt: '2099-01-01T00:00:00Z',
    }),
  });

  try {
    await withChromeState(state, {}, async () => {
      assert.deepEqual(await checkAndRefreshToken(), {
        ok: true,
        refreshed: true,
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(state.extensionAuthToken, 'rotated-token');
  assert.equal(state.extensionTokenExpiresAt, '2099-01-01T00:00:00.000Z');
  assert.equal(state.extensionLinked, true);
  assert.equal(Object.hasOwn(state, 'extensionTokenRefreshBackoff'), false);
});

test('refresh discards backoff from a superseded token before the due check', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'current-token',
    extensionLinked: true,
    extensionTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    extensionTokenRefreshBackoff: {
      tokenFingerprint: 'fingerprint-for-an-old-token',
      failureCount: 4,
      nextAttemptAt: '2099-01-01T00:00:00.000Z',
    },
  };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch must not run');
  };

  try {
    await withChromeState(state, {}, async () => {
      assert.deepEqual(await checkAndRefreshToken(), {
        ok: true,
        skipped: true,
        reason: 'not_due',
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls, 0);
  assert.equal(state.extensionAuthToken, 'current-token');
  assert.equal(Object.hasOwn(state, 'extensionTokenRefreshBackoff'), false);
});

test('token refresh heals an invalid stored instance ID before any fetch', async () => {
  const state = {
    extensionInstanceId: 'corrupted-id',
    extensionAuthToken: 'token',
    extensionLinked: true,
    extensionTokenExpiresAt: '2099-01-01T00:00:00.000Z',
  };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch must not run');
  };

  try {
    await withChromeState(state, {}, async () => {
      assert.deepEqual(await checkAndRefreshToken(), {
        ok: true,
        skipped: true,
        reason: 'not_linked',
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls, 0);
  assert.notEqual(state.extensionInstanceId, 'corrupted-id');
  assert.equal(Object.hasOwn(state, 'extensionAuthToken'), false);
  assert.equal(Object.hasOwn(state, 'extensionTokenExpiresAt'), false);
  assert.equal(state.extensionLinked, false);
});

test('malformed token refresh success keeps the current token and schedules backoff', async () => {
  const invalidPayloads = [
    null,
    { ok: false, extensionAuthToken: 'rotated-token', expiresAt: '2099-01-01T00:00:00Z' },
    { ok: true, extensionAuthToken: '', expiresAt: '2099-01-01T00:00:00Z' },
    { ok: true, extensionAuthToken: 'rotated-token', expiresAt: 'not-a-date' },
    { ok: true, extensionAuthToken: 'rotated-token', expiresAt: '2020-01-01T00:00:00Z' },
  ];

  for (const payload of invalidPayloads) {
    const state = {
      extensionInstanceId: INSTANCE_ID,
      extensionAuthToken: 'current-token',
      extensionLinked: true,
      extensionTokenExpiresAt: '2020-01-01T00:00:00.000Z',
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      status: 200,
      json: async () => payload,
    });

    try {
      await withChromeState(state, {}, async () => {
        assert.deepEqual(await checkAndRefreshToken(), {
          ok: false,
          reason: 'invalid_response',
        });
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(state.extensionAuthToken, 'current-token');
    assert.equal(state.extensionLinked, true);
    assert.equal(state.extensionTokenRefreshBackoff.failureCount, 1);
    assert.equal(state.extensionTokenRefreshBackoff.lastStatus, 200);
  }
});

test('token refresh 401 clears only the token used by that request', async () => {
  const currentState = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'current-token',
    extensionLinked: true,
    extensionTokenExpiresAt: '2020-01-01T00:00:00.000Z',
    extensionTokenRefreshBackoff: { failureCount: 1 },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 401, json: async () => null });

  try {
    await withChromeState(currentState, {}, async () => {
      assert.deepEqual(await checkAndRefreshToken(), {
        ok: false,
        reason: 'unauthorized',
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(Object.hasOwn(currentState, 'extensionAuthToken'), false);
  assert.equal(Object.hasOwn(currentState, 'extensionTokenExpiresAt'), false);
  assert.equal(Object.hasOwn(currentState, 'extensionTokenRefreshBackoff'), false);
  assert.equal(currentState.extensionLinked, false);

  const staleState = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'old-token',
    extensionLinked: true,
    extensionTokenExpiresAt: '2020-01-01T00:00:00.000Z',
  };
  globalThis.fetch = async () => {
    staleState.extensionAuthToken = 'new-token';
    staleState.extensionTokenExpiresAt = '2099-01-01T00:00:00.000Z';
    return { status: 401, json: async () => null };
  };

  try {
    await withChromeState(staleState, {}, async () => {
      assert.deepEqual(await checkAndRefreshToken(), {
        ok: false,
        reason: 'stale_unauthorized',
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(staleState.extensionAuthToken, 'new-token');
  assert.equal(staleState.extensionLinked, true);
  assert.equal(staleState.extensionTokenExpiresAt, '2099-01-01T00:00:00.000Z');
});
