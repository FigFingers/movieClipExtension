import { getApiEndpoint, getSiteUrl } from './../api.js';

export const STORAGE_KEYS = {
  extensionInstanceId: 'extensionInstanceId',
  extensionAuthToken: 'extensionAuthToken',
  extensionLinked: 'extensionLinked',
  lastSyncAt: 'lastSyncAt',
  pendingClips: 'pendingClips',
};

const LOGIN_PROMPT_STORAGE_KEY = 'extensionLoginPromptLastOpenedAt';
const LOGIN_PROMPT_COOLDOWN_MS = 60 * 1000;

let syncInFlight = null;
let syncRequestedAfterCurrent = false;
let nextSyncOptions = {};

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function createUuid() {
  return crypto.randomUUID();
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function nullableString(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeNumber(value, fieldName) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new Error(`Invalid clip ${fieldName}: ${value}`);
  }
  return numberValue;
}

function normalizeUrl(value) {
  const rawUrl = firstPresent(value, location.href);
  if (!rawUrl) {
    throw new Error('Clip url is required');
  }
  return new URL(String(rawUrl), location.origin).href;
}

function normalizePendingClips(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((clip) => clip?.clientItemId && clip?.url);
}

function optionalText(value) {
  const text = nullableString(value);
  return text === null ? undefined : text;
}

function toExtensionSyncItem(clip) {
  const payload = {
    service: clip.service,
    title: clip.title,
    StartTime: clip.startTime,
    EndTime: clip.endTime,
    URL: clip.url,
  };

  const clipName = optionalText(clip.clipName);
  if (clipName !== undefined) payload.clipName = clipName;

  const epnumber = optionalText(clip.epnumber);
  if (epnumber !== undefined) payload.epnumber = epnumber;

  return {
    clientItemId: clip.clientItemId,
    type: 'clip',
    createdAt: clip.createdAt || new Date().toISOString(),
    payload,
  };
}

function parseResponseJson(response) {
  return response
    .json()
    .catch(() => null);
}

function collectClientItemIds(value, ids = new Set()) {
  if (!value || typeof value !== 'object') return ids;

  if (typeof value.clientItemId === 'string') {
    ids.add(value.clientItemId);
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectClientItemIds(item, ids));
    return ids;
  }

  Object.values(value).forEach((item) => collectClientItemIds(item, ids));
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

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

export async function getOrCreateExtensionInstanceId() {
  const stored = await storageGet([STORAGE_KEYS.extensionInstanceId]);
  const existingId = stored[STORAGE_KEYS.extensionInstanceId];
  if (existingId) {
    return existingId;
  }

  // 生成は background に一本化する。auth-status 経路と port 経路がそれぞれ空 storage を
  // 読んで別 UUID を作ると instanceId 不一致でトークンが拒否されるため、ここでは自前生成
  // せず background の直列化された生成器から取得する。
  const response = await sendRuntimeMessage({ type: 'GET_OR_CREATE_INSTANCE_ID' });
  if (response?.ok && response.extensionInstanceId) {
    return response.extensionInstanceId;
  }
  throw new Error(response?.message || 'Failed to obtain extensionInstanceId');
}

export async function getExtensionInstanceId() {
  const stored = await storageGet([STORAGE_KEYS.extensionInstanceId]);
  return stored[STORAGE_KEYS.extensionInstanceId] ?? null;
}

export async function getExtensionConnectionState() {
  const extensionInstanceId = await getOrCreateExtensionInstanceId();
  const stored = await storageGet([
    STORAGE_KEYS.extensionAuthToken,
    STORAGE_KEYS.extensionLinked,
    STORAGE_KEYS.lastSyncAt,
    STORAGE_KEYS.pendingClips,
  ]);
  const extensionAuthToken = stored[STORAGE_KEYS.extensionAuthToken] || null;

  return {
    extensionInstanceId,
    extensionAuthToken,
    extensionLinked: Boolean(extensionAuthToken && stored[STORAGE_KEYS.extensionLinked]),
    lastSyncAt: stored[STORAGE_KEYS.lastSyncAt] || null,
    pendingClips: normalizePendingClips(stored[STORAGE_KEYS.pendingClips]),
  };
}

export async function saveExtensionAuthToken(extensionInstanceId, extensionAuthToken) {
  const currentInstanceId = await getOrCreateExtensionInstanceId();
  if (extensionInstanceId !== currentInstanceId) {
    console.warn('[extension-sync] ignored auth token for mismatched extensionInstanceId', {
      expected: currentInstanceId,
      received: extensionInstanceId,
    });
    return false;
  }

  if (!extensionAuthToken || typeof extensionAuthToken !== 'string') {
    console.warn('[extension-sync] ignored empty auth token');
    return false;
  }

  await storageSet({
    [STORAGE_KEYS.extensionAuthToken]: extensionAuthToken,
    [STORAGE_KEYS.extensionLinked]: true,
  });
  return true;
}

export async function clearExtensionAuthToken() {
  await storageRemove([STORAGE_KEYS.extensionAuthToken]);
  await storageSet({ [STORAGE_KEYS.extensionLinked]: false });
}

