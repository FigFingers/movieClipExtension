import {
  enqueueClip,
  syncPendingQueue,
} from './extensionSync.js';

export const MEMO_SIDEBAR_ID = 'nf-memo-sidebar';
export const AUTO_NAVIGATION_KEY = 'extAutoNavigation';
export const AUTO_NAVIGATION_TTL_MS = 15000;
export const CLOSE_COMMENT_PANEL_EVENT = 'ext:close-comment-panel';

// 表示中サイドバーの状態。再オープン時に元のプレイヤー幅を引き継ぎつつ、
// 前インスタンスのリスナーを確実に外すためモジュールスコープで保持する。
let activeMemoSession = null;

export function requestCloseCommentPanel() {
  if (typeof window.dispatchEvent !== 'function') return;
  const EventConstructor = globalThis.CustomEvent || globalThis.Event;
  if (typeof EventConstructor !== 'function') return;
  window.dispatchEvent(new EventConstructor(CLOSE_COMMENT_PANEL_EVENT));
}

export function closeMemoSidebar() {
  const session = activeMemoSession;
  if (session) {
    session.close();
    return true;
  }

  const sidebar = document.getElementById(MEMO_SIDEBAR_ID);
  if (!sidebar) return false;

  const originalWidth = sidebar.dataset?.originalPlayerWidth;
  sidebar.remove();
  const player =
    document.querySelector('.watch-video--player-view') ||
    document.querySelector('video')?.parentElement;
  if (player) {
    player.style.width =
      originalWidth === undefined ? '100%' : originalWidth;
  }
  return true;
}

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

export function formatSeconds(seconds = 0) {
  const sec = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  // 1時間以上は h:mm:ss、未満は m:ss
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// Netflix のタイトル要素は文字間に U+FEFF / U+200B が挿入されることがある
export function cleanTitleText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\uFEFF\u200B]/g, '').trim();
}

