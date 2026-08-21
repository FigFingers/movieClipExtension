import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  PLAYBACK_CONTEXT_CHANGED_EVENT,
  clearPlaybackContext,
  ensurePlaybackContext,
  readPlaybackContext,
  setPlaybackContext,
} from '../src/content/playbackContext.js';
import { resolveCurrentClipId } from '../src/content/commentPanel.js';

class MemorySessionStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

let previousSessionStorage;
let previousWindow;

beforeEach(() => {
  previousSessionStorage = globalThis.sessionStorage;
  previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: new MemorySessionStorage(),
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: new EventTarget(),
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: previousSessionStorage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: previousWindow,
  });
});

test('initialization records an explicit tab-local null context', () => {
  assert.deepEqual(readPlaybackContext(), {
    initialized: false,
    context: null,
  });

  assert.deepEqual(ensurePlaybackContext(), {
    initialized: true,
    context: null,
  });
  assert.deepEqual(readPlaybackContext(), {
    initialized: true,
    context: null,
  });
});

test('set and clear preserve a normalized, initialized tab-local context', () => {
  assert.deepEqual(setPlaybackContext({ mode: 'playlist', clipId: '42' }), {
    initialized: true,
    context: { mode: 'playlist', clipId: 42 },
  });

  assert.deepEqual(clearPlaybackContext(), {
    initialized: true,
    context: null,
  });
  assert.deepEqual(readPlaybackContext(), {
    initialized: true,
    context: null,
  });
});

test('changes notify this tab once and identical writes are coalesced', () => {
  let changes = 0;
  window.addEventListener(PLAYBACK_CONTEXT_CHANGED_EVENT, () => {
    changes += 1;
  });

  ensurePlaybackContext();
  setPlaybackContext({ mode: 'clip', clipId: 7 });
  setPlaybackContext({ mode: 'clip', clipId: 7 });
  clearPlaybackContext();
  clearPlaybackContext();

  assert.equal(changes, 3);
});

test('invalid contexts are rejected instead of leaking global playback state', () => {
  for (const context of [
    { mode: 'other', clipId: 1 },
    { mode: 'clip', clipId: 0 },
    { mode: 'playlist', clipId: 'abc' },
  ]) {
    assert.throws(() => setPlaybackContext(context), TypeError);
  }
});

test('comment resolution falls back globally only before local initialization', async () => {
  const previousChrome = globalThis.chrome;
  let globalReads = 0;
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: { lastError: null },
      storage: {
        local: {
          get(_keys, callback) {
            globalReads += 1;
            callback({
              playmode: 'clip',
              clip: { clipId: 91 },
            });
          },
        },
      },
    },
  });

  try {
    assert.equal(await resolveCurrentClipId(), 91);
    clearPlaybackContext();
    assert.equal(await resolveCurrentClipId(), null);
    assert.equal(globalReads, 1);
  } finally {
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: previousChrome,
    });
  }
});

test('a blocked sessionStorage write still keeps the tab isolated in memory', () => {
  const storage = globalThis.sessionStorage;
  storage.setItem = () => {
    throw new Error('blocked');
  };

  assert.deepEqual(ensurePlaybackContext(), {
    initialized: true,
    context: null,
  });
  assert.deepEqual(readPlaybackContext(), {
    initialized: true,
    context: null,
  });

  storage.setItem = MemorySessionStorage.prototype.setItem;
  clearPlaybackContext();
});

test('memory fallback wins over an older value left in sessionStorage', () => {
  const storage = globalThis.sessionStorage;
  setPlaybackContext({ mode: 'clip', clipId: 10 });

  storage.setItem = () => {
    throw new Error('blocked');
  };
  setPlaybackContext({ mode: 'clip', clipId: 11 });

  assert.deepEqual(readPlaybackContext(), {
    initialized: true,
    context: { mode: 'clip', clipId: 11 },
  });

  storage.setItem = MemorySessionStorage.prototype.setItem;
  clearPlaybackContext();
});
