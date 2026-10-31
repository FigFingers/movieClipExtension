import { toExtensionClipPayload } from '../shared/clipPayload.js';
import { STORAGE_KEYS, storageGet, storageSet, normalizePendingClips } from '../shared/storage.js';
import { createSerialExecutor } from './exclusive.js';

const runQueueExclusive = createSerialExecutor();

// pendingClipsへの書込みをここへ集約する。複数タブと同期完了のread/modify/writeを直列化。
export function enqueueClip(clip) {
  const normalized = toExtensionClipPayload(clip);
  return runQueueExclusive(async () => {
    const stored = await storageGet([STORAGE_KEYS.pendingClips]);
    const queue = new Map(normalizePendingClips(stored[STORAGE_KEYS.pendingClips]).map((item) => [item.clientItemId, item]));
    queue.set(normalized.clientItemId, normalized);
    await storageSet({ [STORAGE_KEYS.pendingClips]: Array.from(queue.values()) });
    return normalized;
  });
}

export function removePendingClipIds(clientItemIds) {
  const ids = new Set(clientItemIds);
  if (!ids.size) return Promise.resolve();
  return runQueueExclusive(async () => {
    const stored = await storageGet([STORAGE_KEYS.pendingClips]);
    await storageSet({
      [STORAGE_KEYS.pendingClips]: normalizePendingClips(stored[STORAGE_KEYS.pendingClips])
        .filter((clip) => !ids.has(clip.clientItemId)),
    });
  });
}
