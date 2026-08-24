import { getApiEndpoint } from './../api.js';
import {
  STORAGE_KEYS,
  storageGet,
  storageSet,
  storageRemove,
  clearExtensionAuthState,
} from './../shared/storage.js';
import {
  isValidExtensionInstanceId,
  isValidExtensionAuthToken,
  normalizeExtensionTokenExpiry,
} from './../shared/authValidation.js';
import { runExclusive } from './authMutex.js';
import { getOrCreateInstanceIdWhileExclusive } from './instanceId.js';
import { fetchJsonWithTimeout } from './request.js';

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

// バックオフは「どのトークンで失敗したか」に紐づけて保存する。
// auth bridge を含むトークン更新は同じ runExclusive に集約している。fingerprint も保持し、
// 永続化済みの旧バックオフ記録が再連携後の新トークンを抑制しないようにする。
async function tokenFingerprint(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function recordRefreshFailure(attemptedToken, status) {
  const current = await storageGet([STORAGE_KEYS.extensionTokenRefreshBackoff]);
  const previousBackoff = current[STORAGE_KEYS.extensionTokenRefreshBackoff] || null;
  const fingerprint = await tokenFingerprint(attemptedToken);

  // 直前の記録が別トークンのものなら連番を引き継がず 1 から数え直す。
  const failureCount = previousBackoff?.tokenFingerprint === fingerprint
    && Number(previousBackoff.failureCount) > 0
    ? Number(previousBackoff.failureCount) + 1
    : 1;
  const delayMs = Math.min(computeBackoffMs(failureCount, status), BACKOFF_MAX_MS);

  await storageSet({
    [STORAGE_KEYS.extensionTokenRefreshBackoff]: {
      tokenFingerprint: fingerprint,
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

function normalizeRefreshSuccess(data) {
  const expiresAt = normalizeExtensionTokenExpiry(data?.expiresAt);
  if (
    data?.ok !== true
    || !isValidExtensionAuthToken(data.extensionAuthToken)
    || expiresAt === null
    || Date.parse(expiresAt) <= Date.now()
  ) {
    return null;
  }

  return {
    extensionAuthToken: data.extensionAuthToken,
    expiresAt,
  };
}

export function checkAndRefreshToken() {
  return runExclusive(performCheckAndRefreshToken);
}

async function performCheckAndRefreshToken() {
  const stored = await storageGet([
    STORAGE_KEYS.extensionAuthToken,
    STORAGE_KEYS.extensionInstanceId,
    STORAGE_KEYS.extensionLinked,
    STORAGE_KEYS.extensionTokenExpiresAt,
    STORAGE_KEYS.extensionTokenRefreshBackoff,
  ]);
  const token = stored[STORAGE_KEYS.extensionAuthToken];
  const extensionInstanceId = stored[STORAGE_KEYS.extensionInstanceId];

  if (!isValidExtensionInstanceId(extensionInstanceId)) {
    await getOrCreateInstanceIdWhileExclusive();
    return { ok: true, skipped: true, reason: 'not_linked' };
  }

  if (!isValidExtensionAuthToken(token)) {
    if (
      token !== undefined
      || stored[STORAGE_KEYS.extensionLinked] === true
    ) {
      await clearExtensionAuthState();
    }
    return { ok: true, skipped: true, reason: 'not_linked' };
  }

  const backoff = stored[STORAGE_KEYS.extensionTokenRefreshBackoff] || null;
  const nextAttemptAtMs = Date.parse(backoff?.nextAttemptAt || '');
  if (Number.isFinite(nextAttemptAtMs) && nextAttemptAtMs > Date.now()) {
    // 現在のトークンに紐づく記録のときだけ抑制する。再連携で差し替わっていれば旧トークンの
    // 記録なので、古い試行が競合で書き戻したものも含めて破棄し、通常どおり続行する。
    if (backoff.tokenFingerprint === (await tokenFingerprint(token))) {
      return {
        ok: true,
        skipped: true,
        reason: 'backoff',
        nextAttemptAt: backoff.nextAttemptAt,
        failureCount: backoff.failureCount ?? null,
      };
    }

    console.log('[extension-sync] discarding backoff recorded for a superseded token');
    await clearRefreshBackoff();
  }

  const expiresAtMs = Date.parse(stored[STORAGE_KEYS.extensionTokenExpiresAt] || '');

  // expiresAt が未保存(期限導入前に連携した旧形式)の場合は即リフレッシュを試み、
  // 期限付きトークンへ移行させる。
  if (Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() > RENEWAL_THRESHOLD_MS) {
    return { ok: true, skipped: true, reason: 'not_due' };
  }

  const request = await fetchJsonWithTimeout(getApiEndpoint('extension/token/refresh'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ extensionInstanceId }),
  });

  if (!request.ok) {
    console.warn('[extension-sync] token refresh failed; keeping current token', {
      message: request.error?.message,
      timedOut: request.timedOut,
    });
    await recordRefreshFailure(token, null);
    return {
      ok: false,
      reason: request.timedOut ? 'timeout' : 'network_error',
    };
  }
  const { response, data } = request;

  if (response.status === 200) {
    const refreshed = normalizeRefreshSuccess(data);
    if (!refreshed) {
      console.warn('[extension-sync] malformed token refresh response; keeping current token');
      await recordRefreshFailure(token, response.status);
      return { ok: false, reason: 'invalid_response' };
    }

    await storageSet({
      [STORAGE_KEYS.extensionAuthToken]: refreshed.extensionAuthToken,
      [STORAGE_KEYS.extensionTokenExpiresAt]: refreshed.expiresAt,
      [STORAGE_KEYS.extensionLinked]: true,
    });
    await clearRefreshBackoff();
    console.log('[extension-sync] token refreshed', { expiresAt: refreshed.expiresAt });
    return { ok: true, refreshed: true };
  }

  if (response.status === 401) {
    // fetch 中に再連携が起きていた場合、この 401 は旧トークンに対するもの(サイト側 CAS の
    // 競合負け)であり、保存済みの新トークンを消すと連携直後の無言解除になる。
    const current = await storageGet([STORAGE_KEYS.extensionAuthToken]);
    if (current[STORAGE_KEYS.extensionAuthToken] !== token) {
      console.log('[extension-sync] stale 401 for replaced token; keeping current token');
      return { ok: false, reason: 'stale_unauthorized' };
    }

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
  await recordRefreshFailure(token, response.status);
  return { ok: false, reason: 'refresh_failed' };
}
