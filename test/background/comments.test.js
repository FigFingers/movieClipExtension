import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCommentsApiUrl,
  COMMENTS_REQUEST_TIMEOUT_MS,
  fetchClipComments,
  getCommentsResponseReason,
  isValidCommentsSuccessResponse,
  postClipComment,
  validateFetchClipCommentsInput,
  validatePostClipCommentInput,
} from '../../src/background/comments.js';
import { saveExtensionAuthTokenInBackground } from '../../src/background/authState.js';
import { runExclusive } from '../../src/background/sync.js';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

function commentFixture(clipId = 1, overrides = {}) {
  return {
    id: 10,
    clipId,
    userId: 7,
    username: 'alice',
    body: 'hello',
    atMs: null,
    createdAt: '2026-07-18T09:30:00.000Z',
    ...overrides,
  };
}

function getResponseFixture(clipId = 1, overrides = {}) {
  return {
    ok: true,
    clipId,
    comments: [commentFixture(clipId)],
    hasNext: false,
    nextCursor: null,
    ...overrides,
  };
}

function postResponseFixture(clipId = 1, overrides = {}) {
  return {
    ok: true,
    comment: commentFixture(clipId),
    ...overrides,
  };
}

function jsonResponse(status, data) {
  return {
    status,
    json: async () => data,
  };
}

async function withCommentRequestMocks({ state, fetchImpl }, task) {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;

  globalThis.chrome = {
    runtime: { lastError: null },
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
        remove(keys, callback) {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const key of keyList) delete state[key];
          callback();
        },
        set(items, callback) {
          Object.assign(state, items);
          callback();
        },
      },
    },
  };
  globalThis.fetch = fetchImpl;

  try {
    await task();
  } finally {
    if (originalChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = originalChrome;
    }
    if (originalFetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = originalFetch;
    }
  }
}

test('コメント一覧入力を正規化し、limit の既定値を設定する', () => {
  assert.deepEqual(validateFetchClipCommentsInput({ clipId: ' 42 ' }), {
    ok: true,
    value: {
      clipId: 42,
      limit: 20,
    },
  });

  assert.deepEqual(validateFetchClipCommentsInput({
    clipId: 42,
    cursor: '9',
    limit: '100',
  }), {
    ok: true,
    value: {
      clipId: 42,
      cursor: 9,
      limit: 100,
    },
  });
});

test('コメント一覧入力の不正な整数と limit を拒否する', () => {
  for (const clipId of [undefined, null, true, 0, -1, 1.5, '1.5', 'abc']) {
    const result = validateFetchClipCommentsInput({ clipId });
    assert.equal(result.ok, false);
    assert.equal(result.field, 'clipId');
  }

  for (const limit of [0, 101, 1.5, 'abc', null]) {
    const result = validateFetchClipCommentsInput({ clipId: 1, limit });
    assert.equal(result.ok, false);
    assert.equal(result.field, 'limit');
  }

  const cursorResult = validateFetchClipCommentsInput({ clipId: 1, cursor: 0 });
  assert.equal(cursorResult.ok, false);
  assert.equal(cursorResult.field, 'cursor');
});

test('コメント本文を trim し、1〜500文字だけ許可する', () => {
  assert.deepEqual(validatePostClipCommentInput({
    clipId: '7',
    body: '  hello  ',
  }), {
    ok: true,
    value: {
      clipId: 7,
      body: 'hello',
    },
  });

  assert.equal(validatePostClipCommentInput({
    clipId: 7,
    body: 'a'.repeat(500),
  }).ok, true);
  assert.equal(validatePostClipCommentInput({
    clipId: 7,
    body: '😀'.repeat(500),
  }).ok, true);

  for (const body of [
    undefined,
    null,
    123,
    '',
    '   ',
    'a'.repeat(501),
    '😀'.repeat(501),
  ]) {
    const result = validatePostClipCommentInput({ clipId: 7, body });
    assert.equal(result.ok, false);
    assert.equal(result.field, 'body');
  }
});

