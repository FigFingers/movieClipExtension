import { formatSeconds } from '../util/time.js';

export const MEMO_SIDEBAR_ID = 'nf-memo-sidebar';
let activeMemoSession = null;

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

  // 直前のサイドバーが残っている場合は旧セッションを無効化する。同じプレイヤーなら
  // 最初に開く前の幅を引き継ぎ、別プレイヤーなら旧プレイヤーの幅をここで復元する。
  const previousSession = activeMemoSession;
  let originalWidth = player.style.width;
  if (previousSession) {
    previousSession.supersede();
    previousSession.teardown();
    previousSession.sidebar.remove();
    if (previousSession.player === player) {
      originalWidth = previousSession.originalWidth;
    } else {
      previousSession.player.style.width = previousSession.originalWidth || '100%';
    }
    activeMemoSession = null;
  }
  document.getElementById(MEMO_SIDEBAR_ID)?.remove();

  player.style.transition = 'width .3s';
  player.style.width = `calc(100% - ${sidebarPct}%)`;

  const sb = document.createElement('div');
  sb.id = MEMO_SIDEBAR_ID;
  sb.style.cssText = `
    position:fixed;top:0;right:0;width:${sidebarPct}%;
    height:100%;background:rgba(0,0,0,.85);padding:10px;
    box-sizing:border-box;z-index:9999;display:flex;flex-direction:column;gap:8px;`;

  let removeKeyGuard;
  let session;
  let closed = false;
  let superseded = false;

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
  const title = document.createElement('strong');
  title.textContent = sidebarTitle;
  title.style.color = 'white';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'background:red;color:#fff;border:none;cursor:pointer;';
  const closeSidebar = () => {
    if (closed) return;
    closed = true;
    removeKeyGuard?.();
    // 保存完了が遅れても、現在表示中のセッションだけがプレイヤー幅を変更できる。
    if (activeMemoSession === session) {
      activeMemoSession = null;
      player.style.width = originalWidth || '100%';
    }
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
  const submit = async () => {
    if (submitting || closed || superseded) return;
    submitting = true;
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    errorBox.hidden = true;
    const enriched = {
      ...data,
      clipName: nameInput.value.trim(),
    };
    try {
      // ローカルキューに保存できれば完了。同期待ち（queued: true）は失敗ではない。
      await onSave(enriched);
    } catch (error) {
      console.error('保存エラー:', error);
      if (!closed && !superseded && activeMemoSession === session) {
        errorBox.textContent = '保存できませんでした。名前を保持しています。もう一度保存してください。';
        errorBox.hidden = false;
      }
      return;
    } finally {
      submitting = false;
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
    }

    // 閉じた、または置き換えられたパネルの保存完了は現在の再生状態に触れない。
    if (closed || superseded || activeMemoSession !== session) return;
    try {
      // 再生の拒否で保存済みクリップを再送させない。
      videoPlayer?.play?.()?.catch?.((error) => console.warn('再生再開エラー:', error));
    } catch (error) {
      console.warn('再生再開エラー:', error);
    }
    closeSidebar();
  };

  // パネル内キーはサイトへ渡さず入力欄で処理。Enter で保存（IME 変換確定・リピート除外）。
  const onPanelKey = (e) => {
    if (!sb.contains(e.target)) return;
    if (
      e.target === nameInput &&
      e.type === 'keydown' &&
      e.key === 'Enter' &&
      !e.isComposing &&
      !e.repeat
    ) {
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

  const errorBox = document.createElement('div');
  errorBox.role = 'alert';
  errorBox.hidden = true;
  errorBox.style.cssText = 'font-size:12px;color:#ffb4ab;';
  sb.appendChild(errorBox);

  document.body.appendChild(sb);

  session = {
    sidebar: sb,
    player,
    originalWidth,
    teardown: removeKeyGuard,
    supersede: () => {
      superseded = true;
    },
  };
  activeMemoSession = session;

  nameInput.focus();
  nameInput.select();

  return sb;
}

