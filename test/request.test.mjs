import assert from 'node:assert/strict';
import test from 'node:test';
import { requestJson } from '../src/background/request.js';

test('通信のヘッダーと本文を読み取って返す', async (t) => {
  const response = { status: 200, json: async () => ({ ok: true }) };
  const mock = t.mock.method(globalThis, 'fetch', async () => response);
  assert.deepEqual(await requestJson('http://localhost/test', { method: 'POST' }), { response, data: { ok: true } });
  assert.equal(mock.mock.calls[0].arguments[1].method, 'POST');
  assert.equal(mock.mock.calls[0].arguments[1].signal.aborted, false);
});

for (const phase of ['headers', 'body']) {
  test(`${phase}待ちが止まっても通信期限で終了しabortする`, async (t) => {
    let signal;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      signal = options.signal;
      const hang = new Promise(() => {});
      return phase === 'headers' ? hang : { status: 200, json: () => hang };
    });
    await assert.rejects(requestJson('http://localhost/test', {}, { timeoutMs: 10 }), { name: 'TimeoutError' });
    assert.equal(signal.aborted, true);
  });
}

test('JSON破損はnullの本文として呼出側で判定できる', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ status: 200, json: async () => { throw new SyntaxError('JSON'); } }));
  assert.equal((await requestJson('http://localhost/test')).data, null);
});
