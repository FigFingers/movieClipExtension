import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  LINK_WITH_LINK_TOKEN,
  exchangeLinkToken,
  getLinkFailureReason,
  handleLinkTokenMessage,
  isSiteSender,
  isValidOpaqueToken,
  registerLinkTokenExchange,
  saveLinkedAuthToken,
} from '../src/background/linkTokenExchange.js';
import {
  PAGE_LINK_RESULT,
  RUNTIME_LINK_WITH_LINK_TOKEN,
  handleExtensionLinkWithLinkToken,
} from '../src/content/linkTokenBridge.js';

const INSTANCE_ID = '0b0c3c9e-5d1f-4c2a-9a33-6f1f2d6b8e10';
const LINK_TOKEN = 'linkTokenAbc_123-xyz';
const AUTH_TOKEN = 'authTokenFromSite_456';
const EXPIRES_AT = '2027-02-05T00:00:00.000Z';
const SITE_SENDER = { origin: 'http://localhost:3000', url: 'http://localhost:3000/account' };

let store;
let messageListeners;

function installChrome(initial = {}) {
  store = { ...initial };
  messageListeners = [];
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (listener) => messageListeners.push(listener) },
    },
    storage: {
      local: {
        get(keys, callback) {
          const result = {};
          for (const key of [].concat(keys)) {
            if (key in store) result[key] = store[key];
          }
          callback(result);
        },
        set(items, callback) {
          Object.assign(store, items);
          callback?.();
        },
        remove(keys, callback) {
          for (const key of [].concat(keys)) delete store[key];
          callback?.();
        },
      },
    },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function recordingFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response(url, init) : response;
  };
  return { calls, fetchImpl };
}

beforeEach(() => {
  installChrome({ extensionInstanceId: INSTANCE_ID });
});

test('linkToken を background が /api/extension/link で交換し、トークンを保存する', async () => {
  store.extensionTokenRefreshBackoff = { failureCount: 3 };
  const { calls, fetchImpl } = recordingFetch(jsonResponse(200, {
    ok: true,
    extensionAuthToken: AUTH_TOKEN,
    expiresAt: EXPIRES_AT,
  }));
  let syncedAfterLink = 0;

  const result = await exchangeLinkToken(
    { extensionInstanceId: INSTANCE_ID, linkToken: LINK_TOKEN },
    { fetchImpl, afterLinked: () => { syncedAfterLink += 1; } },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(result, { ok: true, linked: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:3000/api/extension/link');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    extensionInstanceId: INSTANCE_ID,
    linkToken: LINK_TOKEN,
  });
  assert.equal(store.extensionAuthToken, AUTH_TOKEN);
  assert.equal(store.extensionTokenExpiresAt, EXPIRES_AT);
  assert.equal(store.extensionLinked, true);
  assert.equal('extensionTokenRefreshBackoff' in store, false);
  assert.equal(syncedAfterLink, 1);
});

test('応答に拡張用トークンを含めない', async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(200, {
    ok: true,
    extensionAuthToken: AUTH_TOKEN,
    expiresAt: EXPIRES_AT,
  }));

  const result = await exchangeLinkToken(
    { extensionInstanceId: INSTANCE_ID, linkToken: LINK_TOKEN },
    { fetchImpl, afterLinked: () => {} },
  );

  assert.equal(JSON.stringify(result).includes(AUTH_TOKEN), false);
});

test('画面の instanceId が拡張の値と違えば linkToken を使わない', async () => {
  const { calls, fetchImpl } = recordingFetch(jsonResponse(200, {}));

  for (const extensionInstanceId of [undefined, '', 'f1e2d3c4-b5a6-4789-8abc-def012345678']) {
    const result = await exchangeLinkToken(
      { extensionInstanceId, linkToken: LINK_TOKEN },
      { fetchImpl, afterLinked: () => {} },
    );
    assert.deepEqual(result, { ok: false, reason: 'instance_mismatch' });
  }

  installChrome({});
  const missing = await exchangeLinkToken(
    { extensionInstanceId: INSTANCE_ID, linkToken: LINK_TOKEN },
    { fetchImpl, afterLinked: () => {} },
  );
  assert.deepEqual(missing, { ok: false, reason: 'instance_mismatch' });
  assert.equal(calls.length, 0);
});

test('不正な linkToken は送らない', async () => {
  const { calls, fetchImpl } = recordingFetch(jsonResponse(200, {}));

  for (const linkToken of [undefined, null, 1, '', 'has space', 'x'.repeat(4097), 'line\nbreak']) {
    const result = await exchangeLinkToken(
      { extensionInstanceId: INSTANCE_ID, linkToken },
      { fetchImpl, afterLinked: () => {} },
    );
    assert.deepEqual(result, { ok: false, reason: 'invalid_link_token' });
  }
  assert.equal(calls.length, 0);
  assert.equal(isValidOpaqueToken('x'.repeat(4096)), true);
});

