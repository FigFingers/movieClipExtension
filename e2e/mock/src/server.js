// モックのサーバー。2 つの役割がある。
//   1. 擬似の配信サービス（Netflix・Disney+）の画面と動画（src/fake-services/）。カタログで作品と動画を決める
//   2. 拡張がつなぐサイト（react--site）の API と画面（src/site/）。再生の引き継ぎや同期を試すときに使う
//
// 拡張の接続先は http://localhost:3000 に固定されている（拡張の src/api.js、Design Doc G-12）。
// 3000 番を別のプロセス（本物のサイトの開発サーバーなど）が使っているときは、このサーバーを別の
// ポートで起動し、ブラウザーのプロキシに指定する。プロキシとして届いた http://localhost:3000/* の
// 要求はサイトとして扱い、それ以外のホストへの要求は外へ出さずに断る。
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, errorBody, parseCookies, sendJson, sendText } from './http.js';
import { faultBody, takeFault } from './faults.js';
import { createStore } from './store.js';
import { normalizeCatalog } from './fake-services/catalog.js';
import { extensionCorsHeaders, handleExtensionApi } from './site/extension-api.js';
import { handleV1Api } from './site/v1-api.js';
import { handleAdminApi } from './admin.js';
import { handlePages } from './site/pages.js';
import { handleFakeServices } from './fake-services/routes.js';
import { SESSION_COOKIE } from './site/session.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIRS = {
  '/__mock-assets/': path.join(SRC_DIR, 'site', 'public'),
  '/__fake-assets/': path.join(SRC_DIR, 'fake-services', 'public'),
};
export const SITE_HOSTS = Object.freeze(['localhost:3000', '127.0.0.1:3000']);

const CONTENT_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

const REDACTED_KEYS = new Set(['linkToken', 'extensionAuthToken', 'token']);

