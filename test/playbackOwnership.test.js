import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLAYBACK_HANDOFF_TTL_MS,
  PLAYBACK_OWNER_STORAGE_KEY,
  PLAYBACK_REGISTRY_STORAGE_KEY,
  createPlaybackOwnershipManager,
} from '../src/background/playbackOwnership.js';

class MemoryStorageArea {
  constructor(initial = {}) {
    this.data = { ...initial };
  }

  async get(keys) {
    if (typeof keys === 'string') return { [keys]: this.data[keys] };
    const selected = {};
    for (const key of keys || Object.keys(this.data)) selected[key] = this.data[key];
    return selected;
  }

  async set(items) {
    Object.assign(this.data, items);
  }
}

function clipSnapshot(
  nonce,
  clipId,
  url = `https://www.netflix.com/watch/${clipId}`
) {
  return {
    clip: { id: clipId, title: `clip-${clipId}`, url },
    playClipSystemKey: 1,
    playlistSystemKey: 0,
    playmode: 'clip',
    [PLAYBACK_OWNER_STORAGE_KEY]: nonce,
  };
}

function createHarness() {
  let currentTime = 1_000;
  const sessionStorage = new MemoryStorageArea();
  const localStorage = new MemoryStorageArea();
  const manager = createPlaybackOwnershipManager({
    sessionStorage,
    localStorage,
    now: () => currentTime,
  });
  return {
    manager,
    sessionStorage,
    localStorage,
    advance(ms) {
      currentTime += ms;
    },
  };
}

async function beginAndClaim(harness, {
  nonce,
  sourceTabId,
  tabId = sourceTabId,
  openerTabId,
  clipId,
}) {
  const snapshot = clipSnapshot(nonce, clipId);
  await harness.manager.beginHandoff({
    nonce,
    sourceTabId,
    context: { mode: 'clip', clipId },
    snapshot,
  });
  return harness.manager.claim({
    tabId,
    openerTabId,
    nonce,
  });
}

test('a handoff can be claimed by its source tab or an opener child only', async () => {
  const sourceHarness = createHarness();
  assert.equal(
    (await beginAndClaim(sourceHarness, {
      nonce: 'nonce-source',
      sourceTabId: 10,
      clipId: 1,
    })).ok,
    true
  );

  const childHarness = createHarness();
  assert.equal(
    (await beginAndClaim(childHarness, {
      nonce: 'nonce-child',
      sourceTabId: 20,
      tabId: 21,
      openerTabId: 20,
      clipId: 2,
    })).ok,
    true
  );

  const unrelatedHarness = createHarness();
  const snapshot = clipSnapshot('nonce-private', 3);
  await unrelatedHarness.manager.beginHandoff({
    nonce: 'nonce-private',
    sourceTabId: 30,
    context: { mode: 'clip', clipId: 3 },
    snapshot,
  });
  assert.deepEqual(
    await unrelatedHarness.manager.claim({
      tabId: 31,
      openerTabId: 999,
      nonce: 'nonce-private',
    }),
    { ok: false, reason: 'handoff_not_found' }
  );
});

test('a nonce-less legacy child claims exactly one opener-bound handoff', async () => {
  const harness = createHarness();
  const snapshot = clipSnapshot('nonce-legacy', 61);
  await harness.manager.beginHandoff({
    nonce: 'nonce-legacy',
    sourceTabId: 60,
    context: { mode: 'clip', clipId: 61 },
    snapshot,
  });

  const claim = await harness.manager.claim({ tabId: 61, openerTabId: 60 });
  assert.equal(claim.ok, true);
  assert.equal(claim.nonce, 'nonce-legacy');
  assert.equal(claim.snapshot.clip.id, 61);
});

test('a nonce-less legacy claim can retry after BEGIN arrives', async () => {
  const harness = createHarness();
  assert.deepEqual(
    await harness.manager.claim({ tabId: 66, openerTabId: 65 }),
    { ok: false, reason: 'handoff_not_found' }
  );
  await harness.manager.beginHandoff({
    nonce: 'nonce-late-begin',
    sourceTabId: 65,
    context: { mode: 'clip', clipId: 66 },
    snapshot: clipSnapshot('nonce-late-begin', 66),
  });
  const claim = await harness.manager.claim({ tabId: 66, openerTabId: 65 });
  assert.equal(claim.ok, true);
  assert.equal(claim.nonce, 'nonce-late-begin');
});

test('a nonce-less legacy claim rejects ambiguous opener handoffs', async () => {
  const harness = createHarness();
  for (const [nonce, clipId] of [['nonce-legacy-a', 71], ['nonce-legacy-b', 72]]) {
    await harness.manager.beginHandoff({
      nonce,
      sourceTabId: 70,
      context: { mode: 'clip', clipId },
      snapshot: clipSnapshot(nonce, clipId),
    });
  }

  assert.deepEqual(
    await harness.manager.claim({ tabId: 71, openerTabId: 70 }),
    { ok: false, reason: 'ambiguous_handoff' }
  );
});

