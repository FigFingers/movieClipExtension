import { storageGet } from './../shared/storage.js';

export const COMMENT_PANEL_ID = 'ext-comment-panel';

const COMMENT_LIMIT = 20;
const COMMENT_BODY_MAX_LENGTH = 500;
const PLAYBACK_STORAGE_KEYS = [
  'playmode',
  'playClipSystemKey',
  'playlistSystemKey',
  'clip',
  'playQueue',
  'currentClipOrder',
];
const WATCHED_STORAGE_KEYS = new Set([
  ...PLAYBACK_STORAGE_KEYS,
  'extensionAuthToken',
  'extensionLinked',
]);

const PANEL_STYLES = `
  :host {
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  *, *::before, *::after {
    box-sizing: border-box;
  }

  [hidden] {
    display: none !important;
  }

  .panel {
    position: absolute;
    top: 0;
    right: 0;
    width: min(420px, 38vw);
    min-width: 300px;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    overflow: hidden;
    color: #fff;
    background: rgba(13, 17, 23, 0.96);
    border-left: 1px solid rgba(255, 255, 255, 0.18);
    box-shadow: -10px 0 28px rgba(0, 0, 0, 0.42);
    pointer-events: auto;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .title {
    margin: 0;
    font-size: 18px;
    line-height: 1.4;
  }

  button,
  textarea {
    font: inherit;
  }

  button {
    border: 0;
    border-radius: 6px;
    cursor: pointer;
  }

  button:focus-visible,
  textarea:focus-visible {
    outline: 2px solid #76b7ff;
    outline-offset: 2px;
  }

  button:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .refresh {
    padding: 6px 10px;
    color: #fff;
    background: rgba(255, 255, 255, 0.14);
    font-size: 12px;
  }

  .close {
    width: 32px;
    height: 32px;
    color: #fff;
    background: rgba(255, 255, 255, 0.14);
    font-size: 22px;
    line-height: 1;
  }

  .comments {
    flex: 1;
    min-height: 100px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-right: 3px;
  }

  .message {
    margin: 16px 0;
    color: #d0d7de;
    line-height: 1.6;
    white-space: pre-wrap;
  }

  .comment {
    padding: 12px 2px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.14);
  }

  .comment-meta {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }

  .comment-user {
    color: #fff;
    font-size: 13px;
  }

  .comment-time {
    color: #9da7b1;
    font-size: 11px;
    white-space: nowrap;
  }

  .comment-body {
    margin: 0;
    color: #f0f3f6;
    font-size: 14px;
    line-height: 1.55;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .pagination,
  .actions {
    display: flex;
    justify-content: center;
    gap: 8px;
  }

  .secondary {
    padding: 7px 12px;
    color: #fff;
    background: rgba(255, 255, 255, 0.14);
  }

  .composer {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.18);
  }

  .composer-label {
    font-size: 12px;
    color: #d0d7de;
  }

  .textarea {
    width: 100%;
    min-height: 82px;
    max-height: 180px;
    resize: vertical;
    padding: 9px 10px;
    border: 1px solid rgba(255, 255, 255, 0.28);
    border-radius: 7px;
    color: #111;
    background: #fff;
    line-height: 1.45;
  }

  .submit {
    align-self: flex-end;
    padding: 8px 16px;
    color: #07130b;
    background: #54d173;
    font-weight: 700;
  }

  .status {
    min-height: 18px;
    margin: 0;
    color: #b8c1cc;
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
  }

  .status[data-tone="error"] {
    color: #ffb4ab;
  }

  .status[data-tone="success"] {
    color: #7ee787;
  }

  @media (max-width: 720px) {
    .panel {
      width: 100%;
      min-width: 0;
    }
  }
`;

let activePanel = null;

function toSafeInteger(value, { positive = false, nonNegative = false } = {}) {
  let numberValue;
  if (typeof value === 'number') {
    numberValue = value;
  } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    numberValue = Number(value.trim());
  } else {
    return null;
  }

  if (!Number.isSafeInteger(numberValue)) return null;
  if (positive && numberValue <= 0) return null;
  if (nonNegative && numberValue < 0) return null;
  return numberValue;
}

