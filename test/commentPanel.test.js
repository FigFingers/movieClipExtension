import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COMMENT_PANEL_ID,
  closeCommentPanel,
  isAmbiguousPostFailure,
  resolveCurrentClipIdFromState,
  shouldClearSubmittedDraft,
  shouldClosePanelForKeyEvent,
  toggleCommentPanel,
} from '../src/content/commentPanel.js';

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) {
      listener(event);
    }
    return true;
  }
}

class FakeElement extends FakeEventTarget {
  constructor(tagName, ownerDocument, { shadowHost = null } = {}) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.shadowHost = shadowHost;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = { cssText: '' };
    this.className = '';
    this.id = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.hidden = false;
  }

  get isConnected() {
    if (this === this.ownerDocument.documentElement) return true;
    if (this.shadowHost) return this.shadowHost.isConnected;
    return this.parentElement?.isConnected === true;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  appendChild(child) {
    if (!(child instanceof FakeElement)) return child;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  }

  contains(target) {
    return target === this || this.children.some((child) => child.contains(target));
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (element) => {
      if (selector === 'button' && element.tagName === 'BUTTON') {
        matches.push(element);
      }
      for (const child of element.children) visit(child);
    };
    visit(this);
    return matches;
  }

  attachShadow() {
    const root = new FakeElement('#shadow-root', this.ownerDocument, {
      shadowHost: this,
    });
    this.attachedShadow = root;
    return root;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
    this.visibilityState = 'visible';
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  querySelectorAll(selector) {
    const ariaControls = selector.match(/^\[aria-controls="([^"]+)"\]$/)?.[1];
    const matches = [];
    const visit = (element) => {
      if (
        (ariaControls && element.getAttribute('aria-controls') === ariaControls) ||
        (selector.startsWith('#') && element.id === selector.slice(1)) ||
        element.tagName.toLowerCase() === selector
      ) {
        matches.push(element);
      }
      for (const child of element.children) visit(child);
    };
    visit(this.documentElement);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getElementById(id) {
    return this.querySelector(`#${id}`);
  }
}

class FakeMutationObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.connected = false;
    FakeMutationObserver.instances.push(this);
  }

  observe() {
    this.connected = true;
  }

  disconnect() {
    this.connected = false;
  }
}

class FakeChromeStorageEvent {
  constructor() {
    this.listeners = new Set();
  }

  addListener(listener) {
    this.listeners.add(listener);
  }

  removeListener(listener) {
    this.listeners.delete(listener);
  }

  emit(changes, areaName) {
    for (const listener of this.listeners) listener(changes, areaName);
  }
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test('単体再生は clipId を id より優先する', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playmode: 'clip',
      clip: { clipId: 123, id: 999 },
    }),
    123
  );
});

test('単体再生は id と数値文字列を後方互換として受け付ける', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playmode: 'clip',
      clip: { id: '456' },
    }),
    456
  );
});

test('プレイリスト再生は currentClipOrder に一致する項目を解決する', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playmode: 'playlist',
      currentClipOrder: '2',
      playQueue: [
        { order: 0, id: 100 },
        { order: 2, clipId: '102', id: 999 },
      ],
    }),
    102
  );
});

test('プレイリストの currentClipId は正として利用しない', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playmode: 'playlist',
      currentClipOrder: 3,
      currentClipId: 777,
      playQueue: [{ order: 2, id: 100 }],
    }),
    null
  );
});

test('サーバーIDが無いローカル録画クリップは null にする', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playmode: 'clip',
      clip: {
        clientItemId: 'local-only',
        title: 'ローカル録画',
      },
    }),
    null
  );
});

test('0・負数・非整数・unsafe integer はクリップIDとして拒否する', () => {
  for (const clipId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'abc']) {
    assert.equal(
      resolveCurrentClipIdFromState({
        playmode: 'clip',
        clip: { clipId },
      }),
      null
    );
  }
});

test('playmode が無い旧状態では mode key をフォールバック利用する', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playClipSystemKey: 1,
      clip: { clipId: 88 },
    }),
    88
  );
  assert.equal(
    resolveCurrentClipIdFromState({
      playlistSystemKey: 1,
      currentClipOrder: 0,
      playQueue: [{ order: 0, id: 89 }],
    }),
    89
  );
});

test('プレイリスト再生は残留した単体再生の clip を参照しない', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playmode: 'playlist',
      clip: { clipId: 555 },
      currentClipOrder: 1,
      playQueue: [
        { order: 0, id: 100 },
        { order: 1, id: 101 },
      ],
    }),
    101
  );
});

test('clipId cookie が失効した単体再生は null にする', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      playmode: 'clip',
      clip: { title: 'タイトル', starttime: '10', endtime: '20' },
    }),
    null
  );
});

test('再生モードが無い通常視聴では null にする', () => {
  assert.equal(
    resolveCurrentClipIdFromState({
      clip: { clipId: 123 },
      currentClipId: 123,
    }),
    null
  );
});

