const DEMO_BASE_URL = 'http://localhost:3000/';
const WELCOME_VERSION_KEY = 'lastSeenWelcomeVersion';
const WHATSNEW_VERSION_KEY = 'lastSeenWhatsNewVersion';
const LAST_SHOWN_AT_KEY = 'lastShownAt';
const DEMO_COOLDOWN_MS = 5 * 60 * 1000;

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'OPEN_EXTENSION_LOGIN') return;

  const fallbackUrl = `${DEMO_BASE_URL}login`;
  const requestedUrl = typeof message.url === 'string' ? message.url : fallbackUrl;
  const url = requestedUrl.startsWith(DEMO_BASE_URL) ? requestedUrl : fallbackUrl;

  createTab(url)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error?.message }));

  return true;
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
  void handleInstalledDemo(details);
});

function readOrCreateInstanceId() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get('extensionInstanceId', (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (result.extensionInstanceId) {
        resolve(result.extensionInstanceId);
        return;
      }

      // 初回リンク時は生成した ID の永続化を待ってから解決する。
      // 先に応答すると、ページがトークンを往復させた際に saveExtensionAuthToken() 側の
      // getOrCreateExtensionInstanceId() が書き込み前の storage を読んで別 ID を生成し、
      // instanceId 不一致でトークンが拒否される競合が起きるため。
      const extensionInstanceId = crypto.randomUUID();
      chrome.storage.local.set({ extensionInstanceId }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(extensionInstanceId);
      });
    });
  });
}

// instanceId 生成を 1 経路に直列化する。port 接続(GET_EXTENSION_INSTANCE_ID)と
// content script からの auth-status 経路が空 storage に同時アクセスしても、同一の
// in-flight Promise を共有して同じ ID に解決させ、二重生成による不一致を防ぐ。
let instanceIdPromise = null;
function getOrCreateInstanceId() {
  if (!instanceIdPromise) {
    instanceIdPromise = readOrCreateInstanceId().catch((error) => {
      instanceIdPromise = null; // 失敗時は次回再試行できるようリセット
      throw error;
    });
  }
  return instanceIdPromise;
}

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
  if (message?.type !== 'GET_OR_CREATE_INSTANCE_ID') return;

  getOrCreateInstanceId()
    .then((extensionInstanceId) => sendResponse({ ok: true, extensionInstanceId }))
    .catch((error) => sendResponse({ ok: false, message: error?.message }));

  return true; // 非同期応答
});

// Netflix プレイヤーへのシーク（content script から {type:"seek", sec} を受け取る）
chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
  if (msg?.type !== 'seek') return;

  const sec = Number(msg.sec);
  if (!Number.isFinite(sec)) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (!/^https:\/\/www\.netflix\.com\/watch\//.test(tab.url || '')) return;

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

  sendResponse({ ok: true });
  return true;
});
