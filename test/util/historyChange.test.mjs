import assert from 'node:assert/strict';
import test from 'node:test';

function restoreGlobal(name, descriptor) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    delete globalThis[name];
  }
}

test('history hook patches once and reports push, replace, and popstate URLs', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const originalCustomEvent = Object.getOwnPropertyDescriptor(
    globalThis,
    'CustomEvent'
  );
  const listeners = new Map();
  const events = [];
  const location = { href: 'https://www.disneyplus.com/video/one' };

  Object.defineProperty(globalThis, 'CustomEvent', {
    configurable: true,
    value: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location,
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      dispatchEvent(event) {
        events.push(event);
      },
    },
  });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: {
      pushState(_state, _unused, url) {
        location.href = new URL(url, location.href).href;
        return 'push-result';
      },
      replaceState(_state, _unused, url) {
        location.href = new URL(url, location.href).href;
        return 'replace-result';
      },
    },
  });

  try {
    await import(`../../src/util/history_change.js?first=${Date.now()}`);
    const patchedPushState = history.pushState;
    const patchedReplaceState = history.replaceState;

    assert.equal(history.pushState({}, '', '/video/two'), 'push-result');
    assert.equal(history.replaceState({}, '', '/video/three'), 'replace-result');
    listeners.get('popstate')();

    assert.deepEqual(
      events.map((event) => ({ type: event.type, detail: event.detail })),
      [
        {
          type: 'historyChange',
          detail: {
            method: 'pushState',
            url: '/video/two',
          },
        },
        {
          type: 'historyChange',
          detail: {
            method: 'replaceState',
            url: '/video/three',
          },
        },
        {
          type: 'historyChange',
          detail: {
            method: 'popstate',
            url: 'https://www.disneyplus.com/video/three',
          },
        },
      ]
    );

    await import(`../../src/util/history_change.js?second=${Date.now()}`);
    assert.equal(history.pushState, patchedPushState);
    assert.equal(history.replaceState, patchedReplaceState);
  } finally {
    restoreGlobal('window', originalWindow);
    restoreGlobal('history', originalHistory);
    restoreGlobal('CustomEvent', originalCustomEvent);
  }
});
