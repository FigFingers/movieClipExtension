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
    this.id = '';
    this.textContent = '';
    this.value = '';
    this.onclick = null;
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

  querySelector() {
    return null;
  }
}

function createKeyboardEvent(target) {
  return {
    type: 'keydown',
    target,
    key: 'Enter',
    isComposing: false,
    repeat: false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
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
});
