import { normalizeClipInput } from '../shared/playbackBridgeValidation.js';

export function normalizeSelectedClip(data = {}, requestedClipId) {
  const clipId = data.clipId ?? data.id ?? requestedClipId;
  const normalized = normalizeClipInput({
    ...data,
    clipId,
    startTime: data.startTime ?? data.starttime ?? data.StartTime,
    endTime: data.endTime ?? data.endtime ?? data.EndTime,
    url: data.url ?? data.URL ?? data.Url,
  });
  if (!normalized.ok) {
    throw new Error(`Invalid selected clip: ${normalized.reason}`);
  }
  return normalized.value;
}

export async function commitSelectedClip({
  data,
  requestedClipId,
  ownerNonce,
  storage,
  setCookies,
  openClip,
}) {
  const selectedClip = normalizeSelectedClip(data, requestedClipId);
  const clipId = selectedClip.clipId;

  await storage.set({
    clip: selectedClip,
    currentClipId: clipId,
    currentClipOrder: 0,
    playClipSystemKey: 1,
    playlistSystemKey: 0,
    playmode: 'clip',
    playbackOwnerNonce: ownerNonce,
  });

  setCookies(selectedClip);
  await openClip(selectedClip);
  return selectedClip;
}
