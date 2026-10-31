import { STORAGE_KEYS, storageGet, storageSet, clearExtensionAuthState } from '../shared/storage.js';
import { runAuthExclusive } from './exclusive.js';

let instanceIdPromise;
export function getOrCreateInstanceId() {
  if (!instanceIdPromise) {
    instanceIdPromise = (async () => {
      const stored = await storageGet([STORAGE_KEYS.extensionInstanceId]);
      if (stored[STORAGE_KEYS.extensionInstanceId]) return stored[STORAGE_KEYS.extensionInstanceId];
      const id = crypto.randomUUID();
      await storageSet({ [STORAGE_KEYS.extensionInstanceId]: id });
      return id;
    })().finally(() => { instanceIdPromise = null; });
  }
  return instanceIdPromise;
}

export function saveExtensionAuthToken({ extensionInstanceId, extensionAuthToken, expiresAt }) {
  return runAuthExclusive(async () => {
    if (extensionInstanceId !== await getOrCreateInstanceId() ||
        typeof extensionAuthToken !== 'string' || !extensionAuthToken.trim()) return { ok: false };
    const expires = Date.parse(expiresAt || '');
    await storageSet({
      [STORAGE_KEYS.extensionAuthToken]: extensionAuthToken,
      [STORAGE_KEYS.extensionTokenExpiresAt]: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
      [STORAGE_KEYS.extensionLinked]: true,
      [STORAGE_KEYS.extensionTokenRefreshBackoff]: null,
    });
    return { ok: true };
  });
}

export function unlinkExtension({ extensionInstanceId }) {
  return runAuthExclusive(async () => {
    const stored = await storageGet([STORAGE_KEYS.extensionInstanceId]);
    if (!extensionInstanceId || stored[STORAGE_KEYS.extensionInstanceId] !== extensionInstanceId) return { ok: false };
    await clearExtensionAuthState();
    return { ok: true };
  });
}
