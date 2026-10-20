import assert from 'node:assert/strict';
import test from 'node:test';
import { handleStateMessage } from '../src/background/stateMessages.js';
import { checkAndRefreshToken } from '../src/background/tokenRefresh.js';
import { fetchClipComments } from '../src/background/comments.js';
import { enqueueClip } from '../src/background/clipQueue.js';
import { toExtensionClipPayload } from '../src/shared/clipPayload.js';
import { installChromeStorage, deferred, sampleClip } from '../test-support/chrome.mjs';

const site = { url: 'http://localhost:3000/account' };
const initialAuth = { extensionInstanceId: 'instance', extensionAuthToken: 'old-token', extensionLinked: true };
const saveToken = (token = 'new-token') => handleStateMessage({
  type: 'SAVE_EXTENSION_AUTH_TOKEN', extensionInstanceId: 'instance', extensionAuthToken: token,
}, site);

test('初回ID要求を共有し、永続化後に同じIDを全callerへ返す', async (t) => {
  const { stored, writes } = installChromeStorage(t);
  const results = await Promise.all(Array.from({ length: 10 }, () => handleStateMessage({ type: 'GET_OR_CREATE_INSTANCE_ID' }, site)));
  assert.equal(new Set(results.map((result) => result.extensionInstanceId)).size, 1);
  assert.equal(results[0].extensionInstanceId, stored.extensionInstanceId);
  assert.equal(writes.length, 1);
});

for (const url of ['https://www.netflix.com/watch/1', 'http://localhost:3001/account', 'http://localhost:3000.evil.test/account', undefined]) {
  test(`サイト以外からの認証更新を拒否する: ${url}`, async (t) => {
    const { stored, writes } = installChromeStorage(t, initialAuth);
    const result = await handleStateMessage({
      type: 'SAVE_EXTENSION_AUTH_TOKEN', extensionInstanceId: 'instance', extensionAuthToken: 'untrusted',
    }, { url });
    assert.equal(result.reason, 'forbidden');
    assert.equal(stored.extensionAuthToken, 'old-token');
    assert.equal(writes.length, 0);
    assert.equal((await handleStateMessage({ type: 'UNLINK_EXTENSION', extensionInstanceId: 'instance' }, { url })).reason, 'forbidden');
  });
}

test('コメントの古い401と再連携が重なっても新トークンを保持する', async (t) => {
  const { stored } = installChromeStorage(t, initialAuth);
  const started = deferred();
  const response = deferred();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', () => { started.resolve(); return response.promise; });
  const comments = fetchClipComments({ clipId: 1 });
  await started.promise;
  const saving = saveToken();
  response.resolve({ status: 401, json: async () => ({}) });
  await comments;
  assert.equal((await saving).ok, true);
  assert.equal(stored.extensionAuthToken, 'new-token');
  assert.equal(stored.extensionLinked, true);
});

test('トークン更新と再連携の競合で新しい連携を上書きしない', async (t) => {
  const { stored } = installChromeStorage(t, initialAuth);
  const started = deferred();
  const response = deferred();
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', () => { started.resolve(); return response.promise; });
  const refreshing = checkAndRefreshToken();
  await started.promise;
  const saving = saveToken();
  response.resolve({ status: 200, json: async () => ({ extensionAuthToken: 'rotated-old-token' }) });
  await refreshing;
  await saving;
  assert.equal(stored.extensionAuthToken, 'new-token');
});

test('認証APIが応答待ちでもローカルクリップを保存できる', async (t) => {
  const { stored } = installChromeStorage(t, initialAuth);
  const started = deferred();
  const response = deferred();
  t.mock.method(globalThis, 'fetch', () => { started.resolve(); return response.promise; });
  const comments = fetchClipComments({ clipId: 1 });
  await started.promise;
  const clip = await enqueueClip(sampleClip());
  assert.equal(stored.pendingClips[0].clientItemId, clip.clientItemId);
  response.resolve({ status: 200, json: async () => ({ ok: true, comments: [] }) });
  await comments;
});

test('認証保存が失敗しても後続の保存を実行できる', async (t) => {
  const { local, stored } = installChromeStorage(t, initialAuth);
  const original = local.set;
  let fail = true;
  local.set = (items, callback) => {
    if (fail) { fail = false; throw new Error('storage failed'); }
    original(items, callback);
  };
  await assert.rejects(saveToken('failed-token'), /storage failed/);
  assert.equal(stored.extensionAuthToken, 'old-token');
  assert.equal((await saveToken()).ok, true);
  assert.equal(stored.extensionAuthToken, 'new-token');
});

test('解除は一回の書込みで認証全体を消し、IDとクリップは保持する', async (t) => {
  const { stored, writes } = installChromeStorage(t, { ...initialAuth, pendingClips: [sampleClip()], extensionTokenRefreshBackoff: { failureCount: 3 } });
  assert.equal((await handleStateMessage({ type: 'UNLINK_EXTENSION', extensionInstanceId: 'instance' }, site)).ok, true);
  assert.equal(writes.length, 1);
  assert.equal(stored.extensionAuthToken, null);
  assert.equal(stored.extensionLinked, false);
  assert.equal(stored.extensionTokenRefreshBackoff, null);
  assert.equal(stored.extensionInstanceId, 'instance');
  assert.equal(stored.pendingClips.length, 1);
});

test('入力正規化はDOMなしで旧フィールド名と相対URLを扱う', () => {
  const clip = toExtensionClipPayload({
    title: ' 作品 ', service: 'Netflix', StartTime: '0', EndTime: '10', URL: '/watch/1',
  }, { pageUrl: 'https://www.netflix.com/watch/2' });
  assert.equal(clip.url, 'https://www.netflix.com/watch/1');
  assert.equal(clip.startTime, 0);
  assert.equal(clip.endTime, 10);
  assert.equal(clip.title, '作品');
});

for (const changes of [{ startTime: null }, { startTime: true }, { startTime: '' }, { startTime: -1 },
  { endTime: 10 }, { endTime: NaN }, { url: 'javascript:alert(1)' }, { title: '' }]) {
  test(`無効な録画データはキューに書き込まない: ${JSON.stringify(changes)}`, async (t) => {
    const { writes } = installChromeStorage(t);
    await assert.rejects(handleStateMessage({ type: 'ENQUEUE_CLIP', clip: { ...sampleClip(), ...changes } }, site));
    assert.equal(writes.length, 0);
  });
}