function resolvePlaybackMode(state) {
  if (state?.playmode === 'playlist' || state?.playmode === 'clip') {
    return state.playmode;
  }

  if (state?.playClipSystemKey === 1) return 'clip';
  if (state?.playlistSystemKey === 1) return 'playlist';
  return null;
}

export function resolveCurrentClipIdFromState(state = {}) {
  const mode = resolvePlaybackMode(state);

  if (mode === 'playlist') {
    if (!Array.isArray(state.playQueue)) return null;
    const currentOrder = toSafeInteger(state.currentClipOrder, { nonNegative: true });
    if (currentOrder === null) return null;

    const currentClip = state.playQueue.find(
      (item) => toSafeInteger(item?.order, { nonNegative: true }) === currentOrder
    );
    const id = currentClip?.clipId ?? currentClip?.id;
    return toSafeInteger(id, { positive: true });
  }

  if (mode === 'clip') {
    const id = state.clip?.clipId ?? state.clip?.id;
    return toSafeInteger(id, { positive: true });
  }

  return null;
}

export async function resolveCurrentClipId() {
  const state = await storageGet(PLAYBACK_STORAGE_KEYS);
  return resolveCurrentClipIdFromState(state);
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) {
      resolve({ ok: false, reason: 'background_unavailable' });
      return;
    }

    try {
      runtime.sendMessage(message, (response) => {
        if (runtime.lastError) {
          resolve({
            ok: false,
            reason: 'background_unavailable',
            message: runtime.lastError.message,
          });
          return;
        }
        resolve(response || { ok: false, reason: 'request_failed' });
      });
    } catch (error) {
      resolve({
        ok: false,
        reason: 'background_unavailable',
        message: error?.message,
      });
    }
  });
}

function createElement(tagName, text) {
  const element = document.createElement(tagName);
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function setStatus(controller, message = '', tone = '') {
  controller.status.textContent = message;
  if (tone) {
    controller.status.dataset.tone = tone;
  } else {
    delete controller.status.dataset.tone;
  }
}

function setActions(controller, buttons = []) {
  controller.actions.replaceChildren(...buttons);
}

function createActionButton(label, onClick) {
  const button = createElement('button', label);
  button.type = 'button';
  button.className = 'secondary';
  button.addEventListener('click', onClick);
  return button;
}

function updateSubmitState(controller) {
  const hasBody = controller.textarea.value.trim().length > 0;
  controller.submitButton.disabled =
    !controller.composeAvailable || controller.posting || !hasBody;
  controller.textarea.disabled = !controller.composeAvailable;
  controller.refreshButton.disabled = controller.posting;
}

function setComposeAvailable(controller, available) {
  controller.composeAvailable = available;
  updateSubmitState(controller);
}

function showListMessage(controller, message) {
  const paragraph = createElement('p', message);
  paragraph.className = 'message';
  controller.commentsList.replaceChildren(paragraph);
  controller.loadMoreButton.hidden = true;
}

function formatCommentDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ja-JP');
}

function createCommentElement(comment) {
  const article = createElement('article');
  article.className = 'comment';

  const meta = createElement('div');
  meta.className = 'comment-meta';

  const username = createElement(
    'strong',
    typeof comment?.username === 'string' && comment.username.trim()
      ? comment.username
      : 'ユーザー'
  );
  username.className = 'comment-user';

  const time = createElement('time', formatCommentDate(comment?.createdAt));
  time.className = 'comment-time';
  if (typeof comment?.createdAt === 'string') {
    time.dateTime = comment.createdAt;
  }

  const body = createElement(
    'p',
    typeof comment?.body === 'string' ? comment.body : ''
  );
  body.className = 'comment-body';

  meta.append(username, time);
  article.append(meta, body);
  return article;
}

function renderComments(controller) {
  if (controller.comments.length === 0) {
    showListMessage(controller, 'コメントはまだありません。');
  } else {
    controller.commentsList.replaceChildren(
      ...controller.comments.map(createCommentElement)
    );
    controller.loadMoreButton.hidden = !controller.hasNext;
  }

  controller.loadMoreButton.disabled = controller.loadingMore;
  controller.loadMoreButton.textContent = controller.loadingMore
    ? '読込中…'
    : 'さらに表示';
}

function commentIdentity(comment) {
  const id = toSafeInteger(comment?.id, { positive: true });
  return id === null ? null : String(id);
}

