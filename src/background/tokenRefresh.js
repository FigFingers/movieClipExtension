import { getApiEndpoint } from './../api.js';
import {
  STORAGE_KEYS,
  storageGet,
  storageSet,
  clearExtensionAuthState,
} from './../shared/storage.js';
import { runExclusive } from './sync.js';

// トークンはサーバ発行の不透明トークン(JWT ではない)。期限はサーバが link/refresh 応答の
// expiresAt で通知し、拡張は storage に保存した値だけを見て更新時期を判断する。
const RENEWAL_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000;

export function checkAndRefreshToken() {
  return runExclusive(performCheckAndRefreshToken);
}

async function performCheckAndRefreshToken() {
  const stored = await storageGet([
    STORAGE_KEYS.extensionAuthToken,
    STORAGE_KEYS.extensionInstanceId,
    STORAGE_KEYS.extensionTokenExpiresAt,
  ]);
  const token = stored[STORAGE_KEYS.extensionAuthToken];
  const extensionInstanceId = stored[STORAGE_KEYS.extensionInstanceId];

  if (!token || !extensionInstanceId) {
    return { ok: true, skipped: true, reason: 'not_linked' };
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
    return { ok: false, reason: 'network_error' };
  }

  if (response.status === 200 && typeof data?.extensionAuthToken === 'string') {
    await storageSet({
      [STORAGE_KEYS.extensionAuthToken]: data.extensionAuthToken,
      [STORAGE_KEYS.extensionTokenExpiresAt]: data.expiresAt || null,
      [STORAGE_KEYS.extensionLinked]: true,
    });
    console.log('[extension-sync] token refreshed', { expiresAt: data.expiresAt });
    return { ok: true, refreshed: true };
  }

  if (response.status === 401) {
    // 失効・解除・ローテーション競合負け。トークンを破棄し、次のユーザー操作時の
    // 再ログイン導線(sync の missing_token 経路)に任せる。
    await clearExtensionAuthState();
    console.warn('[extension-sync] token refresh unauthorized; cleared token');
    return { ok: false, reason: 'unauthorized' };
  }

  console.warn('[extension-sync] token refresh failed; keeping current token', {
    status: response.status,
  });
  return { ok: false, reason: 'refresh_failed' };
}
