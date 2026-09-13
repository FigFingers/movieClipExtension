import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const commonSourceUrl = new URL('../../src/content/common.js', import.meta.url);
let moduleSequence = 0;

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

  dispatch(event) {
    for (const listener of this.listeners.get(event.type) || []) {
      listener(event);
    }
  }

  dispatchEvent(event) {
    this.dispatch(event);
    return true;
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

  trigger() {
    if (this.connected) this.callback([]);
  }
}

class FakeElement extends FakeEventTarget {
  constructor(tagName, ownerDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.style = {
      cssText: '',
      transition: '',
      width: '',
    };
    this.dataset = {};
    this.attributes = new Map();
    this.className = '';
    this.id = '';
    this.textContent = '';
    this.value = '';
    this.onclick = null;
  }

  get isConnected() {
    return (
      this === this.ownerDocument.body ||
      this.parentElement?.isConnected === true
    );
  }

  append(...children) {
    for (const child of children) {
      if (child instanceof FakeElement) this.appendChild(child);
    }
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
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

  focus() {
    this.ownerDocument.activeElement = this;
    this.ownerDocument.dispatch({ type: 'focusin', target: this });
  }

  select() {}

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
    this.body = new FakeElement('body', this);
    this.activeElement = this.body;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    const visit = (element) => {
      if (element.id === id) return element;
      for (const child of element.children) {
        const match = visit(child);
        if (match) return match;
      }
      return null;
    };
    return visit(this.body);
  }

  querySelector(selector) {
    const visit = (element) => {
      if (
        selector.startsWith('.') &&
        element.className.split(/\s+/).includes(selector.slice(1))
      ) {
        return element;
      }
      if (selector === element.tagName.toLowerCase()) return element;
      for (const child of element.children) {
        const match = visit(child);
        if (match) return match;
      }
      return null;
    };
    return visit(this.body);
  }
}

