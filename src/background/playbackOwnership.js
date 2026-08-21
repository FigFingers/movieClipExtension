export const PLAYBACK_OWNER_STORAGE_KEY = 'playbackOwnerNonce';
export const PLAYBACK_REGISTRY_STORAGE_KEY = 'activePlaybackTabsV1';
export const PLAYBACK_HANDOFF_TTL_MS = 30_000;
const PLAYBACK_OWNER_QUERY_PARAM = 'dextPlaybackOwner';

const GLOBAL_PLAYBACK_RESET = Object.freeze({
  playClipSystemKey: 0,
  playlistSystemKey: 0,
  currentClipOrder: 0,
  currentClipId: null,
  playmode: null,
  [PLAYBACK_OWNER_STORAGE_KEY]: null,
});

const SNAPSHOT_KEYS = [
  'clip',
  'playQueue',
  'currentClipOrder',
  'currentClipId',
  'nextClip',
  'playClipSystemKey',
  'playlistSystemKey',
  'playmode',
  PLAYBACK_OWNER_STORAGE_KEY,
];

function isNonce(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 200;
}

function normalizeRoute(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function getOwnerNonceFromUrl(value) {
  try {
    return new URL(value).searchParams.get(PLAYBACK_OWNER_QUERY_PARAM);
  } catch {
    return null;
  }
}

function normalizeContext(value) {
  const clipId = Number(value?.clipId);
  if (
    (value?.mode !== 'clip' && value?.mode !== 'playlist') ||
    !Number.isSafeInteger(clipId) ||
    clipId <= 0
  ) {
    return null;
  }
  return { mode: value.mode, clipId };
}

function resolveSnapshotContext(snapshot) {
  const mode = snapshot?.playmode === 'playlist' || snapshot?.playmode === 'clip'
    ? snapshot.playmode
    : snapshot?.playClipSystemKey === 1
      ? 'clip'
      : snapshot?.playlistSystemKey === 1
        ? 'playlist'
        : null;
  if (!mode) return null;

  let clipId;
  if (mode === 'clip') {
    clipId = snapshot.clip?.clipId ?? snapshot.clip?.id;
  } else {
    const order = Number(snapshot.currentClipOrder);
    const clip = Array.isArray(snapshot.playQueue)
      ? snapshot.playQueue.find((item) => Number(item?.order) === order)
      : null;
    clipId = clip?.clipId ?? clip?.id;
  }
  return normalizeContext({ mode, clipId });
}

function resolveSnapshotClip(snapshot, context) {
  if (context.mode === 'clip') return snapshot?.clip || null;
  const order = Number(snapshot?.currentClipOrder);
  return Array.isArray(snapshot?.playQueue)
    ? snapshot.playQueue.find((item) => Number(item?.order) === order) || null
    : null;
}

function snapshotMatchesRoute(snapshot, context, route) {
  const normalizedRoute = normalizeRoute(route);
  if (!normalizedRoute) return false;
  const rawUrl = resolveSnapshotClip(snapshot, context)?.url;
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
  try {
    const absolute = /^https?:\/\//i.test(rawUrl)
      ? rawUrl
      : /^(?:www\.)?(?:netflix|disneyplus)\.com\//i.test(rawUrl)
        ? `https://${rawUrl}`
        : new URL(rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`, normalizedRoute).toString();
    return normalizeRoute(absolute) === normalizedRoute;
  } catch {
    return false;
  }
}

function normalizeSnapshot(snapshot, nonce, context) {
  if (snapshot?.[PLAYBACK_OWNER_STORAGE_KEY] !== nonce) return null;
  const snapshotContext = resolveSnapshotContext(snapshot);
  if (
    snapshotContext?.mode !== context.mode ||
    snapshotContext.clipId !== context.clipId
  ) {
    return null;
  }
  return Object.fromEntries(
    SNAPSHOT_KEYS
      .filter((key) => snapshot[key] !== undefined)
      .map((key) => [key, snapshot[key]])
  );
}

export function createPlaybackOwnershipManager({
  sessionStorage,
  localStorage,
  now = () => Date.now(),
}) {
  let operation = Promise.resolve();

  const exclusive = (task) => {
    const next = operation.then(task, task);
    operation = next.catch(() => {});
    return next;
  };

  async function readRegistry() {
    const stored = await sessionStorage.get(PLAYBACK_REGISTRY_STORAGE_KEY);
    const raw = stored?.[PLAYBACK_REGISTRY_STORAGE_KEY];
    const active = raw?.active && typeof raw.active === 'object' ? raw.active : {};
    const pending = raw?.pending && typeof raw.pending === 'object' ? raw.pending : {};
    const currentTime = now();
    const retainedPending = Object.fromEntries(
      Object.entries(pending).filter(([, handoff]) =>
        Number(handoff?.expiresAt ?? handoff) > currentTime
      )
    );
    const registry = {
      active: { ...active },
      pending: retainedPending,
      revision: Number.isSafeInteger(raw?.revision) && raw.revision >= 0
        ? raw.revision
        : 0,
    };
    if (Object.keys(retainedPending).length !== Object.keys(pending).length) {
      await writeRegistry(registry);
      await reconcileGlobalOwner(registry);
      await clearGlobalIfIdle(registry);
    }
    return registry;
  }

  async function writeRegistry(registry) {
    await sessionStorage.set({ [PLAYBACK_REGISTRY_STORAGE_KEY]: registry });
  }

  async function clearGlobalIfIdle(registry) {
    if (
      Object.keys(registry.active).length === 0 &&
      Object.keys(registry.pending).length === 0
    ) {
      await localStorage.set(GLOBAL_PLAYBACK_RESET);
      return true;
    }
    return false;
  }

  async function restoreLatestOwnedSnapshot(registry, removedNonce) {
    const globalState = await localStorage.get(PLAYBACK_OWNER_STORAGE_KEY);
    if (globalState?.[PLAYBACK_OWNER_STORAGE_KEY] !== removedNonce) return false;
    const latest = latestOwnedSnapshot(registry);
    if (!latest?.snapshot) return false;
    await localStorage.set(latest.snapshot);
    return true;
  }

  async function reconcileGlobalOwner(registry) {
    const globalState = await localStorage.get(PLAYBACK_OWNER_STORAGE_KEY);
    const globalOwner = globalState?.[PLAYBACK_OWNER_STORAGE_KEY];
    if (
      Object.values(registry.active).some((entry) => entry?.nonce === globalOwner) ||
      registry.pending[globalOwner]
    ) {
      return false;
    }
    const latest = latestOwnedSnapshot(registry);
    if (!latest?.snapshot) return false;
    await localStorage.set(latest.snapshot);
    return true;
  }

  function compareActiveRecency(a, b) {
    const revisionDelta = Number(b?.revision || 0) - Number(a?.revision || 0);
    if (revisionDelta !== 0) return revisionDelta;
    const timeDelta = Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0);
    if (timeDelta !== 0) return timeDelta;
    return String(b?.nonce || '').localeCompare(String(a?.nonce || ''));
  }

  function latestOwnedSnapshot(registry) {
    return [
      ...Object.values(registry.active),
      ...Object.entries(registry.pending).map(([nonce, entry]) => ({
        nonce,
        ...entry,
      })),
    ]
      .filter((entry) => entry?.snapshot)
      .sort(compareActiveRecency)[0];
  }

  function takeRevision(registry) {
    registry.revision = Number(registry.revision || 0) + 1;
    return registry.revision;
  }

  function beginHandoff({ nonce, sourceTabId, context, snapshot }) {
    return exclusive(async () => {
      const normalizedContext = normalizeContext(context);
      const normalizedSnapshot = normalizedContext
        ? normalizeSnapshot(snapshot, nonce, normalizedContext)
        : null;
      if (
        !isNonce(nonce) ||
        !Number.isInteger(sourceTabId) ||
        !normalizedContext ||
        !normalizedSnapshot
      ) {
        return { ok: false, reason: 'invalid_handoff' };
      }
      const registry = await readRegistry();
      registry.pending[nonce] = {
        expiresAt: now() + PLAYBACK_HANDOFF_TTL_MS,
        sourceTabId,
        context: normalizedContext,
        snapshot: normalizedSnapshot,
        revision: takeRevision(registry),
        updatedAt: now(),
      };
      await localStorage.set(normalizedSnapshot);
      await writeRegistry(registry);
      return {
        ok: true,
        context: normalizedContext,
        snapshot: normalizedSnapshot,
      };
    });
  }

  function claim({ tabId, openerTabId, nonce, route }) {
    return exclusive(async () => {
      if (!Number.isInteger(tabId)) {
        return { ok: false, reason: 'invalid_claim' };
      }

      const registry = await readRegistry();
      const tabKey = String(tabId);
      let resolvedNonce = nonce;
      if (!isNonce(resolvedNonce)) {
        resolvedNonce = registry.active[tabKey]?.nonce;
        if (!isNonce(resolvedNonce)) {
          const eligiblePending = Object.entries(registry.pending).filter(
            ([, handoff]) => {
              const sourceTabId = Number(handoff?.sourceTabId);
              return sourceTabId === tabId || sourceTabId === openerTabId;
            }
          );
          if (eligiblePending.length > 1) {
            await writeRegistry(registry);
            return { ok: false, reason: 'ambiguous_handoff' };
          }
          resolvedNonce = eligiblePending[0]?.[0];
        }
      }
      if (!isNonce(resolvedNonce)) {
        await writeRegistry(registry);
        await clearGlobalIfIdle(registry);
        return { ok: false, reason: 'handoff_not_found' };
      }
      const existing = registry.active[tabKey];
      const handoff = registry.pending[resolvedNonce];
      const sourceTabId = Number(handoff?.sourceTabId);
      const mayClaim =
        existing?.nonce === resolvedNonce ||
        (Boolean(handoff) &&
          (
            sourceTabId === tabId ||
            sourceTabId === openerTabId ||
            Number(handoff?.targetTabId) === tabId
          ));
      if (!mayClaim) {
        await writeRegistry(registry);
        await clearGlobalIfIdle(registry);
        return { ok: false, reason: 'handoff_not_found' };
      }

      const source = existing?.nonce === resolvedNonce ? existing : handoff;
      const normalizedContext = normalizeContext(source?.context);
      const normalizedSnapshot = normalizedContext
        ? normalizeSnapshot(source?.snapshot, resolvedNonce, normalizedContext)
        : null;
      if (!normalizedContext || !normalizedSnapshot) {
        await writeRegistry(registry);
        return { ok: false, reason: 'snapshot_mismatch' };
      }

      const claimRoute = normalizeRoute(route);
      if (claimRoute && !snapshotMatchesRoute(normalizedSnapshot, normalizedContext, claimRoute)) {
        if (existing?.nonce === resolvedNonce) {
          delete registry.active[tabKey];
          await writeRegistry(registry);
          await restoreLatestOwnedSnapshot(registry, existing.nonce);
          await clearGlobalIfIdle(registry);
        } else {
          await writeRegistry(registry);
        }
        return { ok: false, reason: 'route_mismatch' };
      }
      if (
        existing?.nonce === resolvedNonce &&
        claimRoute &&
        existing.route &&
        claimRoute !== existing.route &&
        claimRoute !== existing.expectedRoute
      ) {
        delete registry.active[tabKey];
        await writeRegistry(registry);
        await restoreLatestOwnedSnapshot(registry, existing.nonce);
        await clearGlobalIfIdle(registry);
        return { ok: false, reason: 'route_mismatch' };
      }

      await localStorage.set(normalizedSnapshot);
      registry.active[tabKey] = {
        nonce: resolvedNonce,
        context: normalizedContext,
        snapshot: normalizedSnapshot,
        route: claimRoute || existing?.route || null,
        expectedRoute: null,
        revision: takeRevision(registry),
        updatedAt: now(),
      };
      delete registry.pending[resolvedNonce];
      await writeRegistry(registry);
      return {
        ok: true,
        nonce: resolvedNonce,
        context: normalizedContext,
        snapshot: normalizedSnapshot,
      };
    });
  }

  function update({ tabId, nonce, context, patch, route }) {
    return exclusive(async () => {
      const normalizedContext = normalizeContext(context);
      if (
        !Number.isInteger(tabId) ||
        !isNonce(nonce) ||
        !normalizedContext ||
        !patch ||
        typeof patch !== 'object'
      ) {
        return { ok: false, reason: 'invalid_update' };
      }

      const registry = await readRegistry();
      const tabKey = String(tabId);
      const existing = registry.active[tabKey];
      if (existing?.nonce !== nonce) {
        await writeRegistry(registry);
        return { ok: false, reason: 'not_owner' };
      }

      const sanitizedPatch = Object.fromEntries(
        SNAPSHOT_KEYS
          .filter((key) => patch[key] !== undefined)
          .map((key) => [key, patch[key]])
      );
      const candidate = {
        ...existing.snapshot,
        ...sanitizedPatch,
        [PLAYBACK_OWNER_STORAGE_KEY]: nonce,
      };
      const normalizedSnapshot = normalizeSnapshot(
        candidate,
        nonce,
        normalizedContext
      );
      if (!normalizedSnapshot) {
        return { ok: false, reason: 'snapshot_mismatch' };
      }

      await localStorage.set(normalizedSnapshot);
      registry.active[tabKey] = {
        nonce,
        context: normalizedContext,
        snapshot: normalizedSnapshot,
        route: normalizeRoute(route) || existing.route || null,
        expectedRoute: existing.expectedRoute || null,
        revision: takeRevision(registry),
        updatedAt: now(),
      };
      await writeRegistry(registry);
      return {
        ok: true,
        context: normalizedContext,
        snapshot: normalizedSnapshot,
      };
    });
  }

  function prepareNavigation({ tabId, nonce, nextUrl }) {
    return exclusive(async () => {
      if (!Number.isInteger(tabId) || !isNonce(nonce)) {
        return { ok: false, reason: 'invalid_navigation' };
      }
      const nextRoute = normalizeRoute(nextUrl);
      if (!nextRoute) return { ok: false, reason: 'invalid_navigation' };
      const registry = await readRegistry();
      const existing = registry.active[String(tabId)];
      if (existing?.nonce !== nonce) {
        await writeRegistry(registry);
        return { ok: false, reason: 'not_owner' };
      }
      existing.expectedRoute = nextRoute;
      await writeRegistry(registry);
      return { ok: true };
    });
  }

  function bindTarget({ tabId, openerTabId }) {
    return exclusive(async () => {
      if (!Number.isInteger(tabId) || !Number.isInteger(openerTabId)) {
        return { ok: false, reason: 'invalid_tab' };
      }
      const registry = await readRegistry();
      const eligible = Object.values(registry.pending).filter(
        (handoff) =>
          Number(handoff?.sourceTabId) === openerTabId &&
          !Number.isInteger(handoff?.targetTabId)
      );
      if (eligible.length !== 1) {
        await writeRegistry(registry);
        return {
          ok: false,
          reason: eligible.length > 1 ? 'ambiguous_handoff' : 'handoff_not_found',
        };
      }
      eligible[0].targetTabId = tabId;
      await writeRegistry(registry);
      return { ok: true };
    });
  }

  function handleTabNavigation({ tabId, url }) {
    return exclusive(async () => {
      if (!Number.isInteger(tabId)) return { ok: false, reason: 'invalid_tab' };
      const registry = await readRegistry();
      const tabKey = String(tabId);
      const existing = registry.active[tabKey];
      if (!existing) {
        const pendingNonce = getOwnerNonceFromUrl(url);
        if (isNonce(pendingNonce) && registry.pending[pendingNonce]) {
          registry.pending[pendingNonce].targetTabId = tabId;
        }
        await writeRegistry(registry);
        return { ok: true, released: false };
      }
      const nextRoute = normalizeRoute(url);
      if (nextRoute && nextRoute === existing.route) {
        await writeRegistry(registry);
        return { ok: true, released: false };
      }
      if (nextRoute && nextRoute === existing.expectedRoute) {
        existing.route = nextRoute;
        existing.expectedRoute = null;
        await writeRegistry(registry);
        return { ok: true, released: false };
      }

      delete registry.active[tabKey];
      await writeRegistry(registry);
      await restoreLatestOwnedSnapshot(registry, existing.nonce);
      const cleared = await clearGlobalIfIdle(registry);
      return { ok: true, released: true, cleared };
    });
  }

  function release({ tabId, nonce }) {
    return exclusive(async () => {
      if (!Number.isInteger(tabId)) return { ok: false, reason: 'invalid_tab' };
      const registry = await readRegistry();
      const tabKey = String(tabId);
      const existing = registry.active[tabKey];
      let removed = null;
      if (existing && isNonce(nonce) && existing.nonce === nonce) {
        removed = existing;
        delete registry.active[tabKey];
      }
      await writeRegistry(registry);
      if (removed) {
        await restoreLatestOwnedSnapshot(registry, removed.nonce);
      }
      const cleared = await clearGlobalIfIdle(registry);
      return { ok: true, cleared };
    });
  }

  function removeTab(tabId) {
    return exclusive(async () => {
      if (!Number.isInteger(tabId)) return { ok: false, reason: 'invalid_tab' };
      const registry = await readRegistry();
      const existing = registry.active[String(tabId)];
      delete registry.active[String(tabId)];
      await writeRegistry(registry);
      if (existing) {
        await restoreLatestOwnedSnapshot(registry, existing.nonce);
      }
      const cleared = await clearGlobalIfIdle(registry);
      return { ok: true, cleared };
    });
  }

  function cleanupExpired() {
    return exclusive(async () => {
      const registry = await readRegistry();
      await writeRegistry(registry);
      await reconcileGlobalOwner(registry);
      const cleared = await clearGlobalIfIdle(registry);
      return { ok: true, cleared };
    });
  }

  function reset() {
    return exclusive(async () => {
      const registry = { active: {}, pending: {}, revision: 0 };
      await writeRegistry(registry);
      await localStorage.set(GLOBAL_PLAYBACK_RESET);
      return { ok: true };
    });
  }

  return {
    beginHandoff,
    claim,
    update,
    prepareNavigation,
    bindTarget,
    handleTabNavigation,
    release,
    removeTab,
    cleanupExpired,
    reset,
  };
}
