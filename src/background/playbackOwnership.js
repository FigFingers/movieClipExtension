import {
  normalizePlaybackContext,
  normalizePlaybackRoute as normalizeRoute,
  normalizePlaybackSnapshot,
  PLAYBACK_OWNER_QUERY_PARAM,
  PLAYBACK_OWNER_STORAGE_KEY,
} from '../shared/playbackBridgeValidation.js';

export { PLAYBACK_OWNER_STORAGE_KEY };
export const PLAYBACK_REGISTRY_STORAGE_KEY = 'activePlaybackTabsV1';
export const PLAYBACK_HANDOFF_TTL_MS = 30_000;

const GLOBAL_PLAYBACK_RESET = Object.freeze({
  clip: null,
  playQueue: null,
  nextClip: null,
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
  return typeof value === 'string' &&
    /^[a-z\d-]{8,200}$/i.test(value);
}

function getOwnEntry(record, key) {
  return key !== undefined &&
    key !== null &&
    Object.hasOwn(record, key)
    ? record[key]
    : undefined;
}

function getOwnerNonceFromUrl(value) {
  try {
    return new URL(value).searchParams.get(PLAYBACK_OWNER_QUERY_PARAM);
  } catch {
    return null;
  }
}

function normalizeContext(value) {
  const normalized = normalizePlaybackContext(value);
  return normalized.ok ? normalized.value : null;
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
  return normalizeRoute(rawUrl) === normalizedRoute;
}

function normalizeSnapshot(snapshot, nonce, context) {
  if (snapshot?.[PLAYBACK_OWNER_STORAGE_KEY] !== nonce) return null;
  const normalized = normalizePlaybackSnapshot({
    snapshot,
    context,
    ownerNonce: nonce,
  });
  return normalized.ok ? normalized.value : null;
}

export function createPlaybackOwnershipManager({
  sessionStorage,
  localStorage,
  now = () => Date.now(),
}) {
  let operation = Promise.resolve();
  const NO_LOCAL_UPDATE = Symbol('no-local-update');

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
      Object.entries(pending)
        .filter(([, handoff]) =>
          Number(handoff?.expiresAt ?? handoff) > currentTime
        )
        .map(([nonce, handoff]) => [
          nonce,
          handoff && typeof handoff === 'object' ? { ...handoff } : handoff,
        ])
    );
    const registry = {
      active: Object.fromEntries(
        Object.entries(active).map(([tabId, entry]) => [
          tabId,
          entry && typeof entry === 'object' ? { ...entry } : entry,
        ])
      ),
      pending: retainedPending,
      revision: Number.isSafeInteger(raw?.revision) && raw.revision >= 0
        ? raw.revision
        : 0,
    };
    return registry;
  }

  async function writeRegistry(registry) {
    await sessionStorage.set({ [PLAYBACK_REGISTRY_STORAGE_KEY]: registry });
  }

  function isRegistryIdle(registry) {
    return Object.keys(registry.active).length === 0 &&
      Object.keys(registry.pending).length === 0;
  }

  async function captureStorageValues(area, keys) {
    const stored = await area.get(keys);
    return Object.fromEntries(
      keys
        .filter(
          (key) => Object.hasOwn(stored || {}, key) && stored[key] !== undefined
        )
        .map((key) => [key, stored[key]])
    );
  }

  async function restoreStorageValues(area, keys, previous) {
    const values = Object.fromEntries(
      keys
        .filter((key) => Object.hasOwn(previous, key))
        .map((key) => [key, previous[key]])
    );
    const missing = keys.filter((key) => !Object.hasOwn(previous, key));
    if (Object.keys(values).length > 0) await area.set(values);
    if (missing.length > 0) {
      if (typeof area.remove !== 'function') {
        throw new Error('Storage rollback is unavailable');
      }
      await area.remove(missing);
    }
  }

  async function commitOwnershipState(registry, localUpdate = NO_LOCAL_UPDATE) {
    if (localUpdate === NO_LOCAL_UPDATE) {
      const registryKeys = [PLAYBACK_REGISTRY_STORAGE_KEY];
      const previousRegistry = await captureStorageValues(
        sessionStorage,
        registryKeys
      );
      try {
        await writeRegistry(registry);
      } catch (error) {
        await Promise.allSettled([
          restoreStorageValues(sessionStorage, registryKeys, previousRegistry),
        ]);
        throw error;
      }
      return;
    }

    const registryKeys = [PLAYBACK_REGISTRY_STORAGE_KEY];
    const localKeys = Object.keys(localUpdate);
    const [previousRegistry, previousLocal] = await Promise.all([
      captureStorageValues(sessionStorage, registryKeys),
      captureStorageValues(localStorage, localKeys),
    ]);

    try {
      await writeRegistry(registry);
      await localStorage.set(localUpdate);
    } catch (error) {
      await Promise.allSettled([
        restoreStorageValues(sessionStorage, registryKeys, previousRegistry),
        restoreStorageValues(localStorage, localKeys, previousLocal),
      ]);
      throw error;
    }
  }

  async function getReconciledLocalUpdate(registry) {
    if (isRegistryIdle(registry)) return GLOBAL_PLAYBACK_RESET;
    const globalState = await localStorage.get(PLAYBACK_OWNER_STORAGE_KEY);
    const globalOwner = globalState?.[PLAYBACK_OWNER_STORAGE_KEY];
    const ownerStillExists = Object.values(registry.active)
      .some((entry) => entry?.nonce === globalOwner) ||
      Boolean(getOwnEntry(registry.pending, globalOwner));
    if (ownerStillExists) return NO_LOCAL_UPDATE;
    return latestOwnedSnapshot(registry)?.snapshot || GLOBAL_PLAYBACK_RESET;
  }

  async function persistReconciledRegistry(registry) {
    const localUpdate = await getReconciledLocalUpdate(registry);
    await commitOwnershipState(registry, localUpdate);
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
      await commitOwnershipState(registry, normalizedSnapshot);
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
      if (nonce !== undefined && nonce !== null && !isNonce(nonce)) {
        return { ok: false, reason: 'invalid_claim' };
      }

      const registry = await readRegistry();
      const tabKey = String(tabId);
      const canRetryLegacyHandoff = () =>
        Number.isInteger(openerTabId) ||
        Object.values(registry.pending).some(
          (entry) => Number(entry?.sourceTabId) === tabId
        );
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
            await persistReconciledRegistry(registry);
            return { ok: false, reason: 'ambiguous_handoff' };
          }
          resolvedNonce = eligiblePending[0]?.[0];
        }
      }
      if (!isNonce(resolvedNonce)) {
        await persistReconciledRegistry(registry);
        return {
          ok: false,
          reason: 'handoff_not_found',
          retryable: canRetryLegacyHandoff(),
        };
      }
      const existing = registry.active[tabKey];
      const handoff = getOwnEntry(registry.pending, resolvedNonce);
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
        await persistReconciledRegistry(registry);
        return {
          ok: false,
          reason: 'handoff_not_found',
          retryable: canRetryLegacyHandoff(),
        };
      }

      const source = existing?.nonce === resolvedNonce ? existing : handoff;
      const normalizedContext = normalizeContext(source?.context);
      const normalizedSnapshot = normalizedContext
        ? normalizeSnapshot(source?.snapshot, resolvedNonce, normalizedContext)
        : null;
      if (!normalizedContext || !normalizedSnapshot) {
        await persistReconciledRegistry(registry);
        return { ok: false, reason: 'snapshot_mismatch' };
      }

      const claimRoute = normalizeRoute(route);
      const autoNavigation = Boolean(
        existing?.nonce === resolvedNonce &&
        claimRoute &&
        (existing.expectedRoute === claimRoute || existing.autoNavigationRoute === claimRoute)
      );
      if (claimRoute && !snapshotMatchesRoute(normalizedSnapshot, normalizedContext, claimRoute)) {
        if (existing?.nonce === resolvedNonce) {
          delete registry.active[tabKey];
        }
        await persistReconciledRegistry(registry);
        return {
          ok: false,
          reason: 'route_mismatch',
          retryable: canRetryLegacyHandoff(),
        };
      }
      if (
        existing?.nonce === resolvedNonce &&
        claimRoute &&
        existing.route &&
        claimRoute !== existing.route &&
        claimRoute !== existing.expectedRoute
      ) {
        delete registry.active[tabKey];
        await persistReconciledRegistry(registry);
        return {
          ok: false,
          reason: 'route_mismatch',
          retryable: canRetryLegacyHandoff(),
        };
      }

      registry.active[tabKey] = {
        nonce: resolvedNonce,
        context: normalizedContext,
        snapshot: normalizedSnapshot,
        route: claimRoute || existing?.route || null,
        expectedRoute: null,
        autoNavigationRoute: null,
        revision: takeRevision(registry),
        updatedAt: now(),
      };
      delete registry.pending[resolvedNonce];
      await commitOwnershipState(registry, normalizedSnapshot);
      return {
        ok: true,
        nonce: resolvedNonce,
        context: normalizedContext,
        snapshot: normalizedSnapshot,
        autoNavigation,
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
        await persistReconciledRegistry(registry);
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

      registry.active[tabKey] = {
        nonce,
        context: normalizedContext,
        snapshot: normalizedSnapshot,
        route: normalizeRoute(route) || existing.route || null,
        expectedRoute: existing.expectedRoute || null,
        autoNavigationRoute: existing.autoNavigationRoute || null,
        revision: takeRevision(registry),
        updatedAt: now(),
      };
      await commitOwnershipState(registry, normalizedSnapshot);
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
        await persistReconciledRegistry(registry);
        return { ok: false, reason: 'not_owner' };
      }
      if (!snapshotMatchesRoute(
        existing.snapshot,
        existing.context,
        nextRoute
      )) {
        await persistReconciledRegistry(registry);
        return { ok: false, reason: 'route_mismatch' };
      }
      existing.expectedRoute = nextRoute;
      existing.autoNavigationRoute = null;
      await persistReconciledRegistry(registry);
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
        await persistReconciledRegistry(registry);
        return {
          ok: false,
          reason: eligible.length > 1 ? 'ambiguous_handoff' : 'handoff_not_found',
        };
      }
      eligible[0].targetTabId = tabId;
      await persistReconciledRegistry(registry);
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
        const pending = isNonce(pendingNonce)
          ? getOwnEntry(registry.pending, pendingNonce)
          : null;
        if (pending) {
          if (pending.targetTabId !== tabId) {
            pending.targetTabId = tabId;
          }
        }
        await persistReconciledRegistry(registry);
        return { ok: true, released: false };
      }
      const nextRoute = normalizeRoute(url);
      if (nextRoute && nextRoute === existing.route) {
        await persistReconciledRegistry(registry);
        return { ok: true, released: false };
      }
      if (nextRoute && nextRoute === existing.expectedRoute) {
        existing.route = nextRoute;
        existing.expectedRoute = null;
        existing.autoNavigationRoute = nextRoute;
        await persistReconciledRegistry(registry);
        return { ok: true, released: false };
      }

      delete registry.active[tabKey];
      await persistReconciledRegistry(registry);
      const cleared = isRegistryIdle(registry);
      return { ok: true, released: true, cleared };
    });
  }

  function release({ tabId, nonce }) {
    return exclusive(async () => {
      if (!Number.isInteger(tabId)) return { ok: false, reason: 'invalid_tab' };
      const registry = await readRegistry();
      const tabKey = String(tabId);
      const existing = registry.active[tabKey];
      if (existing && isNonce(nonce) && existing.nonce === nonce) {
        delete registry.active[tabKey];
      }
      await persistReconciledRegistry(registry);
      const cleared = isRegistryIdle(registry);
      return { ok: true, cleared };
    });
  }

  function removeTab(tabId) {
    return exclusive(async () => {
      if (!Number.isInteger(tabId)) return { ok: false, reason: 'invalid_tab' };
      const registry = await readRegistry();
      delete registry.active[String(tabId)];
      await persistReconciledRegistry(registry);
      const cleared = isRegistryIdle(registry);
      return { ok: true, cleared };
    });
  }

  function cleanupExpired() {
    return exclusive(async () => {
      const registry = await readRegistry();
      await persistReconciledRegistry(registry);
      const cleared = isRegistryIdle(registry);
      return { ok: true, cleared };
    });
  }

  function reset() {
    return exclusive(async () => {
      const registry = { active: {}, pending: {}, revision: 0 };
      await commitOwnershipState(registry, GLOBAL_PLAYBACK_RESET);
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
