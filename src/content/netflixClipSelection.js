export function normalizeSelectedClip(data = {}, requestedClipId) {
  const clipId = data.clipId ?? data.id ?? requestedClipId;
  return { ...data, clipId };
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
