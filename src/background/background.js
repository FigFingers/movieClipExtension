chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'HISTORY_CHANGE') {
      console.log('URLが変更されました:', message.data.url);
    }
  });

const DEMO_BASE_URL = "http://localhost:3000/";
const WELCOME_VERSION_KEY = "lastSeenWelcomeVersion";
const WHATSNEW_VERSION_KEY = "lastSeenWhatsNewVersion";
const LAST_SHOWN_AT_KEY = "lastShownAt";
const DEMO_COOLDOWN_MS = 5 * 60 * 1000;

function getMajor(v) {
  return parseInt(String(v).split(".")[0] || "0", 10);
}

function storageLocalGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(result || {});
    });
  });
}

function storageLocalSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve();
    });
  });
}

const EXTENSION_INSTANCE_ID_KEY = 'extensionInstanceId';

async function getOrCreateExtensionInstanceId() {
  const stored = await storageLocalGet([EXTENSION_INSTANCE_ID_KEY]);
  if (stored[EXTENSION_INSTANCE_ID_KEY]) {
    return stored[EXTENSION_INSTANCE_ID_KEY];
  }
  const id = crypto.randomUUID();
  await storageLocalSet({ [EXTENSION_INSTANCE_ID_KEY]: id });
  return id;
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "OPEN_EXTENSION_LOGIN") {
    return;
  }

  const fallbackUrl = `${DEMO_BASE_URL}login`;
  const requestedUrl = typeof message.url === "string" ? message.url : fallbackUrl;
  const url = requestedUrl.startsWith(DEMO_BASE_URL) ? requestedUrl : fallbackUrl;

  createTab(url)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error?.message }));

  return true;
});

async function handleInstalledDemo(details) {
  try {
    const reason = details?.reason;
    if (reason !== "install" && reason !== "update") {
      return;
    }

    const currentVersion = chrome.runtime.getManifest().version;
    const previousVersion = details?.previousVersion || "0.0.0";

    const stored = await storageLocalGet([
      WELCOME_VERSION_KEY,
      WHATSNEW_VERSION_KEY,
      LAST_SHOWN_AT_KEY
    ]);

    const now = Date.now();
    const lastShownAt = Number(stored[LAST_SHOWN_AT_KEY]) || 0;
    if (now - lastShownAt < DEMO_COOLDOWN_MS) {
      return;
    }

    let url = "";
    let seenVersionKey = "";

    if (reason === "install") {
      if (stored[WELCOME_VERSION_KEY] === currentVersion) {
        return;
      }

      url = `${DEMO_BASE_URL}?reason=install&to=${encodeURIComponent(currentVersion)}`;
      seenVersionKey = WELCOME_VERSION_KEY;
    }

    if (reason === "update") {
      if (getMajor(previousVersion) === getMajor(currentVersion)) {
        return;
      }

      if (stored[WHATSNEW_VERSION_KEY] === currentVersion) {
        return;
      }

      url = `${DEMO_BASE_URL}?reason=update&from=${encodeURIComponent(previousVersion)}&to=${encodeURIComponent(currentVersion)}`;
      seenVersionKey = WHATSNEW_VERSION_KEY;
    }

    if (!url || !seenVersionKey) {
      return;
    }

    try {
      await createTab(url);
    } catch (error) {
      console.error("Failed to open demo tab on install/update:", error);
      return;
    }

    await storageLocalSet({
      [seenVersionKey]: currentVersion,
      [LAST_SHOWN_AT_KEY]: now
    });
  } catch (error) {
    console.error("Failed to handle install/update demo flow:", error);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  void handleInstalledDemo(details);
  void getOrCreateExtensionInstanceId().catch((error) => {
    console.warn('[extension-sync] failed to initialize extensionInstanceId on install', {
      message: error?.message,
    });
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'extensionInstanceId') return;

  port.onMessage.addListener(() => {
    chrome.storage.local.get('extensionInstanceId', (result) => {
      if (chrome.runtime.lastError) {
        port.postMessage({ ok: false, message: chrome.runtime.lastError.message });
        return;
      }
      const extensionInstanceId = result.extensionInstanceId || crypto.randomUUID();
      if (!result.extensionInstanceId) {
        chrome.storage.local.set({ extensionInstanceId });
      }
      port.postMessage({ ok: true, extensionInstanceId });
    });
  });
});

//再生と録画を切り替える値
  let playClipSystemKey = "initialValue";


//netflix用ブリッジ注入
// background.js — content から {type:"seek", sec:数字} を受け取ってシーク
chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
  if (msg?.type !== "seek") return;

  const sec = Number(msg.sec);
  if (!Number.isFinite(sec)) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (!/^https:\/\/www\.netflix\.com\/watch\//.test(tab.url || "")) return;// Clip再生ページを判定するロジックをここで追加　クエリで要れる

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    args: [sec],
    func: (sec) => {
      function getNetflixPlayer() {
        try {
          const appCtx    = window.netflix?.appContext;
          const playerApp = appCtx?.state?.playerApp?.getAPI?.();
          const vp        = playerApp?.videoPlayer;
          const ids       = vp?.getAllPlayerSessionIds?.();
          if (!ids?.length) return null;
          return vp?.getVideoPlayerBySessionId?.(ids[0]) || null;
        } catch { return null; }
      }

      function seekSeconds(p, sec) {
        let dur = 0;
        try { dur = p.getDuration?.() ?? 0; } catch {}
        const useMs = dur > 1e5;
        const target = useMs ? sec * 1000 : sec;
        p.seek?.(target);
      }

      let tries = 30;
      (function go() {
        const p = getNetflixPlayer();
        if (!p) { if (tries-- > 0) return setTimeout(go, 200); else return; }
        seekSeconds(p, sec);
      })();
    }
  });

  sendResponse({ ok: true });
  return true; // async sendResponse のため
});