test('投稿待ちの間に書き換えた次の下書きは消さない', () => {
  assert.equal(shouldClearSubmittedDraft('送信した本文', '送信した本文'), true);
  assert.equal(shouldClearSubmittedDraft('次のコメント', '送信した本文'), false);
});

test('投稿済みか不明な失敗は一覧で確認する', () => {
  for (const reason of [
    'invalid_response',
    'network_error',
    'timeout',
    'background_unavailable',
    'request_failed',
  ]) {
    assert.equal(isAmbiguousPostFailure(reason), true);
  }
  assert.equal(isAmbiguousPostFailure('validation_error'), false);
  assert.equal(isAmbiguousPostFailure('unauthorized'), false);
  assert.equal(isAmbiguousPostFailure('rate_limited'), false);
});

test('EscapeはIME変換中にパネルを閉じない', () => {
  assert.equal(
    shouldClosePanelForKeyEvent({
      type: 'keydown',
      key: 'Escape',
      isComposing: true,
    }),
    false,
  );
  assert.equal(
    shouldClosePanelForKeyEvent({
      type: 'keydown',
      key: 'Escape',
      isComposing: false,
    }),
    true,
  );
  assert.equal(
    shouldClosePanelForKeyEvent({ type: 'keyup', key: 'Escape' }),
    false,
  );
});

test('投稿中のauth変更は成功応答をstale化させず、後から一覧を更新する', async () => {
  const previousGlobals = new Map();
  for (const name of [
    'chrome',
    'CustomEvent',
    'document',
    'MutationObserver',
    'sessionStorage',
    'window',
  ]) {
    previousGlobals.set(name, {
      present: Object.hasOwn(globalThis, name),
      value: globalThis[name],
    });
  }

  const document = new FakeDocument();
  const window = new FakeEventTarget();
  const storageChanged = new FakeChromeStorageEvent();
  const sessionValues = new Map([
    [
      'dextPlaybackContextV1',
      JSON.stringify({
        initialized: true,
        context: { mode: 'clip', clipId: 42 },
      }),
    ],
  ]);
  const runtimeMessages = [];
  let postCallback = null;

  FakeMutationObserver.instances = [];
  globalThis.document = document;
  globalThis.window = window;
  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.CustomEvent = class {
    constructor(type, { detail } = {}) {
      this.type = type;
      this.detail = detail;
    }
  };
  globalThis.sessionStorage = {
    getItem: (key) => sessionValues.get(key) ?? null,
    setItem: (key, value) => sessionValues.set(key, value),
    removeItem: (key) => sessionValues.delete(key),
  };
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        runtimeMessages.push(message);
        if (message.type === 'POST_CLIP_COMMENT') {
          postCallback = callback;
          return;
        }
        callback({
          ok: true,
          comments: [],
          hasNext: false,
          nextCursor: null,
        });
      },
    },
    storage: { onChanged: storageChanged },
  };

  const trigger = document.createElement('button');
  trigger.setAttribute('aria-controls', COMMENT_PANEL_ID);
  document.body.appendChild(trigger);
  trigger.focus();

  try {
    assert.equal(
      toggleCommentPanel({ mountEl: document.body, triggerEl: trigger }),
      true,
    );
    await flushAsyncWork();

    const host = document.getElementById(COMMENT_PANEL_ID);
    const textarea = host.children[0];
    const panel = host.attachedShadow.children[1];
    const form = panel.children[3];
    textarea.value = '送信本文';
    textarea.dispatchEvent({ type: 'input', target: textarea });
    form.dispatchEvent({
      type: 'submit',
      target: form,
      preventDefault() {},
    });
    await flushAsyncWork();

    assert.equal(typeof postCallback, 'function');
    storageChanged.emit({ extensionAuthToken: { newValue: 'new-token' } }, 'local');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      runtimeMessages.filter((message) => message.type === 'FETCH_CLIP_COMMENTS')
        .length,
      1,
      '投稿中のauth変更はGETを先行させない',
    );

    postCallback({
      ok: true,
      comment: {
        id: 7,
        username: 'ユーザー',
        body: '送信本文',
        createdAt: '2026-08-23T00:00:00.000Z',
      },
    });
    await flushAsyncWork();

    assert.equal(textarea.value, '');
    assert.equal(
      runtimeMessages.filter((message) => message.type === 'FETCH_CLIP_COMMENTS')
        .length,
      2,
      '投稿完了後にqueued refreshを1回実行する',
    );

    const mountObserver = FakeMutationObserver.instances.at(-1);
    closeCommentPanel();
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, trigger);
    assert.equal(storageChanged.listeners.size, 0);
    assert.equal(document.listeners.get('visibilitychange')?.size, 0);
    assert.equal(window.listeners.get('keydown')?.size, 0);
    assert.equal(mountObserver.connected, false);
  } finally {
    closeCommentPanel();
    for (const [name, previous] of previousGlobals) {
      if (previous.present) globalThis[name] = previous.value;
      else delete globalThis[name];
    }
  }
});
