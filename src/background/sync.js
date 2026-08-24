import { getApiEndpoint, getSiteUrl } from './../api.js';
import {
  STORAGE_KEYS,
  storageGet,
  storageSet,
  normalizePendingClips,
  clearExtensionAuthState,
} from './../shared/storage.js';
import {
  isValidExtensionAuthToken,
  isValidExtensionInstanceId,
} from './../shared/authValidation.js';
import { runExclusive } from './authMutex.js';
import { getOrCreateInstanceIdWhileExclusive } from './instanceId.js';
import { fetchJsonWithTimeout } from './request.js';

// 同期 fetch は background(service worker)で実行する。content script の fetch は
// ページオリジン(netflix.com 等)の CORS に従いサイト API に 403 で弾かれるが、
// background は host_permissions によりオリジン chrome-extension://<id> で到達できる
// (サイト側 CLIP_API_ALLOWED_ORIGINS に拡張 ID の登録が必要)。

const LOGIN_PROMPT_STORAGE_KEY = 'extensionLoginPromptLastOpenedAt';
const LOGIN_PROMPT_COOLDOWN_MS = 60 * 1000;

// sync とトークンリフレッシュを直列化するミューテックス。ローテーション中に旧トークンで
// sync が走ると 401 → トークン誤クリアになるため、両者は必ずこれを通す。
export { runExclusive } from './authMutex.js';

// Keep queue read-modify-write operations in one background context. This is
// deliberately separate from the auth mutex: sync holds that mutex across the
// network request, while recording a new clip must not wait up to 15 seconds.
let pendingQueueMutationChain = Promise.resolve();
function runPendingQueueMutation(task) {
  const run = pendingQueueMutationChain.then(() => task());
  pendingQueueMutationChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

function isValidPendingClipForEnqueue(clip) {
  return clip !== null
    && typeof clip === 'object'
    && !Array.isArray(clip)
    && typeof clip.clientItemId === 'string'
    && clip.clientItemId.length > 0
    && typeof clip.url === 'string'
    && clip.url.length > 0
    && Number.isFinite(clip.startTime)
    && Number.isFinite(clip.endTime);
}

export function enqueuePendingClipInBackground(clip) {
  if (!isValidPendingClipForEnqueue(clip)) {
    return Promise.resolve({ ok: false, reason: 'invalid_clip' });
  }

  return runPendingQueueMutation(async () => {
    const stored = await storageGet([STORAGE_KEYS.pendingClips]);
    const pendingClips = normalizePendingClips(stored[STORAGE_KEYS.pendingClips]);
    const queueById = new Map(
      pendingClips.map((pendingClip) => [pendingClip.clientItemId, pendingClip])
    );
    queueById.set(clip.clientItemId, clip);
    await storageSet({
      [STORAGE_KEYS.pendingClips]: Array.from(queueById.values()),
    });
    return { ok: true };
  });
}

function toExtensionSyncItem(clip) {
  const payload = {
    service: clip.service,
    title: clip.title,
    StartTime: clip.startTime,
    EndTime: clip.endTime,
    URL: clip.url,
  };

  if (clip.clipName !== undefined && clip.clipName !== null && clip.clipName !== '') {
    payload.clipName = clip.clipName;
  }

  if (clip.epnumber !== undefined && clip.epnumber !== null && clip.epnumber !== '') {
    payload.epnumber = clip.epnumber;
  }

  return {
    clientItemId: clip.clientItemId,
    type: 'clip',
    createdAt: clip.createdAt || new Date().toISOString(),
    payload,
  };
}

function collectClientItemIds(value, ids = new Set()) {
  if (!value || typeof value !== 'object') return ids;

  if (typeof value.clientItemId === 'string') {
    ids.add(value.clientItemId);
  }

  if (Array.isArray(value)) {
    value.forEach((item) => {
      collectClientItemIds(item, ids);
    });
    return ids;
  }

  Object.values(value).forEach((item) => {
    collectClientItemIds(item, ids);
  });
  return ids;
}

async function removePendingClipIds(clientItemIds) {
  const ids = new Set(clientItemIds.filter(Boolean));
  if (ids.size === 0) return;

  await runPendingQueueMutation(async () => {
    const stored = await storageGet([STORAGE_KEYS.pendingClips]);
    const pendingClips = normalizePendingClips(stored[STORAGE_KEYS.pendingClips]);
    await storageSet({
      [STORAGE_KEYS.pendingClips]: pendingClips.filter(
        (clip) => !ids.has(clip.clientItemId)
      ),
    });
  });
}

function validateSyncSuccessResponse(data, pendingClips) {
  if (
    data === null
    || typeof data !== 'object'
    || Array.isArray(data)
    || data.ok !== true
    || !Array.isArray(data.acceptedItemIds)
  ) {
    return null;
  }

  const attemptedIds = new Set(pendingClips.map((clip) => clip.clientItemId));
  const acceptedIds = new Set();
  for (const clientItemId of data.acceptedItemIds) {
    if (
      typeof clientItemId !== 'string'
      || !attemptedIds.has(clientItemId)
      || acceptedIds.has(clientItemId)
    ) {
      return null;
    }
    acceptedIds.add(clientItemId);
  }

  return Array.from(acceptedIds);
}

async function performOpenLoginTab({ force = false } = {}) {
  if (!force) {
    const stored = await storageGet([LOGIN_PROMPT_STORAGE_KEY]);
    const lastOpenedAt = Number(stored[LOGIN_PROMPT_STORAGE_KEY]) || 0;
    if (Date.now() - lastOpenedAt < LOGIN_PROMPT_COOLDOWN_MS) {
      return { ok: true, skipped: true, reason: 'cooldown' };
    }
  }

  const result = await new Promise((resolve) => {
    chrome.tabs.create({ url: getSiteUrl('/login') }, (tab) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          reason: 'tab_create_failed',
          error: chrome.runtime.lastError.message,
        });
        return;
      }
      resolve({ ok: true, tabId: tab?.id });
    });
  });

  // A failed tabs.create must remain immediately retryable. Record cooldown
  // only after Chrome confirms that a login tab was actually opened.
  if (result.ok) {
    await storageSet({ [LOGIN_PROMPT_STORAGE_KEY]: Date.now() });
  }
  return result;
}

