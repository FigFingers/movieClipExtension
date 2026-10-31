// HTTP の小さな補助。依存パッケージを使わずに node:http だけで動かす。

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {string} [code]
   * @param {unknown} [details]
   * @param {Record<string, unknown>} [extra] 本文に足す項目（invalidItems など）
   */
  constructor(status, message, code, details, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.extra = extra;
  }
}

export const MAX_BODY_BYTES = 1024 * 1024;

/** @returns {Promise<Buffer>} */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large', 'PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * サイトの parseJsonBody と同じ順で確かめる。Content-Type が JSON でなければ 415、
 * JSON として読めなければ 400 INVALID_JSON。
 */
export async function readJsonBody(req) {
  const mediaType = String(req.headers['content-type'] || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== 'application/json') {
    throw new HttpError(415, 'Content-Type must be application/json', 'UNSUPPORTED_MEDIA_TYPE');
  }
  const raw = (await readBody(req)).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new HttpError(400, 'Invalid JSON body', 'INVALID_JSON', error.message);
  }
}

export function sendJson(res, status, data, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

export function sendHtml(res, status, html, headers = {}) {
  sendText(res, status, html, 'text/html; charset=utf-8', headers);
}

export function redirect(res, location, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

/** @returns {Record<string, string>} */
export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      cookies[name] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** HTML の中の <script type="application/json"> に安全に埋め込む。 */
export function jsonForScript(value) {
  // エスケープ列をソースに書かず、文字コードから組み立てる（エディターの変換で壊れないように）。
  const backslash = String.fromCharCode(92);
  return JSON.stringify(value)
    .replace(/</g, `${backslash}u003c`)
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), `${backslash}u2028`)
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), `${backslash}u2029`);
}

export function errorBody(error) {
  return {
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}),
    ...(error.extra || {}),
  };
}
