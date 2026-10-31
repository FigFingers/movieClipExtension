import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueueClip } from '../src/content/extensionSync.js';
import { handleStateMessage } from '../src/background/stateMessages.js';
import { syncPendingQueue } from '../src/background/sync.js';
import { installChromeStorage, sampleClip } from '../test-support/chrome.mjs';

function setup(t, initial) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  globalThis.location = new URL('https://www.netflix.com/watch/81000001');
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'location', previous);
    else delete globalThis.location;
  });
  const fixture = installChromeStorage(t, initial);
  fixture.runtime.sendMessage = (message, callback) => {
    handleStateMessage(message, { url: 'http://localhost:3000/account' }).then(callback);
  };
  return fixture;
}

test('複数タブが同時に保存しても全クリップを保持する', async (t) => {
  const { stored } = setup(t);
  const clips = Array.from({ length: 12 }, () => sampleClip());
  await Promise.all(clips.map(enqueueClip));
  assert.deepEqual(new Set(stored.pendingClips.map((item) => item.clientItemId)), new Set(clips.map((item) => item.clientItemId)));
});

test('同期済み項目の削除と保存が重なっても新しいクリップを保持する', async (t) => {
  const first = sampleClip();
  const later = sampleClip();
  const { stored, local } = setup(t, {
    extensionInstanceId: 'test-instance', extensionAuthToken: 'old-token', pendingClips: [first],
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async () => ({
    status: 200,
    json: async () => ({ ok: true, acceptedItemIds: [first.clientItemId] }),
  }));
  const originalGet = local.get;
  let reads = 0;
  let saving;
  local.get = (keys, callback) => {
    originalGet(keys, callback);
    if (keys.includes('pendingClips') && ++reads === 2) saving = enqueueClip(later);
  };
  await syncPendingQueue();
  await saving;
  assert.deepEqual(stored.pendingClips.map((item) => item.clientItemId), [later.clientItemId]);
});