test('releasing one active tab restores the latest remaining snapshot', async () => {
  const harness = createHarness();
  await beginAndClaim(harness, {
    nonce: 'nonce-active-a',
    sourceTabId: 1,
    clipId: 11,
  });
  harness.advance(10);
  await beginAndClaim(harness, {
    nonce: 'nonce-active-b',
    sourceTabId: 2,
    clipId: 22,
  });

  assert.deepEqual(
    await harness.manager.release({ tabId: 2, nonce: 'nonce-active-b' }),
    { ok: true, cleared: false }
  );
  assert.equal(harness.localStorage.data.playbackOwnerNonce, 'nonce-active-a');
  assert.equal(harness.localStorage.data.clip.id, 11);

  assert.deepEqual(
    await harness.manager.release({ tabId: 1, nonce: 'nonce-active-a' }),
    { ok: true, cleared: true }
  );
  assert.equal(harness.localStorage.data.playmode, null);
  assert.equal(harness.localStorage.data.playbackOwnerNonce, null);
});

test('an owner transition and another tab release are serialized without rollback', async () => {
  for (const releaseFirst of [false, true]) {
    const harness = createHarness();
    await beginAndClaim(harness, {
      nonce: 'nonce-serial-a',
      sourceTabId: 81,
      clipId: 811,
    });
    await beginAndClaim(harness, {
      nonce: 'nonce-serial-b',
      sourceTabId: 82,
      clipId: 821,
    });

    const update = () => harness.manager.update({
      tabId: 81,
      nonce: 'nonce-serial-a',
      context: { mode: 'clip', clipId: 812 },
      patch: clipSnapshot('nonce-serial-a', 812),
    });
    const release = () => harness.manager.release({
      tabId: 82,
      nonce: 'nonce-serial-b',
    });
    const first = releaseFirst ? release() : update();
    const second = releaseFirst ? update() : release();
    await Promise.all([first, second]);

    assert.equal(harness.localStorage.data.playbackOwnerNonce, 'nonce-serial-a');
    assert.equal(harness.localStorage.data.clip.id, 812);
  }
});

test('reload keeps a route owner, manual navigation releases it, and prepared navigation survives', async () => {
  const reloadHarness = createHarness();
  const nonce = 'nonce-route-reload';
  const firstRoute = 'https://www.netflix.com/watch/901?t=3';
  await reloadHarness.manager.beginHandoff({
    nonce,
    sourceTabId: 90,
    context: { mode: 'clip', clipId: 901 },
    snapshot: clipSnapshot(nonce, 901),
  });
  assert.equal((await reloadHarness.manager.claim({
    tabId: 90,
    nonce,
    route: firstRoute,
  })).ok, true);
  assert.equal((await reloadHarness.manager.claim({
    tabId: 90,
    nonce,
    route: firstRoute,
  })).ok, true);

  assert.deepEqual(
    await reloadHarness.manager.handleTabNavigation({
      tabId: 90,
      url: 'https://www.netflix.com/browse',
    }),
    { ok: true, released: true, cleared: true }
  );

  const autoHarness = createHarness();
  const autoNonce = 'nonce-route-auto';
  await beginAndClaim(autoHarness, {
    nonce: autoNonce,
    sourceTabId: 91,
    clipId: 911,
  });
  await autoHarness.manager.update({
    tabId: 91,
    nonce: autoNonce,
    context: { mode: 'clip', clipId: 912 },
    patch: clipSnapshot(autoNonce, 912),
    route: 'https://www.netflix.com/watch/911',
  });
  assert.deepEqual(
    await autoHarness.manager.prepareNavigation({
      tabId: 91,
      nonce: autoNonce,
      nextUrl: 'https://www.netflix.com/watch/912?t=4',
    }),
    { ok: true }
  );
  assert.deepEqual(
    await autoHarness.manager.handleTabNavigation({
      tabId: 91,
      url: 'https://www.netflix.com/watch/912?t=4',
    }),
    { ok: true, released: false }
  );
  assert.equal((await autoHarness.manager.claim({
    tabId: 91,
    nonce: autoNonce,
    route: 'https://www.netflix.com/watch/912?t=4',
  })).ok, true);
});

test('claim rejects a stale owner when the document route no longer matches its clip', async () => {
  const harness = createHarness();
  const nonce = 'nonce-claim-route';
  await harness.manager.beginHandoff({
    nonce,
    sourceTabId: 92,
    context: { mode: 'clip', clipId: 921 },
    snapshot: clipSnapshot(nonce, 921),
  });
  assert.equal((await harness.manager.claim({
    tabId: 92,
    nonce,
    route: 'https://www.netflix.com/watch/921',
  })).ok, true);

  assert.deepEqual(
    await harness.manager.claim({
      tabId: 92,
      nonce,
      route: 'https://www.netflix.com/watch/999',
    }),
    { ok: false, reason: 'route_mismatch' }
  );
  assert.equal(harness.localStorage.data.playbackOwnerNonce, null);
});