export function toExtensionClipPayload(clip) {
  const startTimeValue = firstPresent(clip?.startTime, clip?.StartTime);
  const endTimeValue = firstPresent(clip?.endTime, clip?.EndTime);
  const clientItemId = firstPresent(clip?.clientItemId, clip?.localClientItemId) || createUuid();

  return {
    clientItemId: String(clientItemId),
    title: nullableString(clip?.title),
    url: normalizeUrl(firstPresent(clip?.url, clip?.URL)),
    startTime: normalizeNumber(startTimeValue, 'startTime'),
    endTime: normalizeNumber(endTimeValue, 'endTime'),
    service: nullableString(clip?.service),
    clipName: nullableString(clip?.clipName),
    epnumber: nullableString(clip?.epnumber),
    createdAt: clip?.createdAt || new Date().toISOString(),
  };
}

export async function enqueueClip(clip) {
  const normalizedClip = toExtensionClipPayload(clip);
  const stored = await storageGet([STORAGE_KEYS.pendingClips]);
  const pendingClips = normalizePendingClips(stored[STORAGE_KEYS.pendingClips]);
  const queueById = new Map(pendingClips.map((item) => [item.clientItemId, item]));
  queueById.set(normalizedClip.clientItemId, normalizedClip);

  await storageSet({
    [STORAGE_KEYS.pendingClips]: Array.from(queueById.values()),
  });

  return normalizedClip;
}

export async function openExtensionLoginPage({ force = false } = {}) {
  const loginUrl = getSiteUrl('/login');

  if (!force) {
    const stored = await storageGet([LOGIN_PROMPT_STORAGE_KEY]);
    const lastOpenedAt = Number(stored[LOGIN_PROMPT_STORAGE_KEY]) || 0;
    if (Date.now() - lastOpenedAt < LOGIN_PROMPT_COOLDOWN_MS) {
      return { ok: false, reason: 'cooldown' };
    }
  }

  await storageSet({ [LOGIN_PROMPT_STORAGE_KEY]: Date.now() });

  try {
    return await sendRuntimeMessage({
      type: 'OPEN_EXTENSION_LOGIN',
      url: loginUrl,
    });
  } catch (error) {
    window.open(loginUrl, '_blank', 'noopener');
    return { ok: true, fallback: true };
  }
}

async function performSyncPendingQueue({ openLoginIfMissingToken = false } = {}) {
  const state = await getExtensionConnectionState();
  const { extensionAuthToken, pendingClips } = state;

  if (pendingClips.length === 0) {
    return { ok: true, skipped: true, reason: 'empty_queue' };
  }

  if (!extensionAuthToken) {
    console.log('[extension-sync] sync start', {
      clipCount: pendingClips.length,
      hasToken: false,
    });

    if (openLoginIfMissingToken) {
      await openExtensionLoginPage();
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
    response = await fetch(getApiEndpoint('extension/sync'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${extensionAuthToken}`,
      },
      body: JSON.stringify({
        extensionInstanceId: state.extensionInstanceId,
        items: pendingClips.map(toExtensionSyncItem),
      }),
    });

    data = await parseResponseJson(response);
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
    await clearExtensionAuthToken();
    console.warn('[extension-sync] auth token rejected; cleared token and kept queue');
    if (openLoginIfMissingToken) {
      await openExtensionLoginPage();
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
    let result = await performSyncPendingQueue(options);

    while (syncRequestedAfterCurrent) {
      const followUpOptions = nextSyncOptions;
      syncRequestedAfterCurrent = false;
      nextSyncOptions = {};
      result = await performSyncPendingQueue(followUpOptions);
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

const RENEWAL_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000;

function decodeBase64Url(segment) {
  // JWT は base64url ('-' '_'・パディング無し)。atob は標準 base64 しか受け付けず、
  // URL-safe 文字が含まれると throw するため、標準 base64 に変換してから復号する。
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (base64.length % 4)) % 4;
  return atob(base64 + '='.repeat(paddingLength));
}

function getTokenExpiryMs(token) {
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const payload = JSON.parse(decodeBase64Url(segment));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export async function checkAndRenewToken() {
  const stored = await storageGet([
    STORAGE_KEYS.extensionAuthToken,
    STORAGE_KEYS.extensionInstanceId,
  ]);
  const token = stored[STORAGE_KEYS.extensionAuthToken];
  const extensionInstanceId = stored[STORAGE_KEYS.extensionInstanceId];

  if (!token || !extensionInstanceId) return;

  const expiryMs = getTokenExpiryMs(token);
  if (!expiryMs) return;

  const remainingMs = expiryMs - Date.now();
  if (remainingMs > RENEWAL_THRESHOLD_MS) return;

  try {
    const res = await fetch('/api/extension/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extensionInstanceId }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.token === 'string') {
      await storageSet({ [STORAGE_KEYS.extensionAuthToken]: data.token });
      console.log('[extension-sync] token renewed automatically');
    }
  } catch (error) {
    console.warn('[extension-sync] token renewal failed', { message: error?.message });
  }
}

export async function handleExtensionAuthStatusRequest(message, targetOrigin = window.location.origin) {
  const state = await getExtensionConnectionState();
  const response = {
    type: 'EXTENSION_AUTH_STATUS',
    requestId: message?.requestId,
    loggedIn: Boolean(state.extensionAuthToken),
    extensionInstanceId: state.extensionInstanceId,
  };

  window.postMessage(response, targetOrigin);
  return response;
}

export async function handleExtensionLinkWithAuthToken(message) {
  const saved = await saveExtensionAuthToken(
    message?.extensionInstanceId,
    message?.token ?? message?.extensionAuthToken
  );

  if (saved) {
    await syncPendingQueue();
  }

  return { ok: saved };
}