test('サイトのエラーを理由に変換し、保存済みのトークンを残す', async () => {
  const cases = [
    [400, { code: 'LINK_TOKEN_EXPIRED' }, 'link_token_expired'],
    [400, { code: 'BAD_REQUEST' }, 'invalid_request'],
    [401, { code: 'UNAUTHORIZED' }, 'link_token_invalid'],
    [403, { message: 'OriginNotAllowed', code: 'FORBIDDEN' }, 'origin_not_allowed'],
    [409, { code: 'CONFLICT' }, 'link_token_used'],
    [500, null, 'link_failed'],
  ];

  for (const [status, body, reason] of cases) {
    installChrome({ extensionInstanceId: INSTANCE_ID, extensionAuthToken: 'previousToken' });
    const { fetchImpl } = recordingFetch(jsonResponse(status, body));
    const result = await exchangeLinkToken(
      { extensionInstanceId: INSTANCE_ID, linkToken: LINK_TOKEN },
      { fetchImpl, afterLinked: () => assert.fail('失敗時は同期しない') },
    );

    assert.deepEqual(result, { ok: false, reason, status });
    assert.equal(getLinkFailureReason(status, body), reason);
    assert.equal(store.extensionAuthToken, 'previousToken');
  }
});

test('200 でも応答の形が違えば保存しない', async () => {
  for (const body of [
    null,
    { extensionAuthToken: AUTH_TOKEN },
    { ok: true },
    { ok: true, extensionAuthToken: '' },
    { ok: true, extensionAuthToken: 'has space' },
  ]) {
    installChrome({ extensionInstanceId: INSTANCE_ID });
    const { fetchImpl } = recordingFetch(jsonResponse(200, body));
    const result = await exchangeLinkToken(
      { extensionInstanceId: INSTANCE_ID, linkToken: LINK_TOKEN },
      { fetchImpl, afterLinked: () => {} },
    );

    assert.deepEqual(result, { ok: false, reason: 'invalid_response', status: 200 });
    assert.equal('extensionAuthToken' in store, false);
  }
});

test('通信の失敗と期限切れを区別する', async () => {
  const networkError = await exchangeLinkToken(
    { extensionInstanceId: INSTANCE_ID, linkToken: LINK_TOKEN },
    {
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
      afterLinked: () => {},
    },
  );
  assert.deepEqual(networkError, { ok: false, reason: 'network_error' });

  const timeout = await exchangeLinkToken(
    { extensionInstanceId: INSTANCE_ID, linkToken: LINK_TOKEN },
    {
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
      afterLinked: () => {},
      timeoutMs: 5,
    },
  );
  assert.deepEqual(timeout, { ok: false, reason: 'timeout' });
});

test('サイトのページ以外からの要求を受け付けない', async () => {
  assert.equal(isSiteSender(SITE_SENDER), true);
  assert.equal(isSiteSender({ origin: 'http://127.0.0.1:3000' }), true);
  assert.equal(isSiteSender({ url: 'http://localhost:3000/account' }), true);

  for (const sender of [
    undefined,
    {},
    { origin: 'https://www.netflix.com', url: 'https://www.netflix.com/watch/1' },
    { origin: 'http://localhost:3001' },
    { url: 'chrome-extension://abcdefghijklmnop/popup.html' },
    { origin: 'null' },
  ]) {
    assert.equal(isSiteSender(sender), false);
  }

  const { calls, fetchImpl } = recordingFetch(jsonResponse(200, {}));
  const result = await handleLinkTokenMessage(
    { type: LINK_WITH_LINK_TOKEN, extensionInstanceId: INSTANCE_ID, linkToken: LINK_TOKEN },
    { origin: 'https://www.netflix.com' },
    { fetchImpl, afterLinked: () => {} },
  );
  assert.deepEqual(result, { ok: false, reason: 'forbidden' });
  assert.equal(calls.length, 0);
  assert.equal(handleLinkTokenMessage({ type: 'OTHER' }, SITE_SENDER), null);
});