test('コメントAPI URLは認証instanceIdとページネーションだけをqueryに含める', () => {
  const url = new URL(buildCommentsApiUrl({
    clipId: 123,
    cursor: 456,
    limit: 20,
  }, '11111111-1111-4111-8111-111111111111'));

  assert.equal(url.pathname, '/api/extension/clips/123/comments');
  assert.equal(
    url.searchParams.get('extensionInstanceId'),
    '11111111-1111-4111-8111-111111111111'
  );
  assert.equal(url.searchParams.get('cursor'), '456');
  assert.equal(url.searchParams.get('limit'), '20');
});

test('HTTP statusをコメントUI向けreasonへ変換する', () => {
  assert.equal(getCommentsResponseReason(200), null);
  assert.equal(getCommentsResponseReason(201), null);
  assert.equal(getCommentsResponseReason(400), 'validation_error');
  assert.equal(getCommentsResponseReason(401), 'unauthorized');
  assert.equal(getCommentsResponseReason(403), 'forbidden');
  assert.equal(getCommentsResponseReason(404), 'not_found');
  assert.equal(getCommentsResponseReason(429), 'rate_limited');
  assert.equal(getCommentsResponseReason(500), 'request_failed');
});

test('successful GET and POST responses require their expected JSON shape', () => {
  assert.equal(isValidCommentsSuccessResponse(
    'GET',
    getResponseFixture(1),
    1
  ), true);
  assert.equal(isValidCommentsSuccessResponse('GET', getResponseFixture(1, {
    comments: [
      commentFixture(1, { id: 11 }),
      commentFixture(1, { id: 10, username: null }),
    ],
    hasNext: true,
    nextCursor: 10,
  }), 1), true);
  assert.equal(isValidCommentsSuccessResponse(
    'POST',
    postResponseFixture(1),
    1
  ), true);
  assert.equal(isValidCommentsSuccessResponse('POST', postResponseFixture(1, {
    comment: commentFixture(1, {
      atMs: 12_345,
      futureField: { safely: 'ignored' },
    }),
  }), 1), true);
  assert.equal(isValidCommentsSuccessResponse('GET', getResponseFixture(1, {
    comments: [commentFixture(1, {
      userId: null,
      username: null,
      body: '😀'.repeat(500),
    })],
  }), 1), true);

  assert.equal(isValidCommentsSuccessResponse('GET', {}, 1), false);
  assert.equal(isValidCommentsSuccessResponse('GET', getResponseFixture(1, {
    ok: false,
  }), 1), false);
  assert.equal(isValidCommentsSuccessResponse('GET', getResponseFixture(2), 1), false);
  assert.equal(isValidCommentsSuccessResponse('GET', getResponseFixture(1, {
    hasNext: true,
    nextCursor: null,
  }), 1), false);
  assert.equal(isValidCommentsSuccessResponse('GET', getResponseFixture(1, {
    nextCursor: 10,
  }), 1), false);
  assert.equal(isValidCommentsSuccessResponse('POST', { ok: true, comment: {} }, 1), false);
  assert.equal(isValidCommentsSuccessResponse('POST', null, 1), false);
});

test('comment responses require every field in the API contract', () => {
  const invalidOverrides = [
    { id: undefined },
    { clipId: undefined },
    { clipId: 2 },
    { userId: undefined },
    { userId: 0 },
    { username: undefined },
    { body: undefined },
    { body: '' },
    { body: '   ' },
    { body: 'a'.repeat(501) },
    { createdAt: undefined },
    { createdAt: 'not-a-date' },
    { createdAt: '01/02/2026' },
  ];

  for (const override of invalidOverrides) {
    assert.equal(isValidCommentsSuccessResponse('POST', postResponseFixture(1, {
      comment: commentFixture(1, override),
    }), 1), false, JSON.stringify(override));
  }
});

test('malformed success JSON is returned as invalid_response', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'token',
  };

  await withCommentRequestMocks({
    state,
    fetchImpl: async () => jsonResponse(200, {}),
  }, async () => {
    assert.deepEqual(await fetchClipComments({ clipId: 1 }), {
      ok: false,
      reason: 'invalid_response',
      status: 200,
    });
  });

  await withCommentRequestMocks({
    state,
    fetchImpl: async () => jsonResponse(201, { comment: {} }),
  }, async () => {
    assert.deepEqual(await postClipComment({ clipId: 1, body: 'hello' }), {
      ok: false,
      reason: 'invalid_response',
      status: 201,
    });
  });
});

