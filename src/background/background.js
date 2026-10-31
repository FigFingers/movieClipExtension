import { getOrCreateInstanceId } from './authState.js';
import { handleStateMessage } from './stateMessages.js';
import {
  fetchClipComments,
  postClipComment,
} from './comments.js';
import { openLoginTab, syncPendingQueue } from './sync.js';
import { checkAndRefreshToken } from './tokenRefresh.js';

const DEMO_BASE_URL = 'http://localhost:3000/';
const WELCOME_VERSION_KEY = 'lastSeenWelcomeVersion';
const WHATSNEW_VERSION_KEY = 'lastSeenWhatsNewVersion';
const LAST_SHOWN_AT_KEY = 'lastShownAt';
const DEMO_COOLDOWN_MS = 5 * 60 * 1000;

const TOKEN_REFRESH_ALARM = 'extension-token-refresh';
const SYNC_RETRY_ALARM = 'extension-sync-retry';
const TOKEN_REFRESH_PERIOD_MINUTES = 6 * 60;
const SYNC_RETRY_PERIOD_MINUTES = 15;

function getMajor(v) {
  return parseInt(String(v).split('.')[0] || '0', 10);
}

function createTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(tab);
    });
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'HISTORY_CHANGE') {
    console.log('URLが変更されました:', message.data.url);
  }
});

// クリップ同期は background で fetch する(content の fetch はページオリジンの CORS で
// サイト API に弾かれるため)。ログインタブ起動も sync 側(openLoginTab)が直接行う。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'SYNC_PENDING_CLIPS') return;

  syncPendingQueue(message.options || {})
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({
      ok: false,
      queued: true,
      reason: 'sync_error',
      message: error?.message,
    }));

  return true;
});

function respondToAsyncRequest(promise, sendResponse, reason = 'request_failed') {
  promise
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({
      ok: false,
      reason,
      message: error?.message,
    }));

  return true;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'FETCH_CLIP_COMMENTS') {
    return respondToAsyncRequest(fetchClipComments({
      clipId: message.clipId,
      cursor: message.cursor,
      limit: message.limit,
    }), sendResponse);
  }

  if (message?.type === 'POST_CLIP_COMMENT') {
    return respondToAsyncRequest(postClipComment({
      clipId: message.clipId,
      body: message.body,
    }), sendResponse);
  }

  if (message?.type === 'OPEN_LOGIN_TAB') {
    return respondToAsyncRequest(
      openLoginTab({ force: true }),
      sendResponse,
      'open_login_failed'
    );
  }
});

function scheduleAlarms() {
  chrome.alarms.create(TOKEN_REFRESH_ALARM, { periodInMinutes: TOKEN_REFRESH_PERIOD_MINUTES });
  chrome.alarms.create(SYNC_RETRY_ALARM, { periodInMinutes: SYNC_RETRY_PERIOD_MINUTES });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TOKEN_REFRESH_ALARM) {
    void checkAndRefreshToken();
    return;
  }
  if (alarm.name === SYNC_RETRY_ALARM) {
    // キューが空なら storage を1回読むだけで即終了するので低コスト。
    void syncPendingQueue();
  }
});

chrome.runtime.onStartup.addListener(() => {
  scheduleAlarms();
});

// SW が起きたタイミングで期限チェックと積み残しの再送を行う(どちらも未連携・空キュー
// なら即終了)。refresh を先に済ませ、旧トークンでの sync 401 を避ける。
checkAndRefreshToken().finally(() => {
  void syncPendingQueue();
});

