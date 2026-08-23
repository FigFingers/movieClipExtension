import assert from 'node:assert/strict';
import test from 'node:test';

const listeners = {};
const postedMessages = [];
const runtimeMessages = [];
const scheduledTasks = [];
let storedQueue = null;
let runtimeResponse = { ok: true };

globalThis.window = {
  location: {
    origin: 'http://localhost:3000',
    href: 'http://localhost:3000/clips',
  },
  addEventListener(type, listener) {
    listeners[type] = listener;
  },
  postMessage(message, targetOrigin) {
    postedMessages.push({ message, targetOrigin });
  },
};
globalThis.document = { cookie: '' };
globalThis.localStorage = {
  getItem(key) {
    return key === 'playQueue' ? storedQueue : null;
  },
};
globalThis.chrome = {
  runtime: {
    lastError: null,
    sendMessage(message, callback) {
      runtimeMessages.push(message);
      callback(runtimeResponse);
    },
  },
};
globalThis.setTimeout = (callback, delay) => {
  scheduledTasks.push({ callback, delay });
  return scheduledTasks.length;
};

await import('../src/content/getClipData.js');

function resetObservations() {
  postedMessages.length = 0;
  runtimeMessages.length = 0;
  scheduledTasks.length = 0;
  storedQueue = null;
  runtimeResponse = { ok: true };
  window.location.href = 'http://localhost:3000/clips';
}

function messageEvent(data) {
  return {
    source: window,
    origin: window.location.origin,
    data,
  };
}

test('SET_CLIP_DATA rejects a missing payload without contacting background', async () => {
  resetObservations();

  await listeners.message(messageEvent({
    type: 'SET_CLIP_DATA',
    requestId: 'missing-payload',
  }));

  assert.equal(runtimeMessages.length, 0);
  assert.equal(scheduledTasks.length, 0);
  assert.deepEqual(postedMessages.at(-1), {
    targetOrigin: 'http://localhost:3000',
    message: {
      type: 'EXTENSION_PLAYBACK_HANDOFF_RESULT',
      source: 'SET_CLIP_DATA',
      ok: false,
      reason: 'invalid_payload',
      field: 'clip',
      requestId: 'missing-payload',
    },
  });
});

test('invalid playlist data never reaches background or navigation', async () => {
  resetObservations();
  storedQueue = JSON.stringify([{ id: 1, service: 'youtube' }]);

  await listeners.message(messageEvent({ type: 'PLAY_PLAYLIST_START' }));

  assert.equal(runtimeMessages.length, 0);
  assert.equal(scheduledTasks.length, 0);
  assert.equal(window.location.href, 'http://localhost:3000/clips');
  assert.equal(postedMessages.at(-1).message.ok, false);
});

test('failed BEGIN_PLAYBACK_HANDOFF reports failure and does not navigate', async () => {
  resetObservations();
  storedQueue = JSON.stringify([
    {
      id: 1,
      service: 'netflix',
      url: '/watch/1',
      startTime: 10,
      endTime: 20,
    },
  ]);
  runtimeResponse = { ok: false, reason: 'invalid_handoff' };

  await listeners.message(messageEvent({
    type: 'PLAY_PLAYLIST_START',
    requestId: 'handoff-failure',
  }));

  assert.equal(runtimeMessages.length, 1);
  assert.equal(runtimeMessages[0].type, 'BEGIN_PLAYBACK_HANDOFF');
  assert.equal(scheduledTasks.length, 0);
  assert.equal(window.location.href, 'http://localhost:3000/clips');
  assert.deepEqual(postedMessages.at(-1).message, {
    type: 'EXTENSION_PLAYBACK_HANDOFF_RESULT',
    source: 'PLAY_PLAYLIST_START',
    ok: false,
    reason: 'handoff_failed',
    requestId: 'handoff-failure',
  });
});
