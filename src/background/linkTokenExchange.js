import { getApiEndpoint, SITE_ORIGIN } from './../api.js';
import {
  STORAGE_KEYS,
  storageGet,
  storageRemove,
  storageSet,
} from './../shared/storage.js';
import { runExclusive, syncPendingQueue } from './sync.js';

// 90 日の拡張用トークンは background だけが受け取り、画面と content script には linkToken だけを通す。
export const LINK_WITH_LINK_TOKEN = 'LINK_WITH_LINK_TOKEN';

const LINK_REQUEST_TIMEOUT_MS = 15 * 1000;
const MAX_TOKEN_LENGTH = 4096;
const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SITE_ORIGINS = new Set([
  SITE_ORIGIN,
  SITE_ORIGIN.replace('//localhost', '//127.0.0.1'),
]);

// Bearer のヘッダー値として送れる文字だけを許す。中身は解釈しない。
export function isValidOpaqueToken(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_TOKEN_LENGTH
    && /^[\x21-\x7e]+$/.test(value);
}

export function isValidInstanceId(value) {
  return typeof value === 'string' && INSTANCE_ID_PATTERN.test(value);
}

// サイトのページで動く content script からの要求だけを受ける（Netflix 等のタブや拡張ページは拒否）。
export function isSiteSender(sender) {
  const source = sender?.origin || sender?.url;
  if (typeof source !== 'string') return false;
  try {
    return SITE_ORIGINS.has(new URL(source).origin);
  } catch {
    return false;
  }
}

function normalizeExpiry(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const expiresAtMs = Date.parse(value);
  return Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null;
}

export function getLinkFailureReason(status, body) {
  if (status === 400 && body?.code === 'LINK_TOKEN_EXPIRED') return 'link_token_expired';
  if (status === 400) return 'invalid_request';
  if (status === 401) return 'link_token_invalid';
  if (status === 403) return 'origin_not_allowed';
  if (status === 409) return 'link_token_used';
  return 'link_failed';
}

// sync・リフレッシュと同じ排他の中で書く（exchangeLinkToken の saveAuthToken で差し替えられる）。
export function saveLinkedAuthToken({ extensionInstanceId, extensionAuthToken, expiresAt }) {
  return runExclusive(async () => {
    const stored = await storageGet([STORAGE_KEYS.extensionInstanceId]);
    if (stored[STORAGE_KEYS.extensionInstanceId] !== extensionInstanceId) {
      return { ok: false, reason: 'instance_mismatch' };
    }

    await storageSet({
      [STORAGE_KEYS.extensionAuthToken]: extensionAuthToken,
      [STORAGE_KEYS.extensionTokenExpiresAt]: normalizeExpiry(expiresAt),
      [STORAGE_KEYS.extensionLinked]: true,
    });
    // 旧トークンで積み上がったリフレッシュの抑制を新しいトークンに持ち越さない。
    await storageRemove([STORAGE_KEYS.extensionTokenRefreshBackoff]);
    return { ok: true };
  });
}

async function postLinkRequest(fetchImpl, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(getApiEndpoint('extension/link'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function exchangeLinkToken(message, {
  fetchImpl = globalThis.fetch,
  saveAuthToken = saveLinkedAuthToken,
  afterLinked = () => syncPendingQueue(),
  timeoutMs = LINK_REQUEST_TIMEOUT_MS,
} = {}) {
  const linkToken = message?.linkToken;
  if (!isValidOpaqueToken(linkToken)) {
    return { ok: false, reason: 'invalid_link_token' };
  }

  // サーバーへ送る ID は background が持つ値に限る。画面の値と違えば linkToken を使わない。
  const stored = await storageGet([STORAGE_KEYS.extensionInstanceId]);
  const extensionInstanceId = stored[STORAGE_KEYS.extensionInstanceId];
  if (!isValidInstanceId(extensionInstanceId) || message?.extensionInstanceId !== extensionInstanceId) {
    return { ok: false, reason: 'instance_mismatch' };
  }

  let result;
  try {
    result = await postLinkRequest(fetchImpl, { extensionInstanceId, linkToken }, timeoutMs);
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'network_error' };
  }

  if (!result.ok) {
    return {
      ok: false,
      reason: getLinkFailureReason(result.status, result.body),
      status: result.status,
    };
  }
  if (result.body?.ok !== true || !isValidOpaqueToken(result.body?.extensionAuthToken)) {
    return { ok: false, reason: 'invalid_response', status: result.status };
  }

  const saved = await saveAuthToken({
    extensionInstanceId,
    extensionAuthToken: result.body.extensionAuthToken,
    expiresAt: result.body.expiresAt,
  });
  if (!saved?.ok) {
    return { ok: false, reason: saved?.reason || 'save_failed' };
  }

  // 連携前に貯まったクリップを送る。画面への応答はこの完了を待たない。
  Promise.resolve().then(afterLinked).catch(() => {});
  return { ok: true, linked: true };
}

// 並行すると古い応答が後から保存され、無効なトークンが残りうるため1件ずつ交換する。
let exchangeTail = Promise.resolve();
function exchangeInOrder(message, deps) {
  const run = exchangeTail.then(() => exchangeLinkToken(message, deps));
  exchangeTail = run.catch(() => {});
  return run;
}

export function handleLinkTokenMessage(message, sender, deps) {
  if (message?.type !== LINK_WITH_LINK_TOKEN) return null;
  if (!isSiteSender(sender)) {
    return Promise.resolve({ ok: false, reason: 'forbidden' });
  }
  return exchangeInOrder(message, deps);
}

export function registerLinkTokenExchange(deps) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const pending = handleLinkTokenMessage(message, sender, deps);
    if (!pending) return;

    pending
      .then((result) => {
        if (!result?.ok) {
          console.warn('[extension-link] link token exchange failed', {
            reason: result?.reason,
            status: result?.status ?? null,
          });
        }
        sendResponse(result);
      })
      .catch((error) => sendResponse({
        ok: false,
        reason: 'link_error',
        message: error?.message,
      }));
    return true;
  });
}