async function handleInstalledDemo(details) {
  try {
    const reason = details?.reason;
    if (reason !== 'install' && reason !== 'update') return;

    const currentVersion = chrome.runtime.getManifest().version;
    const previousVersion = details?.previousVersion || '0.0.0';

    const stored = await chrome.storage.local.get([
      WELCOME_VERSION_KEY,
      WHATSNEW_VERSION_KEY,
      LAST_SHOWN_AT_KEY,
    ]);

    const now = Date.now();
    if (now - (Number(stored[LAST_SHOWN_AT_KEY]) || 0) < DEMO_COOLDOWN_MS) return;

    let url = '';
    let seenVersionKey = '';

    if (reason === 'install') {
      if (stored[WELCOME_VERSION_KEY] === currentVersion) return;
      url = `${DEMO_BASE_URL}?reason=install&to=${encodeURIComponent(currentVersion)}`;
      seenVersionKey = WELCOME_VERSION_KEY;
    }

    if (reason === 'update') {
      if (getMajor(previousVersion) === getMajor(currentVersion)) return;
      if (stored[WHATSNEW_VERSION_KEY] === currentVersion) return;
      url = `${DEMO_BASE_URL}?reason=update&from=${encodeURIComponent(previousVersion)}&to=${encodeURIComponent(currentVersion)}`;
      seenVersionKey = WHATSNEW_VERSION_KEY;
    }

    if (!url || !seenVersionKey) return;

    try {
      await createTab(url);
    } catch (error) {
      console.error('Failed to open demo tab on install/update:', error);
      return;
    }

    await chrome.storage.local.set({ [seenVersionKey]: currentVersion, [LAST_SHOWN_AT_KEY]: now });
  } catch (error) {
    console.error('Failed to handle install/update demo flow:', error);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  scheduleAlarms();
  void handleInstalledDemo(details);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'extensionInstanceId') return;

  port.onMessage.addListener(() => {
    getOrCreateInstanceId()
      .then((extensionInstanceId) => port.postMessage({ ok: true, extensionInstanceId }))
      .catch((error) => port.postMessage({ ok: false, message: error?.message }));
  });
});

// content script はこのメッセージ経由で ID を取得し、自前生成せず background に一本化する。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const result = handleStateMessage(message, sender);
  if (result) return respondToAsyncRequest(result, sendResponse, 'state_update_failed');
});

// Netflix プレイヤーへのシーク（content script から {type:"seek", sec} を受け取る）
// リスナーを async にすると戻り値が Promise になり `return true` が効かず応答ポートが
// 閉じるため、同期リスナー + 内部 async 関数の形にしている。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'seek') return;

  const sec = Number(msg.sec);
  if (!Number.isFinite(sec)) return;

  handleSeekMessage(sec, sender)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, message: error?.message }));

  return true; // 非同期応答
});

async function handleSeekMessage(sec, sender) {
  // seek 要求は Netflix タブの content script から来るため、送信元タブを優先する。
  // active tab 参照だと、再生タブが非アクティブのとき seek されない・別タブへ誤送出する。
  let tab = sender?.tab;
  if (!tab?.id) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab?.id) return { ok: false, reason: 'no_tab' };
  if (!/^https:\/\/www\.netflix\.com\/watch\//.test(tab.url || '')) {
    return { ok: false, reason: 'not_netflix_watch' };
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [sec],
    func: (sec) => {
      function getNetflixPlayer() {
        try {
          const appCtx = window.netflix?.appContext;
          const playerApp = appCtx?.state?.playerApp?.getAPI?.();
          const vp = playerApp?.videoPlayer;
          const ids = vp?.getAllPlayerSessionIds?.();
          if (!ids?.length) return null;
          return vp?.getVideoPlayerBySessionId?.(ids[0]) || null;
        } catch { return null; }
      }

      function seekSeconds(p, sec) {
        let dur = 0;
        try { dur = p.getDuration?.() ?? 0; } catch {}
        p.seek?.(dur > 1e5 ? sec * 1000 : sec);
      }

      let tries = 30;
      (function go() {
        const p = getNetflixPlayer();
        if (!p) { if (tries-- > 0) return setTimeout(go, 200); else return; }
        seekSeconds(p, sec);
      })();
    },
  });

  return { ok: true };
}