function mergeComments(existing, incoming) {
  const seenIds = new Set();
  const merged = [];
  for (const comment of [...existing, ...incoming]) {
    const identity = commentIdentity(comment);
    if (identity !== null && seenIds.has(identity)) continue;
    if (identity !== null) seenIds.add(identity);
    merged.push(comment);
  }
  return merged;
}

async function openLoginPage(controller) {
  setStatus(controller, 'ログインページを開いています…');
  const result = await sendRuntimeMessage({ type: 'OPEN_LOGIN_TAB' });
  if (controller.closed) return;

  if (result?.ok) {
    setStatus(
      controller,
      'ログインページを開きました。連携後に再試行してください。',
      'success'
    );
  } else {
    setStatus(controller, 'ログインページを開けませんでした。', 'error');
  }
}

function showAuthRequired(controller) {
  showListMessage(controller, 'コメントを利用するには、サイトとの連携が必要です。');
  setComposeAvailable(controller, false);
  setStatus(controller, 'サイトとの連携が必要です。', 'error');
  setActions(controller, [
    createActionButton('連携する', () => {
      void openLoginPage(controller);
    }),
    createActionButton('再試行', () => {
      void refreshCurrentClip(controller);
    }),
  ]);
}

function showFetchError(controller, result, retry) {
  setComposeAvailable(controller, false);

  if (result?.reason === 'missing_token' || result?.reason === 'unauthorized') {
    showAuthRequired(controller);
    return;
  }

  if (result?.reason === 'not_found') {
    showListMessage(controller, '対象のクリップが見つかりません。');
    setStatus(controller, 'コメントを取得できません。', 'error');
    setActions(controller);
    return;
  }

  if (result?.reason === 'forbidden') {
    showListMessage(controller, 'このクリップのコメントにはアクセスできません。');
    setStatus(controller, 'アクセスが拒否されました。', 'error');
    setActions(controller);
    return;
  }

  showListMessage(controller, 'コメントの取得に失敗しました。');
  setStatus(controller, result?.message || '通信状態を確認して再試行してください。', 'error');
  setActions(controller, [createActionButton('再試行', retry)]);
}

async function loadComments(
  controller,
  { cursor, append = false, contextVersion = controller.contextVersion } = {}
) {
  if (controller.closed || controller.clipId === null) return;

  const requestVersion = ++controller.requestVersion;
  if (append) {
    controller.loadingMore = true;
    renderComments(controller);
    setStatus(controller, '以前のコメントを読み込んでいます…');
  } else {
    controller.comments = [];
    controller.hasNext = false;
    controller.nextCursor = null;
    showListMessage(controller, '読込中…');
    setComposeAvailable(controller, false);
    setActions(controller);
    setStatus(controller, 'コメントを読み込んでいます…');
  }

  const message = {
    type: 'FETCH_CLIP_COMMENTS',
    clipId: controller.clipId,
    limit: COMMENT_LIMIT,
  };
  if (cursor !== undefined && cursor !== null) {
    message.cursor = cursor;
  }

  const result = await sendRuntimeMessage(message);
  if (
    controller.closed ||
    controller.contextVersion !== contextVersion ||
    controller.requestVersion !== requestVersion
  ) {
    return;
  }

  controller.loadingMore = false;
  if (!result?.ok) {
    if (append && controller.comments.length > 0) {
      renderComments(controller);
      if (result?.reason === 'missing_token' || result?.reason === 'unauthorized') {
        showAuthRequired(controller);
      } else {
        setStatus(controller, '追加のコメント取得に失敗しました。', 'error');
        setActions(controller, [
          createActionButton('再試行', () => {
            void loadComments(controller, {
              cursor,
              append: true,
              contextVersion,
            });
          }),
        ]);
      }
      return;
    }

    showFetchError(controller, result, () => {
      void refreshCurrentClip(controller);
    });
    return;
  }

  const receivedComments = Array.isArray(result.comments) ? result.comments : [];
  controller.comments = append
    ? mergeComments(controller.comments, receivedComments)
    : mergeComments([], receivedComments);
  const nextCursor = toSafeInteger(result.nextCursor, { positive: true });
  controller.hasNext = Boolean(result.hasNext && nextCursor !== null);
  controller.nextCursor = controller.hasNext ? nextCursor : null;

  renderComments(controller);
  setComposeAvailable(controller, true);
  setActions(controller);
  setStatus(controller);
}

