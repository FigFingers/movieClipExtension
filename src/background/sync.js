import { runAuthExclusive as runExclusive } from './exclusive.js';
import { removePendingClipIds } from './clipQueue.js';
import { getApiEndpoint, getSiteUrl } from './../api.js';
import { requestJson } from './request.js';
import {
  STORAGE_KEYS,
  storageGet,
  storageSet,
  normalizePendingClips,
  clearExtensionAuthState,
} from './../shared/storage.js';

// 同期 fetch は background(service worker)で実行する。content script の fetch は
// ページオリジン(netflix.com 等)の CORS に従いサイト API に 403 で弾かれるが、
// background は host_permissions によりオリジン chrome-extension://<id> で到達できる
// (サイト側 CLIP_API_ALLOWED_ORIGINS に拡張 ID の登録が必要)。

const LOGIN_PROMPT_STORAGE_KEY = 'extensionLoginPromptLastOpenedAt';
const LOGIN_PROMPT_COOLDOWN_MS = 60 * 1000;


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

export async function openLoginTab({ force = false } = {}) {
  if (!force) {
    const stored = await storageGet([LOGIN_PROMPT_STORAGE_KEY]);
    const lastOpenedAt = Number(stored[LOGIN_PROMPT_STORAGE_KEY]) || 0;
    if (Date.now() - lastOpenedAt < LOGIN_PROMPT_COOLDOWN_MS) {
      return { ok: false, reason: 'cooldown' };
    }
  }

  await storageSet({ [LOGIN_PROMPT_STORAGE_KEY]: Date.now() });

  return new Promise((resolve) => {
    chrome.tabs.create({ url: getSiteUrl('/login') }, (tab) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve({ ok: true, tabId: tab?.id });
    });
  });
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

  let response;
  let data = null;

  try {
    ({ response, data } = await requestJson(getApiEndpoint('extension/sync'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${extensionAuthToken}`,
      },
      body: JSON.stringify({
        extensionInstanceId,
        items: pendingClips.map(toExtensionSyncItem),
      }),
    }));
  } catch (error) {
    console.warn('[extension-sync] network error; keeping clips queued', {
      clipCount: pendingClips.length,
      message: error?.message,
    });
    return { ok: false, queued: true, reason: 'network_error' };
  }

  console.log('[extension-sync] sync result', {
    status: response.status,
    acceptedCount: data?.acceptedItemIds?.length,
  });

  if (response.status === 200) {
    const attemptedIds = new Set(pendingClips.map((clip) => clip.clientItemId));
    // 本文欠落・壊れたJSON・不正な受理IDを「旧形式の成功」と解釈すると録画を失う。
    // 旧形式は明示的な ok: true とフィールド省略の場合だけ受け付ける。
    const hasAcceptedField = data && Object.hasOwn(data, 'acceptedItemIds');
    if (data?.ok !== true || (hasAcceptedField && (
      !Array.isArray(data.acceptedItemIds) ||
      !data.acceptedItemIds.every((id) => typeof id === 'string' && attemptedIds.has(id))
    ))) {
      console.warn('[extension-sync] invalid success response; keeping clips queued');
      return { ok: false, queued: true, reason: 'invalid_response' };
    }
    // 空配列＝受理ゼロ。重複したIDは件数にも重複計上しない。
    const syncedItemIds = hasAcceptedField
      ? Array.from(new Set(data.acceptedItemIds))
      : Array.from(attemptedIds);
    await removePendingClipIds(syncedItemIds);
    await storageSet({ [STORAGE_KEYS.lastSyncAt]: new Date().toISOString() });
    return { ok: true, acceptedCount: syncedItemIds.length };
  }

  if (response.status === 400) {
    const attemptedIds = new Set(pendingClips.map((clip) => clip.clientItemId));
    const dropItemIds = Array.from(collectClientItemIds(data?.issues || data))
      .filter((id) => attemptedIds.has(id));

    // リクエスト全体の400から個別クリップの不正は断定できない。特定できた送信分だけ削除。
    console.warn('[extension-sync] validation error; dropping identified invalid clips', {
      clipCount: dropItemIds.length,
      issues: data?.issues || data?.error || data?.message,
    });
    await removePendingClipIds(dropItemIds);
    return {
      ok: false,
      queued: dropItemIds.length < attemptedIds.size,
      reason: 'validation_error',
    };
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
