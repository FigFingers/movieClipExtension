import { getApiEndpoint } from './../api.js';

export const MEMO_SIDEBAR_ID = 'nf-memo-sidebar';
export const AUTO_NAVIGATION_KEY = 'extAutoNavigation';
export const EXT_CONNECTION_STATE_KEY = 'extensionConnectionState';

const DEFAULT_CONNECTION_STATE = {
  extensionInstanceId: '',
  extensionAuthToken: '',
  linked: false,
  lastSyncAt: null,
};

function isExtensionContextAvailable() {
  return Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.storage?.local);
}

function createExtensionContextError() {
  return new Error('Extension context is invalidated. Reload this streaming page after updating the extension.');
}

function assertExtensionContext() {
  if (!isExtensionContextAvailable()) {
    throw createExtensionContextError();
  }
}

function isExtensionContextError(error) {
  return String(error?.message || error).includes('Extension context invalidated');
}

async function chromeStorageGet(keys) {
  assertExtensionContext();
  try {
    return await chrome.storage.local.get(keys);
  } catch (error) {
    if (isExtensionContextError(error)) {
      throw createExtensionContextError();
    }
    throw error;
  }
}

async function chromeStorageSet(items) {
  assertExtensionContext();
  try {
    await chrome.storage.local.set(items);
  } catch (error) {
    if (isExtensionContextError(error)) {
      throw createExtensionContextError();
    }
    throw error;
  }
}

export function detectService(host = window.location.hostname) {
  if (host.includes('netflix.com')) return 'Netflix';
  if (host.includes('primevideo.com')) return 'Prime Video';
  if (host.includes('youtube.com')) return 'YouTube';
  if (host.includes('disneyplus.com')) return 'DisneyPlus';
  if (host.includes('hulu.jp') || host.includes('hulu.com')) return 'Hulu';
  return 'Unknown';
}

export function formatSeconds(seconds = 0) {
  const sec = Math.max(0, Math.floor(seconds));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function decideClipTransition(currentUrl, nextUrl) {
  return currentUrl === nextUrl ? 'seek' : 'navigate';
}

export async function handleClipTransition({ currentUrl, nextUrl, onSameUrl, onDifferentUrl }) {
  const action = decideClipTransition(currentUrl, nextUrl);
  if (action === 'seek') {
    return onSameUrl?.();
  }
  return onDifferentUrl?.();
}

export async function requestSeek({ service = detectService(), seconds, adapter, videoElement }) {
  const targetSeconds = Number(seconds);
  if (!Number.isFinite(targetSeconds)) {
    throw new Error(`Invalid seek seconds: ${seconds}`);
  }

  if (service === 'Netflix') {
    return chrome.runtime.sendMessage({ type: 'seek', sec: targetSeconds });
  }

  if (adapter?.seek) {
    adapter.seek(targetSeconds);
    return { ok: true };
  }

  if (videoElement) {
    videoElement.currentTime = targetSeconds;
    videoElement.play?.();
    return { ok: true };
  }

  console.warn(`[Seek] No handler for service: ${service}`);
  return { ok: false };
}

function generateUuid() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const values = globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint8Array(16))
    : Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  values[6] = (values[6] & 0x0f) | 0x40;
  values[8] = (values[8] & 0x3f) | 0x80;
  const hex = Array.from(values, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function getConnectionState() {
  const { [EXT_CONNECTION_STATE_KEY]: raw } = await chromeStorageGet([EXT_CONNECTION_STATE_KEY]);
  return {
    ...DEFAULT_CONNECTION_STATE,
    ...(raw || {}),
  };
}

async function saveConnectionState(nextState) {
  await chromeStorageSet({ [EXT_CONNECTION_STATE_KEY]: nextState });
  return nextState;
}

async function clearStoredAuthToken(state) {
  const currentState = state || (await getConnectionState());
  return saveConnectionState({
    ...currentState,
    extensionAuthToken: '',
    linked: false,
    lastSyncAt: null,
  });
}

export async function ensureExtensionInstanceId() {
  const state = await getConnectionState();
  if (state.extensionInstanceId) return state.extensionInstanceId;

  const extensionInstanceId = generateUuid();
  await saveConnectionState({
    ...state,
    extensionInstanceId,
  });
  return extensionInstanceId;
}

export async function checkExtensionSession() {
  const state = await getConnectionState();

  if (!isJwtValid(state.extensionAuthToken)) {
    await clearStoredAuthToken(state);
    return { loggedIn: false };
  }

  const response = await fetch(getApiEndpoint('extension/session'), {
    method: 'GET',
    headers: { Authorization: `Bearer ${state.extensionAuthToken}` },
  });

  if (!response.ok) {
    await clearStoredAuthToken(state);
    return { loggedIn: false };
  }

  const session = await response.json();
  return { ...session, loggedIn: true };
}

let loginTabOpened = false;

function isJwtValid(token) {
  if (!token) return false;
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64));
    return typeof payload.exp === 'number' && payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

function openLoginTab() {
  if (!loginTabOpened) {
    loginTabOpened = true;
    window.open('http://localhost:3000', '_blank');
  }
}

