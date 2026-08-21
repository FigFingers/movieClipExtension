import { storageGet } from './../shared/storage.js';
import {
  CLOSE_COMMENT_PANEL_EVENT,
  closeMemoSidebar,
} from './common.js';
import {
  PLAYBACK_CONTEXT_CHANGED_EVENT,
  readPlaybackContext,
} from './playbackContext.js';

export const COMMENT_PANEL_ID = 'ext-comment-panel';
export const COMMENT_PANEL_OPEN_STATE_EVENT =
  'ext:comment-panel-open-state';

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
const WATCHED_AUTH_STORAGE_KEYS = new Set([
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
  ::slotted(textarea) {
    font: inherit;
  }

  button {
    border: 0;
    border-radius: 6px;
    cursor: pointer;
  }

  button:focus-visible,
  ::slotted(textarea:focus-visible) {
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

  ::slotted(.textarea) {
    box-sizing: border-box;
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
    pointer-events: auto;
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
  const localPlayback = readPlaybackContext();
  if (localPlayback.initialized) {
    return localPlayback.context?.clipId ?? null;
  }

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
  controller.refreshButton.disabled =
    controller.posting || controller.loadingBase || controller.refreshingContext;
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

  controller.loadMoreButton.disabled =
    controller.loadingMore || controller.loadingBase;
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

export function shouldClearSubmittedDraft(currentValue, submittedValue) {
  return currentValue === submittedValue;
}

export function isAmbiguousPostFailure(reason) {
  return reason === 'invalid_response'
    || reason === 'network_error'
    || reason === 'timeout'
    || reason === 'background_unavailable'
    || reason === 'request_failed';
}

async function openLoginPage(controller) {
  if (controller.closed || controller.openingLogin) return;
  controller.openingLogin = true;
  for (const button of controller.actions.querySelectorAll('button')) {
    button.disabled = true;
  }
  setStatus(controller, 'ログインページを開いています…');
  try {
    const result = await sendRuntimeMessage({ type: 'OPEN_LOGIN_TAB' });
    if (controller.closed) return;

    if (result?.ok && result?.skipped && result?.reason === 'cooldown') {
      setStatus(
        controller,
        'ログインページは直前に開いています。連携後に再試行してください。',
        'success'
      );
    } else if (result?.ok) {
      setStatus(
        controller,
        'ログインページを開きました。連携後に再試行してください。',
        'success'
      );
    } else {
      setStatus(controller, 'ログインページを開けませんでした。', 'error');
    }
  } finally {
    controller.openingLogin = false;
    if (!controller.closed) {
      for (const button of controller.actions.querySelectorAll('button')) {
        button.disabled = false;
      }
    }
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

function loadComments(controller, options = {}) {
  const append = options.append === true;
  if (controller.closed || controller.clipId === null) {
    return Promise.resolve();
  }
  if (append && (controller.loadingMore || controller.loadingBase)) {
    return Promise.resolve();
  }
  if (!append && controller.baseLoadPromise) {
    return controller.baseLoadPromise;
  }

  if (!append) {
    controller.loadingBase = true;
    controller.loadingMore = false;
    updateSubmitState(controller);
  }

  const loadPromise = performLoadComments(controller, options);
  if (!append) {
    controller.baseLoadPromise = loadPromise;
    const finishBaseLoad = () => {
      if (controller.baseLoadPromise !== loadPromise) return;
      controller.baseLoadPromise = null;
      controller.loadingBase = false;
      if (!controller.closed) {
        controller.loadMoreButton.disabled = controller.loadingMore;
        updateSubmitState(controller);
      }
    };
    loadPromise.then(finishBaseLoad, finishBaseLoad);
  }
  return loadPromise;
}

async function performLoadComments(
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

function refreshCurrentClip(controller, { queueIfBusy = false } = {}) {
  if (controller.closed) return Promise.resolve();
  if (controller.refreshPromise) {
    if (queueIfBusy) controller.refreshQueued = true;
    return controller.refreshPromise;
  }
  if (controller.baseLoadPromise) {
    if (queueIfBusy && !controller.refreshAfterBase) {
      controller.refreshAfterBase = true;
      const activeLoad = controller.baseLoadPromise;
      const refreshAfterLoad = () => {
        if (!controller.refreshAfterBase) return;
        controller.refreshAfterBase = false;
        if (!controller.closed) void refreshCurrentClip(controller);
      };
      activeLoad.then(refreshAfterLoad, refreshAfterLoad);
    }
    return controller.baseLoadPromise;
  }

  controller.refreshingContext = true;
  updateSubmitState(controller);
  const refreshPromise = performRefreshCurrentClip(controller);
  controller.refreshPromise = refreshPromise;
  const finishRefresh = () => {
    if (controller.refreshPromise !== refreshPromise) return;
    controller.refreshPromise = null;
    controller.refreshingContext = false;
    if (controller.closed) return;
    updateSubmitState(controller);
    if (controller.refreshQueued) {
      controller.refreshQueued = false;
      void refreshCurrentClip(controller);
    }
  };
  refreshPromise.then(finishRefresh, finishRefresh);
  return refreshPromise;
}

async function performRefreshCurrentClip(controller) {
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
  const submittedValue = controller.textarea.value;
  const body = submittedValue.trim();
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

    if (isAmbiguousPostFailure(result?.reason)) {
      setStatus(
        controller,
        '投稿結果を確認できなかったため、一覧を更新しています…',
        'error'
      );
      await loadComments(controller);
      if (!controller.closed && controller.contextVersion === contextVersion) {
        setStatus(
          controller,
          '投稿結果を確認できませんでした。一覧を確認してから、必要な場合だけ再投稿してください。入力内容は保持されています。',
          'error'
        );
      }
      return;
    }

    if (!result?.ok || !result.comment || typeof result.comment !== 'object') {
      showPostError(controller, result);
      return;
    }

    controller.comments = mergeComments([result.comment], controller.comments);
    if (shouldClearSubmittedDraft(controller.textarea.value, submittedValue)) {
      controller.textarea.value = '';
    }
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
  if (
    controller.closed ||
    controller.posting ||
    controller.loadingBase ||
    controller.refreshingContext
  ) {
    return;
  }

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
      void refreshCurrentClip(controller, { queueIfBusy: true });
    }
  });
}

function addStorageListener(controller) {
  const onChanged = globalThis.chrome?.storage?.onChanged;
  if (!onChanged?.addListener) return;

  controller.storageListener = (changes, areaName) => {
    if (areaName !== 'local') return;
    if (
      Object.keys(changes).some((key) => WATCHED_AUTH_STORAGE_KEYS.has(key))
    ) {
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

function addPlaybackContextListener(controller) {
  controller.playbackContextListener = () => {
    scheduleStorageRefresh(controller);
  };
  window.addEventListener(
    PLAYBACK_CONTEXT_CHANGED_EVENT,
    controller.playbackContextListener
  );
}

function removePlaybackContextListener(controller) {
  if (!controller.playbackContextListener) return;
  window.removeEventListener(
    PLAYBACK_CONTEXT_CHANGED_EVENT,
    controller.playbackContextListener
  );
  controller.playbackContextListener = null;
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

function dispatchPanelOpenState(open) {
  if (!window?.dispatchEvent) return;
  try {
    window.dispatchEvent(
      new CustomEvent(COMMENT_PANEL_OPEN_STATE_EVENT, {
        detail: { open },
      })
    );
  } catch {
    // The direct callback and aria state still work on restricted pages.
  }
}

function notifyOpenState(controller, open) {
  for (const trigger of document.querySelectorAll(
    `[aria-controls="${COMMENT_PANEL_ID}"]`
  )) {
    trigger.setAttribute('aria-expanded', String(open));
  }
  try {
    controller.onOpenChange?.(open);
  } catch (error) {
    console.warn('[extension-comments] onOpenChange failed', error);
  }
  dispatchPanelOpenState(open);
}

function eventBelongsToPanel(event, controller) {
  if (event.target === controller.host) return true;
  try {
    if (event.composedPath?.().includes(controller.host)) return true;
    return controller.host.contains(event.target);
  } catch {
    return false;
  }
}

function addKeyGuard(controller) {
  controller.keyGuard = (event) => {
    if (controller.closed || !eventBelongsToPanel(event, controller)) return;
    // Capture on window before the event reaches document/player shortcuts.
    event.stopImmediatePropagation();
    if (event.type === 'keydown' && event.key === 'Escape') {
      event.preventDefault();
      closeController(controller);
    }
  };
  for (const eventName of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(eventName, controller.keyGuard, true);
  }
}

function removeKeyGuard(controller) {
  if (!controller.keyGuard) return;
  for (const eventName of ['keydown', 'keyup', 'keypress']) {
    window.removeEventListener(eventName, controller.keyGuard, true);
  }
  controller.keyGuard = null;
}

function addDetachedMountObserver(controller) {
  if (typeof MutationObserver !== 'function' || !document.documentElement) return;
  controller.mountObserver = new MutationObserver(() => {
    if (!controller.host.isConnected) {
      closeController(controller, { restoreFocus: false });
    }
  });
  controller.mountObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function removeDetachedMountObserver(controller) {
  controller.mountObserver?.disconnect();
  controller.mountObserver = null;
}

function addCloseRequestListener(controller) {
  controller.closeRequestListener = () => closeController(controller);
  window.addEventListener(
    CLOSE_COMMENT_PANEL_EVENT,
    controller.closeRequestListener
  );
}

function removeCloseRequestListener(controller) {
  if (!controller.closeRequestListener) return;
  window.removeEventListener(
    CLOSE_COMMENT_PANEL_EVENT,
    controller.closeRequestListener
  );
  controller.closeRequestListener = null;
}

function closeController(controller, { restoreFocus = true } = {}) {
  if (!controller || controller.closed) return;
  controller.closed = true;
  controller.contextVersion += 1;
  controller.requestVersion += 1;
  removeStorageListener(controller);
  removePlaybackContextListener(controller);
  removeVisibilityListener(controller);
  removeKeyGuard(controller);
  removeDetachedMountObserver(controller);
  removeCloseRequestListener(controller);
  window.removeEventListener('beforeunload', controller.beforeUnload);
  controller.host.remove();
  if (activePanel === controller) {
    activePanel = null;
  }
  notifyOpenState(controller, false);

  if (restoreFocus) {
    const focusTarget = controller.triggerEl?.isConnected
      ? controller.triggerEl
      : document.querySelector(`[aria-controls="${COMMENT_PANEL_ID}"]`);
    focusTarget?.focus?.();
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
  textarea.slot = 'comment-composer';
  textarea.maxLength = COMMENT_BODY_MAX_LENGTH;
  textarea.rows = 3;
  textarea.placeholder = 'コメントを入力（500文字まで）';
  textarea.setAttribute('aria-label', 'コメントを入力');
  // Keep the editable control in the light DOM and render it through a slot.
  // Streaming sites then see a real textarea target and can apply their normal
  // shortcut exclusion even though the rest of the panel remains isolated.
  const textareaSlot = createElement('slot');
  textareaSlot.name = textarea.slot;
  label.addEventListener('click', () => textarea.focus());
  const submitButton = createElement('button', '投稿');
  submitButton.type = 'submit';
  submitButton.className = 'submit';
  submitButton.disabled = true;
  form.append(label, textareaSlot, submitButton);

  const actions = createElement('div');
  actions.className = 'actions';
  const status = createElement('p');
  status.className = 'status';
  status.setAttribute('aria-live', 'polite');

  panel.append(header, commentsList, pagination, form, actions, status);
  host.appendChild(textarea);
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
    loadingBase: false,
    loadingMore: false,
    posting: false,
    openingLogin: false,
    closed: false,
    contextVersion: 0,
    requestVersion: 0,
    baseLoadPromise: null,
    refreshingContext: false,
    refreshPromise: null,
    refreshQueued: false,
    refreshAfterBase: false,
    refreshScheduled: false,
    storageListener: null,
    playbackContextListener: null,
    visibilityListener: null,
    keyGuard: null,
    mountObserver: null,
    closeRequestListener: null,
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
  addPlaybackContextListener(controller);
  addVisibilityListener(controller);
  addKeyGuard(controller);
  addDetachedMountObserver(controller);
  addCloseRequestListener(controller);
  return controller;
}

export function toggleCommentPanel({
  mountEl,
  triggerEl = document.activeElement,
  onOpenChange,
} = {}) {
  pruneDetachedPanel();
  if (activePanel) {
    if (triggerEl?.isConnected) activePanel.triggerEl = triggerEl;
    if (onOpenChange) activePanel.onOpenChange = onOpenChange;
    closeController(activePanel);
    return false;
  }

  if (!mountEl?.appendChild) {
    console.warn('[extension-comments] comment panel mount element was not found');
    return false;
  }

  closeMemoSidebar();
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
