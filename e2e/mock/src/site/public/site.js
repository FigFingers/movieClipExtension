// サイトの画面のスクリプト。拡張とのやり取りは、react--site の次のファイルと同じ手順にする。
//   src/lib/extension/client.ts       連携 ID の取得・連携・解除
//   src/lib/extension/handoffRequest.ts 引き継ぎの requestId
//   src/lib/clips/playback.ts         「観る」（window.open → Cookie → clipSelected）
//   PlaylistView.tsx                  プレイリスト再生（localStorage.playQueue → PLAY_PLAYLIST_START）
// サイトに無い操作（同じタブでの SET_CLIP_DATA、連携状態の問い合わせ）は、拡張の契約を確かめるために足した。

const pageData = JSON.parse(document.getElementById('page-data')?.textContent || '{}');
const TIMEOUT_MS = 3000;

function createRequestId() {
  return globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toast(message, tone = 'info') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const item = document.createElement('div');
  item.className = `toast ${tone}`;
  item.textContent = message;
  box.append(item);
  setTimeout(() => item.remove(), 6000);
}

/** 同じウィンドウへの postMessage の応答を 1 つ待つ。 */
function waitForMessage(predicate, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Extension response timeout'));
    }, timeoutMs);
    function handler(event) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (!predicate(event.data)) return;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      resolve(event.data);
    }
    window.addEventListener('message', handler);
  });
}

// ---------------------------------------------------------------------------
// src/lib/extension/client.ts
// ---------------------------------------------------------------------------

export async function getExtensionInstanceIdFromExtension() {
  const requestId = createRequestId();
  const response = waitForMessage((data) => data?.type === 'EXTENSION_INSTANCE_ID_RESPONSE' && data.requestId === requestId);
  window.postMessage({ type: 'GET_EXTENSION_INSTANCE_ID', requestId }, window.location.origin);
  const data = await response;
  if (!data.ok || !data.extensionInstanceId) throw new Error(data.message || 'Failed to get extensionInstanceId');
  return data.extensionInstanceId;
}

/** サイトには無い。拡張の EXTENSION_AUTH_STATUS_REQUEST の応答を見るために足した。 */
export async function requestExtensionAuthStatus() {
  const requestId = createRequestId();
  const response = waitForMessage((data) => data?.type === 'EXTENSION_AUTH_STATUS' && data.requestId === requestId);
  window.postMessage({ type: 'EXTENSION_AUTH_STATUS_REQUEST', requestId }, window.location.origin);
  return response;
}

async function requestJson(url, init) {
  const res = await fetch(url, { credentials: 'include', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `${url} failed (${res.status})`);
  return body;
}

export async function linkExtensionToCurrentUserFromUserAction() {
  const extensionInstanceId = await getExtensionInstanceIdFromExtension();
  const { linkToken } = await requestJson('/api/extension/link-token', { method: 'POST' });
  const result = await requestJson('/api/extension/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ extensionInstanceId, linkToken }),
  });
  window.postMessage({
    type: 'EXT_LINK_WITH_AUTH_TOKEN',
    requestId: createRequestId(),
    extensionInstanceId,
    extensionAuthToken: result.extensionAuthToken,
    expiresAt: result.expiresAt,
    token: result.extensionAuthToken,
  }, window.location.origin);
  return { ...result, extensionInstanceId };
}

export async function unlinkExtensionFromCurrentUser(linkedExtensionId, expectedExtensionInstanceId) {
  const body = await requestJson('/api/extension/unlink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ linkedExtensionId }),
  });
  const extensionInstanceId = typeof body.extensionInstanceId === 'string' ? body.extensionInstanceId : expectedExtensionInstanceId;
  window.postMessage({ type: 'EXTENSION_UNLINKED', requestId: createRequestId(), extensionInstanceId }, window.location.origin);
  return { extensionInstanceId };
}

// ---------------------------------------------------------------------------
// src/lib/extension/handoffRequest.ts
// ---------------------------------------------------------------------------

const MAX_TRACKED = 8;
const pendingHandoffs = [];

export function createHandoffRequestId() {
  const id = createRequestId();
  pendingHandoffs.push(id);
  if (pendingHandoffs.length > MAX_TRACKED) pendingHandoffs.splice(0, pendingHandoffs.length - MAX_TRACKED);
  return id;
}

export function consumeHandoffResult(requestId) {
  if (requestId === undefined || requestId === null) return true;
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) return false;
  const index = pendingHandoffs.indexOf(requestId);
  if (index < 0) return false;
  pendingHandoffs.splice(0, index + 1);
  return true;
}

