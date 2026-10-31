// /__mock/api/*。モックの状態の確認・初期化・障害の注入。拡張からは使わない。
import { HttpError, errorBody, readBody, sendJson } from './http.js';
import { faultBody, normalizeFault } from './faults.js';
import { mergeSettings } from './store.js';
import { CatalogError, normalizeCatalog } from './fake-services/catalog.js';
import { SESSION_COOKIE, sessionCookie, clearSessionCookie } from './site/session.js';

async function readOptionalJson(req) {
  const raw = (await readBody(req)).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON body', 'INVALID_JSON');
  }
}

function findLinked(store, id) {
  const linked = store.state.linkedExtensions.find((entry) => entry.id === Number(id));
  if (!linked) throw new HttpError(404, 'Linked extension not found', 'NOT_FOUND');
  return linked;
}

export function stateSnapshot(store, now) {
  const { state } = store;
  return {
    now: new Date(now).toISOString(),
    settings: state.settings,
    catalog: state.catalog,
    users: state.users,
    vods: state.vods,
    sessions: Object.entries(state.sessions).map(([id, userId]) => ({ id, userId })),
    linkTokens: state.linkTokens,
    linkedExtensions: state.linkedExtensions,
    clips: state.clips,
    comments: state.comments,
    playlists: state.playlists,
    syncReceipts: state.syncReceipts,
    faults: state.faults,
    requestCount: state.requests.length,
    lastRequestId: state.requests.at(-1)?.id ?? 0,
  };
}

export async function handleAdminApi(ctx) {
  const { pathname } = ctx.url;
  if (!pathname.startsWith('/__mock/api/')) return false;
  const { store } = ctx;
  const { state } = store;
  const route = pathname.slice('/__mock/api/'.length);
  try {
    if (route === 'state' && ctx.method === 'GET') {
      sendJson(ctx.res, 200, stateSnapshot(store, ctx.now()));
      return true;
    }
    if (route === 'requests' && ctx.method === 'GET') {
      const after = Number(ctx.url.searchParams.get('after') || 0);
      const prefix = ctx.url.searchParams.get('path') || '';
      sendJson(ctx.res, 200, {
        requests: state.requests.filter((entry) => entry.id > after && entry.path.startsWith(prefix)),
      });
      return true;
    }
    if (route === 'reset' && ctx.method === 'POST') {
      const body = await readOptionalJson(ctx.req);
      store.reset({ seed: body.seed === 'empty' ? 'empty' : 'default', keepSettings: body.keepSettings === true });
      sendJson(ctx.res, 200, { ok: true });
      return true;
    }
    if (route === 'catalog') {
      if (ctx.method === 'POST') {
        // 作品と動画を差し替える。video の相対パスはモックを起動したフォルダーから解決する。
        const body = await readOptionalJson(ctx.req);
        try {
          state.catalog = normalizeCatalog(body);
        } catch (error) {
          if (error instanceof CatalogError) throw new HttpError(400, error.message, 'INVALID_CATALOG');
          throw error;
        }
      }
      sendJson(ctx.res, 200, state.catalog);
      return true;
    }
    if (route === 'settings') {
      if (ctx.method === 'POST') {
        const body = await readOptionalJson(ctx.req);
        state.settings = mergeSettings(state.settings, body);
      }
      sendJson(ctx.res, 200, state.settings);
      return true;
    }
    if (route === 'faults') {
      if (ctx.method === 'POST') {
        const body = await readOptionalJson(ctx.req);
        let fault;
        try {
          fault = normalizeFault(body, store.nextId('fault'));
        } catch (error) {
          throw new HttpError(400, error.message, 'INVALID_FAULT');
        }
        state.faults.push(fault);
        sendJson(ctx.res, 201, { ...fault, preview: fault.kind === 'status' ? faultBody(fault) : undefined });
        return true;
      }
      if (ctx.method === 'DELETE') {
        state.faults.splice(0);
        sendJson(ctx.res, 200, { ok: true });
        return true;
      }
      sendJson(ctx.res, 200, state.faults);
      return true;
    }
    const faultMatch = /^faults\/(\d+)$/.exec(route);
    if (faultMatch && ctx.method === 'DELETE') {
      const index = state.faults.findIndex((fault) => fault.id === Number(faultMatch[1]));
      if (index >= 0) state.faults.splice(index, 1);
      sendJson(ctx.res, 200, { ok: index >= 0 });
      return true;
    }
    if (route === 'login' && ctx.method === 'POST') {
      const body = await readOptionalJson(ctx.req);
      const user = store.findUser(body.userId ?? 1);
      if (!user) throw new HttpError(404, 'User not found', 'NOT_FOUND');
      const sessionId = store.createSession(user.id);
      sendJson(ctx.res, 200, { ok: true, userId: user.id, sessionId, cookie: SESSION_COOKIE }, { 'Set-Cookie': sessionCookie(sessionId) });
      return true;
    }
    if (route === 'logout' && ctx.method === 'POST') {
      if (ctx.sessionId) store.endSession(ctx.sessionId);
      sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
      return true;
    }
    const linkedMatch = /^linked-extensions\/(\d+)\/(revoke|expire|delete-user)$/.exec(route);
    if (linkedMatch && ctx.method === 'POST') {
      const linked = findLinked(store, linkedMatch[1]);
      const action = linkedMatch[2];
      if (action === 'revoke') {
        linked.revokedAt = new Date(ctx.now()).toISOString();
      } else if (action === 'expire') {
        const body = await readOptionalJson(ctx.req);
        const inMs = Number.isFinite(body.inMs) ? body.inMs : -1000;
        linked.expiresAt = new Date(ctx.now() + inMs).toISOString();
      } else {
        const user = state.users.find((entry) => entry.id === linked.userId);
        if (user) user.deletedAt = new Date(ctx.now()).toISOString();
      }
      sendJson(ctx.res, 200, linked);
      return true;
    }
    if (route === 'link-tokens/expire' && ctx.method === 'POST') {
      for (const token of state.linkTokens) token.expiresAt = new Date(ctx.now() - 1000).toISOString();
      sendJson(ctx.res, 200, { ok: true, count: state.linkTokens.length });
      return true;
    }
    const clipMatch = /^clips\/(\d+)$/.exec(route);
    if (clipMatch && ctx.method === 'DELETE') {
      const clip = store.findClip(clipMatch[1]);
      if (!clip) throw new HttpError(404, 'Clip not found', 'NOT_FOUND');
      clip.deletedAt = new Date(ctx.now()).toISOString();
      sendJson(ctx.res, 200, clip);
      return true;
    }
    if (route === 'clock' && ctx.method === 'POST') {
      const body = await readOptionalJson(ctx.req);
      ctx.setClockOffset(Number(body.offsetMs) || 0);
      sendJson(ctx.res, 200, { ok: true, now: new Date(ctx.now()).toISOString() });
      return true;
    }
    throw new HttpError(404, 'Unknown mock admin route', 'NOT_FOUND');
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    sendJson(ctx.res, error.status, errorBody(error));
    return true;
  }
}
