import {
  STORAGE_KEYS,
  clearExtensionAuthState,
  storageGet,
  storageRemove,
  storageSet,
} from './../shared/storage.js';
import {
  isValidExtensionAuthToken,
  isValidExtensionInstanceId,
  normalizeExtensionTokenExpiry,
} from './../shared/authValidation.js';
import { runExclusive } from './authMutex.js';

async function performSaveExtensionAuthToken({
  extensionInstanceId,
  extensionAuthToken,
  expiresAt,
}) {
  const stored = await storageGet([STORAGE_KEYS.extensionInstanceId]);
  const currentInstanceId = stored[STORAGE_KEYS.extensionInstanceId];
  if (
    !isValidExtensionInstanceId(currentInstanceId)
    || !isValidExtensionInstanceId(extensionInstanceId)
    || extensionInstanceId !== currentInstanceId
  ) {
    console.warn('[extension-sync] ignored auth token for mismatched extensionInstanceId');
    return { ok: false, reason: 'instance_mismatch' };
  }

  if (!isValidExtensionAuthToken(extensionAuthToken)) {
    console.warn('[extension-sync] ignored invalid auth token');
    return { ok: false, reason: 'invalid_token' };
  }

  await storageSet({
    [STORAGE_KEYS.extensionAuthToken]: extensionAuthToken,
    [STORAGE_KEYS.extensionTokenExpiresAt]: normalizeExtensionTokenExpiry(expiresAt),
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
  if (
    !isValidExtensionInstanceId(currentInstanceId)
    || !isValidExtensionInstanceId(extensionInstanceId)
    || extensionInstanceId !== currentInstanceId
  ) {
    console.warn('[extension-sync] ignored unlink for mismatched extensionInstanceId');
    return { ok: false, reason: 'instance_mismatch' };
  }

  await clearExtensionAuthState();
  console.log('[extension-sync] cleared auth state after unlink');
  return { ok: true };
}

export function unlinkExtensionInBackground(input) {
  return runExclusive(() => performUnlinkExtension(input || {}));
}