test('GET accepts only 200 and POST accepts only 201', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'token',
  };

  await withCommentRequestMocks({
    state,
    fetchImpl: async () => jsonResponse(201, getResponseFixture(1)),
  }, async () => {
    assert.deepEqual(await fetchClipComments({ clipId: 1 }), {
      ok: false,
      reason: 'request_failed',
      status: 201,
    });
  });

  await withCommentRequestMocks({
    state,
    fetchImpl: async () => jsonResponse(200, postResponseFixture(1)),
  }, async () => {
    assert.deepEqual(await postClipComment({ clipId: 1, body: 'hello' }), {
      ok: false,
      reason: 'request_failed',
      status: 200,
    });
  });
});

test('429 is returned as a deterministic rate limit rejection', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'token',
    extensionLinked: true,
  };

  await withCommentRequestMocks({
    state,
    fetchImpl: async () => jsonResponse(429, {
      message: 'Comment rate limit exceeded',
      code: 'COMMENT_RATE_LIMITED',
    }),
  }, async () => {
    assert.deepEqual(await postClipComment({ clipId: 1, body: 'hello' }), {
      ok: false,
      reason: 'rate_limited',
      status: 429,
      message: 'Comment rate limit exceeded',
      code: 'COMMENT_RATE_LIMITED',
    });
  });

  assert.equal(state.extensionAuthToken, 'token');
  assert.equal(state.extensionLinked, true);
});

test('comments heal an invalid stored instance ID before any fetch', async () => {
  const state = {
    extensionInstanceId: 'corrupted-id',
    extensionAuthToken: 'token',
    extensionLinked: true,
  };
  let fetchCalls = 0;

  await withCommentRequestMocks({
    state,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('fetch must not run');
    },
  }, async () => {
    assert.deepEqual(await fetchClipComments({ clipId: 1 }), {
      ok: false,
      reason: 'missing_token',
    });
  });

  assert.equal(fetchCalls, 0);
  assert.notEqual(state.extensionInstanceId, 'corrupted-id');
  assert.equal(Object.hasOwn(state, 'extensionAuthToken'), false);
  assert.equal(state.extensionLinked, false);
});

test('a stale 401 does not clear a newly stored auth token', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'old-token',
    extensionTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    extensionLinked: true,
  };

  await withCommentRequestMocks({
    state,
    fetchImpl: async () => {
      state.extensionAuthToken = 'new-token';
      return jsonResponse(401, { message: 'expired' });
    },
  }, async () => {
    const result = await fetchClipComments({ clipId: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale_unauthorized');
    assert.equal(result.message, 'expired');
  });

  assert.equal(state.extensionAuthToken, 'new-token');
  assert.equal(state.extensionLinked, true);
  assert.equal(state.extensionTokenExpiresAt, '2099-01-01T00:00:00.000Z');
});

test('a 401 for the current token clears auth state', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'current-token',
    extensionTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    extensionTokenRefreshBackoff: { failureCount: 1 },
    extensionLinked: true,
  };

  await withCommentRequestMocks({
    state,
    fetchImpl: async () => jsonResponse(401, null),
  }, async () => {
    const result = await fetchClipComments({ clipId: 1 });
    assert.equal(result.reason, 'unauthorized');
  });

  assert.equal(Object.hasOwn(state, 'extensionAuthToken'), false);
  assert.equal(Object.hasOwn(state, 'extensionTokenExpiresAt'), false);
  assert.equal(Object.hasOwn(state, 'extensionTokenRefreshBackoff'), false);
  assert.equal(state.extensionLinked, false);
});