function redact(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    REDACTED_KEYS.has(key) && typeof item === 'string' ? `***${item.slice(-4)}` : redact(item, depth + 1),
  ]));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function serveAsset(res, prefix, pathname) {
  const name = pathname.slice(prefix.length);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return false;
  const dir = ASSET_DIRS[prefix];
  try {
    const body = await readFile(path.join(dir, name));
    sendText(res, 200, body, CONTENT_TYPES[path.extname(name)] || 'application/octet-stream');
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} [options]
 * @param {number} [options.port] 0 なら空いているポート
 * @param {string} [options.host]
 * @param {object} [options.catalog] 擬似の配信サービスの作品（fake-services/catalog.js の形）。省くと既定のカタログ
 * @param {'default' | 'empty'} [options.seed] サイトのモックの初期データ
 * @param {boolean} [options.quiet]
 * @param {ReturnType<typeof createStore>} [options.store]
 */
export function createMockServer({ port = 3000, host = '127.0.0.1', catalog, seed = 'default', quiet = true, store } = {}) {
  const mockStore = store ?? createStore({ seed, ...(catalog ? { catalog: normalizeCatalog(catalog) } : {}) });
  let clockOffsetMs = 0;
  const now = () => Date.now() + clockOffsetMs;
  const ownHosts = new Set();

  async function handle(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const proxied = /^https?:\/\//i.test(req.url || '');
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const hostKey = url.host.toLowerCase();

    if (proxied && !SITE_HOSTS.includes(hostKey) && !ownHosts.has(hostKey)) {
      mockStore.logRequest({ method, path: url.pathname, host: hostKey, status: 502, blocked: true });
      sendText(res, 502, `The mock proxy does not forward requests to ${hostKey}.`);
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[SESSION_COOKIE] || null;
    // 静的ファイルと管理 API 以外を記録する（サイトの画面の読み込みも、拡張が開いたかの確認に使う）。
    const logged = !/^\/(?:__mock-assets|__fake-assets|__fake-media|__mock\/api)\//.test(url.pathname) && url.pathname !== '/favicon.ico';
    const entry = logged
      ? mockStore.logRequest({
          method,
          path: url.pathname,
          query: url.search || undefined,
          host: hostKey,
          origin: req.headers.origin || null,
          authorization: req.headers.authorization ? 'Bearer ***' : null,
          status: null,
        })
      : null;
    const startedAt = Date.now();
    if (entry) {
      res.on('finish', () => {
        entry.status = res.statusCode;
        entry.durationMs = Date.now() - startedAt;
      });
      res.on('close', () => {
        if (entry.status === null) entry.status = res.writableFinished ? res.statusCode : 'closed';
      });
    }

    const ctx = {
      req,
      res,
      url,
      method,
      store: mockStore,
      cookies,
      sessionId,
      sessionUser: mockStore.sessionUser(sessionId),
      now,
      setClockOffset: (offset) => {
        clockOffsetMs = offset;
      },
      logBody: (body) => {
        if (!entry) return;
        const text = JSON.stringify(redact(body));
        entry.body = text.length > 8192 ? `${text.slice(0, 8192)}…` : JSON.parse(text);
      },
      note: (detail) => {
        if (entry) entry.note = { ...(entry.note || {}), ...detail };
      },
    };

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname.startsWith('/__mock-assets/') && (await serveAsset(res, '/__mock-assets/', url.pathname))) return;
    if (url.pathname.startsWith('/__fake-assets/') && (await serveAsset(res, '/__fake-assets/', url.pathname))) return;
    if (await handleAdminApi(ctx)) return;

    if (url.pathname.startsWith('/api/') && method !== 'OPTIONS') {
      const fault = takeFault(mockStore.state.faults, method, url.pathname);
      if (fault) {
        if (entry) entry.fault = { id: fault.id, kind: fault.kind, status: fault.kind === 'status' ? fault.status : undefined };
        if (fault.kind === 'delay') {
          await sleep(fault.delayMs);
        } else if (fault.kind === 'hang') {
          // 拡張の AbortController が切るまで返さない。
          req.on('close', () => res.destroy());
          return;
        } else if (fault.kind === 'reset') {
          req.socket.destroy();
          return;
        } else if (fault.kind === 'malformed') {
          sendText(res, 200, '{"ok": tru', 'application/json', extensionCorsHeaders(ctx));
          return;
        } else {
          if (fault.delayMs) await sleep(fault.delayMs);
          sendJson(res, fault.status, faultBody(fault), extensionCorsHeaders(ctx));
          return;
        }
      }
    }

    if (await handleFakeServices(ctx)) return;
    if (await handleExtensionApi(ctx)) return;
    if (await handleV1Api(ctx)) return;
    if (await handlePages(ctx)) return;
    sendText(res, 404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, errorBody(error));
        return;
      }
      if (!quiet) console.error('[mock] request failed', error);
      sendJson(res, 500, { message: 'Internal server error', code: 'INTERNAL_ERROR' });
    });
  });
  // プロキシとしての CONNECT（https）は外へ出さない。擬似サービスの https はハーネスの route が返す。
  // ただし、カタログで https の動画を指定した作品の配信元へは中継する（ブラウザーが動画を直接取りに行くため）。
  server.on('connect', (req, socket, head) => {
    socket.on('error', () => {});
    const [hostname, portText = '443'] = String(req.url || '').split(':');
    const allowed = Object.values(mockStore.state.catalog).some((service) => service.titles.some((title) =>
      title.video?.kind === 'url' && new URL(title.video.url).hostname === hostname));
    if (!allowed || portText !== '443') {
      mockStore.logRequest({ method: 'CONNECT', path: req.url, host: hostname, status: 403, blocked: true });
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(443, hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return {
    store: mockStore,
    server,
    now,
    /** @returns {Promise<{ port: number, origin: string }>} */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          ownHosts.add(`${host}:${address.port}`.toLowerCase());
          ownHosts.add(`localhost:${address.port}`);
          ownHosts.add(`127.0.0.1:${address.port}`);
          resolve({ port: address.port, origin: `http://${host}:${address.port}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
