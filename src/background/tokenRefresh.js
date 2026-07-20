import { getApiEndpoint } from './../api.js';
import {
  STORAGE_KEYS,
  storageGet,
  storageSet,
  storageRemove,
  clearExtensionAuthState,
} from './../shared/storage.js';
import { runExclusive } from './sync.js';

// トークンはサーバ発行の不透明トークン(JWT ではない)。期限はサーバが link/refresh 応答の
// expiresAt で通知し、拡張は storage に保存した値だけを見て更新時期を判断する。
const RENEWAL_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000;

// expiresAt が未保存だと下の not_due 判定を素通りするため、失敗が続くと SW 起動毎
// (実効15分間隔)にリフレッシュを撃ち続ける。連続失敗を storage に記録して抑制する。
const BACKOFF_BASE_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
// 404 はサイト側がこのエンドポイントを未実装であることを意味し、短間隔で試す意味がない。
const BACKOFF_NOT_IMPLEMENTED_MS = 6 * 60 * 60 * 1000;

function computeBackoffMs(failureCount, status) {
  if (status === 404) {
    return Math.max(BACKOFF_NOT_IMPLEMENTED_MS, BACKOFF_BASE_MS * 2 ** (failureCount - 1));
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** (failureCount - 1), BACKOFF_MAX_MS);
}

async function recordRefreshFailure(previousBackoff, status) {
  const failureCount = Number(previousBackoff?.failureCount) > 0
    ? Number(previousBackoff.failureCount) + 1
    : 1;
  const delayMs = Math.min(computeBackoffMs(failureCount, status), BACKOFF_MAX_MS);

  await storageSet({
    [STORAGE_KEYS.extensionTokenRefreshBackoff]: {
      failureCount,
      nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
      lastStatus: status ?? null,
    },
  });

  console.warn('[extension-sync] refresh backoff scheduled', {
    failureCount,
    delayMinutes: Math.round(delayMs / 60000),
    status: status ?? null,
  });
}

function clearRefreshBackoff() {
  return storageRemove([STORAGE_KEYS.extensionTokenRefreshBackoff]);
}

export function checkAndRefreshToken() {
  return runExclusive(performCheckAndRefreshToken);
}

async function performCheckAndRefreshToken() {
  const stored = await storageGet([
    STORAGE_KEYS.extensionAuthToken,
    STORAGE_KEYS.extensionInstanceId,
    STORAGE_KEYS.extensionTokenExpiresAt,
    STORAGE_KEYS.extensionTokenRefreshBackoff,
  ]);
  const token = stored[STORAGE_KEYS.extensionAuthToken];
  const extensionInstanceId = stored[STORAGE_KEYS.extensionInstanceId];

  if (!token || !extensionInstanceId) {
    return { ok: true, skipped: true, reason: 'not_linked' };
  }

  const backoff = stored[STORAGE_KEYS.extensionTokenRefreshBackoff] || null;
  const nextAttemptAtMs = Date.parse(backoff?.nextAttemptAt || '');
  if (Number.isFinite(nextAttemptAtMs) && nextAttemptAtMs > Date.now()) {
    return {
      ok: true,
      skipped: true,
      reason: 'backoff',
      nextAttemptAt: backoff.nextAttemptAt,
      failureCount: backoff.failureCount ?? null,
    };
  }

  const expiresAtMs = Date.parse(stored[STORAGE_KEYS.extensionTokenExpiresAt] || '');

  // expiresAt が未保存(期限導入前に連携した旧形式)の場合は即リフレッシュを試み、
  // 期限付きトークンへ移行させる。
  if (Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() > RENEWAL_THRESHOLD_MS) {
    return { ok: true, skipped: true, reason: 'not_due' };
  }

  let response;
  let data = null;

  try {
    response = await fetch(getApiEndpoint('extension/token/refresh'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ extensionInstanceId }),
    });
    data = await response.json().catch(() => null);
  } catch (error) {
    console.warn('[extension-sync] token refresh failed; keeping current token', {
      message: error?.message,
    });
    await recordRefreshFailure(backoff, null);
    return { ok: false, reason: 'network_error' };
  }

  if (response.status === 200 && typeof data?.extensionAuthToken === 'string') {
    await storageSet({
      [STORAGE_KEYS.extensionAuthToken]: data.extensionAuthToken,
      [STORAGE_KEYS.extensionTokenExpiresAt]: data.expiresAt || null,
      [STORAGE_KEYS.extensionLinked]: true,
    });
    await clearRefreshBackoff();
    console.log('[extension-sync] token refreshed', { expiresAt: data.expiresAt });
    return { ok: true, refreshed: true };
  }

  if (response.status === 401) {
    // 失効・解除・ローテーション競合負け。トークンを破棄し、次のユーザー操作時の
    // 再ログイン導線(sync の missing_token 経路)に任せる。
    // バックオフ状態は clearExtensionAuthState() が併せて削除する。
    await clearExtensionAuthState();
    console.warn('[extension-sync] token refresh unauthorized; cleared token');
    return { ok: false, reason: 'unauthorized' };
  }

  console.warn('[extension-sync] token refresh failed; keeping current token', {
    status: response.status,
  });
  await recordRefreshFailure(backoff, response.status);
  return { ok: false, reason: 'refresh_failed' };
}