test('a re-link queued during an old-token 401 is saved after the clear', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'old-token',
    extensionLinked: true,
  };
  let resolveFetch;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });

  await withCommentRequestMocks({
    state,
    fetchImpl: async () => {
      markFetchStarted();
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
  }, async () => {
    const commentsPromise = fetchClipComments({ clipId: 1 });
    await fetchStarted;

    const savePromise = saveExtensionAuthTokenInBackground({
      extensionInstanceId: INSTANCE_ID,
      extensionAuthToken: 'new-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await Promise.resolve();
    assert.equal(state.extensionAuthToken, 'old-token');

    resolveFetch(jsonResponse(401, { message: 'expired' }));
    const [commentsResult, saveResult] = await Promise.all([
      commentsPromise,
      savePromise,
    ]);
    assert.equal(commentsResult.reason, 'unauthorized');
    assert.deepEqual(saveResult, { ok: true });
  });

  assert.equal(state.extensionAuthToken, 'new-token');
  assert.equal(state.extensionLinked, true);
  assert.equal(state.extensionTokenExpiresAt, '2099-01-01T00:00:00.000Z');
});

test('a re-link queued first is visible to the following comments request', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'old-token',
    extensionLinked: true,
  };
  let authorization;

  await withCommentRequestMocks({
    state,
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization;
      return jsonResponse(401, null);
    },
  }, async () => {
    const savePromise = saveExtensionAuthTokenInBackground({
      extensionInstanceId: INSTANCE_ID,
      extensionAuthToken: 'new-token',
    });
    const commentsPromise = fetchClipComments({ clipId: 1 });
    const [saveResult, commentsResult] = await Promise.all([
      savePromise,
      commentsPromise,
    ]);
    assert.deepEqual(saveResult, { ok: true });
    assert.equal(commentsResult.reason, 'unauthorized');
  });

  assert.equal(authorization, 'Bearer new-token');
  assert.equal(Object.hasOwn(state, 'extensionAuthToken'), false);
  assert.equal(state.extensionLinked, false);
});

test('a stalled comments request is aborted and returned as timeout', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'token',
  };
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalWarn = console.warn;

  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return 1;
  };
  globalThis.clearTimeout = () => {};
  console.warn = () => {};

  try {
    await withCommentRequestMocks({
      state,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        const rejectAsAborted = () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (options.signal.aborted) {
          rejectAsAborted();
        } else {
          options.signal.addEventListener('abort', rejectAsAborted, { once: true });
        }
      }),
    }, async () => {
      assert.deepEqual(await fetchClipComments({ clipId: 1 }), {
        ok: false,
        reason: 'timeout',
      });
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    console.warn = originalWarn;
  }
});

test('a completed comments response is not timed out only because the wall clock crossed the deadline', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'token',
  };
  const originalDateNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = 1_000;
  let timeoutCallback;

  Date.now = () => now;
  globalThis.setTimeout = (callback) => {
    timeoutCallback = callback;
    return 1;
  };
  globalThis.clearTimeout = () => {};

  try {
    await withCommentRequestMocks({
      state,
      fetchImpl: async (_url, options) => ({
        status: 200,
        json: async () => {
          assert.equal(options.signal.aborted, false);
          now += COMMENTS_REQUEST_TIMEOUT_MS + 1;
          return getResponseFixture(1);
        },
      }),
    }, async () => {
      assert.deepEqual(
        await fetchClipComments({ clipId: 1 }),
        getResponseFixture(1)
      );
      assert.equal(typeof timeoutCallback, 'function');
    });
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('the comments deadline includes time waiting for the exclusive queue', async () => {
  const state = {
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: 'token',
  };
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let releaseBlocker;
  const blocker = runExclusive(() => new Promise((resolve) => {
    releaseBlocker = resolve;
  }));
  let fetchCalls = 0;

  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return 1;
  };
  globalThis.clearTimeout = () => {};

  try {
    await withCommentRequestMocks({
      state,
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse(200, getResponseFixture(1));
      },
    }, async () => {
      assert.deepEqual(await fetchClipComments({ clipId: 1 }), {
        ok: false,
        reason: 'timeout',
      });
      assert.equal(fetchCalls, 0);

      releaseBlocker();
      await blocker;
      await Promise.resolve();
      assert.equal(fetchCalls, 0);
    });
  } finally {
    releaseBlocker?.();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
