export const PLAYBACK_OWNER_STORAGE_KEY = 'playbackOwnerNonce';
export const PLAYBACK_OWNER_QUERY_PARAM = 'dextPlaybackOwner';
export const PLAYBACK_OWNER_TAB_KEY = 'dextPlaybackOwnerTab';
function sendMessage(message) {
  return new Promise((resolve) => {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) {
      resolve({ ok: false, reason: 'background_unavailable' });
      return;
    }
    try {
      runtime.sendMessage(message, (response) => {
        if (runtime.lastError) {
          resolve({ ok: false, reason: 'background_unavailable' });
          return;
        }
        resolve(response || { ok: false, reason: 'request_failed' });
      });
    } catch {
      resolve({ ok: false, reason: 'background_unavailable' });
    }
  });
}

export function createPlaybackOwnerNonce() {
  return globalThis.crypto?.randomUUID?.() ||
    `playback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getPlaybackOwnerNonceFromUrl(url = globalThis.location?.href) {
  try {
    return new URL(url).searchParams.get(PLAYBACK_OWNER_QUERY_PARAM);
  } catch {
    return null;
  }
}

export function getTabPlaybackOwnerNonce() {
  const fromUrl = getPlaybackOwnerNonceFromUrl();
  if (fromUrl) return fromUrl;
  try {
    return globalThis.sessionStorage?.getItem(PLAYBACK_OWNER_TAB_KEY) || null;
  } catch {
    return null;
  }
}

function rememberTabOwner(nonce) {
  try {
    globalThis.sessionStorage?.setItem(PLAYBACK_OWNER_TAB_KEY, nonce);
  } catch {
    // The background tab binding remains authoritative if sessionStorage is blocked.
  }
}

function forgetTabOwner(nonce) {
  try {
    if (globalThis.sessionStorage?.getItem(PLAYBACK_OWNER_TAB_KEY) === nonce) {
      globalThis.sessionStorage.removeItem(PLAYBACK_OWNER_TAB_KEY);
    }
  } catch {
    // Nothing else to tear down locally.
  }
}

export function addPlaybackOwnerToUrl(url, nonce) {
  const target = new URL(url);
  target.searchParams.set(PLAYBACK_OWNER_QUERY_PARAM, nonce);
  return target.toString();
}

export function beginPlaybackHandoff({ nonce, mode, clipId, snapshot }) {
  return sendMessage({
    type: 'BEGIN_PLAYBACK_HANDOFF',
    nonce,
    context: { mode, clipId },
    snapshot: {
      ...snapshot,
      [PLAYBACK_OWNER_STORAGE_KEY]: nonce,
    },
  });
}

export async function claimPlaybackOwnership({ nonce }) {
  const mayNeedLegacyHandoff = !getPlaybackOwnerNonceFromUrl();
  let requestedNonce = nonce;
  for (let attempt = 0; attempt < (mayNeedLegacyHandoff ? 20 : 1); attempt += 1) {
    const result = await sendMessage({
      type: 'CLAIM_PLAYBACK_OWNERSHIP',
      nonce: requestedNonce,
      route: globalThis.location?.href,
    });
    if (result?.ok) {
      rememberTabOwner(result.nonce || requestedNonce);
      return result;
    }
    if (
      !getPlaybackOwnerNonceFromUrl() &&
      requestedNonce &&
      (result?.reason === 'handoff_not_found' || result?.reason === 'route_mismatch')
    ) {
      forgetTabOwner(requestedNonce);
    }
    if (
      (result?.reason !== 'handoff_not_found' && result?.reason !== 'route_mismatch') ||
      !mayNeedLegacyHandoff
    ) {
      return result;
    }
    requestedNonce = null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { ok: false, reason: 'handoff_not_found' };
}

export async function updatePlaybackOwnership({ nonce, mode, clipId, patch }) {
  const result = await sendMessage({
    type: 'UPDATE_PLAYBACK_OWNERSHIP',
    nonce,
    context: { mode, clipId },
    patch,
    route: globalThis.location?.href,
  });
  if (result?.ok) rememberTabOwner(nonce);
  return result;
}

export function preparePlaybackNavigation(nonce, nextUrl) {
  return sendMessage({
    type: 'PREPARE_PLAYBACK_NAVIGATION',
    nonce,
    nextUrl,
  });
}

export function releasePlaybackOwnership(nonce) {
  if (!nonce) return;
  forgetTabOwner(nonce);
  try {
    const runtime = globalThis.chrome?.runtime;
    runtime?.sendMessage?.(
      { type: 'RELEASE_PLAYBACK_OWNERSHIP', nonce },
      () => void runtime.lastError
    );
  } catch {
    // tabs.onRemoved is the reliable fallback when an unloading page cannot message.
  }
}