let loginTabInFlight = null;
export function openLoginTab(options = {}) {
  if (!loginTabInFlight) {
    loginTabInFlight = performOpenLoginTab(options)
      .finally(() => {
        loginTabInFlight = null;
      });
  }
  return loginTabInFlight;
}

async function performSyncPendingQueue({ openLoginIfMissingToken = false } = {}) {
  const stored = await storageGet([
    STORAGE_KEYS.extensionInstanceId,
    STORAGE_KEYS.extensionAuthToken,
    STORAGE_KEYS.extensionLinked,
    STORAGE_KEYS.pendingClips,
  ]);
  const extensionInstanceId = stored[STORAGE_KEYS.extensionInstanceId];
  const extensionAuthToken = stored[STORAGE_KEYS.extensionAuthToken];
  const pendingClips = normalizePendingClips(stored[STORAGE_KEYS.pendingClips]);

  if (pendingClips.length === 0) {
    return { ok: true, skipped: true, reason: 'empty_queue' };
  }

  if (!isValidExtensionInstanceId(extensionInstanceId)) {
    await getOrCreateInstanceIdWhileExclusive();
  } else if (
    !isValidExtensionAuthToken(extensionAuthToken)
    && (
      extensionAuthToken !== undefined
      || stored[STORAGE_KEYS.extensionLinked] === true
    )
  ) {
    await clearExtensionAuthState();
  }

  if (
    !isValidExtensionAuthToken(extensionAuthToken)
    || !isValidExtensionInstanceId(extensionInstanceId)
  ) {
    console.log('[extension-sync] sync start', {
      clipCount: pendingClips.length,
      hasToken: false,
    });

    if (openLoginIfMissingToken) {
      await openLoginTab();
    }

    return { ok: false, queued: true, reason: 'missing_token' };
  }

  console.log('[extension-sync] sync start', {
    clipCount: pendingClips.length,
    hasToken: true,
  });

  const request = await fetchJsonWithTimeout(getApiEndpoint('extension/sync'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${extensionAuthToken}`,
    },
    body: JSON.stringify({
      extensionInstanceId,
      items: pendingClips.map(toExtensionSyncItem),
    }),
  });

  if (!request.ok) {
    console.warn('[extension-sync] network error; keeping clips queued', {
      clipCount: pendingClips.length,
      message: request.error?.message,
      timedOut: request.timedOut,
    });
    return {
      ok: false,
      queued: true,
      reason: request.timedOut ? 'timeout' : 'network_error',
    };
  }
  const { response, data } = request;

  console.log('[extension-sync] sync result', {
    status: response.status,
    acceptedCount: data?.acceptedItemIds?.length,
  });

  if (response.status === 200) {
    const syncedItemIds = validateSyncSuccessResponse(data, pendingClips);
    if (syncedItemIds === null) {
      console.warn('[extension-sync] malformed success response; keeping clips queued');
      return { ok: false, queued: true, reason: 'invalid_response' };
    }

    await removePendingClipIds(syncedItemIds);
    await storageSet({ [STORAGE_KEYS.lastSyncAt]: new Date().toISOString() });
    return { ok: true, acceptedCount: syncedItemIds.length };
  }

  if (response.status === 400) {
    const issueItemIds = Array.from(collectClientItemIds(data?.issues || data));
    if (issueItemIds.length === 0) {
      // Production validation responses intentionally omit schema details. A
      // generic 400 cannot identify which item is bad, so deleting the whole
      // attempted batch would also discard valid clips without an ack.
      console.warn('[extension-sync] validation error without item IDs; keeping clips queued', {
        clipCount: pendingClips.length,
      });
      return { ok: false, queued: true, reason: 'validation_error' };
    }

    console.warn('[extension-sync] validation error; dropping identified clips', {
      clipCount: issueItemIds.length,
    });
    await removePendingClipIds(issueItemIds);
    return { ok: false, queued: false, reason: 'validation_error' };
  }

  if (response.status === 401) {
    const current = await storageGet([STORAGE_KEYS.extensionAuthToken]);
    if (current[STORAGE_KEYS.extensionAuthToken] !== extensionAuthToken) {
      console.log('[extension-sync] stale sync 401 for replaced token; keeping current token');
      return { ok: false, queued: true, reason: 'stale_unauthorized' };
    }

    await clearExtensionAuthState();
    console.warn('[extension-sync] auth token rejected; cleared token and kept queue');
    if (openLoginIfMissingToken) {
      await openLoginTab();
    }
    return { ok: false, queued: true, reason: 'unauthorized' };
  }

  if (response.status === 403) {
    console.warn('[extension-sync] forbidden; keeping clips queued', {
      status: response.status,
    });
    return { ok: false, queued: true, reason: 'forbidden' };
  }

  console.warn('[extension-sync] sync failed; keeping clips queued', {
    status: response.status,
  });
  return { ok: false, queued: true, reason: 'sync_failed' };
}

let syncInFlight = null;
let syncRequestedAfterCurrent = false;
let nextSyncOptions = {};

export function syncPendingQueue(options = {}) {
  if (syncInFlight) {
    syncRequestedAfterCurrent = true;
    nextSyncOptions = {
      ...nextSyncOptions,
      ...options,
      openLoginIfMissingToken: Boolean(
        nextSyncOptions.openLoginIfMissingToken || options.openLoginIfMissingToken
      ),
    };
    return syncInFlight;
  }

  syncInFlight = (async () => {
    let result = await runExclusive(() => performSyncPendingQueue(options));

    while (syncRequestedAfterCurrent) {
      const followUpOptions = nextSyncOptions;
      syncRequestedAfterCurrent = false;
      nextSyncOptions = {};
      result = await runExclusive(() => performSyncPendingQueue(followUpOptions));
    }

    return result;
  })()
    .finally(() => {
      syncInFlight = null;
      syncRequestedAfterCurrent = false;
      nextSyncOptions = {};
    });

  return syncInFlight;
}
