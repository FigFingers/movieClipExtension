// /api/extension/*。サイト（react--site）の src/app/api/extension/**/route.ts と
// src/server/services/extensions.ts・comments.ts の動作を写す。
import { HttpError, errorBody, readJsonBody, sendJson } from '../http.js';
import { opaqueToken } from '../store.js';
import {
  flattenIssues,
  validateCommentCreateBody,
  validateCommentListQuery,
  validateLinkBody,
  validateRefreshBody,
  validateSyncBody,
  validateUnlinkBody,
} from './validation.js';

// ---------------------------------------------------------------------------
// Origin と CORS（src/server/http/cors.ts）
// ---------------------------------------------------------------------------

function originMatches(pattern, origin) {
  if (pattern === origin) return true;
  if (pattern.endsWith('://*')) {
    const scheme = pattern.slice(0, -1);
    const rest = origin.slice(scheme.length);
    return origin.startsWith(scheme) && rest.length > 0 && !rest.includes('/');
  }
  return false;
}

export function isAllowedOrigin(settings, origin) {
  if (!origin) return true;
  return settings.allowedOrigins.some((pattern) => originMatches(pattern, origin));
}

export function extensionCorsHeaders(ctx, methods = ['GET', 'POST', 'OPTIONS']) {
  const origin = ctx.req.headers.origin;
  const headers = {
    'Access-Control-Allow-Methods': methods.join(', '),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
  if (origin && isAllowedOrigin(ctx.store.state.settings, origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

function forbiddenOrigin() {
  return new HttpError(403, 'OriginNotAllowed', 'FORBIDDEN');
}

function unauthorized(message = 'Unauthorized') {
  return new HttpError(401, message, 'UNAUTHORIZED');
}

function parseBearerToken(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(header || '').trim());
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// 検証エラーの応答
// ---------------------------------------------------------------------------

function invalidRequest(ctx, issues, { message = 'Invalid request body', code = 'INVALID_BODY', items } = {}) {
  const format = ctx.store.state.settings.validationErrorFormat;
  if (format === 'site-prod') return new HttpError(400, message, code);
  if (format === 'invalid-items' && Array.isArray(items)) {
    const invalidItems = [];
    for (const issue of issues) {
      if (issue.path[0] !== 'items' || !Number.isInteger(issue.path[1])) continue;
      const clientItemId = items[issue.path[1]]?.clientItemId;
      if (typeof clientItemId !== 'string') continue;
      invalidItems.push({
        clientItemId,
        field: issue.path.slice(2).filter((part) => part !== 'payload').join('.') || null,
        code: issue.code,
      });
    }
    if (invalidItems.length > 0) {
      return new HttpError(400, 'Invalid items', 'INVALID_ITEMS', undefined, { invalidItems });
    }
  }
  return new HttpError(400, message, code, flattenIssues(issues));
}

// ---------------------------------------------------------------------------
// 連携済み拡張の認証（authenticateLinkedExtension）
// ---------------------------------------------------------------------------

function authenticate(ctx, extensionInstanceId, token) {
  const { state } = ctx.store;
  const linked = state.linkedExtensions.find((entry) =>
    entry.extensionInstanceId === extensionInstanceId && entry.revokedAt === null);
  if (!linked || linked.authToken !== token) throw unauthorized();
  if (Date.parse(linked.expiresAt) <= ctx.now()) throw unauthorized();
  if (!ctx.store.findUser(linked.userId)) throw unauthorized();
  return linked;
}

function touch(ctx, linked) {
  linked.lastSeenAt = new Date(ctx.now()).toISOString();
}

// ---------------------------------------------------------------------------
// ハンドラー
// ---------------------------------------------------------------------------

async function linkToken(ctx) {
  const user = ctx.sessionUser;
  if (!user) throw new HttpError(401, 'Authentication required', 'UNAUTHORIZED');
  const { state } = ctx.store;
  const token = opaqueToken();
  const expiresAt = new Date(ctx.now() + state.settings.linkTokenTtlMs).toISOString();
  state.linkTokens.push({ token, userId: user.id, expiresAt, usedAt: null, createdAt: new Date(ctx.now()).toISOString() });
  return { status: 200, body: { linkToken: token, expiresAt } };
}

async function link(ctx) {
  const body = await readJsonBody(ctx.req);
  ctx.logBody(body);
  const parsed = validateLinkBody(body);
  if (!parsed.ok) throw invalidRequest(ctx, parsed.issues);
  const { state } = ctx.store;
  const record = state.linkTokens.find((entry) => entry.token === parsed.value.linkToken.trim());
  if (!record) throw unauthorized('Invalid link token');
  if (record.usedAt) throw new HttpError(409, 'Link token already used', 'CONFLICT');
  if (Date.parse(record.expiresAt) <= ctx.now()) throw new HttpError(400, 'Link token expired', 'LINK_TOKEN_EXPIRED');
  if (!ctx.store.findUser(record.userId)) throw unauthorized();
  record.usedAt = new Date(ctx.now()).toISOString();

  const extensionAuthToken = opaqueToken();
  const expiresAt = new Date(ctx.now() + state.settings.authTokenTtlMs).toISOString();
  const nowIso = new Date(ctx.now()).toISOString();
  const existing = state.linkedExtensions.find((entry) =>
    entry.extensionInstanceId === parsed.value.extensionInstanceId && entry.revokedAt === null);
  if (existing) {
    if (existing.userId !== record.userId && !state.settings.relinkReassignsUser) {
      throw new HttpError(409, 'Extension is linked to another user', 'CONFLICT');
    }
    if (existing.userId !== record.userId) {
      existing.previousUserIds = [...(existing.previousUserIds || []), existing.userId];
    }
    Object.assign(existing, {
      userId: record.userId,
      authToken: extensionAuthToken,
      expiresAt,
      lastSeenAt: nowIso,
    });
  } else {
    state.linkedExtensions.push({
      id: ctx.store.nextId('linkedExtension'),
      userId: record.userId,
      extensionInstanceId: parsed.value.extensionInstanceId,
      authToken: extensionAuthToken,
      expiresAt,
      linkedAt: nowIso,
      lastSeenAt: nowIso,
      revokedAt: null,
      rotations: 0,
    });
  }
  return { status: 200, body: { ok: true, extensionAuthToken, expiresAt } };
}

async function unlink(ctx) {
  const user = ctx.sessionUser;
  if (!user) throw new HttpError(401, 'Authentication required', 'UNAUTHORIZED');
  const body = await readJsonBody(ctx.req);
  ctx.logBody(body);
  const parsed = validateUnlinkBody(body);
  if (!parsed.ok) throw invalidRequest(ctx, parsed.issues);
  const linked = ctx.store.state.linkedExtensions.find((entry) =>
    entry.id === parsed.value.linkedExtensionId && entry.userId === user.id && entry.revokedAt === null);
  if (!linked) throw new HttpError(404, 'Linked extension not found', 'NOT_FOUND');
  linked.revokedAt = new Date(ctx.now()).toISOString();
  return { status: 200, body: { ok: true, extensionInstanceId: linked.extensionInstanceId } };
}

async function session(ctx) {
  return { status: 200, body: { loggedIn: Boolean(ctx.sessionUser) } };
}

async function sync(ctx) {
  const token = parseBearerToken(ctx.req.headers.authorization);
  if (!token) throw new HttpError(401, 'Authentication required', 'UNAUTHORIZED');
  const body = await readJsonBody(ctx.req);
  ctx.logBody(body);
  const parsed = validateSyncBody(body);
  if (!parsed.ok) {
    throw invalidRequest(ctx, parsed.issues, { items: Array.isArray(body?.items) ? body.items : undefined });
  }
  const linked = authenticate(ctx, parsed.value.extensionInstanceId, token);

  // buildLegacyClipCreateData: VOD を引けない項目があると、一括全体が 404 になる。
  const inputs = parsed.value.items.map((item) => {
    const vod = ctx.store.findVodByLookup(item.payload.service);
    if (!vod) throw new HttpError(404, 'VOD not found', 'NOT_FOUND');
    return { item, vod };
  });

  const { state } = ctx.store;
  const created = [];
  for (const { item, vod } of inputs) {
    const key = `${linked.id}:${item.clientItemId.toLowerCase()}`;
    if (state.syncReceipts.includes(key)) continue;
    state.syncReceipts.push(key);
    const nowIso = new Date(ctx.now()).toISOString();
    const clip = {
      id: ctx.store.nextId('clip'),
      userId: linked.userId,
      vodId: vod.id,
      name: item.payload.clipName?.trim() || '切り抜き',
      title: item.payload.title.trim(),
      startMs: Math.round(item.payload.StartTime * 1000),
      endMs: Math.round(item.payload.EndTime * 1000),
      url: item.payload.URL.trim(),
      epnum: item.payload.epnumber?.trim() || null,
      views: 0,
      createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : nowIso,
      updatedAt: nowIso,
      deletedAt: null,
      // モックだけの記録。どの拡張・どの clientItemId から来たかを状態の画面で見られるようにする。
      source: { linkedExtensionId: linked.id, clientItemId: item.clientItemId, service: item.payload.service },
    };
    state.clips.push(clip);
    created.push(clip.id);
  }
  touch(ctx, linked);
  ctx.note({ createdClipIds: created });
  return { status: 200, body: { ok: true, acceptedItemIds: parsed.value.items.map((item) => item.clientItemId) } };
}

async function refresh(ctx) {
  const token = parseBearerToken(ctx.req.headers.authorization);
  if (!token) throw new HttpError(401, 'Authentication required', 'UNAUTHORIZED');
  const body = await readJsonBody(ctx.req);
  ctx.logBody(body);
  const parsed = validateRefreshBody(body);
  if (!parsed.ok) throw invalidRequest(ctx, parsed.issues);
  const linked = authenticate(ctx, parsed.value.extensionInstanceId, token);
  const extensionAuthToken = opaqueToken();
  const expiresAt = new Date(ctx.now() + ctx.store.state.settings.authTokenTtlMs).toISOString();
  linked.authToken = extensionAuthToken;
  linked.expiresAt = expiresAt;
  linked.rotations = (linked.rotations || 0) + 1;
  touch(ctx, linked);
  return { status: 200, body: { ok: true, extensionAuthToken, expiresAt } };
}

function commentView(ctx, comment) {
  const user = ctx.store.findUser(comment.userId);
  return {
    id: comment.id,
    clipId: comment.clipId,
    userId: user ? comment.userId : null,
    username: user ? user.name : null,
    body: comment.body,
    atMs: comment.atMs,
    createdAt: comment.createdAt,
  };
}

function parseClipIdParam(value) {
  if (!/^\d+$/.test(value)) {
    throw new HttpError(400, 'Invalid route params', 'INVALID_PARAMS', { formErrors: [], fieldErrors: { clipId: ['Invalid id'] } });
  }
  const clipId = Number(value);
  if (!Number.isSafeInteger(clipId) || clipId <= 0) {
    throw new HttpError(400, 'Invalid route params', 'INVALID_PARAMS', { formErrors: [], fieldErrors: { clipId: ['Invalid id'] } });
  }
  return clipId;
}

async function listComments(ctx, clipIdParam) {
  const token = parseBearerToken(ctx.req.headers.authorization);
  if (!token) throw new HttpError(401, 'Authentication required', 'UNAUTHORIZED');
  const clipId = parseClipIdParam(clipIdParam);
  const parsed = validateCommentListQuery(ctx.url.searchParams);
  if (!parsed.ok) throw invalidRequest(ctx, parsed.issues, { message: 'Invalid query parameters', code: 'INVALID_QUERY' });
  const linked = authenticate(ctx, parsed.value.extensionInstanceId, token);
  const clip = ctx.store.findClip(clipId);
  if (!clip) throw new HttpError(404, 'Clip not found', 'NOT_FOUND');
  const { cursor, limit } = parsed.value;
  const all = ctx.store.state.comments
    .filter((comment) => comment.clipId === clipId && comment.deletedAt === null && (cursor === undefined || comment.id < cursor))
    .sort((a, b) => b.id - a.id);
  const hasNext = all.length > limit;
  const page = all.slice(0, limit);
  touch(ctx, linked);
  return {
    status: 200,
    body: {
      ok: true,
      clipId,
      comments: page.map((comment) => commentView(ctx, comment)),
      hasNext,
      nextCursor: hasNext ? page.at(-1).id : null,
    },
  };
}

async function postComment(ctx, clipIdParam) {
  const token = parseBearerToken(ctx.req.headers.authorization);
  if (!token) throw new HttpError(401, 'Authentication required', 'UNAUTHORIZED');
  const clipId = parseClipIdParam(clipIdParam);
  const body = await readJsonBody(ctx.req);
  ctx.logBody(body);
  const parsed = validateCommentCreateBody(body);
  if (!parsed.ok) throw invalidRequest(ctx, parsed.issues);
  const linked = authenticate(ctx, parsed.value.extensionInstanceId, token);
  const clip = ctx.store.findClip(clipId);
  if (!clip) throw new HttpError(404, 'Clip not found', 'NOT_FOUND');
  const { state } = ctx.store;
  const { atMs = null, clientRequestId } = parsed.value;
  if (atMs !== null && (atMs < clip.startMs || atMs > clip.endMs)) {
    throw new HttpError(400, 'atMs is outside the clip range', 'AT_MS_OUT_OF_RANGE');
  }
  if (clientRequestId) {
    const replay = state.comments.find((comment) =>
      comment.userId === linked.userId && comment.clientRequestId === clientRequestId);
    if (replay) {
      ctx.note({ idempotentReplay: true });
      return { status: 201, body: { ok: true, comment: commentView(ctx, replay) } };
    }
  }
  const windowStart = ctx.now() - 60_000;
  const recent = state.comments.filter((comment) =>
    comment.userId === linked.userId && Date.parse(comment.createdAt) > windowStart).length;
  if (recent >= state.settings.commentRateLimitPerMinute) {
    throw new HttpError(429, 'Too many comments', 'COMMENT_RATE_LIMITED', { limit: state.settings.commentRateLimitPerMinute, windowSeconds: 60 });
  }
  const comment = {
    id: ctx.store.nextId('comment'),
    clipId,
    userId: linked.userId,
    body: parsed.value.body,
    atMs,
    clientRequestId: clientRequestId ?? null,
    createdAt: new Date(ctx.now()).toISOString(),
    deletedAt: null,
  };
  state.comments.push(comment);
  touch(ctx, linked);
  return { status: 201, body: { ok: true, comment: commentView(ctx, comment) } };
}

// ---------------------------------------------------------------------------
// 振り分け
// ---------------------------------------------------------------------------

const ROUTES = [
  { path: /^\/api\/extension\/link-token$/, methods: { POST: linkToken }, allow: ['POST', 'OPTIONS'] },
  { path: /^\/api\/extension\/link$/, methods: { POST: link }, allow: ['POST', 'OPTIONS'] },
  { path: /^\/api\/extension\/unlink$/, methods: { POST: unlink }, allow: ['POST', 'OPTIONS'] },
  { path: /^\/api\/extension\/session$/, methods: { GET: session }, allow: ['GET', 'POST', 'OPTIONS'] },
  { path: /^\/api\/extension\/sync$/, methods: { POST: sync }, allow: ['POST', 'OPTIONS'] },
  { path: /^\/api\/extension\/token\/refresh$/, methods: { POST: refresh }, allow: ['POST', 'OPTIONS'] },
  {
    path: /^\/api\/extension\/clips\/([^/]+)\/comments$/,
    methods: { GET: listComments, POST: postComment },
    allow: ['GET', 'POST', 'OPTIONS'],
  },
];

/** @returns {Promise<boolean>} 扱ったら true */
export async function handleExtensionApi(ctx) {
  const route = ROUTES.find((entry) => entry.path.test(ctx.url.pathname));
  if (!route) return false;
  const params = route.path.exec(ctx.url.pathname).slice(1);
  const headers = extensionCorsHeaders(ctx, route.allow);
  const allowed = isAllowedOrigin(ctx.store.state.settings, ctx.req.headers.origin);

  if (ctx.method === 'OPTIONS') {
    ctx.res.writeHead(allowed ? 200 : 403, headers);
    ctx.res.end();
    return true;
  }
  const handler = route.methods[ctx.method];
  if (!handler) {
    sendJson(ctx.res, 405, { message: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, headers);
    return true;
  }
  try {
    if (!allowed) throw forbiddenOrigin();
    const result = await handler(ctx, ...params);
    sendJson(ctx.res, result.status, result.body, headers);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    sendJson(ctx.res, error.status, errorBody(error), headers);
  }
  return true;
}
