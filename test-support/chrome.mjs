export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export function installChromeStorage(t, initial = {}) {
  const stored = structuredClone(initial);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const writes = [];
  const runtime = {};
  const local = {
    get(keys, callback) {
      const names = typeof keys === 'string' ? [keys] : keys;
      const snapshot = structuredClone(Object.fromEntries(names.filter((key) => key in stored).map((key) => [key, stored[key]])));
      queueMicrotask(() => callback(snapshot));
    },
    set(items, callback) {
      writes.push(structuredClone(items));
      Object.assign(stored, structuredClone(items));
      queueMicrotask(callback);
    },
    remove(keys, callback) {
      for (const key of keys) delete stored[key];
      queueMicrotask(callback);
    },
  };
  globalThis.chrome = { runtime, storage: { local } };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous);
    else delete globalThis.chrome;
  });
  return { stored, local, runtime, writes };
}

export function sampleClip(clientItemId = crypto.randomUUID()) {
  return {
    clientItemId, url: 'https://www.netflix.com/watch/81000001',
    service: 'Netflix', title: 'テスト作品', startTime: 10, endTime: 20,
  };
}
