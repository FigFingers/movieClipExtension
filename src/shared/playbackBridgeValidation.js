export const MAX_PLAYLIST_ITEMS = 100;
export const MAX_PLAYBACK_PAYLOAD_BYTES = 512 * 1024;
export const MAX_PLAYBACK_URL_LENGTH = 4096;
export const PLAYBACK_OWNER_STORAGE_KEY = 'playbackOwnerNonce';
export const PLAYBACK_OWNER_QUERY_PARAM = 'dextPlaybackOwner';

const STRING_LIMITS = Object.freeze({
  title: 500,
  clipname: 500,
  user: 200,
  username: 200,
  epnumber: 200,
});
const COOKIE_KEYS = new Set([
  'title',
  'user',
  'url',
  'service',
  'clipId',
  'username',
  'startTime',
  'starttime',
  'endTime',
  'endtime',
]);
const SERVICE_CONFIG = Object.freeze({
  netflix: {
    baseUrl: 'https://www.netflix.com',
    hostname: 'www.netflix.com',
  },
  disneyplus: {
    baseUrl: 'https://www.disneyplus.com',
    hostname: 'www.disneyplus.com',
  },
});
const SERVICE_ALIASES = Object.freeze({
  'disney+': 'disneyplus',
  disney: 'disneyplus',
  disney_plus: 'disneyplus',
});

function failure(reason, field, index) {
  return {
    ok: false,
    reason,
    ...(field ? { field } : {}),
    ...(Number.isInteger(index) ? { index } : {}),
  };
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  try {
    return Object.prototype.toString.call(value) === '[object Object]';
  } catch {
    return false;
  }
}

export function normalizePlaybackRoute(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function parseFiniteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNonNegativeSafeInteger(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function normalizePositiveClipId(value) {
  const parsed = parseNonNegativeSafeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function readConsistentNumberAlias(input, aliases) {
  const present = aliases
    .filter((key) => input[key] !== undefined && input[key] !== null)
    .map((key) => parseFiniteNumber(input[key]));
  if (present.length === 0 || present.some((value) => value === null)) return null;
  return present.every((value) => value === present[0]) ? present[0] : null;
}

function normalizeClipIdFromInput(input, index) {
  const rawIds = [input.clipId, input.id]
    .filter((value) => value !== undefined && value !== null);
  if (rawIds.length === 0) return failure('invalid_clip_id', 'clipId', index);
  const ids = rawIds.map(normalizePositiveClipId);
  if (ids.some((value) => value === null) || ids.some((value) => value !== ids[0])) {
    return failure('invalid_clip_id', 'clipId', index);
  }
  return { ok: true, value: ids[0] };
}

function normalizeService(value, index) {
  if (typeof value !== 'string' || value.length > 32) {
    return failure('invalid_service', 'service', index);
  }
  const lowered = value.trim().toLowerCase().replace(/\s+/g, '');
  const normalized = SERVICE_ALIASES[lowered] || lowered;
  if (!SERVICE_CONFIG[normalized]) {
    return failure('invalid_service', 'service', index);
  }
  return { ok: true, value: normalized };
}

function normalizeUrl(value, service, index) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PLAYBACK_URL_LENGTH
  ) {
    return failure('invalid_url', 'url', index);
  }

  const config = SERVICE_CONFIG[service];
  try {
    const url = new URL(value, config.baseUrl);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== config.hostname ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.href.length > MAX_PLAYBACK_URL_LENGTH
    ) {
      return failure('invalid_url', 'url', index);
    }
    return { ok: true, value: url.toString() };
  } catch {
    return failure('invalid_url', 'url', index);
  }
}

function normalizeOptionalStrings(input, index) {
  const normalized = {};
  for (const [key, limit] of Object.entries(STRING_LIMITS)) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.length > limit) {
      return failure('invalid_payload', key, index);
    }
    const trimmed = value.trim();
    if (trimmed) normalized[key] = trimmed;
  }
  return { ok: true, value: normalized };
}

export function normalizeClipInput(input, { playlist = false, index } = {}) {
  if (!isRecord(input)) return failure('invalid_payload', 'clip', index);

  const clipId = normalizeClipIdFromInput(input, index);
  if (!clipId.ok) return clipId;

  const service = normalizeService(input.service, index);
  if (!service.ok) return service;

  const url = normalizeUrl(input.url, service.value, index);
  if (!url.ok) return url;

  const startTime = readConsistentNumberAlias(input, [
    'startTime',
    'starttime',
    'StartTime',
  ]);
  const endTime = readConsistentNumberAlias(input, [
    'endTime',
    'endtime',
    'EndTime',
  ]);
  if (startTime === null || startTime < 0) {
    return failure('invalid_time_range', 'startTime', index);
  }
  if (endTime === null || endTime <= startTime) {
    return failure('invalid_time_range', 'endTime', index);
  }

  const optional = normalizeOptionalStrings(input, index);
  if (!optional.ok) return optional;

  const value = {
    clipId: clipId.value,
    service: service.value,
    url: url.value,
    startTime,
    endTime,
    ...optional.value,
  };

  if (playlist) {
    const hasOrder = Object.hasOwn(input, 'order');
    const order = hasOrder
      ? parseNonNegativeSafeInteger(input.order)
      : parseNonNegativeSafeInteger(index);
    if (order === null) return failure('invalid_order', 'order', index);
    value.id = clipId.value;
    value.order = order;
  }

  return { ok: true, value };
}

