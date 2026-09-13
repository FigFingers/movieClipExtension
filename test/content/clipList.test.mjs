import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClipList } from '../../src/content/clipList.js';

function setup(t) {
  const originalChrome = globalThis.chrome;
  t.after(() => { globalThis.chrome = originalChrome; });
  const requests = [];
  globalThis.chrome = { runtime: {
    sendMessage(message, respond) { requests.push({ message, respond }); },
  } };
  const document = {
    createElement() {
      return {
        ownerDocument: document,
        isConnected: true,
        children: [],
        textContent: '',
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        replaceChildren(...children) { this.children = children; },
        appendChild(child) { this.children.push(child); },
      };
    },
  };
  const container = document.createElement('div');
  const loaded = [];
  const options = { title: '作品名', onLoaded: (items) => loaded.push(items) };
  return { container, requests, loaded, options };
}

test('clip list retries a failed request without duplicate clicks', async (t) => {
  const { container, requests, loaded, options } = setup(t);
  const pending = loadClipList(container, options);
  assert.equal(container.children[0].textContent, '読込中…');
  assert.equal(container.children[0].attributes.role, 'status');
  assert.deepEqual(requests[0].message, { type: 'FETCH_CLIP_LIST', title: '作品名' });
  requests[0].respond({ ok: false, reason: 'network_error' });
  await pending;
  assert.match(container.children[0].textContent, /通信環境/);
  const retry = container.children[1];
  const retried = retry.onclick();
  retry.onclick();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].message.title, options.title);
  const items = [{ clipId: 12 }];
  requests[1].respond({ ok: true, items });
  await retried;
  assert.deepEqual(loaded, [items]);
});

test('closed panels ignore both successful and failed late responses', async (t) => {
  const { container, requests, loaded, options } = setup(t);
  for (const response of [{ ok: true, items: [{ clipId: 12 }] }, { ok: false }]) {
    container.isConnected = true;
    const pending = loadClipList(container, options);
    container.isConnected = false;
    requests.at(-1).respond(response);
    await pending;
    assert.equal(container.children[0].textContent, '読込中…');
    assert.equal(container.children.length, 1);
  }
  assert.deepEqual(loaded, []);
});

test('an older clip list response cannot overwrite a newer request', async (t) => {
  const { container, requests, loaded, options } = setup(t);
  const first = loadClipList(container, options);
  const second = loadClipList(container, { ...options, title: '別の作品' });
  requests[1].respond({ ok: true, items: [] });
  await second;
  requests[0].respond({ ok: false });
  await first;
  assert.equal(container.children[0].textContent, '「別の作品」の記録はまだありません。');
  assert.equal(container.children.length, 1);
  assert.deepEqual(loaded, []);
});

test('malformed successful responses show retry instead of an empty list', async (t) => {
  const { container, requests, loaded, options } = setup(t);
  for (const items of [undefined, null, {}, 'clips']) {
    const pending = loadClipList(container, options);
    requests.at(-1).respond({ ok: true, items });
    await pending;
    assert.match(container.children[0].textContent, /失敗/);
    assert.equal(container.children[1].textContent, '再試行');
  }
  assert.deepEqual(loaded, []);
});

test('missing extension runtime displays reload guidance', async (t) => {
  const { container, options } = setup(t);
  globalThis.chrome = undefined;
  await loadClipList(container, options);
  assert.match(container.children[0].textContent, /再読み込み/);
});
