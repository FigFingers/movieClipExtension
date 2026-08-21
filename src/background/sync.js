import { getApiEndpoint, getSiteUrl } from './../api.js';
import {
  STORAGE_KEYS,
  storageGet,
  storageSet,
  normalizePendingClips,
  clearExtensionAuthState,
} from './../shared/storage.js';
import { fetchJsonWithTimeout } from './request.js';

// 同期 fetch は background(service worker)で実行する。content script の fetch は
// ページオリジン(netflix.com 等)の CORS に従いサイト API に 403 で弾かれるが、
// background は host_permissions によりオリジン chrome-extension://<id> で到達できる
// (サイト側 CLIP_API_ALLOWED_ORIGINS に拡張 ID の登録が必要)。

const LOGIN_PROMPT_STORAGE_KEY = 'extensionLoginPromptLastOpenedAt';
const LOGIN_PROMPT_COOLDOWN_MS = 60 * 1000;

// sync とトークンリフレッシュを直列化するミューテックス。ローテーション中に旧トークンで
// sync が走ると 401 → トークン誤クリアになるため、両者は必ずこれを通す。
let exclusiveChain = Promise.resolve();
export function runExclusive(task) {
  const run = exclusiveChain.then(() => task());
  exclusiveChain = run.then(
    () => {},
    () => {}
  );
  return run;
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

  const stored = await storageGet([STORAGE_KEYS.pendingClips]);
  const pendingClips = normalizePendingClips(stored[STORAGE_KEYS.pendingClips]);
  await storageSet({
    [STORAGE_KEYS.pendingClips]: pendingClips.filter(
      (clip) => !ids.has(clip.clientItemId)
    ),
  });
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
    STORAGE_KEYS.pendingClips,
  ]);
  const extensionInstanceId = stored[STORAGE_KEYS.extensionInstanceId];
  const extensionAuthToken = stored[STORAGE_KEYS.extensionAuthToken] || null;
  const pendingClips = normalizePendingClips(stored[STORAGE_KEYS.pendingClips]);

  if (pendingClips.length === 0) {
    return { ok: true, skipped: true, reason: 'empty_queue' };
  }

  if (!extensionAuthToken || !extensionInstanceId) {
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
    // フィールドが存在すればそれが権威的（空配列＝受理ゼロなので何も削除しない）。
    // フィールド自体が無いレガシー応答のときだけ、従来どおり全送信分を削除する。
    const hasAcceptedField = Array.isArray(data?.acceptedItemIds);
    const syncedItemIds = hasAcceptedField
      ? data.acceptedItemIds
      : pendingClips.map((clip) => clip.clientItemId);
    await removePendingClipIds(syncedItemIds);
    await storageSet({ [STORAGE_KEYS.lastSyncAt]: new Date().toISOString() });
    return { ok: true, acceptedCount: syncedItemIds.length };
  }

  if (response.status === 400) {
    const issueItemIds = Array.from(collectClientItemIds(data?.issues || data));
    const dropItemIds = issueItemIds.length > 0
      ? issueItemIds
      : pendingClips.map((clip) => clip.clientItemId);

    console.warn('[extension-sync] validation error; dropping attempted clips', {
      clipCount: dropItemIds.length,
      issues: data?.issues || data?.error || data?.message,
    });
    await removePendingClipIds(dropItemIds);
    return { ok: false, queued: false, reason: 'validation_error' };
  }

  if (response.status === 401) {
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
