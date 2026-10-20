import assert from 'node:assert/strict';
import test from 'node:test';
import { sendData } from '../src/content/common.js';
import { handleStateMessage } from '../src/background/stateMessages.js';
import { installChromeStorage, sampleClip } from '../test-support/chrome.mjs';

test('サイト同期の応答を待たず永続キューへの保存でUIに完了を返す', async (t) => {
  const { runtime, stored } = installChromeStorage(t);
  let syncRequested = false;
  runtime.sendMessage = (message, callback) => {
    if (message.type === 'SYNC_PENDING_CLIPS') { syncRequested = true; return; }
    handleStateMessage(message, {}).then(callback);
  };
  const result = await sendData(sampleClip());
  assert.equal(result.ok, true);
  assert.equal(syncRequested, true);
  assert.equal(stored.pendingClips[0].clientItemId, result.clientItemId);
});

test('保存失敗はUIへ返し、同期を開始しない', async (t) => {
  const { runtime, stored } = installChromeStorage(t);
  runtime.sendMessage = (message, callback) => {
    assert.equal(message.type, 'ENQUEUE_CLIP');
    callback({ ok: false, message: 'storage write failed' });
  };
  await assert.rejects(sendData(sampleClip()), /storage write failed/);
  assert.equal(stored.pendingClips, undefined);
});

for (const error of ['missing-response', 'runtime-error']) {
  test(`backgroundが保存を確認できない場合は成功扱いしない: ${error}`, async (t) => {
    const { runtime } = installChromeStorage(t);
    runtime.sendMessage = (_message, callback) => {
      if (error === 'runtime-error') runtime.lastError = { message: 'port closed' };
      callback();
      delete runtime.lastError;
    };
    await assert.rejects(sendData(sampleClip()), error === 'runtime-error' ? /port closed/ : /Empty background response/);
  });
}
