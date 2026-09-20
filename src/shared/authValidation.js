const EXTENSION_INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EXTENSION_AUTH_TOKEN_LENGTH = 4096;

export function isValidExtensionInstanceId(value) {
  return typeof value === 'string'
    && EXTENSION_INSTANCE_ID_PATTERN.test(value);
}

// Bearer認証情報はHTTPヘッダー値として送信する。トークンの内容は解釈せず、
// 単一のヘッダー値として安全に表現できないものだけを拒否する。
export function isValidExtensionAuthToken(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_EXTENSION_AUTH_TOKEN_LENGTH
    && /^[\x21-\x7e]+$/.test(value);
}

export function normalizeExtensionTokenExpiry(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const expiresAtMs = Date.parse(value);
  return Number.isFinite(expiresAtMs)
    ? new Date(expiresAtMs).toISOString()
    : null;
}