// メモ欄の初期値。エピソードタイトルが取れない動画では作品名だけを返す
export function buildClipName(seriesTitle, episodeTitle) {
  const series = cleanTitleText(seriesTitle);
  const episode = cleanTitleText(episodeTitle);
  if (series && episode) return `${series}｜${episode}`;
  return series || episode;
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
  const syncResult = await syncPendingQueue({ openLoginIfMissingToken: true });
  return {
    ok: syncResult?.ok === true,
    queued: true,
    clientItemId: queuedClip.clientItemId,
    syncResult,
  };
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
  const focusTarget = document.activeElement;

  requestCloseCommentPanel();

  // 直前のサイドバーが残っている場合は旧セッションを無効化する。同じプレイヤーなら
  // 最初に開く前の幅を引き継ぎ、別プレイヤーなら旧プレイヤーの幅をここで復元する。
  const previousSession = activeMemoSession;
  if (!previousSession) {
    // Netflix のクリップ一覧など、メモ以外が同じ領域を使っている場合は、
    // そのサイドバーが保存した元幅へ戻してからメモ側の originalWidth を取得する。
    closeMemoSidebar();
  }
  const originalWidth =
    previousSession?.player === player
      ? previousSession.originalWidth
      : player.style.width;
  if (previousSession) {
    previousSession.supersede();
    previousSession.close({ notify: false, restoreFocus: false });
  }
  document.getElementById(MEMO_SIDEBAR_ID)?.remove();

  player.style.transition = 'width .3s';
  player.style.width = `calc(100% - ${sidebarPct}%)`;

  const sb = document.createElement('div');
  sb.id = MEMO_SIDEBAR_ID;
  sb.setAttribute('role', 'dialog');
  sb.setAttribute('aria-modal', 'false');
  sb.setAttribute('aria-labelledby', `${MEMO_SIDEBAR_ID}-title`);
  sb.style.cssText = `
    position:fixed;top:0;right:0;width:${sidebarPct}%;
    height:100%;background:rgba(0,0,0,.85);padding:10px;
    box-sizing:border-box;z-index:9999;display:flex;flex-direction:column;gap:8px;`;

  let removeKeyGuard;
  let removeMountObserver;
  let session;
  let closed = false;
  let superseded = false;

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
  const title = document.createElement('strong');
  title.id = `${MEMO_SIDEBAR_ID}-title`;
  title.textContent = sidebarTitle;
  title.style.color = 'white';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', '録画メモを閉じる');
  closeBtn.style.cssText = 'background:red;color:#fff;border:none;cursor:pointer;';
  const closeSidebar = ({ notify = true, restoreFocus = true } = {}) => {
    if (closed) return;
    closed = true;
    removeKeyGuard?.();
    removeMountObserver?.();
    // 保存完了が遅れても、現在表示中のセッションだけがプレイヤー幅を変更できる。
    if (activeMemoSession === session) {
      activeMemoSession = null;
      player.style.width = originalWidth;
    }
    sb.remove();
    if (notify) onClose?.();
    if (restoreFocus && focusTarget?.isConnected) {
      focusTarget.focus?.();
    }
  };
  closeBtn.onclick = closeSidebar;
  header.append(title, closeBtn);
  sb.appendChild(header);

  const infoBox = document.createElement('div');
  infoBox.style.fontSize = '12px';
  infoBox.style.color = 'white';
  const start = Math.floor(data?.StartTime || 0);
  const end = Math.floor(data?.EndTime || 0);
  // ページ由来の文字列を扱うため innerHTML は使わない (refs #96)
  const infoRows = [
    ['タイトル', data?.title || '(不明)'],
    ['エピソード', data?.epnumber || '-'],
    ['サービス', data?.service || '-'],
    ['開始', formatSeconds(start)],
    ['終了', formatSeconds(end)],
    ['URL', data?.URL || location.href],
  ];
  for (const [label, value] of infoRows) {
    const row = document.createElement('div');
    const labelEl = document.createElement('b');
    labelEl.textContent = `${label}:`;
    row.append(labelEl, ` ${value}`);
    infoBox.appendChild(row);
  }
  sb.appendChild(infoBox);

  const nameLabel = document.createElement('label');
  nameLabel.style.cssText = 'font-size:12px;color:#fff;';
  nameLabel.textContent = '名前:';
  const nameInput = document.createElement('input');
  // 親 label の color:#fff を継承して白背景に埋もれるため色を明示する。
  nameInput.style.cssText =
    'width:100%;margin-top:4px;padding:4px 6px;box-sizing:border-box;color:#000;background:#fff;border:1px solid #ccc;border-radius:3px;';
  nameInput.value = data?.clipName || '';
  nameLabel.appendChild(nameInput);
  sb.appendChild(nameLabel);

  // 二重送信防止（Enter リピート・保存連打・Enter/click 競合）。
  let submitting = false;
  const submit = () => {
    if (submitting) return;
    submitting = true;
    const enriched = {
      ...data,
      clipName: nameInput.value.trim(),
    };
    const result = onSave ? onSave(enriched) : sendData(enriched);
    Promise.resolve(result)
      .catch(() => console.error('保存に失敗しました'))
      .finally(() => {
        // 再オープンで置き換えられた旧セッションは、新しい入力中の再生状態に触れない。
        if (
          !closed &&
          !superseded &&
          (!activeMemoSession || activeMemoSession === session)
        ) {
          videoPlayer?.play?.();
        }
        closeSidebar();
      });
  };

  // パネル内キーはサイトへ渡さず入力欄で処理。Enter で保存（IME 変換確定・リピート除外）。
  const onPanelKey = (e) => {
    if (!sb.contains(e.target)) return;
    if (e.type === 'keydown' && e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      closeSidebar();
    } else if (
      e.target === nameInput &&
      e.type === 'keydown' &&
      e.key === 'Enter' &&
      !e.isComposing &&
      !e.repeat
    ) {
      e.preventDefault();
      submit();
    }
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    } else {
      e.stopPropagation();
    }
  };
  const keyTypes = ['keydown', 'keyup', 'keypress'];
  for (const type of keyTypes) {
    window.addEventListener(type, onPanelKey, true);
  }

  // サイトがプレイヤーへフォーカスを引き戻すため、外れたら入力欄へ戻す（凍結防止の上限つき）。
  let refocusBudget = 30;
  let refocusWindowStart = 0;
  const keepFocusInPanel = () => {
    if (sb.contains(document.activeElement)) return;
    const now = Date.now();
    if (now - refocusWindowStart > 1000) {
      refocusWindowStart = now;
      refocusBudget = 30;
    }
    if (refocusBudget <= 0) return;
    refocusBudget -= 1;
    nameInput.focus();
  };
  document.addEventListener('focusin', keepFocusInPanel, true);

  removeKeyGuard = () => {
    for (const type of keyTypes) {
      window.removeEventListener(type, onPanelKey, true);
    }
    document.removeEventListener('focusin', keepFocusInPanel, true);
  };

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = '保存';
  saveBtn.style.cssText = 'background:#00c853;border:none;color:#fff;padding:6px;cursor:pointer;';
  saveBtn.onclick = submit;
  sb.appendChild(saveBtn);

  document.body.appendChild(sb);

  session = {
    sidebar: sb,
    player,
    originalWidth,
    teardown: removeKeyGuard,
    close: closeSidebar,
    supersede: () => {
      superseded = true;
    },
  };
  activeMemoSession = session;

  const MutationObserverConstructor = globalThis.MutationObserver;
  const observationRoot = document.documentElement || document.body;
  if (
    typeof MutationObserverConstructor === 'function' &&
    observationRoot
  ) {
    const mountObserver = new MutationObserverConstructor(() => {
      if (!closed && !sb.isConnected) {
        closeSidebar({ restoreFocus: false });
      }
    });
    mountObserver.observe(observationRoot, { childList: true, subtree: true });
    removeMountObserver = () => mountObserver.disconnect();
  }

  nameInput.focus();
  nameInput.select();

  return sb;
}

