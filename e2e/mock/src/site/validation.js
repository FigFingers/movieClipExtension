// サイトの Zod スキーマ（src/server/schemas/*.ts）を手で写した検証。
// 問題は { path, message, code } の配列で返し、応答の形は呼び出し側が決める。

const UUID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

export const CLIP_NAME_MAX = 255;
export const COMMENT_BODY_MAX_CODE_POINTS = 500;
export const MAX_QUERY_LENGTH = 200;

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class Issues {
  constructor() {
    this.list = [];
  }

  add(path, message, code = 'invalid') {
    this.list.push({ path, message, code });
  }

  get empty() {
    return this.list.length === 0;
  }
}

function strictKeys(issues, value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.add(path, `Unrecognized key: "${key}"`, 'unrecognized_keys');
  }
}

function expectObject(issues, value, path) {
  if (isPlainObject(value)) return true;
  issues.add(path, `Invalid input: expected object, received ${typeName(value)}`, 'invalid_type');
  return false;
}

function uuid(issues, value, path) {
  if (typeof value !== 'string') {
    issues.add(path, `Invalid input: expected string, received ${typeName(value)}`, 'invalid_type');
    return;
  }
  if (!UUID_PATTERN.test(value)) issues.add(path, 'Invalid UUID', 'invalid_format');
}

/** z.string().trim().min(min).max(max)。trim した値を返す。 */
function trimmedString(issues, value, path, { min = 0, max = Infinity } = {}) {
  if (typeof value !== 'string') {
    issues.add(path, `Invalid input: expected string, received ${typeName(value)}`, 'invalid_type');
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length < min) issues.add(path, `Too small: expected string to have >=${min} characters`, 'too_small');
  if (trimmed.length > max) issues.add(path, `Too big: expected string to have <=${max} characters`, 'too_big');
  return trimmed;
}

function finiteNumber(issues, value, path, { min } = {}) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    issues.add(path, `Invalid input: expected number, received ${typeName(value)}`, 'invalid_type');
    return undefined;
  }
  if (!Number.isFinite(value)) {
    issues.add(path, 'Invalid input: expected number, received Infinity', 'invalid_type');
    return undefined;
  }
  if (min !== undefined && value < min) issues.add(path, `Too small: expected number to be >=${min}`, 'too_small');
  return value;
}

function codePointLength(value) {
  let length = 0;
  for (const _ of value) length += 1;
  return length;
}

// ---------------------------------------------------------------------------
// /api/extension/sync（extensionSyncBodySchema と legacyClipCreateBodySchema）
// ---------------------------------------------------------------------------

const SYNC_BODY_KEYS = ['extensionInstanceId', 'items'];
const SYNC_ITEM_KEYS = ['clientItemId', 'type', 'createdAt', 'payload'];
const LEGACY_CLIP_KEYS = ['clipName', 'service', 'StartTime', 'EndTime', 'URL', 'title', 'epnumber'];

function validateLegacyClip(issues, payload, path) {
  if (!expectObject(issues, payload, path)) return;
  const before = issues.list.length;
  strictKeys(issues, payload, LEGACY_CLIP_KEYS, path);
  if (payload.clipName !== undefined) {
    trimmedString(issues, payload.clipName, [...path, 'clipName'], { min: 1, max: CLIP_NAME_MAX });
  }
  trimmedString(issues, payload.service, [...path, 'service'], { min: 1 });
  const start = finiteNumber(issues, payload.StartTime, [...path, 'StartTime'], { min: 0 });
  const end = finiteNumber(issues, payload.EndTime, [...path, 'EndTime'], { min: 0 });
  trimmedString(issues, payload.URL, [...path, 'URL'], { min: 1 });
  trimmedString(issues, payload.title, [...path, 'title'], { min: 1 });
  if (payload.epnumber !== undefined) trimmedString(issues, payload.epnumber, [...path, 'epnumber'], { min: 1 });
  // Zod の refine は、オブジェクトの検証が通ったときだけ走る。
  if (issues.list.length === before && start !== undefined && end !== undefined && !(end > start)) {
    issues.add([...path, 'EndTime'], 'EndTime must be greater than StartTime', 'custom');
  }
}

