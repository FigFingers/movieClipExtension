import { getApiEndpoint } from './../api.js';
import { STRING_LIMITS } from './../shared/playbackBridgeValidation.js';
import { fetchJsonWithTimeout } from './request.js';

export const CLIP_LIST_DEFAULT_LIMIT = 10;
// サイトの cursorPaginationQuerySchema が受け付ける上限。
export const CLIP_LIST_MAX_LIMIT = 100;
// サイトの MAX_QUERY_LENGTH。超える title を送ると 400 になる。
export const CLIP_LIST_MAX_TITLE_LENGTH = 200;

function clampString(value, limit) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

function normalizeLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return CLIP_LIST_DEFAULT_LIMIT;
  return Math.min(parsed, CLIP_LIST_MAX_LIMIT);
}

export function buildClipListApiUrl({ title, limit } = {}) {
  const url = new URL(getApiEndpoint('v1/clips'));
  const normalizedTitle = clampString(title, CLIP_LIST_MAX_TITLE_LENGTH);
  // title は任意。取れなかった場合は絞り込まず新着順の先頭を返す。
  if (normalizedTitle) url.searchParams.set('title', normalizedTitle);
  url.searchParams.set('limit', String(normalizeLimit(limit)));
  return url.toString();
}

export function getClipListResponseReason(status) {
  if (status === 200) return null;
  if (status === 400) return 'validation_error';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'request_failed';
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function msToSeconds(value) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value / 1000;
}

/**
 * サイトの clip 行を、サイドバー表示と再生 handoff が必要とする形へ落とし込む。
 *
 * `GET /api/v1/clips` は Prisma の `include: { user: true }` をそのまま返すため、
 * 応答には拡張が使わない user の全カラムが含まれる。ここで必要な項目だけを
 * 組み直し、余分な値が storage・cookie・DOM に流れないようにしている。
 *
 * @returns {import('../types/clip').ClipDataProps | null} 壊れた行は null
 */
export function normalizeClipListItem(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const id = Number(raw.id);
  if (!isPositiveSafeInteger(id)) return null;

  const startTime = msToSeconds(raw.startMs);
  const endTime = msToSeconds(raw.endMs);
  if (startTime === null || endTime === null || endTime <= startTime) return null;

  const url = typeof raw.url === 'string' ? raw.url : '';
  const service = typeof raw.vod?.code === 'string' ? raw.vod.code : '';
  if (!url || !service) return null;

  return {
    id,
    clipId: id,
    title: clampString(raw.title, STRING_LIMITS.title),
    epnumber: clampString(raw.epnum, STRING_LIMITS.epnumber),
    user: clampString(raw.user?.name, STRING_LIMITS.user),
    service,
    url,
    startTime,
    endTime,
  };
}

/**
 * 記録一覧を取得する。content script から直接叩くとページオリジンの CORS で
 * 弾かれるため、host permissions を持つ background 側で fetch する。
 */
export async function fetchClipList({ title, limit } = {}) {
  const request = await fetchJsonWithTimeout(buildClipListApiUrl({ title, limit }));

  if (!request.ok) {
    return {
      ok: false,
      reason: request.timedOut ? 'timeout' : 'network_error',
      message: request.error?.message,
    };
  }

  const { response, data } = request;
  const reason = getClipListResponseReason(response.status);
  if (reason) return { ok: false, reason, status: response.status };

  if (!Array.isArray(data?.data)) return { ok: false, reason: 'invalid_response' };

  // 1 件でも壊れていたら一覧ごと落とすのではなく、その行だけ捨てる。
  const items = data.data
    .map((item) => normalizeClipListItem(item))
    .filter((item) => item !== null);

  return { ok: true, items };
}