test('rapid handoffs retain nonce-bound snapshots and can be claimed independently', async () => {
  const harness = createHarness();
  const firstSnapshot = clipSnapshot('nonce-fast-1', 101);
  const secondSnapshot = clipSnapshot('nonce-fast-2', 202);
  await harness.manager.beginHandoff({
    nonce: 'nonce-fast-1',
    sourceTabId: 7,
    context: { mode: 'clip', clipId: 101 },
    snapshot: firstSnapshot,
  });
  await harness.manager.beginHandoff({
    nonce: 'nonce-fast-2',
    sourceTabId: 7,
    context: { mode: 'clip', clipId: 202 },
    snapshot: secondSnapshot,
  });

  const firstClaim = await harness.manager.claim({
      tabId: 8,
      openerTabId: 7,
      nonce: 'nonce-fast-1',
    });
  assert.equal(firstClaim.ok, true);
  assert.equal(firstClaim.snapshot.clip.id, 101);
  const secondClaim = await harness.manager.claim({
      tabId: 9,
      openerTabId: 7,
      nonce: 'nonce-fast-2',
    });
  assert.equal(secondClaim.ok, true);
  assert.equal(secondClaim.snapshot.clip.id, 202);
});

test('expired pending handoffs are cleaned and reset stale global playback', async () => {
  const harness = createHarness();
  await harness.manager.beginHandoff({
    nonce: 'nonce-expired',
    sourceTabId: 4,
    context: { mode: 'clip', clipId: 44 },
    snapshot: clipSnapshot('nonce-expired', 44),
  });
  harness.advance(PLAYBACK_HANDOFF_TTL_MS + 1);

  assert.deepEqual(await harness.manager.cleanupExpired(), {
    ok: true,
    cleared: true,
  });
  const registry = harness.sessionStorage.data[PLAYBACK_REGISTRY_STORAGE_KEY];
  assert.deepEqual(registry.active, {});
  assert.deepEqual(registry.pending, {});
  assert.equal(harness.localStorage.data.playmode, null);
});

test('expiring the global pending owner restores the latest active snapshot', async () => {
  const harness = createHarness();
  await beginAndClaim(harness, {
    nonce: 'nonce-still-active',
    sourceTabId: 40,
    clipId: 401,
  });
  await harness.manager.beginHandoff({
    nonce: 'nonce-will-expire',
    sourceTabId: 41,
    context: { mode: 'clip', clipId: 402 },
    snapshot: clipSnapshot('nonce-will-expire', 402),
  });
  harness.advance(PLAYBACK_HANDOFF_TTL_MS + 1);

  assert.deepEqual(await harness.manager.cleanupExpired(), {
    ok: true,
    cleared: false,
  });
  assert.equal(harness.localStorage.data.playbackOwnerNonce, 'nonce-still-active');
  assert.equal(harness.localStorage.data.clip.id, 401);
});

test('release ignores a missing or mismatched nonce', async () => {
  const harness = createHarness();
  await beginAndClaim(harness, {
    nonce: 'nonce-protected',
    sourceTabId: 50,
    clipId: 501,
  });

  assert.deepEqual(await harness.manager.release({ tabId: 50 }), {
    ok: true,
    cleared: false,
  });
  assert.deepEqual(
    await harness.manager.release({ tabId: 50, nonce: 'nonce-other' }),
    { ok: true, cleared: false }
  );
  const registry = harness.sessionStorage.data[PLAYBACK_REGISTRY_STORAGE_KEY];
  assert.equal(registry.active['50'].nonce, 'nonce-protected');
  assert.equal(harness.localStorage.data.playbackOwnerNonce, 'nonce-protected');
});

test('removing a source tab releases active ownership but preserves a pending child handoff', async () => {
  const harness = createHarness();
  await beginAndClaim(harness, {
    nonce: 'nonce-remove-active',
    sourceTabId: 5,
    clipId: 55,
  });
  await harness.manager.beginHandoff({
    nonce: 'nonce-remove-pending',
    sourceTabId: 5,
    context: { mode: 'clip', clipId: 56 },
    snapshot: clipSnapshot('nonce-remove-pending', 56),
  });
  assert.deepEqual(
    await harness.manager.bindTarget({ tabId: 6, openerTabId: 5 }),
    { ok: true }
  );

  assert.deepEqual(await harness.manager.removeTab(5), {
    ok: true,
    cleared: false,
  });
  const registry = harness.sessionStorage.data[PLAYBACK_REGISTRY_STORAGE_KEY];
  assert.deepEqual(registry.active, {});
  assert.equal(registry.pending['nonce-remove-pending'].sourceTabId, 5);
  assert.equal(harness.localStorage.data.playbackOwnerNonce, 'nonce-remove-pending');

  const childClaim = await harness.manager.claim({
    tabId: 6,
    nonce: 'nonce-remove-pending',
  });
  assert.equal(childClaim.ok, true);
  assert.equal(childClaim.snapshot.clip.id, 56);
});
