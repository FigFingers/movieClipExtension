import {
  normalizeClipInput,
  normalizeClipSelectedInput,
  normalizePlaylistJson,
} from '../shared/playbackBridgeValidation.js';
import {
  addPlaybackOwnerToUrl,
  beginPlaybackHandoff,
  createPlaybackOwnerNonce,
} from './playbackOwnership.js';

const HANDOFF_RESULT_TYPE = 'EXTENSION_PLAYBACK_HANDOFF_RESULT';
const SAFE_HANDOFF_REASONS = new Set([
  'invalid_payload',
  'invalid_clip_id',
  'clip_id_mismatch',
  'invalid_service',
  'invalid_url',
  'invalid_time_range',
  'invalid_order',
  'duplicate_order',
  'empty_playlist',
  'queue_too_large',
  'payload_too_large',
  'handoff_failed',
  'background_unavailable',
]);

function normalizeRequestId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    ? value
    : undefined;
}

function sanitizeHandoffResult(result) {
  if (result?.ok) return { ok: true };
  const reason = SAFE_HANDOFF_REASONS.has(result?.reason)
    ? result.reason
    : 'handoff_failed';
  return {
    ok: false,
    reason,
    ...(typeof result?.field === 'string' ? { field: result.field } : {}),
    ...(Number.isInteger(result?.index) ? { index: result.index } : {}),
  };
}

function publishHandoffResult({ source, requestId, result }) {
  const safeResult = sanitizeHandoffResult(result);
  const message = {
    type: HANDOFF_RESULT_TYPE,
    source,
    ...safeResult,
    ...(requestId ? { requestId } : {}),
  };
  window.postMessage(message, window.location.origin);
  if (!safeResult.ok) {
    console.warn('[EXT] Playback handoff rejected', {
      source,
      reason: safeResult.reason,
      field: safeResult.field,
      index: safeResult.index,
    });
  }
}

async function registerClipHandoff(clip) {
  const nonce = createPlaybackOwnerNonce();
  const result = await beginPlaybackHandoff({
    nonce,
    mode: 'clip',
    clipId: clip.clipId,
    snapshot: {
      clip,
      currentClipId: clip.clipId,
      currentClipOrder: 0,
      playClipSystemKey: 1,
      playlistSystemKey: 0,
      playmode: 'clip',
    },
  });
  return { result, nonce };
}

function buildPlaybackUrl(clip, nonce) {
  const target = new URL(clip.url);
  target.searchParams.set('t', String(Math.floor(clip.startTime)));
  return addPlaybackOwnerToUrl(target.toString(), nonce);
}

window.addEventListener('clipSelected', async (event) => {
  const source = 'clipSelected';
  const requestId = normalizeRequestId(event?.detail?.requestId);
  const normalized = normalizeClipSelectedInput(document.cookie, event?.detail);
  if (!normalized.ok) {
    publishHandoffResult({ source, requestId, result: normalized });
    return;
  }

  for (const key of normalized.invalidCookieKeys || []) {
    console.warn('[EXT] Ignored malformed playback cookie', { key });
  }
  const { result } = await registerClipHandoff(normalized.value);
  publishHandoffResult({ source, requestId, result });
});

window.addEventListener('message', async (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data;
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'SET_CLIP_DATA') {
    const source = 'SET_CLIP_DATA';
    const requestId = normalizeRequestId(message.requestId);
    const normalized = normalizeClipInput(message.payload?.clip);
    if (!normalized.ok) {
      publishHandoffResult({ source, requestId, result: normalized });
      return;
    }
    const { result } = await registerClipHandoff(normalized.value);
    publishHandoffResult({ source, requestId, result });
    return;
  }

  if (message.type !== 'PLAY_PLAYLIST_START') return;

  const source = 'PLAY_PLAYLIST_START';
  const requestId = normalizeRequestId(message.requestId);
  const normalized = normalizePlaylistJson(localStorage.getItem('playQueue'));
  if (!normalized.ok) {
    publishHandoffResult({ source, requestId, result: normalized });
    return;
  }

  const queue = normalized.value;
  const firstClip = queue.reduce((first, item) =>
    item.order < first.order ? item : first
  );
  const nonce = createPlaybackOwnerNonce();
  const handoff = await beginPlaybackHandoff({
    nonce,
    mode: 'playlist',
    clipId: firstClip.clipId,
    snapshot: {
      clip: null,
      playQueue: queue,
      currentClipOrder: firstClip.order,
      currentClipId: firstClip.clipId,
      nextClip: firstClip,
      playClipSystemKey: 0,
      playlistSystemKey: 1,
      playmode: 'playlist',
    },
  });
  publishHandoffResult({ source, requestId, result: handoff });
  if (!handoff?.ok) return;

  const targetUrl = buildPlaybackUrl(firstClip, nonce);
  setTimeout(() => {
    window.location.href = targetUrl;
  }, 300);
});