export function validateSyncBody(body) {
  const issues = new Issues();
  if (!expectObject(issues, body, [])) return { ok: false, issues: issues.list };
  strictKeys(issues, body, SYNC_BODY_KEYS, []);
  uuid(issues, body.extensionInstanceId, ['extensionInstanceId']);
  if (!Array.isArray(body.items)) {
    issues.add(['items'], `Invalid input: expected array, received ${typeName(body.items)}`, 'invalid_type');
    return { ok: false, issues: issues.list };
  }
  body.items.forEach((item, index) => {
    const path = ['items', index];
    if (!expectObject(issues, item, path)) return;
    strictKeys(issues, item, SYNC_ITEM_KEYS, path);
    uuid(issues, item.clientItemId, [...path, 'clientItemId']);
    if (item.type !== 'clip') issues.add([...path, 'type'], 'Invalid input: expected "clip"', 'invalid_value');
    if (item.createdAt !== undefined && item.createdAt !== null) {
      if (typeof item.createdAt !== 'string' || !DATETIME_PATTERN.test(item.createdAt) || !Number.isFinite(Date.parse(item.createdAt))) {
        issues.add([...path, 'createdAt'], 'Invalid ISO datetime', 'invalid_format');
      }
    }
    validateLegacyClip(issues, item.payload, [...path, 'payload']);
  });
  // superRefine も同じく、ここまでが通ったときだけ走る。
  if (issues.empty) {
    const seen = new Set();
    body.items.forEach((item, index) => {
      if (seen.has(item.clientItemId)) {
        issues.add(['items', index, 'clientItemId'], 'clientItemId must be unique within the request', 'custom');
        return;
      }
      seen.add(item.clientItemId);
    });
  }
  return issues.empty ? { ok: true, value: body } : { ok: false, issues: issues.list };
}

// ---------------------------------------------------------------------------
// 連携・トークン
// ---------------------------------------------------------------------------

export function validateLinkBody(body) {
  const issues = new Issues();
  if (expectObject(issues, body, [])) {
    strictKeys(issues, body, ['extensionInstanceId', 'linkToken'], []);
    uuid(issues, body.extensionInstanceId, ['extensionInstanceId']);
    trimmedString(issues, body.linkToken, ['linkToken'], { min: 1 });
  }
  return issues.empty ? { ok: true, value: body } : { ok: false, issues: issues.list };
}

export function validateRefreshBody(body) {
  const issues = new Issues();
  if (expectObject(issues, body, [])) {
    strictKeys(issues, body, ['extensionInstanceId'], []);
    uuid(issues, body.extensionInstanceId, ['extensionInstanceId']);
  }
  return issues.empty ? { ok: true, value: body } : { ok: false, issues: issues.list };
}

export function validateUnlinkBody(body) {
  const issues = new Issues();
  if (expectObject(issues, body, [])) {
    strictKeys(issues, body, ['linkedExtensionId'], []);
    if (!Number.isInteger(body.linkedExtensionId) || body.linkedExtensionId <= 0) {
      issues.add(['linkedExtensionId'], 'Invalid input: expected a positive integer', 'invalid_type');
    }
  }
  return issues.empty ? { ok: true, value: body } : { ok: false, issues: issues.list };
}

// ---------------------------------------------------------------------------
// コメント（extensionCommentListQuerySchema・extensionCommentCreateBodySchema）
// ---------------------------------------------------------------------------

function coercePositiveInteger(value) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isInteger(number) ? number : Number.NaN;
}

export function validateCommentListQuery(searchParams) {
  const issues = new Issues();
  const query = Object.fromEntries(searchParams.entries());
  strictKeys(issues, query, ['extensionInstanceId', 'cursor', 'limit'], []);
  uuid(issues, query.extensionInstanceId, ['extensionInstanceId']);
  const cursor = coercePositiveInteger(query.cursor);
  if (cursor !== undefined && !(cursor > 0)) issues.add(['cursor'], 'Invalid input: expected a positive integer', 'invalid_type');
  const limit = query.limit === undefined ? 20 : coercePositiveInteger(query.limit);
  if (!(limit >= 1 && limit <= 100)) issues.add(['limit'], 'Too big or too small: expected 1 to 100', 'too_big');
  return issues.empty
    ? { ok: true, value: { extensionInstanceId: query.extensionInstanceId, cursor, limit } }
    : { ok: false, issues: issues.list };
}

