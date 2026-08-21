import {
  STORAGE_KEYS,
  clearExtensionAuthState,
  storageGet,
  storageRemove,
  storageSet,
} from './../shared/storage.js';
import { runExclusive } from './sync.js';

function normalizeExpiresAt(expiresAt) {
  const expiresAtMs = Date.parse(expiresAt || '');
  return Number.isFinite(expiresAtMs)
    ? new Date(expiresAtMs).toISOString()
    : null;
}

async function performSaveExtensionAuthToken({
  extensionInstanceId,
  extensionAuthToken,
  expiresAt,
}) {
  const stored = await storageGet([STORAGE_KEYS.extensionInstanceId]);
  const currentInstanceId = stored[STORAGE_KEYS.extensionInstanceId];
  if (!currentInstanceId || extensionInstanceId !== currentInstanceId) {
    console.warn('[extension-sync] ignored auth token for mismatched extensionInstanceId', {
      expected: currentInstanceId,
      received: extensionInstanceId,
    });
    return { ok: false, reason: 'instance_mismatch' };
  }

  if (
    typeof extensionAuthToken !== 'string'
    || extensionAuthToken.trim().length === 0
  ) {
    console.warn('[extension-sync] ignored empty auth token');
    return { ok: false, reason: 'invalid_token' };
  }

  await storageSet({
    [STORAGE_KEYS.extensionAuthToken]: extensionAuthToken,
    [STORAGE_KEYS.extensionTokenExpiresAt]: normalizeExpiresAt(expiresAt),
    [STORAGE_KEYS.extensionLinked]: true,
  });
  await storageRemove([STORAGE_KEYS.extensionTokenRefreshBackoff]);
  return { ok: true };
}

/**
 * Persist a token received by the site bridge under the same mutex used by
 * comments, sync, and token refresh. This makes a 401 clear and a re-link
 * operation ordered rather than relying on a non-atomic storage CAS.
 */
export function saveExtensionAuthTokenInBackground(input) {
  return runExclusive(() => performSaveExtensionAuthToken(input || {}));
}

async function performUnlinkExtension({ extensionInstanceId }) {
  const stored = await storageGet([STORAGE_KEYS.extensionInstanceId]);
  const currentInstanceId = stored[STORAGE_KEYS.extensionInstanceId];
  if (!currentInstanceId || extensionInstanceId !== currentInstanceId) {
    console.warn('[extension-sync] ignored unlink for mismatched extensionInstanceId', {
      expected: currentInstanceId,
      received: extensionInstanceId,
    });
    return { ok: false, reason: 'instance_mismatch' };
  }

  await clearExtensionAuthState();
  console.log('[extension-sync] cleared auth state after unlink');
  return { ok: true };
}

export function unlinkExtensionInBackground(input) {
  return runExclusive(() => performUnlinkExtension(input || {}));
}
