import {
  PLAYBACK_OWNER_QUERY_PARAM,
  PLAYBACK_OWNER_STORAGE_KEY,
} from '../shared/playbackBridgeValidation.js';

export { PLAYBACK_OWNER_QUERY_PARAM, PLAYBACK_OWNER_STORAGE_KEY };
export const PLAYBACK_OWNER_TAB_KEY = 'dextPlaybackOwnerTab';

function readPlaybackOwnerQuery(url = globalThis.location?.href) {
  try {
    const searchParams = new URL(url).searchParams;
    return {
      present: searchParams.has(PLAYBACK_OWNER_QUERY_PARAM),
      value: searchParams.get(PLAYBACK_OWNER_QUERY_PARAM),
    };
  } catch {
    return { present: false, value: null };
  }
}

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
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    try {
      const nonce = cryptoApi.randomUUID();
      if (
        typeof nonce === 'string' &&
        nonce.length >= 8 &&
        nonce.length <= 200
      ) {
        return nonce;
      }
    } catch {
      // Fall through to getRandomValues when randomUUID is unavailable at runtime.
    }
  }

  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
    return [
      hex.slice(0, 4).join(''),
      hex.slice(4, 6).join(''),
      hex.slice(6, 8).join(''),
      hex.slice(8, 10).join(''),
      hex.slice(10).join(''),
    ].join('-');
  }

  throw new Error('Secure random number generator is unavailable');
}

export function getPlaybackOwnerNonceFromUrl(url = globalThis.location?.href) {
  return readPlaybackOwnerQuery(url).value;
}

export function getTabPlaybackOwnerNonce() {
  const fromUrl = readPlaybackOwnerQuery();
  if (fromUrl.present) return fromUrl.value;
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
  const ownerQuery = readPlaybackOwnerQuery();
  const mayNeedLegacyHandoff = !ownerQuery.present;
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
      !ownerQuery.present &&
      requestedNonce &&
      (result?.reason === 'handoff_not_found' || result?.reason === 'route_mismatch')
    ) {
      forgetTabOwner(requestedNonce);
    }
    if (
      (result?.reason !== 'handoff_not_found' && result?.reason !== 'route_mismatch') ||
      !mayNeedLegacyHandoff ||
      result?.retryable === false
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