export function validateCommentBody(issues, value, path) {
  if (typeof value !== 'string') {
    issues.add(path, `Invalid input: expected string, received ${typeName(value)}`, 'invalid_type');
    return undefined;
  }
  if (codePointLength(value) > COMMENT_BODY_MAX_CODE_POINTS) {
    issues.add(path, `Must contain at most ${COMMENT_BODY_MAX_CODE_POINTS} Unicode code points`, 'custom');
  }
  const trimmed = value.trim();
  if (trimmed.length < 1) issues.add(path, 'Too small: expected string to have >=1 characters', 'too_small');
  if (trimmed.includes('\u0000')) issues.add(path, 'NUL characters are not allowed', 'custom');
  return trimmed;
}

export function validateCommentCreateBody(body) {
  const issues = new Issues();
  let text;
  if (expectObject(issues, body, [])) {
    strictKeys(issues, body, ['extensionInstanceId', 'body', 'atMs', 'clientRequestId'], []);
    uuid(issues, body.extensionInstanceId, ['extensionInstanceId']);
    text = validateCommentBody(issues, body.body, ['body']);
    if (body.atMs !== undefined && body.atMs !== null && !(Number.isInteger(body.atMs) && body.atMs >= 0)) {
      issues.add(['atMs'], 'Invalid input: expected a non-negative integer', 'invalid_type');
    }
    if (body.clientRequestId !== undefined) uuid(issues, body.clientRequestId, ['clientRequestId']);
  }
  return issues.empty
    ? { ok: true, value: { ...body, body: text } }
    : { ok: false, issues: issues.list };
}

// ---------------------------------------------------------------------------
// GET /api/v1/clips（clipCursorListQuerySchema）
// ---------------------------------------------------------------------------

export function validateClipListQuery(searchParams) {
  const issues = new Issues();
  const query = Object.fromEntries(searchParams.entries());
  strictKeys(issues, query, ['cursor', 'limit', 'userId', 'vodId', 'title'], []);
  const limit = query.limit === undefined ? 20 : coercePositiveInteger(query.limit);
  if (!(limit >= 1 && limit <= 100)) issues.add(['limit'], 'Too big or too small: expected 1 to 100', 'too_big');
  if (query.cursor !== undefined && query.cursor.length < 1) issues.add(['cursor'], 'Too small', 'too_small');
  for (const key of ['userId', 'vodId']) {
    if (query[key] !== undefined && !(coercePositiveInteger(query[key]) > 0)) {
      issues.add([key], 'Invalid input: expected a positive integer', 'invalid_type');
    }
  }
  if (query.title !== undefined && query.title.length > MAX_QUERY_LENGTH) {
    issues.add(['title'], `Too big: expected string to have <=${MAX_QUERY_LENGTH} characters`, 'too_big');
  }
  return issues.empty
    ? {
        ok: true,
        value: {
          limit,
          cursor: query.cursor,
          userId: query.userId === undefined ? undefined : Number(query.userId),
          vodId: query.vodId === undefined ? undefined : Number(query.vodId),
          title: query.title,
        },
      }
    : { ok: false, issues: issues.list };
}

// ---------------------------------------------------------------------------
// 応答の形
// ---------------------------------------------------------------------------

/** Zod の error.flatten() と同じ形。fieldErrors は先頭の path ごとにまとめる。 */
export function flattenIssues(issues) {
  const formErrors = [];
  const fieldErrors = {};
  for (const issue of issues) {
    if (issue.path.length === 0) {
      formErrors.push(issue.message);
      continue;
    }
    const key = String(issue.path[0]);
    fieldErrors[key] ||= [];
    fieldErrors[key].push(issue.message);
  }
  return { formErrors, fieldErrors };
}
