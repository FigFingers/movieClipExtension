export const PLAYBACK_CONTEXT_CHANGED_EVENT =
  'ext:playback-context-changed';

const PLAYBACK_CONTEXT_STORAGE_KEY = 'dextPlaybackContextV1';
const EMPTY_SNAPSHOT = Object.freeze({ initialized: false, context: null });
let memorySnapshot = EMPTY_SNAPSHOT;
let memoryFallbackActive = false;
let memoryStorage = null;

function normalizeClipId(value) {
  const numberValue =
    typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
  return Number.isSafeInteger(numberValue) && numberValue > 0
    ? numberValue
    : null;
}

function normalizeContext(value) {
  if (value?.mode !== 'clip' && value?.mode !== 'playlist') return null;
  const clipId = normalizeClipId(value.clipId);
  if (clipId === null) return null;
  return { mode: value.mode, clipId };
}

function getSessionStorage() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

function parseStoredSnapshot(rawValue) {
  if (rawValue === null) return EMPTY_SNAPSHOT;

  try {
    const parsed = JSON.parse(rawValue);
    if (parsed?.initialized !== true) {
      // A present marker must never fall back to another tab's global state.
      return { initialized: true, context: null };
    }
    return {
      initialized: true,
      context: normalizeContext(parsed.context),
    };
  } catch {
    // Treat a corrupt, but present, marker as explicitly initialized and empty.
    return { initialized: true, context: null };
  }
}

export function readPlaybackContext() {
  const storage = getSessionStorage();
  if (!storage) return memorySnapshot;
  if (
    memoryStorage === storage ||
    (memoryFallbackActive && memoryStorage === null)
  ) {
    return memorySnapshot;
  }

  try {
    const rawValue = storage.getItem(PLAYBACK_CONTEXT_STORAGE_KEY);
    memorySnapshot = parseStoredSnapshot(rawValue);
    memoryStorage = storage;
    memoryFallbackActive = false;
    return memorySnapshot;
  } catch {
    memoryStorage = storage;
    memoryFallbackActive = true;
    return memorySnapshot;
  }
}

function dispatchChange(snapshot) {
  const eventTarget = globalThis.window;
  if (!eventTarget?.dispatchEvent) return;

  try {
    const event = new CustomEvent(PLAYBACK_CONTEXT_CHANGED_EVENT, {
      detail: snapshot,
    });
    eventTarget.dispatchEvent(event);
  } catch {
    // Old/locked-down pages can expose EventTarget without a usable CustomEvent.
    try {
      eventTarget.dispatchEvent(new Event(PLAYBACK_CONTEXT_CHANGED_EVENT));
    } catch {
      // The stored context remains authoritative even when notification is blocked.
    }
  }
}

function writePlaybackContext(context) {
  const nextSnapshot = { initialized: true, context };
  const previousSnapshot = readPlaybackContext();
  const unchanged =
    previousSnapshot.initialized &&
    previousSnapshot.context?.mode === context?.mode &&
    previousSnapshot.context?.clipId === context?.clipId;

  memorySnapshot = nextSnapshot;
  const storage = getSessionStorage();
  if (storage) {
    try {
      storage.setItem(
        PLAYBACK_CONTEXT_STORAGE_KEY,
        JSON.stringify(nextSnapshot)
      );
      memoryStorage = storage;
      memoryFallbackActive = false;
    } catch {
      // Keep the module-local value so this tab still remains isolated.
      memoryStorage = storage;
      memoryFallbackActive = true;
    }
  } else {
    memoryStorage = null;
    memoryFallbackActive = true;
  }

  if (!unchanged) dispatchChange(nextSnapshot);
  return nextSnapshot;
}

/** Mark this tab as initialized without borrowing another tab's playback state. */
export function ensurePlaybackContext() {
  const current = readPlaybackContext();
  if (current.initialized) return current;
  return writePlaybackContext(null);
}

export function setPlaybackContext({ mode, clipId } = {}) {
  const context = normalizeContext({ mode, clipId });
  if (!context) {
    throw new TypeError('Playback context requires clip/playlist mode and a positive clipId');
  }
  return writePlaybackContext(context);
}

/** Clear this tab's playback state while retaining the initialized-null marker. */
export function clearPlaybackContext() {
  return writePlaybackContext(null);
}