test('並行した交換は1件ずつ行い、後の連携の結果が残る', async () => {
  const releases = [];
  const started = [];
  const fetchImpl = (_url, init) => {
    const { linkToken } = JSON.parse(init.body);
    started.push(linkToken);
    return new Promise((resolve) => {
      releases.push(() => resolve(jsonResponse(200, {
        ok: true,
        extensionAuthToken: `auth-for-${linkToken}`,
        expiresAt: EXPIRES_AT,
      })));
    });
  };
  const deps = { fetchImpl, afterLinked: () => {} };

  const first = handleLinkTokenMessage(
    { type: LINK_WITH_LINK_TOKEN, extensionInstanceId: INSTANCE_ID, linkToken: 'first' },
    SITE_SENDER,
    deps,
  );
  const second = handleLinkTokenMessage(
    { type: LINK_WITH_LINK_TOKEN, extensionInstanceId: INSTANCE_ID, linkToken: 'second' },
    SITE_SENDER,
    deps,
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first']);
  releases[0]();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first', 'second']);
  releases[1]();
  await second;

  assert.equal(store.extensionAuthToken, 'auth-for-second');
});

test('保存時に instanceId が変わっていれば書き込まない', async () => {
  const result = await saveLinkedAuthToken({
    extensionInstanceId: 'f1e2d3c4-b5a6-4789-8abc-def012345678',
    extensionAuthToken: AUTH_TOKEN,
    expiresAt: EXPIRES_AT,
  });

  assert.deepEqual(result, { ok: false, reason: 'instance_mismatch' });
  assert.equal('extensionAuthToken' in store, false);
});

test('保存処理を差し替えられる', async () => {
  const saved = [];
  const { fetchImpl } = recordingFetch(jsonResponse(200, {
    ok: true,
    extensionAuthToken: AUTH_TOKEN,
    expiresAt: EXPIRES_AT,
  }));

  const result = await exchangeLinkToken(
    { extensionInstanceId: INSTANCE_ID, linkToken: LINK_TOKEN },
    {
      fetchImpl,
      afterLinked: () => {},
      saveAuthToken: async (input) => {
        saved.push(input);
        return { ok: false, reason: 'instance_mismatch' };
      },
    },
  );

  assert.deepEqual(saved, [{
    extensionInstanceId: INSTANCE_ID,
    extensionAuthToken: AUTH_TOKEN,
    expiresAt: EXPIRES_AT,
  }]);
  assert.deepEqual(result, { ok: false, reason: 'instance_mismatch' });
  assert.equal('extensionAuthToken' in store, false);
});

test('background のリスナーは対象のメッセージだけに非同期で応答する', async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(401, { code: 'UNAUTHORIZED' }));
  registerLinkTokenExchange({ fetchImpl, afterLinked: () => {} });
  assert.equal(messageListeners.length, 1);
  const [listener] = messageListeners;

  assert.equal(listener({ type: 'SYNC_PENDING_CLIPS' }, SITE_SENDER, () => {}), undefined);

  const responses = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const keepOpen = listener(
      { type: LINK_WITH_LINK_TOKEN, extensionInstanceId: INSTANCE_ID, linkToken: LINK_TOKEN },
      SITE_SENDER,
      (response) => responses.push(response),
    );
    assert.equal(keepOpen, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(responses, [{ ok: false, reason: 'link_token_invalid', status: 401 }]);
});

test('content script は linkToken だけを background へ渡し、決めた項目だけを画面へ返す', async () => {
  assert.equal(RUNTIME_LINK_WITH_LINK_TOKEN, LINK_WITH_LINK_TOKEN);

  const sent = [];
  const posted = [];
  const response = await handleExtensionLinkWithLinkToken(
    {
      type: 'EXT_LINK_WITH_LINK_TOKEN',
      requestId: 'req-1',
      extensionInstanceId: INSTANCE_ID,
      linkToken: LINK_TOKEN,
      extra: 'ignored',
    },
    'http://localhost:3000',
    {
      sendMessage: async (message) => {
        sent.push(message);
        return { ok: true, linked: true, extensionAuthToken: AUTH_TOKEN };
      },
      postMessage: (data, origin) => posted.push({ data, origin }),
    },
  );

  assert.deepEqual(sent, [{
    type: RUNTIME_LINK_WITH_LINK_TOKEN,
    extensionInstanceId: INSTANCE_ID,
    linkToken: LINK_TOKEN,
  }]);
  const expected = {
    type: PAGE_LINK_RESULT,
    requestId: 'req-1',
    ok: true,
    linked: true,
    reason: null,
    status: null,
  };
  assert.deepEqual(response, expected);
  assert.deepEqual(posted, [{ data: expected, origin: 'http://localhost:3000' }]);
  assert.equal(JSON.stringify(posted).includes(AUTH_TOKEN), false);
});

test('content script は失敗も画面へ返し、待たせない', async () => {
  const posted = [];
  const postMessage = (data) => posted.push(data);

  await handleExtensionLinkWithLinkToken(
    { requestId: 7, extensionInstanceId: INSTANCE_ID, linkToken: LINK_TOKEN },
    'http://localhost:3000',
    {
      sendMessage: async () => { throw new Error('Could not establish connection'); },
      postMessage,
    },
  );
  await handleExtensionLinkWithLinkToken(
    { requestId: { nested: true }, extensionInstanceId: INSTANCE_ID, linkToken: 42 },
    'http://localhost:3000',
    { sendMessage: async () => assert.fail('不正な入力は送らない'), postMessage },
  );
  await handleExtensionLinkWithLinkToken(
    { requestId: 'req-3', extensionInstanceId: INSTANCE_ID, linkToken: LINK_TOKEN },
    'http://localhost:3000',
    {
      sendMessage: async () => ({ ok: false, reason: 'link_token_expired', status: 400 }),
      postMessage,
    },
  );

  assert.deepEqual(posted, [
    { type: PAGE_LINK_RESULT, requestId: 7, ok: false, linked: false, reason: 'background_unavailable', status: null },
    { type: PAGE_LINK_RESULT, requestId: null, ok: false, linked: false, reason: 'invalid_link_token', status: null },
    { type: PAGE_LINK_RESULT, requestId: 'req-3', ok: false, linked: false, reason: 'link_token_expired', status: 400 },
  ]);
});
