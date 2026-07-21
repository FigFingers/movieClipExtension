import {
  STORAGE_KEYS,
  storageGet,
  storageSet,
  storageRemove,
  normalizePendingClips,
  clearExtensionAuthState,
} from './../shared/storage.js';

// このモジュールは content script 専用。サイト API への fetch(同期・トークンリフレッシュ)は
// background(src/background/sync.js, tokenRefresh.js)が担う。content の fetch はページ
// オリジンの CORS に従いサイト API に弾かれるため、ここに fetch を戻してはならない。

export { STORAGE_KEYS };

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

export async function saveExtensionAuthToken(extensionInstanceId, extensionAuthToken, expiresAt) {
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

  // expiresAt はサーバ発行の ISO 文字列。欠落時(旧サイト)でもトークン自体は保存し、
  // background のリフレッシュが期限付きトークンへ移行させる。
  const expiresAtMs = Date.parse(expiresAt || '');
  await storageSet({
    [STORAGE_KEYS.extensionAuthToken]: extensionAuthToken,
    [STORAGE_KEYS.extensionTokenExpiresAt]: Number.isFinite(expiresAtMs)
      ? new Date(expiresAtMs).toISOString()
      : null,
    [STORAGE_KEYS.extensionLinked]: true,
  });
  // 新しいトークンを受けた時点で旧トークン時代の失敗回数は無効。抑制を持ち越すと
  // 再連携直後のリフレッシュが不要に待たされる。
  await storageRemove([STORAGE_KEYS.extensionTokenRefreshBackoff]);
  return true;
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

export async function syncPendingQueue(options = {}) {
  // 実処理は background。SW 停止直後などで応答が取れなくても、クリップは storage の
  // pendingClips に残っており alarm/次回同期で再送されるため、失敗として握りつぶす。
  try {
    return await sendRuntimeMessage({ type: 'SYNC_PENDING_CLIPS', options });
  } catch (error) {
    console.warn('[extension-sync] sync request to background failed', {
      message: error?.message,
    });
    return { ok: false, queued: true, reason: 'background_unavailable' };
  }
}

export async function handleExtensionAuthStatusRequest(message, targetOrigin = window.location.origin) {
  const state = await getExtensionConnectionState();
  const response = {
    type: 'EXTENSION_AUTH_STATUS',
    requestId: message?.requestId,
    // loggedIn は互換用フィールド。実態は「連携トークンを保持しているか」なので、
    // 新しい読み手は linked を参照すること。
    loggedIn: Boolean(state.extensionAuthToken),
    linked: state.extensionLinked,
    extensionInstanceId: state.extensionInstanceId,
  };

  window.postMessage(response, targetOrigin);
  return response;
}

export async function handleExtensionLinkWithAuthToken(message) {
  const saved = await saveExtensionAuthToken(
    message?.extensionInstanceId,
    message?.token ?? message?.extensionAuthToken,
    message?.expiresAt
  );

  if (saved) {
    await syncPendingQueue();
  }

  return { ok: saved };
}

export async function handleExtensionUnlinked(message) {
  // 未連携時に unlink を受けても instanceId を新規発行しないよう、保存済みの値だけ読む。
  const currentInstanceId = await getExtensionInstanceId();
  if (!currentInstanceId || message?.extensionInstanceId !== currentInstanceId) {
    console.warn('[extension-sync] ignored unlink for mismatched extensionInstanceId', {
      expected: currentInstanceId,
      received: message?.extensionInstanceId,
    });
    return { ok: false };
  }

  await clearExtensionAuthState();
  console.log('[extension-sync] cleared auth state after unlink');
  return { ok: true };
}
