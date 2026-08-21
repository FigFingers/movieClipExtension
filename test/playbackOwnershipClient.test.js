import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLAYBACK_OWNER_TAB_KEY,
  claimPlaybackOwnership,
} from '../src/content/playbackOwnership.js';

class MemorySessionStorage {
  constructor(initial = {}) {
    this.data = { ...initial };
  }

  getItem(key) {
    return Object.hasOwn(this.data, key) ? this.data[key] : null;
  }

  setItem(key, value) {
    this.data[key] = String(value);
  }

  removeItem(key) {
    delete this.data[key];
  }
}

function installGlobals({ href, storedNonce = null, respond }) {
  const sessionStorage = new MemorySessionStorage(
    storedNonce ? { [PLAYBACK_OWNER_TAB_KEY]: storedNonce } : {}
  );
  const messages = [];
  globalThis.location = { href };
  globalThis.sessionStorage = sessionStorage;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        callback(respond(message, messages.length));
      },
    },
  };
  return { messages, sessionStorage };
}

test('an explicit URL nonce never falls back to an opener handoff', async () => {
  const { messages } = installGlobals({
    href: 'https://www.netflix.com/watch/1?dextPlaybackOwner=url-nonce-1',
    respond: () => ({ ok: false, reason: 'handoff_not_found' }),
  });

  const result = await claimPlaybackOwnership({ nonce: 'url-nonce-1' });
  assert.deepEqual(result, { ok: false, reason: 'handoff_not_found' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].nonce, 'url-nonce-1');
});

test('a stale tab-local nonce falls back to a late legacy handoff', async () => {
  const { messages, sessionStorage } = installGlobals({
    href: 'https://www.netflix.com/watch/2?t=5',
    storedNonce: 'stale-tab-nonce',
    respond: (message) => message.nonce
      ? { ok: false, reason: 'handoff_not_found' }
      : {
          ok: true,
          nonce: 'fresh-legacy-nonce',
          context: { mode: 'clip', clipId: 2 },
          snapshot: {},
        },
  });

  const result = await claimPlaybackOwnership({ nonce: 'stale-tab-nonce' });
  assert.equal(result.ok, true);
  assert.deepEqual(messages.map((message) => message.nonce), [
    'stale-tab-nonce',
    null,
  ]);
  assert.equal(
    sessionStorage.getItem(PLAYBACK_OWNER_TAB_KEY),
    'fresh-legacy-nonce'
  );
});

test('a stale owner rejected on a new route falls back to the new handoff', async () => {
  const { messages } = installGlobals({
    href: 'https://www.netflix.com/watch/3?t=5',
    storedNonce: 'previous-route-nonce',
    respond: (message) => message.nonce
      ? { ok: false, reason: 'route_mismatch' }
      : {
          ok: true,
          nonce: 'new-route-nonce',
          context: { mode: 'clip', clipId: 3 },
          snapshot: {},
        },
  });

  const result = await claimPlaybackOwnership({ nonce: 'previous-route-nonce' });
  assert.equal(result.nonce, 'new-route-nonce');
  assert.deepEqual(messages.map((message) => message.nonce), [
    'previous-route-nonce',
    null,
  ]);
});

test('an ambiguous legacy handoff fails without retrying', async () => {
  const { messages } = installGlobals({
    href: 'https://www.disneyplus.com/video/example?t=4',
    respond: () => ({ ok: false, reason: 'ambiguous_handoff' }),
  });

  const result = await claimPlaybackOwnership({ nonce: null });
  assert.deepEqual(result, { ok: false, reason: 'ambiguous_handoff' });
  assert.equal(messages.length, 1);
});
