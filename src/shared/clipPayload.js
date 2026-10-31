function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function nullableString(value) {
  if (value === undefined || value === null) return null;
  return String(value).trim() || null;
}

function clipTime(value, field) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw new Error(`Invalid clip ${field}`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Invalid clip ${field}`);
  return number;
}

// DOMやstorageに依存しない入力境界。旧フィールド名の吸収はここだけで行う。
export function toExtensionClipPayload(clip, { pageUrl } = {}) {
  const startTime = clipTime(firstPresent(clip?.startTime, clip?.StartTime), 'startTime');
  const endTime = clipTime(firstPresent(clip?.endTime, clip?.EndTime), 'endTime');
  if (endTime <= startTime) throw new Error('Clip endTime must be greater than startTime');
  const url = new URL(firstPresent(clip?.url, clip?.URL, pageUrl), pageUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid clip url');
  const title = nullableString(clip?.title);
  const service = nullableString(clip?.service);
  if (!title || !service) throw new Error('Clip title and service are required');
  const createdAt = clip?.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Invalid clip createdAt');
  return {
    clientItemId: String(firstPresent(clip?.clientItemId, clip?.localClientItemId) || crypto.randomUUID()),
    title, url: url.href, startTime, endTime, service,
    clipName: nullableString(clip?.clipName), epnumber: nullableString(clip?.epnumber),
    createdAt: new Date(createdAt).toISOString(),
  };
}
