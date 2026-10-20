// 障害の注入。拡張の失敗時の扱い（再送・トークンの破棄・タイムアウト）を確かめるために使う。
//
// ルール:
//   { method: 'POST' | '*', path: '/api/extension/sync', kind, status?, body?, delayMs?, times? }
//   path は完全一致。末尾が * なら前方一致、^ で始まれば正規表現。
//   kind:
//     status    指定の status と本文を返す（本文を省くと { message, code } を作る）
//     delay     delayMs 待ってから通常どおり処理する
//     hang      応答しない（拡張の 15 秒のタイムアウトを確かめる）
//     malformed 200 で JSON として読めない本文を返す
//     reset     接続を切る（通信の失敗）
//   times を省くと、消すまで毎回当てはまる。

const KINDS = new Set(['status', 'delay', 'hang', 'malformed', 'reset']);

const DEFAULT_BODIES = {
  400: { message: 'Invalid request body', code: 'INVALID_BODY' },
  401: { message: 'Unauthorized', code: 'UNAUTHORIZED' },
  403: { message: 'OriginNotAllowed', code: 'FORBIDDEN' },
  404: { message: 'Resource not found', code: 'NOT_FOUND' },
  409: { message: 'Conflict', code: 'CONFLICT' },
  429: { message: 'Too many requests', code: 'RATE_LIMITED' },
  500: { message: 'Internal server error', code: 'INTERNAL_ERROR' },
  503: { message: 'Service unavailable', code: 'SERVICE_UNAVAILABLE' },
};

export function normalizeFault(input, id) {
  if (!input || typeof input !== 'object') throw new TypeError('fault must be an object');
  const kind = input.kind ?? 'status';
  if (!KINDS.has(kind)) throw new TypeError(`unknown fault kind: ${kind}`);
  if (typeof input.path !== 'string' || input.path.length === 0) throw new TypeError('fault.path is required');
  const status = Number(input.status ?? 500);
  if (kind === 'status' && (!Number.isInteger(status) || status < 100 || status > 599)) {
    throw new TypeError('fault.status must be an HTTP status');
  }
  const times = input.times === undefined || input.times === null ? null : Number(input.times);
  if (times !== null && (!Number.isInteger(times) || times < 1)) throw new TypeError('fault.times must be a positive integer');
  return {
    id,
    method: String(input.method || '*').toUpperCase(),
    path: input.path,
    kind,
    status,
    body: input.body,
    delayMs: Math.max(0, Number(input.delayMs ?? 0) || 0),
    times,
    hits: 0,
    note: typeof input.note === 'string' ? input.note : undefined,
  };
}

function pathMatches(pattern, pathname) {
  if (pattern.startsWith('^')) {
    try {
      return new RegExp(pattern).test(pathname);
    } catch {
      return false;
    }
  }
  if (pattern.endsWith('*')) return pathname.startsWith(pattern.slice(0, -1));
  return pattern === pathname;
}

/** 当てはまるルールを 1 つ取り出し、回数を減らす。 */
export function takeFault(faults, method, pathname) {
  const index = faults.findIndex((fault) =>
    (fault.method === '*' || fault.method === method) && pathMatches(fault.path, pathname));
  if (index < 0) return null;
  const fault = faults[index];
  fault.hits += 1;
  if (fault.times !== null) {
    fault.times -= 1;
    if (fault.times <= 0) faults.splice(index, 1);
  }
  return { ...fault };
}

export function faultBody(fault) {
  if (fault.body !== undefined) return fault.body;
  return DEFAULT_BODIES[fault.status] || { message: `Mock fault ${fault.status}`, code: 'MOCK_FAULT' };
}
