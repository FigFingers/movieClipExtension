import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTO_NAVIGATION_KEY,
  clearAutoNavigation,
  createElementWait,
  handleOwnedPlaybackRouteChange,
  markAutoNavigation,
} from '../../src/content/common.js';
import { setTextContentIfChanged } from '../../src/content/domUpdates.js';
import { commitSelectedClip } from '../../src/content/netflixClipSelection.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function installWebStorage(t, { sessionStorage, localStorage }) {
  const sessionDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'sessionStorage',
  );
  const localDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage',
  );
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: sessionStorage,
    writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: localStorage,
    writable: true,
  });
  t.after(() => {
    if (sessionDescriptor) {
      Object.defineProperty(globalThis, 'sessionStorage', sessionDescriptor);
    } else {
      delete globalThis.sessionStorage;
    }
    if (localDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', localDescriptor);
    } else {
      delete globalThis.localStorage;
    }
  });
}

test('Netflix auto-navigation markers cannot suppress another tab teardown', (t) => {
  const tabAStorage = new MemoryStorage();
  const tabBStorage = new MemoryStorage();
  const sharedLocalStorage = new MemoryStorage();
  installWebStorage(t, {
    sessionStorage: tabAStorage,
    localStorage: sharedLocalStorage,
  });

  assert.equal(
    markAutoNavigation({
      ownerNonce: 'owner-nonce-tab-a',
      expectedRoute: 'https://www.netflix.com/watch/2',
      reason: 'playlist',
    }),
    true,
  );
  assert.equal(sharedLocalStorage.getItem(AUTO_NAVIGATION_KEY), null);

  tabBStorage.setItem(
    AUTO_NAVIGATION_KEY,
    tabAStorage.getItem(AUTO_NAVIGATION_KEY),
  );
  sharedLocalStorage.setItem(AUTO_NAVIGATION_KEY, 'legacy-shared-marker');
  globalThis.sessionStorage = tabBStorage;
  let tabBTeardownCount = 0;
  assert.equal(
    handleOwnedPlaybackRouteChange({
      ownerNonce: 'owner-nonce-tab-b',
      currentRoute: 'https://www.netflix.com/watch/10',
      nextRoute: 'https://www.netflix.com/watch/2',
      onManualNavigation: () => {
        tabBTeardownCount += 1;
      },
    }),
    'manual',
  );
  assert.equal(tabBTeardownCount, 1);
  assert.equal(sharedLocalStorage.getItem(AUTO_NAVIGATION_KEY), 'legacy-shared-marker');

  globalThis.sessionStorage = tabAStorage;
  assert.equal(
    handleOwnedPlaybackRouteChange({
      ownerNonce: 'owner-nonce-tab-a',
      currentRoute: 'https://www.netflix.com/watch/1',
      nextRoute: 'https://www.netflix.com/watch/2',
    }),
    'auto',
  );
});

test('Disney+ auto-navigation is consumed before a second SPA route teardown', (t) => {
  installWebStorage(t, {
    sessionStorage: new MemoryStorage(),
    localStorage: new MemoryStorage(),
  });

  let ownerNonce = 'owner-nonce-disney';
  let playbackRoute = 'https://www.disneyplus.com/play/one';
  let contextActive = true;
  let panelOpen = true;
  let releaseCount = 0;
  const handleRoute = (nextRoute) =>
    handleOwnedPlaybackRouteChange({
      ownerNonce,
      currentRoute: playbackRoute,
      nextRoute,
      onAutoNavigation: (route) => {
        playbackRoute = route;
      },
      onManualNavigation: () => {
        ownerNonce = null;
        contextActive = false;
        panelOpen = false;
        releaseCount += 1;
        clearAutoNavigation();
      },
    });

  assert.equal(
    markAutoNavigation({
      ownerNonce,
      expectedRoute: 'https://www.disneyplus.com/play/two',
      reason: 'playlist:2:22',
    }),
    true,
  );
  assert.equal(handleRoute('https://www.disneyplus.com/play/two'), 'auto');
  assert.equal(contextActive, true);
  assert.equal(panelOpen, true);
  assert.equal(releaseCount, 0);

  assert.equal(handleRoute('https://www.disneyplus.com/browse'), 'manual');
  assert.equal(ownerNonce, null);
  assert.equal(contextActive, false);
  assert.equal(panelOpen, false);
  assert.equal(releaseCount, 1);

  ownerNonce = 'owner-nonce-disney-reload';
  playbackRoute = 'https://www.disneyplus.com/play/three';
  contextActive = true;
  panelOpen = true;
  assert.equal(
    markAutoNavigation({
      ownerNonce,
      expectedRoute: playbackRoute,
      reason: 'playlist:3:33',
    }),
    true,
  );
  clearAutoNavigation();

  assert.equal(handleRoute('https://www.disneyplus.com/search'), 'manual');
  assert.equal(ownerNonce, null);
  assert.equal(contextActive, false);
  assert.equal(panelOpen, false);
  assert.equal(releaseCount, 2);
});

