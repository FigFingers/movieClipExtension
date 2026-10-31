import {
  enqueueClip,
  syncPendingQueue,
} from './extensionSync.js';

import { openMemoSidebar as renderMemoSidebar } from './memoSidebar.js';
export { MEMO_SIDEBAR_ID } from './memoSidebar.js';
export { formatSeconds } from '../util/time.js';
export const AUTO_NAVIGATION_KEY = 'extAutoNavigation';

export function detectService(host = window.location.hostname) {
  if (host.includes('netflix.com')) return 'Netflix';
  if (host.includes('primevideo.com')) return 'Prime Video';
  if (host.includes('youtube.com')) return 'YouTube';
  // サイト側 VOD 名(prisma seed: name "Disney+")と一致させる。'DisneyPlus' だと
  // findActiveIdByLookup が code/name/alias いずれにも一致せず 404 になる。
  if (host.includes('disneyplus.com')) return 'Disney+';
  if (host.includes('hulu.jp') || host.includes('hulu.com')) return 'Hulu';
  return 'Unknown';
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

export async function sendData(dataToSend) {
  const queuedClip = await enqueueClip(dataToSend);
  // 保存完了は永続キューへの書込み。ネットワーク待ちで入力パネルを塞がない。
  void syncPendingQueue({ openLoginIfMissingToken: true });
  return {
    ok: true,
    queued: true,
    clientItemId: queuedClip.clientItemId,
  };
}

export function openMemoSidebar(options) {
  return renderMemoSidebar({
    ...options,
    data: {
      ...options.data,
      clientItemId: options.data?.clientItemId || crypto.randomUUID(),
      createdAt: options.data?.createdAt || new Date().toISOString(),
    },
    onSave: options.onSave || sendData,
  });
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

// === タブ可視性に応じた拡張 UI の表示制御 ===
// 動画タブが裏に回った（document.hidden）ら拡張ボタンを隠し、戻ったら opacity の
// トランジションでフェードインさせる。対象は markExtUi で EXT_UI_CLASS を付けた要素。
// 状態は <html> の class で持たせて CSS 一括制御するため、タブが隠れている間に
// 再注入されたボタンにも自動で効く。
export const EXT_UI_CLASS = 'dext-ext-ui';
const TAB_HIDDEN_CLASS = 'dext-tab-hidden';
const VISIBILITY_STYLE_ID = 'dext-visibility-style';

export function markExtUi(element) {
  element?.classList.add(EXT_UI_CLASS);
  return element;
}

function ensureVisibilityStyle() {
  if (document.getElementById(VISIBILITY_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = VISIBILITY_STYLE_ID;
  style.textContent = `
    .${EXT_UI_CLASS} { transition: opacity .3s ease; }
    .${TAB_HIDDEN_CLASS} .${EXT_UI_CLASS} { opacity: 0; pointer-events: none; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

export function startTabVisibilityToggle() {
  ensureVisibilityStyle();
  const apply = () =>
    document.documentElement.classList.toggle(TAB_HIDDEN_CLASS, document.hidden);
  apply();
  document.addEventListener('visibilitychange', apply);
}
