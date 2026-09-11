import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLIP_LIST_DEFAULT_LIMIT,
  buildClipListApiUrl,
  fetchClipList,
  getClipListResponseReason,
  normalizeClipListItem,
} from '../../src/background/clips.js';

function clipRowFixture(overrides = {}) {
  return {
    id: 12,
    userId: 3,
    vodId: 1,
    name: 'ブレイキング・バッド｜Pilot',
    title: 'ブレイキング・バッド',
    views: 0,
    startMs: 61_000,
    endMs: 95_500,
    url: '/watch/70143836',
    epnum: 'エピソード1',
    createdAt: '2026-08-30T12:00:00.000Z',
    vod: { id: 1, code: 'NETFLIX', name: 'Netflix' },
    user: { id: 3, name: 'alice', email: 'alice@example.com', hashedPassword: 'x' },
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function withFetch(fetchImpl, task) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await task();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withImmediateTimeout(task) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback) => {
    callback();
    return 1;
  };
  globalThis.clearTimeout = () => {};
  try {
    return await task();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

function abortAwareFetch(_url, options) {
  return new Promise((_resolve, reject) => {
    const fail = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (options.signal.aborted) {
      fail();
      return;
    }
    options.signal.addEventListener('abort', fail, { once: true });
  });
}

test('再生中の作品名で絞り込む URL を組み立てる', () => {
  const url = new URL(buildClipListApiUrl({ title: 'ブレイキング・バッド' }));
  assert.equal(url.pathname, '/api/v1/clips');
  assert.equal(url.searchParams.get('title'), 'ブレイキング・バッド');
  assert.equal(url.searchParams.get('limit'), String(CLIP_LIST_DEFAULT_LIMIT));
});

test('タイトルを取れなかったときは絞り込まない', () => {
  for (const title of ['', '   ', undefined, null, 42]) {
    const url = new URL(buildClipListApiUrl({ title }));
    assert.equal(url.searchParams.has('title'), false);
  }
});

test('limit と title をサイトが受け付ける範囲へ丸める', () => {
  const tooLarge = new URL(buildClipListApiUrl({ limit: 1000 }));
  assert.equal(tooLarge.searchParams.get('limit'), '100');

  for (const limit of [0, -1, 1.5, 'abc', undefined]) {
    const url = new URL(buildClipListApiUrl({ limit }));
    assert.equal(url.searchParams.get('limit'), String(CLIP_LIST_DEFAULT_LIMIT));
  }

  const longTitle = new URL(buildClipListApiUrl({ title: 'あ'.repeat(300) }));
  assert.equal(longTitle.searchParams.get('title').length, 200);
});

test('status から失敗理由を決める', () => {
  assert.equal(getClipListResponseReason(200), null);
  assert.equal(getClipListResponseReason(400), 'validation_error');
  assert.equal(getClipListResponseReason(404), 'not_found');
  assert.equal(getClipListResponseReason(429), 'rate_limited');
  assert.equal(getClipListResponseReason(500), 'request_failed');
});

test('clip 行を拡張が使う項目だけに組み直す', () => {
  const item = normalizeClipListItem(clipRowFixture());

  assert.deepEqual(item, {
    id: 12,
    clipId: 12,
    title: 'ブレイキング・バッド',
    epnumber: 'エピソード1',
    user: 'alice',
    service: 'NETFLIX',
    url: '/watch/70143836',
    startTime: 61,
    endTime: 95.5,
  });
});

test('サイトが返す user の余分な列を持ち込まない', () => {
  const item = normalizeClipListItem(clipRowFixture());
  const serialized = JSON.stringify(item);

  assert.equal(serialized.includes('alice@example.com'), false);
  assert.equal(serialized.includes('hashedPassword'), false);
  assert.equal(Object.hasOwn(item, 'userId'), false);
  assert.equal(Object.hasOwn(item, 'vod'), false);
});

test('話数と投稿者名は欠けていても空文字で通す', () => {
  const item = normalizeClipListItem(
    clipRowFixture({ epnum: null, user: null })
  );

  assert.equal(item.epnumber, '');
  assert.equal(item.user, '');
  assert.equal(item.id, 12);
});

test('文字列は再生 handoff の上限で切り詰める', () => {
  const item = normalizeClipListItem(
    clipRowFixture({ title: 'あ'.repeat(600), user: { name: 'い'.repeat(300) } })
  );

  assert.equal(item.title.length, 500);
  assert.equal(item.user.length, 200);
});

test('再生に必要な項目を欠く行は捨てる', () => {
  const broken = [
    { id: 0 },
    { id: 'abc' },
    clipRowFixture({ startMs: 5000, endMs: 5000 }),
    clipRowFixture({ startMs: 9000, endMs: 1000 }),
    clipRowFixture({ startMs: -1 }),
    clipRowFixture({ url: '' }),
    clipRowFixture({ vod: null }),
    null,
    'clip',
    [],
  ];

  for (const row of broken) {
    assert.equal(normalizeClipListItem(row), null);
  }
});

test('200 なら正規化した一覧を返し、壊れた行だけ落とす', async () => {
  let requestedUrl = null;

  const result = await withFetch(
    async (url) => {
      requestedUrl = url;
      return jsonResponse(200, {
        data: [clipRowFixture(), clipRowFixture({ id: 13, vod: null })],
        meta: { nextCursor: null, hasNext: false },
      });
    },
    () => fetchClipList({ title: 'ブレイキング・バッド' })
  );

  assert.equal(new URL(requestedUrl).searchParams.get('title'), 'ブレイキング・バッド');
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].clipId, 12);
});

test('2xx 以外は status を理由付きで返す', async () => {
  const result = await withFetch(
    async () => jsonResponse(400, { error: 'validation' }),
    () => fetchClipList({ title: 'x' })
  );

  assert.deepEqual(result, {
    ok: false,
    reason: 'validation_error',
    status: 400,
  });
});

test('data が配列でない応答は invalid_response', async () => {
  for (const body of [{ data: null }, { items: [] }, null, []]) {
    const result = await withFetch(
      async () => jsonResponse(200, body),
      () => fetchClipList({})
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_response');
  }
});

test('通信に失敗したら network_error', async () => {
  const result = await withFetch(
    async () => {
      throw new Error('offline');
    },
    () => fetchClipList({})
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network_error');
  assert.equal(result.message, 'offline');
});

test('応答しない API は timeout として返す', async () => {
  const result = await withImmediateTimeout(() =>
    withFetch(abortAwareFetch, () => fetchClipList({}))
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
});