test('a cancelled Netflix video wait disconnects and settles without a video', async () => {
  let video = null;
  let observer;
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnectCount = 0;
      observer = this;
    }

    observe() {}

    disconnect() {
      this.disconnectCount += 1;
    }

    trigger() {
      this.callback();
    }
  }
  const documentRef = {
    body: {},
    querySelector: () => video,
  };
  const wait = createElementWait('video', {
    documentRef,
    MutationObserverConstructor: FakeMutationObserver,
  });

  wait.cancel();
  assert.equal(await wait.promise, null);
  assert.equal(observer.disconnectCount, 1);

  video = { tagName: 'VIDEO' };
  observer.trigger();
  assert.equal(observer.disconnectCount, 1);
});

test('unchanged Disney+ button labels do not rewrite their text node', () => {
  let textContent = 'コメント';
  let writeCount = 0;
  const label = {
    get textContent() {
      return textContent;
    },
    set textContent(value) {
      textContent = value;
      writeCount += 1;
    },
  };

  assert.equal(setTextContentIfChanged(label, 'コメント'), false);
  assert.equal(writeCount, 0);
  assert.equal(setTextContentIfChanged(label, 'コメントを見る'), true);
  assert.equal(writeCount, 1);
  assert.equal(textContent, 'コメントを見る');
});

test('Netflix selection stores one complete mode update before opening', async () => {
  let finishStorage;
  const events = [];
  const writes = [];
  const storage = {
    set(value) {
      events.push('storage:start');
      writes.push(value);
      return new Promise((resolve) => {
        finishStorage = () => {
          events.push('storage:end');
          resolve();
        };
      });
    },
  };

  const committing = commitSelectedClip({
    data: {
      id: 42,
      title: 'Example',
      service: 'netflix',
      url: '/watch/42',
      StartTime: 10,
      EndTime: 20,
      ignored: 'not persisted',
    },
    requestedClipId: 99,
    ownerNonce: 'owner-nonce-42',
    storage,
    setCookies: () => events.push('cookies'),
    openClip: () => events.push('open'),
  });

  assert.deepEqual(events, ['storage:start']);
  assert.deepEqual(writes, [
    {
      clip: {
        clipId: 42,
        service: 'netflix',
        url: 'https://www.netflix.com/watch/42',
        startTime: 10,
        endTime: 20,
        title: 'Example',
      },
      currentClipId: 42,
      currentClipOrder: 0,
      playClipSystemKey: 1,
      playlistSystemKey: 0,
      playmode: 'clip',
      playbackOwnerNonce: 'owner-nonce-42',
    },
  ]);

  finishStorage();
  const selectedClip = await committing;

  assert.deepEqual(events, ['storage:start', 'storage:end', 'cookies', 'open']);
  assert.deepEqual(selectedClip, {
    clipId: 42,
    service: 'netflix',
    url: 'https://www.netflix.com/watch/42',
    startTime: 10,
    endTime: 20,
    title: 'Example',
  });
});