async function refreshCurrentClip(controller) {
  if (controller.closed) return;
  const previousClipId = controller.clipId;
  const contextVersion = ++controller.contextVersion;
  controller.requestVersion += 1;
  controller.comments = [];
  controller.hasNext = false;
  controller.nextCursor = null;
  controller.loadingMore = false;
  showListMessage(controller, '再生中のクリップを確認しています…');
  setComposeAvailable(controller, false);
  setActions(controller);
  setStatus(controller);

  let clipId = null;
  try {
    clipId = await resolveCurrentClipId();
  } catch (error) {
    if (controller.closed || controller.contextVersion !== contextVersion) return;
    controller.clipId = null;
    showListMessage(controller, '再生中のクリップを確認できませんでした。');
    setStatus(controller, error?.message || 'ストレージの読み込みに失敗しました。', 'error');
    setActions(controller, [
      createActionButton('再試行', () => {
        void refreshCurrentClip(controller);
      }),
    ]);
    return;
  }

  if (controller.closed || controller.contextVersion !== contextVersion) return;
  if (clipId === null) {
    controller.clipId = null;
    if (previousClipId !== null) {
      controller.textarea.value = '';
    }
    showListMessage(
      controller,
      'コメントを表示できるのは、サイトから再生したクリップのみです。'
    );
    setStatus(controller, 'このクリップにはサーバー上のIDがありません。');
    return;
  }

  if (previousClipId !== null && clipId !== previousClipId) {
    controller.textarea.value = '';
  }
  controller.clipId = clipId;
  await loadComments(controller, { contextVersion });
}

function showPostError(controller, result) {
  if (result?.reason === 'missing_token' || result?.reason === 'unauthorized') {
    setComposeAvailable(controller, false);
    setStatus(controller, '投稿するにはサイトとの連携が必要です。', 'error');
    setActions(controller, [
      createActionButton('連携する', () => {
        void openLoginPage(controller);
      }),
      createActionButton('再試行', () => {
        void refreshCurrentClip(controller);
      }),
    ]);
    return;
  }

  if (result?.reason === 'not_found') {
    setComposeAvailable(controller, false);
    setStatus(controller, '対象のクリップが見つかりません。', 'error');
    return;
  }

  if (result?.reason === 'validation_error') {
    setStatus(
      controller,
      result?.message || 'コメントは1〜500文字で入力してください。',
      'error'
    );
    return;
  }

  setStatus(
    controller,
    result?.message || 'コメントの投稿に失敗しました。入力内容は保持されています。',
    'error'
  );
}

async function postComment(controller) {
  if (controller.closed || controller.posting || !controller.composeAvailable) return;
  const body = controller.textarea.value.trim();
  if (!body) {
    updateSubmitState(controller);
    return;
  }

  if (body.length > COMMENT_BODY_MAX_LENGTH) {
    setStatus(controller, 'コメントは500文字以内で入力してください。', 'error');
    return;
  }

  controller.posting = true;
  updateSubmitState(controller);
  setActions(controller);
  setStatus(controller, '投稿しています…');

  const contextVersion = controller.contextVersion;
  const expectedClipId = controller.clipId;

  try {
    let currentClipId = null;
    try {
      currentClipId = await resolveCurrentClipId();
    } catch (error) {
      if (!controller.closed && controller.contextVersion === contextVersion) {
        setStatus(
          controller,
          error?.message || '再生中のクリップを確認できませんでした。',
          'error'
        );
      }
      return;
    }

    if (controller.closed || controller.contextVersion !== contextVersion) return;
    if (currentClipId === null || currentClipId !== expectedClipId) {
      setStatus(controller, '再生中のクリップが変わったため、投稿を中止しました。', 'error');
      await refreshCurrentClip(controller);
      return;
    }

    const result = await sendRuntimeMessage({
      type: 'POST_CLIP_COMMENT',
      clipId: expectedClipId,
      body,
    });

    if (controller.closed || controller.contextVersion !== contextVersion) return;

    if (!result?.ok || !result.comment || typeof result.comment !== 'object') {
      showPostError(controller, result);
      return;
    }

    controller.comments = mergeComments([result.comment], controller.comments);
    controller.textarea.value = '';
    renderComments(controller);
    setActions(controller);
    setStatus(controller, 'コメントを投稿しました。', 'success');
  } finally {
    if (!controller.closed) {
      controller.posting = false;
      updateSubmitState(controller);
    }
  }
}

