import {
  STORAGE_KEYS,
  clearExtensionAuthState,
  storageGet,
  storageSet,
} from './../shared/storage.js';
import { isValidExtensionInstanceId } from './../shared/authValidation.js';
import { runExclusive } from './authMutex.js';

async function readOrCreateInstanceId() {
  const stored = await storageGet([STORAGE_KEYS.extensionInstanceId]);
  const existingId = stored[STORAGE_KEYS.extensionInstanceId];
  if (isValidExtensionInstanceId(existingId)) {
    return existingId;
  }

  // An auth token is bound to its instance ID. If the ID is missing or
  // malformed, keeping the old token would expose a false linked state and
  // make every API request fail until a later 401 happens to clean it up.
  await clearExtensionAuthState();

  const extensionInstanceId = crypto.randomUUID();
  await storageSet({ [STORAGE_KEYS.extensionInstanceId]: extensionInstanceId });
  return extensionInstanceId;
}

async function readValidInstanceIdOrRepair() {
  const stored = await storageGet([STORAGE_KEYS.extensionInstanceId]);
  const existingId = stored[STORAGE_KEYS.extensionInstanceId];
  if (isValidExtensionInstanceId(existingId)) {
    return existingId;
  }

  // Re-read under the mutex before mutating. Valid-ID lookups stay responsive
  // while a comments/sync request is in flight, but repair remains ordered with
  // every auth writer.
  return runExclusive(readOrCreateInstanceId);
}

let instanceIdPromise = null;

// Callers already running under the auth mutex use this entry point to avoid
// reacquiring the non-reentrant lock.
export function getOrCreateInstanceIdWhileExclusive() {
  return readOrCreateInstanceId();
}

/**
 * Share only the currently running read/create operation. Re-reading storage
 * after it settles lets the extension recover if local storage is cleared or
 * corrupted while the service worker remains alive.
 */
export function getOrCreateInstanceId() {
  if (!instanceIdPromise) {
    const pending = readValidInstanceIdOrRepair();
    const shared = pending.then(
      (extensionInstanceId) => {
        if (instanceIdPromise === shared) instanceIdPromise = null;
        return extensionInstanceId;
      },
      (error) => {
        if (instanceIdPromise === shared) instanceIdPromise = null;
        throw error;
      }
    );
    instanceIdPromise = shared;
  }
  return instanceIdPromise;
}