// ---------------------------------------------------------------------------
// src/lib/clips/playback.ts
// ---------------------------------------------------------------------------

const SERVICE_HOSTS = {
  Netflix: new Set(['netflix.com', 'www.netflix.com']),
  prime: new Set(['amazon.co.jp', 'www.amazon.co.jp', 'primevideo.com', 'www.primevideo.com']),
  DISNEY_PLUS: new Set(['disneyplus.com', 'www.disneyplus.com']),
};
SERVICE_HOSTS.NETFLIX = SERVICE_HOSTS.Netflix;
SERVICE_HOSTS.PRIME_VIDEO = SERVICE_HOSTS.prime;

export function buildServiceUrl(code, url) {
  const trimmed = url.trim();
  if (/^https?:\/\//.test(trimmed)) {
    const hosts = SERVICE_HOSTS[code];
    if (!hosts) return null;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:') return null;
      return hosts.has(parsed.hostname) ? parsed.href : null;
    } catch {
      return null;
    }
  }
  if (!trimmed.startsWith('/')) return null;
  switch (code) {
    case 'Netflix':
    case 'NETFLIX':
      return `https://www.netflix.com${trimmed}`;
    case 'prime':
    case 'PRIME_VIDEO':
      return `https://www.amazon.co.jp/primevideo${trimmed}`;
    case 'DISNEY_PLUS':
      return `https://www.disneyplus.com${trimmed}`;
    default:
      return null;
  }
}

export function buildPlaybackUrl(code, url, starttime) {
  const base = buildServiceUrl(code, url);
  if (!base) return null;
  if (starttime === undefined) return base;
  return `${base}${base.includes('?') ? '&' : '?'}t=${starttime}`;
}

const CLIP_ID_COOKIE_ATTRS = 'path=/; secure; samesite=lax';

export function clearPlaybackClipId() {
  document.cookie = `clipId=; ${CLIP_ID_COOKIE_ATTRS}; max-age=0`;
}

/** 開けた場合 true、未対応サービスまたは popup がブロックされた場合 false（サイトと同じ）。 */
export function openClipPlayback(clip) {
  const { name, title, username, service, url, starttime, endtime, id } = clip;
  const playbackUrl = buildPlaybackUrl(service, url, starttime);
  if (!playbackUrl) return false;
  const playbackWindow = window.open(playbackUrl, '_blank');
  if (!playbackWindow) return false;

  const hasClipId = id !== undefined && Number.isSafeInteger(id) && id > 0;
  document.cookie = `name=${encodeURIComponent(name)}; path=/; max-age=3600; secure; samesite=lax`;
  document.cookie = `title=${encodeURIComponent(title)}; path=/; max-age=3600; secure; samesite=lax`;
  document.cookie = `username=${encodeURIComponent(username)}; path=/; max-age=3600; secure; samesite=lax`;
  document.cookie = `starttime=${encodeURIComponent(String(starttime))}; path=/; max-age=3600; secure`;
  document.cookie = `endtime=${encodeURIComponent(String(endtime))}; path=/; max-age=3600; secure`;
  document.cookie = `url=${encodeURIComponent(url)}; path=/; max-age=3600; secure`;
  document.cookie = `service=${encodeURIComponent(service)}; path=/; max-age=3600; secure`;
  if (hasClipId) {
    document.cookie = `clipId=${encodeURIComponent(String(id))}; ${CLIP_ID_COOKIE_ATTRS}; max-age=3600`;
  } else {
    clearPlaybackClipId();
  }
  const detail = { name, username, starttime, endtime, requestId: createHandoffRequestId() };
  if (hasClipId) detail.clipId = id;
  window.dispatchEvent(new CustomEvent('clipSelected', { detail }));
  return true;
}

/** サイトには無い。SET_CLIP_DATA で渡し、受理されたら同じタブで移動する（拡張の契約 v1）。 */
export async function handoffInSameTab(clip) {
  const playbackUrl = buildPlaybackUrl(clip.service, clip.url, clip.starttime);
  if (!playbackUrl) return { ok: false, reason: 'unsupported_service' };
  const requestId = createHandoffRequestId();
  const result = waitForMessage((data) => data?.type === 'EXTENSION_PLAYBACK_HANDOFF_RESULT' && data.requestId === requestId);
  window.postMessage({
    type: 'SET_CLIP_DATA',
    requestId,
    payload: {
      clip: {
        clipId: clip.id,
        service: clip.service,
        url: clip.url,
        startTime: clip.starttime,
        endTime: clip.endtime,
        title: clip.title,
        clipname: clip.name,
        username: clip.username,
      },
    },
  }, window.location.origin);
  const data = await result;
  if (data.ok) location.href = playbackUrl;
  return data;
}