/**
 * 先頭ページを取り直して一覧を作り直す。サイト側でコメントが削除されると
 * 一覧から消えるだけなので、追記マージのままでは削除済みが残り続ける。
 */
function reloadComments(controller) {
  if (controller.closed || controller.posting) return;

  if (controller.clipId === null) {
    void refreshCurrentClip(controller);
    return;
  }

  void loadComments(controller);
}

function scheduleStorageRefresh(controller) {
  if (controller.refreshScheduled || controller.closed) return;
  controller.refreshScheduled = true;
  queueMicrotask(() => {
    controller.refreshScheduled = false;
    if (!controller.closed) {
      void refreshCurrentClip(controller);
    }
  });
}

function addStorageListener(controller) {
  const onChanged = globalThis.chrome?.storage?.onChanged;
  if (!onChanged?.addListener) return;

  controller.storageListener = (changes, areaName) => {
    if (areaName !== 'local') return;
    if (Object.keys(changes).some((key) => WATCHED_STORAGE_KEYS.has(key))) {
      scheduleStorageRefresh(controller);
    }
  };
  onChanged.addListener(controller.storageListener);
}

function removeStorageListener(controller) {
  if (!controller.storageListener) return;
  globalThis.chrome?.storage?.onChanged?.removeListener?.(controller.storageListener);
  controller.storageListener = null;
}

// サイトのタブでコメントを消して戻ってきたときに、削除済みを表示したままにしない。
function addVisibilityListener(controller) {
  controller.visibilityListener = () => {
    if (document.visibilityState === 'visible') {
      reloadComments(controller);
    }
  };
  document.addEventListener('visibilitychange', controller.visibilityListener);
}

function removeVisibilityListener(controller) {
  if (!controller.visibilityListener) return;
  document.removeEventListener('visibilitychange', controller.visibilityListener);
  controller.visibilityListener = null;
}

function notifyOpenState(controller, open) {
  try {
    controller.onOpenChange?.(open);
  } catch (error) {
    console.warn('[extension-comments] onOpenChange failed', error);
  }
}

function closeController(controller, { restoreFocus = true } = {}) {
  if (!controller || controller.closed) return;
  controller.closed = true;
  controller.contextVersion += 1;
  controller.requestVersion += 1;
  removeStorageListener(controller);
  removeVisibilityListener(controller);
  window.removeEventListener('beforeunload', controller.beforeUnload);
  controller.host.remove();
  if (activePanel === controller) {
    activePanel = null;
  }
  notifyOpenState(controller, false);

  if (restoreFocus && controller.triggerEl?.isConnected) {
    controller.triggerEl.focus?.();
  }
}

function pruneDetachedPanel() {
  if (activePanel && !activePanel.host.isConnected) {
    closeController(activePanel, { restoreFocus: false });
  }
}

export function isCommentPanelOpen() {
  pruneDetachedPanel();
  return Boolean(activePanel);
}

export function closeCommentPanel() {
  pruneDetachedPanel();
  if (activePanel) {
    closeController(activePanel);
  }
}