function createKeyboardEvent(
  target,
  { key = 'Enter', isComposing = false, repeat = false } = {},
) {
  return {
    type: 'keydown',
    target,
    key,
    isComposing,
    repeat,
    defaultPrevented: false,
    propagationStopped: false,
    immediatePropagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    stopImmediatePropagation() {
      this.immediatePropagationStopped = true;
      this.propagationStopped = true;
    },
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function loadCommonModule() {
  const source = await readFile(commonSourceUrl, 'utf8');
  const importPattern =
    /import\s*\{[\s\S]*?\}\s*from '\.\/extensionSync\.js';/;
  const testableSource = source.replace(
    importPattern,
    'const enqueueClip = async () => ({ clientItemId: "test" });\n' +
      'const syncPendingQueue = async () => ({ ok: true });',
  );
  assert.notEqual(testableSource, source, 'extensionSync import should be replaced');

  moduleSequence += 1;
  const encoded = Buffer.from(
    `${testableSource}\n//# sourceURL=common-test-${moduleSequence}.mjs`,
  ).toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

function installDom() {
  const document = new FakeDocument();
  const window = new FakeEventTarget();
  window.location = { hostname: 'www.netflix.com' };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.location = { href: 'https://www.netflix.com/watch/1' };
  FakeMutationObserver.instances = [];
  globalThis.MutationObserver = FakeMutationObserver;
  return { document, window };
}

function sidebarControls(sidebar) {
  const header = sidebar.children[0];
  const nameLabel = sidebar.children[2];
  return {
    closeButton: header.children[1],
    nameInput: nameLabel.children[0],
    saveButton: sidebar.children[3],
  };
}

test('a stale save completion does not alter a reopened sidebar', async () => {
  const { document } = installDom();
  const { MEMO_SIDEBAR_ID, openMemoSidebar } = await loadCommonModule();
  const save = createDeferred();
  const player = document.createElement('video');
  player.style.width = '75%';
  let playCount = 0;
  player.play = () => {
    playCount += 1;
  };

  const firstSidebar = openMemoSidebar({
    videoPlayer: player,
    onSave: () => save.promise,
  });
  sidebarControls(firstSidebar).saveButton.onclick();

  const secondSidebar = openMemoSidebar({
    videoPlayer: player,
    onSave: () => Promise.resolve(),
  });
  assert.equal(player.style.width, 'calc(100% - 20%)');

  save.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(document.getElementById(MEMO_SIDEBAR_ID), secondSidebar);
  assert.equal(player.style.width, 'calc(100% - 20%)');
  assert.equal(playCount, 0);

  sidebarControls(secondSidebar).closeButton.onclick();
  assert.equal(player.style.width, '75%');
});

test('reopening on another player restores both original widths', async () => {
  const { document } = installDom();
  const { openMemoSidebar } = await loadCommonModule();
  const firstPlayer = document.createElement('video');
  const secondPlayer = document.createElement('video');
  firstPlayer.style.width = '60%';
  secondPlayer.style.width = '85%';

  openMemoSidebar({ videoPlayer: firstPlayer });
  const secondSidebar = openMemoSidebar({ videoPlayer: secondPlayer });

  assert.equal(firstPlayer.style.width, '60%');
  assert.equal(secondPlayer.style.width, 'calc(100% - 20%)');

  sidebarControls(secondSidebar).closeButton.onclick();
  assert.equal(secondPlayer.style.width, '85%');
});

test('Enter submits only from the name input', async () => {
  const { document, window } = installDom();
  const { openMemoSidebar } = await loadCommonModule();
  const player = document.createElement('video');
  player.play = () => {};
  let saveCount = 0;

  const firstSidebar = openMemoSidebar({
    videoPlayer: player,
    onSave: () => {
      saveCount += 1;
    },
  });
  const firstControls = sidebarControls(firstSidebar);
  const closeEnter = createKeyboardEvent(firstControls.closeButton);
  window.dispatch(closeEnter);

  assert.equal(saveCount, 0);
  assert.equal(closeEnter.defaultPrevented, false);
  firstControls.closeButton.onclick();

  const secondSidebar = openMemoSidebar({
    videoPlayer: player,
    onSave: () => {
      saveCount += 1;
    },
  });
  const inputEnter = createKeyboardEvent(sidebarControls(secondSidebar).nameInput);
  window.dispatch(inputEnter);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(saveCount, 1);
  assert.equal(inputEnter.defaultPrevented, true);
  assert.equal(inputEnter.immediatePropagationStopped, true);
});

test('closeMemoSidebar fully tears down the active session', async () => {
  const { document, window } = installDom();
  const { closeMemoSidebar, MEMO_SIDEBAR_ID, openMemoSidebar } =
    await loadCommonModule();
  const player = document.createElement('video');
  player.style.width = '70%';
  let closeCount = 0;

  openMemoSidebar({
    videoPlayer: player,
    onClose: () => {
      closeCount += 1;
    },
  });

  assert.equal(player.style.width, 'calc(100% - 20%)');
  assert.equal(window.listeners.get('keydown')?.size, 1);
  assert.equal(document.listeners.get('focusin')?.size, 1);

  assert.equal(closeMemoSidebar(), true);
  assert.equal(document.getElementById(MEMO_SIDEBAR_ID), null);
  assert.equal(player.style.width, '70%');
  assert.equal(window.listeners.get('keydown')?.size, 0);
  assert.equal(document.listeners.get('focusin')?.size, 0);
  assert.equal(closeCount, 1);
  assert.equal(closeMemoSidebar(), false);
});

test('superseding a memo session does not call its close callback', async () => {
  const { document } = installDom();
  const { closeMemoSidebar, openMemoSidebar } = await loadCommonModule();
  const player = document.createElement('video');
  let firstCloseCount = 0;

  openMemoSidebar({
    videoPlayer: player,
    onClose: () => {
      firstCloseCount += 1;
    },
  });
  openMemoSidebar({ videoPlayer: player });

  assert.equal(firstCloseCount, 0);
  closeMemoSidebar();
});

test('opening a memo requests that the comment panel close', async () => {
  const { document, window } = installDom();
  const {
    CLOSE_COMMENT_PANEL_EVENT,
    closeMemoSidebar,
    openMemoSidebar,
  } = await loadCommonModule();
  const player = document.createElement('video');
  let closeRequestCount = 0;
  window.addEventListener(CLOSE_COMMENT_PANEL_EVENT, () => {
    closeRequestCount += 1;
  });

  openMemoSidebar({ videoPlayer: player });

  assert.equal(closeRequestCount, 1);
  closeMemoSidebar();
});

test('opening a memo after the Netflix clip list preserves the true player width', async () => {
  const { document } = installDom();
  const { closeMemoSidebar, MEMO_SIDEBAR_ID, openMemoSidebar } =
    await loadCommonModule();
  const player = document.createElement('div');
  player.className = 'watch-video--player-view';
  player.style.width = '65%';
  document.body.appendChild(player);

  const clipList = document.createElement('div');
  clipList.id = MEMO_SIDEBAR_ID;
  clipList.dataset.sidebarType = 'clip-list';
  clipList.dataset.originalPlayerWidth = player.style.width;
  document.body.appendChild(clipList);
  player.style.width = 'calc(100% - 30%)';

  const memo = openMemoSidebar({ videoPlayer: player });

  assert.notEqual(memo, null);
  assert.equal(clipList.parentElement, null);
  assert.equal(player.style.width, 'calc(100% - 20%)');

  closeMemoSidebar();
  assert.equal(player.style.width, '65%');
});

test('site-side removal tears down memo listeners and restores the exact width', async () => {
  const { document, window } = installDom();
  const { closeMemoSidebar, openMemoSidebar } = await loadCommonModule();
  const player = document.createElement('video');
  player.style.width = '';
  const save = createDeferred();
  let playCount = 0;
  player.play = () => {
    playCount += 1;
  };
  let closeCount = 0;

  const sidebar = openMemoSidebar({
    videoPlayer: player,
    onSave: () => save.promise,
    onClose: () => {
      closeCount += 1;
    },
  });
  const mountObserver = FakeMutationObserver.instances.at(-1);

  assert.equal(mountObserver?.connected, true);
  sidebarControls(sidebar).saveButton.onclick();
  sidebar.remove();
  mountObserver.trigger();

  assert.equal(player.style.width, '');
  assert.equal(window.listeners.get('keydown')?.size, 0);
  assert.equal(document.listeners.get('focusin')?.size, 0);
  assert.equal(mountObserver.connected, false);
  assert.equal(closeCount, 1);
  assert.equal(closeMemoSidebar(), false);

  save.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(playCount, 0);
});

test('memo Escape respects IME composition and restores focus on close', async () => {
  const { document, window } = installDom();
  const { MEMO_SIDEBAR_ID, openMemoSidebar } = await loadCommonModule();
  const player = document.createElement('video');
  const trigger = document.createElement('button');
  document.body.appendChild(trigger);
  trigger.focus();

  const sidebar = openMemoSidebar({ videoPlayer: player });
  const controls = sidebarControls(sidebar);

  assert.equal(sidebar.getAttribute('role'), 'dialog');
  assert.equal(
    sidebar.getAttribute('aria-labelledby'),
    `${MEMO_SIDEBAR_ID}-title`,
  );
  assert.equal(controls.closeButton.getAttribute('aria-label'), '録画メモを閉じる');

  const composingEscape = createKeyboardEvent(controls.nameInput, {
    key: 'Escape',
    isComposing: true,
  });
  window.dispatch(composingEscape);
  assert.equal(document.getElementById(MEMO_SIDEBAR_ID), sidebar);
  assert.equal(composingEscape.defaultPrevented, false);
  assert.equal(composingEscape.immediatePropagationStopped, true);

  const escape = createKeyboardEvent(controls.nameInput, { key: 'Escape' });
  window.dispatch(escape);
  assert.equal(document.getElementById(MEMO_SIDEBAR_ID), null);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(document.activeElement, trigger);
});

test('formatSeconds renders m:ss under an hour and h:mm:ss at or above one hour', async () => {
  installDom();
  const { formatSeconds } = await loadCommonModule();

  assert.equal(formatSeconds(0), '0:00');
  assert.equal(formatSeconds(9), '0:09');
  assert.equal(formatSeconds(65), '1:05');
  assert.equal(formatSeconds(599), '9:59');
  assert.equal(formatSeconds(3599), '59:59');
  assert.equal(formatSeconds(3600), '1:00:00');
  assert.equal(formatSeconds(3661), '1:01:01');
  assert.equal(formatSeconds(7325), '2:02:05');
});

test('formatSeconds floors fractions and clamps invalid input to zero', async () => {
  installDom();
  const { formatSeconds } = await loadCommonModule();

  assert.equal(formatSeconds(65.9), '1:05');
  assert.equal(formatSeconds(-30), '0:00');
  assert.equal(formatSeconds(Number.NaN), '0:00');
  assert.equal(formatSeconds(Number.POSITIVE_INFINITY), '0:00');
  assert.equal(formatSeconds(), '0:00');
});

test('cleanTitleText strips zero-width characters and trims', async () => {
  installDom();
  const { cleanTitleText } = await loadCommonModule();

  // Netflix の話数 span は文字間に U+FEFF が挿入される
  assert.equal(cleanTitleText('\uFEFFエ\uFEFFピ\uFEFFソ\uFEFFー\uFEFFド16: '), 'エピソード16:');
  assert.equal(cleanTitleText('物怪\u200Bと武士'), '物怪と武士');
  assert.equal(cleanTitleText('  刃牙道  '), '刃牙道');
  assert.equal(cleanTitleText('\uFEFF\u200B'), '');
  assert.equal(cleanTitleText(undefined), '');
  assert.equal(cleanTitleText(null), '');
  assert.equal(cleanTitleText(42), '');
});

test('buildClipName joins the series and episode titles', async () => {
  installDom();
  const { buildClipName } = await loadCommonModule();

  assert.equal(buildClipName('刃牙道', '物怪と武士'), '刃牙道｜物怪と武士');
  assert.equal(buildClipName('\uFEFF刃牙道', ' 物怪と武士 '), '刃牙道｜物怪と武士');
  // span が 1 つしか無い動画では作品名だけを返す
  assert.equal(buildClipName('刃牙道', ''), '刃牙道');
  assert.equal(buildClipName('刃牙道', undefined), '刃牙道');
  assert.equal(buildClipName('', '物怪と武士'), '物怪と武士');
  assert.equal(buildClipName(undefined, undefined), '');
});
