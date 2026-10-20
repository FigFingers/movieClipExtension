import assert from 'node:assert/strict';
import test from 'node:test';
import { syncPendingQueue } from '../src/background/sync.js';

function clip(clientItemId) {
  return {
    clientItemId, url: 'https://www.netflix.com/watch/81000001',
    service: 'Netflix', title: 'テスト作品', startTime: 10, endTime: 20,
  };
}

function setup(t, response) {
  const stored = {
    extensionInstanceId: 'test-instance', extensionAuthToken: 'test-token',
    extensionLinked: true, pendingClips: [clip('a'), clip('b')],
  };
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  globalThis.chrome = {
    runtime: {},
    storage: { local: {
      get(keys, callback) {
        const result = Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]]));
        queueMicrotask(() => callback(structuredClone(result)));
      },
      set(items, callback) { Object.assign(stored, structuredClone(items)); queueMicrotask(callback); },
      remove(keys, callback) { for (const key of keys) delete stored[key]; queueMicrotask(callback); },
    } },
  };
  t.after(() => {
    if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
    else delete globalThis.chrome;
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => response);
  return { stored, fetchMock };
}

function jsonResponse(status, data) {
  return { status, json: async () => data };
}

test('同期は受理された送信IDだけを削除する', async (t) => {
  const { stored, fetchMock } = setup(t, jsonResponse(200, { ok: true, acceptedItemIds: ['a'] }));
  const result = await syncPendingQueue();
  assert.equal(result.ok, true);
  assert.equal(result.acceptedCount, 1);
  assert.deepEqual(stored.pendingClips.map((item) => item.clientItemId), ['b']);
  assert.ok(stored.lastSyncAt);
  const request = fetchMock.mock.calls[0].arguments[1];
  assert.equal(request.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(request.body).items.map((item) => item.clientItemId), ['a', 'b']);
});

test('受理IDの空配列はキューを削除しない', async (t) => {
  const { stored } = setup(t, jsonResponse(200, { ok: true, acceptedItemIds: [] }));
  assert.equal((await syncPendingQueue()).acceptedCount, 0);
  assert.equal(stored.pendingClips.length, 2);
});

test('受理IDが省略された旧形式の明示的成功応答と互換性を保つ', async (t) => {
  const { stored } = setup(t, jsonResponse(200, { ok: true }));
  assert.equal((await syncPendingQueue()).acceptedCount, 2);
  assert.deepEqual(stored.pendingClips, []);
});

for (const data of [null, {}, [], { ok: false },
  { ok: true, acceptedItemIds: null }, { ok: true, acceptedItemIds: 'a' },
  { ok: true, acceptedItemIds: [42] }, { ok: true, acceptedItemIds: ['not-sent'] }]) {
  test(`不正な200応答ではクリップと最終同期時刻を保持する: ${JSON.stringify(data)}`, async (t) => {
    const { stored } = setup(t, jsonResponse(200, data));
    stored.lastSyncAt = '2026-10-01T00:00:00.000Z';
    const result = await syncPendingQueue();
    assert.equal(result.ok, false);
    assert.equal(result.queued, true);
    assert.equal(result.reason, 'invalid_response');
    assert.deepEqual(stored.pendingClips.map((item) => item.clientItemId), ['a', 'b']);
    assert.equal(stored.lastSyncAt, '2026-10-01T00:00:00.000Z');
  });
}

test('JSON読込に失敗した200応答でもクリップを削除しない', async (t) => {
  const { stored } = setup(t, { status: 200, json: async () => { throw new SyntaxError('invalid JSON'); } });
  assert.equal((await syncPendingQueue()).reason, 'invalid_response');
  assert.equal(stored.pendingClips.length, 2);
});

test('応答に重複したIDがあっても受理件数は重複計上しない', async (t) => {
  const { stored } = setup(t, jsonResponse(200, { ok: true, acceptedItemIds: ['a', 'a'] }));
  assert.equal((await syncPendingQueue()).acceptedCount, 1);
  assert.deepEqual(stored.pendingClips.map((item) => item.clientItemId), ['b']);
});

test('400で不正項目を特定できない場合は全クリップを保持する', async (t) => {
  const { stored } = setup(t, jsonResponse(400, { error: 'Invalid request body' }));
  const result = await syncPendingQueue();
  assert.equal(result.reason, 'validation_error');
  assert.equal(result.queued, true);
  assert.equal(stored.pendingClips.length, 2);
});

test('400では特定された送信済みの不正項目だけを削除する', async (t) => {
  const { stored } = setup(t, jsonResponse(400, { issues: [{ clientItemId: 'a' }] }));
  const result = await syncPendingQueue();
  assert.equal(result.queued, true);
  assert.deepEqual(stored.pendingClips.map((item) => item.clientItemId), ['b']);
});

for (const status of [200, 400]) {
  test(`同期中に追加された未送信クリップを${status}応答で削除しない`, async (t) => {
    const response = status === 200
      ? { ok: true, acceptedItemIds: ['later'] }
      : { issues: [{ clientItemId: 'later' }] };
    const { stored } = setup(t, jsonResponse(status, response));
    t.mock.method(globalThis, 'fetch', async () => {
      stored.pendingClips.push(clip('later'));
      return jsonResponse(status, response);
    });
    await syncPendingQueue();
    assert.deepEqual(stored.pendingClips.map((item) => item.clientItemId), ['a', 'b', 'later']);
  });
}

for (const status of [401, 403, 500]) {
  test(`${status}では未送信クリップを保持する`, async (t) => {
    const { stored } = setup(t, jsonResponse(status, {}));
    const result = await syncPendingQueue();
    assert.equal(result.queued, true);
    assert.equal(stored.pendingClips.length, 2);
    assert.equal(stored.extensionAuthToken, status === 401 ? undefined : 'test-token');
  });
}