function createPanel({ mountEl, triggerEl, onOpenChange }) {
  const host = createElement('div');
  host.id = COMMENT_PANEL_ID;
  const isDocumentMount = mountEl === document.body || mountEl === document.documentElement;
  host.style.cssText = `
    position:${isDocumentMount ? 'fixed' : 'absolute'};
    inset:0;
    z-index:2147483001;
    pointer-events:none;
  `;

  const shadowRoot = host.attachShadow({ mode: 'closed' });
  const style = createElement('style', PANEL_STYLES);

  const panel = createElement('section');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', `${COMMENT_PANEL_ID}-title`);

  const header = createElement('header');
  header.className = 'header';
  const title = createElement('h2', 'コメント');
  title.id = `${COMMENT_PANEL_ID}-title`;
  title.className = 'title';
  const refreshButton = createElement('button', '更新');
  refreshButton.type = 'button';
  refreshButton.className = 'refresh';
  refreshButton.setAttribute('aria-label', 'コメントを再読み込み');
  const closeButton = createElement('button', '×');
  closeButton.type = 'button';
  closeButton.className = 'close';
  closeButton.setAttribute('aria-label', 'コメントを閉じる');
  const headerActions = createElement('div');
  headerActions.className = 'header-actions';
  headerActions.append(refreshButton, closeButton);
  header.append(title, headerActions);

  const commentsList = createElement('div');
  commentsList.className = 'comments';
  commentsList.setAttribute('aria-live', 'polite');

  const pagination = createElement('div');
  pagination.className = 'pagination';
  const loadMoreButton = createElement('button', 'さらに表示');
  loadMoreButton.type = 'button';
  loadMoreButton.className = 'secondary';
  loadMoreButton.hidden = true;
  pagination.appendChild(loadMoreButton);

  const form = createElement('form');
  form.className = 'composer';
  const textareaId = `${COMMENT_PANEL_ID}-body`;
  const label = createElement('label', 'コメントを入力');
  label.className = 'composer-label';
  label.htmlFor = textareaId;
  const textarea = createElement('textarea');
  textarea.id = textareaId;
  textarea.className = 'textarea';
  textarea.maxLength = COMMENT_BODY_MAX_LENGTH;
  textarea.rows = 3;
  textarea.placeholder = 'コメントを入力（500文字まで）';
  const submitButton = createElement('button', '投稿');
  submitButton.type = 'submit';
  submitButton.className = 'submit';
  submitButton.disabled = true;
  form.append(label, textarea, submitButton);

  const actions = createElement('div');
  actions.className = 'actions';
  const status = createElement('p');
  status.className = 'status';
  status.setAttribute('aria-live', 'polite');

  panel.append(header, commentsList, pagination, form, actions, status);
  shadowRoot.append(style, panel);
  mountEl.appendChild(host);

  const controller = {
    host,
    shadowRoot,
    panel,
    commentsList,
    closeButton,
    refreshButton,
    loadMoreButton,
    textarea,
    submitButton,
    actions,
    status,
    triggerEl,
    onOpenChange,
    clipId: null,
    comments: [],
    hasNext: false,
    nextCursor: null,
    composeAvailable: false,
    loadingMore: false,
    posting: false,
    closed: false,
    contextVersion: 0,
    requestVersion: 0,
    refreshScheduled: false,
    storageListener: null,
    visibilityListener: null,
    beforeUnload: null,
  };

  closeButton.addEventListener('click', () => closeController(controller));
  refreshButton.addEventListener('click', () => reloadComments(controller));
  textarea.addEventListener('input', () => updateSubmitState(controller));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void postComment(controller);
  });
  loadMoreButton.addEventListener('click', () => {
    if (
      controller.loadingMore ||
      !controller.hasNext ||
      controller.nextCursor === null
    ) {
      return;
    }
    void loadComments(controller, {
      cursor: controller.nextCursor,
      append: true,
    });
  });

  for (const eventName of ['click', 'mousedown', 'pointerdown', 'keyup']) {
    panel.addEventListener(eventName, (event) => event.stopPropagation());
  }
  panel.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      closeController(controller);
    }
  });

  controller.beforeUnload = () => closeController(controller, { restoreFocus: false });
  window.addEventListener('beforeunload', controller.beforeUnload, { once: true });
  addStorageListener(controller);
  addVisibilityListener(controller);
  return controller;
}

export function toggleCommentPanel({
  mountEl,
  triggerEl = document.activeElement,
  onOpenChange,
} = {}) {
  pruneDetachedPanel();
  if (activePanel) {
    closeController(activePanel);
    return false;
  }

  if (!mountEl?.appendChild) {
    console.warn('[extension-comments] comment panel mount element was not found');
    return false;
  }

  activePanel = createPanel({ mountEl, triggerEl, onOpenChange });
  notifyOpenState(activePanel, true);
  void refreshCurrentClip(activePanel);
  queueMicrotask(() => {
    if (!activePanel?.closed) {
      activePanel.closeButton.focus();
    }
  });
  return true;
}