async function postClipToLegacyReceive(payload) {
  const state = await getConnectionState();
  const token = state.extensionAuthToken;

  if (!isJwtValid(token)) {
    await clearStoredAuthToken(state);
    openLoginTab();
    throw new Error('Unauthorized: please log in at localhost:3000');
  }

  const response = await fetch(getApiEndpoint('receive'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 401) {
    await clearStoredAuthToken(state);
    openLoginTab();
    throw new Error('Unauthorized: please log in at localhost:3000');
  }

  if (!response.ok) {
    throw new Error(`Legacy receive failed: ${response.status}`);
  }

  const text = await response.text();
  if (!text) {
    return { ok: true };
  }

  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, raw: text };
  }
}

export async function sendData(dataToSend) {
  return postClipToLegacyReceive(dataToSend);
}

let extensionClientInitialized = false;

export async function initializeExtensionClient() {
  if (extensionClientInitialized) return;
  extensionClientInitialized = true;
  try {
    await ensureExtensionInstanceId();
  } catch (error) {
    extensionClientInitialized = false;
    if (error?.message?.includes('Extension context is invalidated')) {
      console.warn('[ExtensionClient] context invalidated; reload this page after updating the extension.');
      return;
    }
    throw error;
  }

}

export function openMemoSidebar({
  data = {},
  videoPlayer,
  sidebarPct = 20,
  sidebarTitle = '録画メモ',
  onSave,
  onClose,
}) {
  const player =
    videoPlayer ||
    document.querySelector('.watch-video--player-view') ||
    document.querySelector('video')?.parentElement;
  if (!player) return null;

  document.getElementById(MEMO_SIDEBAR_ID)?.remove();

  const originalWidth = player.style.width;
  player.style.transition = 'width .3s';
  player.style.width = `calc(100% - ${sidebarPct}%)`;

  const sb = document.createElement('div');
  sb.id = MEMO_SIDEBAR_ID;
  sb.style.cssText = `
    position:fixed;top:0;right:0;width:${sidebarPct}%;
    height:100%;background:rgba(0,0,0,.85);padding:10px;
    box-sizing:border-box;z-index:9999;display:flex;flex-direction:column;gap:8px;`;

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
  const title = document.createElement('strong');
  title.textContent = sidebarTitle;
  title.style.color = 'white';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'background:red;color:#fff;border:none;cursor:pointer;';
  const closeSidebar = () => {
    player.style.width = originalWidth || '100%';
    sb.remove();
    onClose?.();
  };
  closeBtn.onclick = closeSidebar;
  header.append(title, closeBtn);
  sb.appendChild(header);

  const infoBox = document.createElement('div');
  infoBox.style.fontSize = '12px';
  infoBox.style.color = 'white';
  const start = Math.floor(data?.StartTime || 0);
  const end = Math.floor(data?.EndTime || 0);
  infoBox.innerHTML = `
    <div><b>タイトル:</b> ${data?.title || '(不明)'}</div>
    <div><b>エピソード:</b> ${data?.epnumber || '-'}</div>
    <div><b>サービス:</b> ${data?.service || '-'}</div>
    <div><b>開始:</b> ${formatSeconds(start)}</div>
    <div><b>終了:</b> ${formatSeconds(end)}</div>
    <div><b>URL:</b> ${data?.URL || location.href}</div>`;
  sb.appendChild(infoBox);

  const nameLabel = document.createElement('label');
  nameLabel.style.cssText = 'font-size:12px;color:#000;';
  nameLabel.textContent = '名前:';
  const nameInput = document.createElement('input');
  nameInput.style.cssText = 'width:100%;margin-top:4px;';
  nameInput.value = data?.clipName || '';
  nameLabel.appendChild(nameInput);
  sb.appendChild(nameLabel);

  const saveBtn = document.createElement('button');
  saveBtn.textContent = '保存';
  saveBtn.style.cssText = 'background:#00c853;border:none;color:#fff;padding:6px;cursor:pointer;';

  saveBtn.onclick = () => {
    const enriched = {
      ...data,
      clipName: nameInput.value.trim(),
    };
    const result = onSave ? onSave(enriched) : sendData(enriched);
    Promise.resolve(result)
      .catch((error) => console.error('保存エラー:', error))
      .finally(() => {
        videoPlayer?.play?.();
        closeSidebar();
      });
  };
  sb.appendChild(saveBtn);

  document.body.appendChild(sb);
  return sb;
}

export function markAutoNavigation(reason = 'auto') {
  sessionStorage.setItem(AUTO_NAVIGATION_KEY, reason);
  localStorage.setItem(AUTO_NAVIGATION_KEY, reason);
}

export function isAutoNavigation() {
  return Boolean(
    sessionStorage.getItem(AUTO_NAVIGATION_KEY) ||
      localStorage.getItem(AUTO_NAVIGATION_KEY)
  );
}

export function clearAutoNavigation() {
  sessionStorage.removeItem(AUTO_NAVIGATION_KEY);
  localStorage.removeItem(AUTO_NAVIGATION_KEY);
}