export function normalizePlaylistInput(input) {
  if (!Array.isArray(input)) return failure('invalid_payload', 'playQueue');
  if (input.length === 0) return failure('empty_playlist', 'playQueue');
  if (input.length > MAX_PLAYLIST_ITEMS) {
    return failure('queue_too_large', 'playQueue');
  }

  const queue = [];
  const orders = new Set();
  for (let index = 0; index < input.length; index += 1) {
    const item = normalizeClipInput(input[index], { playlist: true, index });
    if (!item.ok) return item;
    if (orders.has(item.value.order)) {
      return failure('duplicate_order', 'order', index);
    }
    orders.add(item.value.order);
    queue.push(item.value);
  }

  const serialized = JSON.stringify(queue);
  if (utf8ByteLength(serialized) > MAX_PLAYBACK_PAYLOAD_BYTES) {
    return failure('payload_too_large', 'playQueue');
  }
  return { ok: true, value: queue };
}

export function normalizePlaylistJson(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.length === 0) {
    return failure('empty_playlist', 'playQueue');
  }
  if (utf8ByteLength(rawValue) > MAX_PLAYBACK_PAYLOAD_BYTES) {
    return failure('payload_too_large', 'playQueue');
  }
  try {
    return normalizePlaylistInput(JSON.parse(rawValue));
  } catch {
    return failure('invalid_payload', 'playQueue');
  }
}

export function parsePlaybackCookies(cookieString) {
  const values = {};
  const invalidKeys = [];
  if (typeof cookieString !== 'string' || cookieString.length === 0) {
    return { values, invalidKeys };
  }

  for (const part of cookieString.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (!COOKIE_KEYS.has(key)) continue;
    try {
      values[key] = decodeURIComponent(part.slice(separator + 1));
    } catch {
      invalidKeys.push(key);
    }
  }
  return { values, invalidKeys };
}

export function normalizeClipSelectedInput(cookieString, detail) {
  if (!isRecord(detail)) return failure('invalid_payload', 'detail');
  const detailClipId = normalizePositiveClipId(detail.clipId);
  if (detailClipId === null) return failure('invalid_clip_id', 'clipId');

  const { values, invalidKeys } = parsePlaybackCookies(cookieString);
  if (invalidKeys.includes('clipId')) {
    return failure('invalid_clip_id', 'clipId');
  }
  if (values.clipId !== undefined) {
    const cookieClipId = normalizePositiveClipId(values.clipId);
    if (cookieClipId === null) return failure('invalid_clip_id', 'clipId');
    if (cookieClipId !== detailClipId) {
      return failure('clip_id_mismatch', 'clipId');
    }
  }

  const clip = normalizeClipInput({ ...values, clipId: detailClipId });
  return clip.ok ? { ...clip, invalidCookieKeys: invalidKeys } : clip;
}

export function normalizePlaybackContext(value) {
  if (!isRecord(value) || (value.mode !== 'clip' && value.mode !== 'playlist')) {
    return failure('invalid_payload', 'context');
  }
  const clipId = normalizePositiveClipId(value.clipId);
  if (clipId === null) return failure('invalid_clip_id', 'context.clipId');
  return { ok: true, value: { mode: value.mode, clipId } };
}

export function normalizePlaybackSnapshot({ snapshot, context, ownerNonce }) {
  if (!isRecord(snapshot)) return failure('invalid_payload', 'snapshot');
  const normalizedContext = normalizePlaybackContext(context);
  if (!normalizedContext.ok) return normalizedContext;

  const common = {
    currentClipOrder: 0,
    currentClipId: normalizedContext.value.clipId,
    [PLAYBACK_OWNER_STORAGE_KEY]: ownerNonce,
  };

  if (normalizedContext.value.mode === 'clip') {
    const clip = normalizeClipInput(snapshot.clip);
    if (!clip.ok) return clip;
    if (clip.value.clipId !== normalizedContext.value.clipId) {
      return failure('clip_id_mismatch', 'context.clipId');
    }
    return {
      ok: true,
      context: normalizedContext.value,
      value: {
        ...common,
        clip: clip.value,
        playQueue: null,
        nextClip: null,
        playClipSystemKey: 1,
        playlistSystemKey: 0,
        playmode: 'clip',
      },
    };
  }

  const queue = normalizePlaylistInput(snapshot.playQueue);
  if (!queue.ok) return queue;
  const currentClipOrder = parseNonNegativeSafeInteger(snapshot.currentClipOrder);
  if (currentClipOrder === null) {
    return failure('invalid_order', 'currentClipOrder');
  }
  const currentClip = queue.value.find((item) => item.order === currentClipOrder);
  if (!currentClip) return failure('invalid_order', 'currentClipOrder');
  if (currentClip.clipId !== normalizedContext.value.clipId) {
    return failure('clip_id_mismatch', 'context.clipId');
  }

  return {
    ok: true,
    context: normalizedContext.value,
    value: {
      ...common,
      clip: null,
      playQueue: queue.value,
      currentClipOrder,
      nextClip: currentClip,
      playClipSystemKey: 0,
      playlistSystemKey: 1,
      playmode: 'playlist',
    },
  };
}
