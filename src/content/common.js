import {
  enqueueClip,
  syncPendingQueue,
} from './extensionSync.js';

export const MEMO_SIDEBAR_ID = 'nf-memo-sidebar';
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

  let removeKeyGuard;

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
  const title = document.createElement('strong');
  title.textContent = sidebarTitle;
  title.style.color = 'white';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'background:red;color:#fff;border:none;cursor:pointer;';
  const closeSidebar = () => {
    removeKeyGuard?.();
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
      .catch((error) => console.error('保存エラー:', error))
      .finally(() => {
        videoPlayer?.play?.();
        closeSidebar();
      });
  };

  // パネル内キーはサイトへ渡さず入力欄で処理。Enter で保存（IME 変換確定・リピート除外）。
  const onPanelKey = (e) => {
    if (!sb.contains(e.target)) return;
    if (e.type === 'keydown' && e.key === 'Enter' && !e.isComposing && !e.repeat) {
      e.preventDefault();
      submit();
    }
    e.stopPropagation();
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
  saveBtn.textContent = '保存';
  saveBtn.style.cssText = 'background:#00c853;border:none;color:#fff;padding:6px;cursor:pointer;';
  saveBtn.onclick = submit;
  sb.appendChild(saveBtn);

  document.body.appendChild(sb);

  nameInput.focus();
  nameInput.select();

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