function readAutoNavigationMarker() {
  try {
    const rawMarker = globalThis.sessionStorage?.getItem(AUTO_NAVIGATION_KEY);
    if (!rawMarker) return null;
    const marker = JSON.parse(rawMarker);
    if (!marker || typeof marker !== 'object') return null;
    return marker;
  } catch {
    return null;
  }
}

export function markAutoNavigation({
  ownerNonce,
  expectedRoute,
  reason = 'auto',
  now = Date.now(),
} = {}) {
  clearAutoNavigation();
  if (
    typeof ownerNonce !== 'string' ||
    ownerNonce.length < 8 ||
    typeof expectedRoute !== 'string' ||
    expectedRoute.length === 0 ||
    !Number.isFinite(now)
  ) {
    return false;
  }

  try {
    globalThis.sessionStorage?.setItem(
      AUTO_NAVIGATION_KEY,
      JSON.stringify({ ownerNonce, expectedRoute, reason, createdAt: now }),
    );
    return Boolean(globalThis.sessionStorage);
  } catch {
    return false;
  }
}

export function isAutoNavigation({
  ownerNonce,
  expectedRoute,
  maxAgeMs = AUTO_NAVIGATION_TTL_MS,
  now = Date.now(),
} = {}) {
  const marker = readAutoNavigationMarker();
  const age = now - Number(marker?.createdAt);
  return Boolean(
    marker &&
      typeof ownerNonce === 'string' &&
      marker.ownerNonce === ownerNonce &&
      typeof expectedRoute === 'string' &&
      marker.expectedRoute === expectedRoute &&
      Number.isFinite(maxAgeMs) &&
      maxAgeMs >= 0 &&
      Number.isFinite(age) &&
      age >= 0 &&
      age <= maxAgeMs
  );
}

export function clearAutoNavigation() {
  try {
    globalThis.sessionStorage?.removeItem(AUTO_NAVIGATION_KEY);
  } catch {
    // バックグラウンド側の所有権検査により、事前登録されていない遷移先は引き続き拒否される。
  }
}

export function consumeAutoNavigation(options) {
  const matched = isAutoNavigation(options);
  clearAutoNavigation();
  return matched;
}

export function handleOwnedPlaybackRouteChange({
  ownerNonce,
  currentRoute,
  nextRoute,
  onAutoNavigation,
  onManualNavigation,
}) {
  if (!ownerNonce || nextRoute === currentRoute) return 'unchanged';
  if (consumeAutoNavigation({ ownerNonce, expectedRoute: nextRoute })) {
    onAutoNavigation?.(nextRoute);
    return 'auto';
  }
  onManualNavigation?.();
  return 'manual';
}

export function createElementWait(
  selector,
  {
    documentRef = globalThis.document,
    MutationObserverConstructor = globalThis.MutationObserver,
  } = {},
) {
  let observer = null;
  let settled = false;
  let resolveWait;
  const finish = (element) => {
    if (settled) return;
    settled = true;
    observer?.disconnect();
    resolveWait(element);
  };
  const promise = new Promise((resolve) => {
    resolveWait = resolve;
    const existing = documentRef?.querySelector?.(selector);
    if (existing) {
      finish(existing);
      return;
    }
    if (!documentRef?.body || typeof MutationObserverConstructor !== 'function') {
      finish(null);
      return;
    }
    observer = new MutationObserverConstructor(() => {
      const element = documentRef.querySelector(selector);
      if (element) finish(element);
    });
    observer.observe(documentRef.body, { childList: true, subtree: true });
  });
  return {
    promise,
    cancel: () => finish(null),
  };
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