export function startPlaylist(queue) {
  clearPlaybackClipId();
  localStorage.setItem('playQueue', JSON.stringify(queue));
  window.postMessage({ type: 'PLAY_PLAYLIST_START', requestId: createHandoffRequestId() }, window.location.origin);
}

// ---------------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------------

function clipById(id) {
  return (pageData.clips || []).find((clip) => clip.id === Number(id));
}

function logHandoff(text, tone) {
  const list = document.getElementById('handoff-log');
  if (!list) return;
  const item = document.createElement('li');
  item.className = tone;
  item.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  list.prepend(item);
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (data?.type !== 'EXTENSION_PLAYBACK_HANDOFF_RESULT') return;
  if (!consumeHandoffResult(data.requestId)) {
    logHandoff(`（無視）他の要求の結果: ${JSON.stringify(data)}`, 'muted');
    return;
  }
  const text = data.ok
    ? `${data.source}: 拡張が受理しました`
    : `${data.source}: 拡張が拒否しました（${data.reason}${data.field ? ` / ${data.field}` : ''}）`;
  logHandoff(text, data.ok ? 'ok' : 'error');
  toast(text, data.ok ? 'ok' : 'error');
});

async function showExtensionStatus() {
  const bar = document.getElementById('ext-status');
  if (!bar) return;
  const present = window.__CLIP_EXTENSION_PRESENT__ === true;
  bar.dataset.present = String(present);
  bar.textContent = present ? '拡張: 検知しました（__CLIP_EXTENSION_PRESENT__）' : '拡張: 見つかりません';
  if (!present) return;
  try {
    const status = await requestExtensionAuthStatus();
    bar.textContent += status.linked ? ' · 連携済み' : ' · 未連携';
    bar.dataset.linked = String(Boolean(status.linked));
  } catch {
    bar.textContent += ' · 連携状態の応答なし';
  }
}

async function refreshFacts() {
  const set = (id, text) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };
  set('fact-present', String(window.__CLIP_EXTENSION_PRESENT__ === true));
  try {
    set('fact-instance', await getExtensionInstanceIdFromExtension());
  } catch (error) {
    set('fact-instance', `取得できません（${error.message}）`);
  }
  try {
    const status = await requestExtensionAuthStatus();
    set('fact-auth', `linked=${status.linked} loggedIn=${status.loggedIn}`);
  } catch (error) {
    set('fact-auth', `応答なし（${error.message}）`);
  }
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === 'watch') {
      const clip = clipById(button.dataset.clipId);
      const opened = openClipPlayback(clip);
      logHandoff(opened ? `clipSelected を送りました（クリップ ${clip.id}）` : `再生ページを開けませんでした（window.open が null。クリップ ${clip.id}）。拡張には何も渡していません`, opened ? 'info' : 'error');
      if (!opened) toast('再生ページを開けませんでした（ポップアップがブロックされた可能性があります）', 'error');
    } else if (action === 'watch-same-tab') {
      const clip = clipById(button.dataset.clipId);
      const result = await handoffInSameTab(clip);
      if (!result.ok) toast(`引き継げませんでした: ${result.reason}`, 'error');
    } else if (action === 'play-playlist') {
      startPlaylist(pageData.playQueue || []);
      logHandoff('PLAY_PLAYLIST_START を送りました', 'info');
    } else if (action === 'link') {
      button.disabled = true;
      await linkExtensionToCurrentUserFromUserAction();
      toast('連携のトークンを拡張へ渡しました', 'ok');
      setTimeout(() => location.reload(), 800);
    } else if (action === 'unlink') {
      await unlinkExtensionFromCurrentUser(Number(button.dataset.linkedId), button.dataset.instanceId);
      toast('連携を解除しました', 'ok');
      setTimeout(() => location.reload(), 800);
    } else if (action === 'refresh-facts') {
      await refreshFacts();
    }
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
  }
});

showExtensionStatus();
if (document.getElementById('ext-facts')) refreshFacts();

window.__site = {
  getExtensionInstanceIdFromExtension,
  requestExtensionAuthStatus,
  linkExtensionToCurrentUserFromUserAction,
  unlinkExtensionFromCurrentUser,
  openClipPlayback,
  handoffInSameTab,
  startPlaylist,
  pageData,
};
