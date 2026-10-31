// /api/v1/*。拡張が使うのは GET /api/v1/clips（記録一覧）だけ。
// サイトの画面（モック）が使う最小限の API も置く。
import { HttpError, errorBody, sendJson } from '../http.js';
import { flattenIssues, validateClipListQuery } from './validation.js';

function encodeCursor(clip) {
  return Buffer.from(JSON.stringify({ c: clip.createdAt, i: String(clip.id), v: 1 })).toString('base64url');
}

function decodeCursor(value) {
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof payload?.c !== 'string' || !/^\d+$/.test(payload?.i)) throw new Error('bad cursor');
    return { createdAt: payload.c, id: Number(payload.i) };
  } catch {
    throw new HttpError(400, 'Invalid cursor', 'INVALID_CURSOR');
  }
}

/** listCursor の include: { vod: true, user: { select: { id, name } } } と同じ形。 */
export function clipView(store, clip) {
  const vod = store.findVod(clip.vodId);
  const user = store.state.users.find((entry) => entry.id === clip.userId);
  return {
    id: clip.id,
    userId: clip.userId,
    vodId: clip.vodId,
    name: clip.name,
    title: clip.title,
    views: clip.views,
    startMs: clip.startMs,
    endMs: clip.endMs,
    url: clip.url,
    epnum: clip.epnum,
    createdAt: clip.createdAt,
    updatedAt: clip.updatedAt,
    deletedAt: clip.deletedAt,
    vod: vod ? { id: vod.id, code: vod.code, name: vod.name, createdAt: clip.createdAt, updatedAt: clip.createdAt, deletedAt: null } : null,
    user: user ? { id: user.id, name: user.name } : null,
  };
}

function keywordsOf(raw) {
  return String(raw || '').trim().split(/\s+/).filter(Boolean).map((keyword) => keyword.toLowerCase());
}

export function listClips(store, { limit = 20, cursor, userId, vodId, title } = {}) {
  const keywords = keywordsOf(title);
  const after = cursor ? decodeCursor(cursor) : null;
  const rows = store.state.clips
    .filter((clip) => clip.deletedAt === null)
    .filter((clip) => userId === undefined || clip.userId === userId)
    .filter((clip) => vodId === undefined || clip.vodId === vodId)
    .filter((clip) => {
      if (keywords.length === 0) return true;
      const vodName = store.findVod(clip.vodId)?.name || '';
      const haystacks = [clip.title, clip.name, clip.epnum || '', vodName].map((value) => value.toLowerCase());
      return keywords.every((keyword) => haystacks.some((value) => value.includes(keyword)));
    })
    .sort((a, b) => (b.createdAt.localeCompare(a.createdAt)) || (b.id - a.id))
    .filter((clip) => !after
      || clip.createdAt < after.createdAt
      || (clip.createdAt === after.createdAt && clip.id < after.id));
  const hasNext = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    data: page.map((clip) => clipView(store, clip)),
    meta: { limit, hasNext, nextCursor: hasNext ? encodeCursor(page.at(-1)) : null },
  };
}

export async function handleV1Api(ctx) {
  const { pathname } = ctx.url;
  if (!pathname.startsWith('/api/v1/')) return false;
  try {
    if (pathname === '/api/v1/health' && ctx.method === 'GET') {
      sendJson(ctx.res, 200, { ok: true });
      return true;
    }
    if (pathname === '/api/v1/clips' && ctx.method === 'GET') {
      const parsed = validateClipListQuery(ctx.url.searchParams);
      if (!parsed.ok) throw new HttpError(400, 'Invalid query parameters', 'INVALID_QUERY', flattenIssues(parsed.issues));
      sendJson(ctx.res, 200, listClips(ctx.store, parsed.value));
      return true;
    }
    const clipMatch = /^\/api\/v1\/clips\/(\d+)$/.exec(pathname);
    if (clipMatch && ctx.method === 'GET') {
      const clip = ctx.store.findClip(clipMatch[1]);
      if (!clip) throw new HttpError(404, 'Clip not found', 'NOT_FOUND');
      sendJson(ctx.res, 200, clipView(ctx.store, clip));
      return true;
    }
    if (pathname === '/api/v1/me' && ctx.method === 'GET') {
      if (!ctx.sessionUser) throw new HttpError(401, 'Authentication required', 'UNAUTHORIZED');
      const { id, name, email } = ctx.sessionUser;
      sendJson(ctx.res, 200, { id, name, email });
      return true;
    }
    throw new HttpError(404, 'Not found', 'NOT_FOUND');
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    sendJson(ctx.res, error.status, errorBody(error));
    return true;
  }
}
