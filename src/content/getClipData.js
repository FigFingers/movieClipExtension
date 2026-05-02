// ======================================================
// getClipData.js - localhost:3000 用 content script
// ======================================================

// ------------------------------------------------------
// 初期化ログ
// ------------------------------------------------------
console.log("✅ getClipData.js: content script injected on", location.origin);
console.log("📍 location:", location.href);
console.log("📦 chrome.storage available:", typeof chrome?.storage);

/** @typedef {import('../types/clip').CacheItem} CacheItem */

// ------------------------------------------------------
// カスタムイベント監視（clip選択・リスト読み込み）
// ------------------------------------------------------
window.addEventListener("clipListElementsRendered", () => {
});

window.addEventListener("clipSelected", () => {
  console.log("🎬 このclipを選択しました！");
  const playClipData = getCookies();
  console.log("🍪 Cookies on video:", playClipData);

  chrome.storage.local.set({ clip: playClipData });
  chrome.storage.local.set({ playClipSystemKey: 1 });
  safeSetStorage({ playmode: "clip" });

  chrome.storage.local.get(["playClipSystemKey"], (result) => {
    console.log("🔑 再生機能の起動キー:", result.playClipSystemKey);
  });
});

// ------------------------------------------------------
// Chrome storage 安全書き込みユーティリティ
// ------------------------------------------------------
async function safeSetStorage(data) {
  try {
    // 直接 local に書き込む（localhostでも確実に動く）
    await chrome.storage.local.set(data);
    console.log("✅ [EXT] chrome.storage.local.set:", data);
  } catch (err) {
    console.warn("⚠️ safeSetStorage direct failed:", err);
    if (chrome.runtime?.id) {
      console.log("➡️ Fallback to background relay");
      await chrome.runtime.sendMessage({ type: "SET_SESSION_DATA", payload: data });
    } else {
      console.log("➡️ Fallback to window.localStorage");
      localStorage.setItem("ext_fallback", JSON.stringify(data));
    }
  }
}

// ------------------------------------------------------
// window.postMessage 受信ハンドラ
// ------------------------------------------------------
const EXT_CONNECTION_STATE_KEY = "extensionConnectionState";

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

function postExtensionMessage(message) {
  window.postMessage(message, window.location.origin);
}

async function getConnectionState() {
  const { [EXT_CONNECTION_STATE_KEY]: state } = await chrome.storage.local.get(EXT_CONNECTION_STATE_KEY);
  return state || {};
}

async function saveConnectionState(state) {
  await chrome.storage.local.set({ [EXT_CONNECTION_STATE_KEY]: state });
  return state;
}

async function clearStoredAuthToken(state) {
  return saveConnectionState({
    ...(state || {}),
    extensionAuthToken: "",
    linked: false,
    lastSyncAt: null,
  });
}

async function ensureConnectionStateWithInstanceId(state) {
  if (state.extensionInstanceId) return state;

  const nextState = {
    ...state,
    extensionInstanceId: crypto.randomUUID(),
  };
  await saveConnectionState(nextState);
  return nextState;
}

async function checkStoredAuthState() {
  const state = await getConnectionState();
  const token = state.extensionAuthToken;

  if (!isJwtValid(token)) {
    await clearStoredAuthToken(state);
    return { loggedIn: false };
  }

  try {
    const res = await fetch("/api/extension/session", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      await clearStoredAuthToken(state);
      return { loggedIn: false };
    }

    return { loggedIn: true };
  } catch (error) {
    console.warn("[ExtLink] session check failed:", error);
    return { loggedIn: false };
  }
}

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const msg = event.data;
  if (!msg || typeof msg.type !== "string") return;

  // ---- クリップデータ受信 ----
  if (msg.type === "SET_CLIP_DATA") {
    const { clip, playClipSystemKey } = msg.payload;
    await chrome.storage.local.set({ clip});
    await safeSetStorage({ playmode: "clip" });
    // clip再生開始時に
    chrome.storage.local.set({playClipSystemKey: 1,playlistSystemKey: 0});
    console.log("🎞️ clipデータを保存:", clip, playClipSystemKey);
  }

  // ---- プレイリスト再生開始 ----
  if (msg.type === "PLAY_PLAYLIST_START") {
    console.log("🎬 PLAY_PLAYLIST_START 受信");

    // localStorage から playQueue を取得
    const stored = localStorage.getItem("playQueue");
    const queue = stored ? JSON.parse(stored) : null;

    if (!queue || !Array.isArray(queue) || queue.length === 0) {
      console.warn("⚠️ プレイキューが空です");
      return;
    }

    console.log("🧩 プレイキュー全体:", queue);

    // 🎯 playQueue 全体を拡張ストレージに保存（別ドメインからも参照可能に）
    await safeSetStorage({ playQueue: queue, currentClipOrder: 0, playmode: "playlist" });
    console.log("💾 playQueue 全体を chrome.storage.local に保存しました");

    playQueue(queue);
  }

  // ---- 外部から直接ストレージ設定 ----
  if (msg.type === "EXT/SET_SESSION") {
    await safeSetStorage(msg.payload);
  }

  // ---- 拡張機能リンクトークン（localhost上でAPI呼び出し → common.js に転送）----
  if (msg.type === "EXT_LINK_WITH_TOKEN") {
    try {
      const current = await ensureConnectionStateWithInstanceId(await getConnectionState());

      const res = await fetch("/api/extension/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          extensionInstanceId: current.extensionInstanceId,
          linkToken: msg.linkToken,
        }),
      });

      if (!res.ok) {
        console.error("[ExtLink] Link failed:", res.status);
        postExtensionMessage({
          type: "EXTENSION_LINK_RESULT",
          requestId: msg.requestId,
          ok: false,
          status: res.status,
        });
        return;
      }

      const data = await res.json();
      if (!data.extensionAuthToken) {
        console.error("[ExtLink] extensionAuthToken not found in response");
        postExtensionMessage({
          type: "EXTENSION_LINK_RESULT",
          requestId: msg.requestId,
          ok: false,
          error: "MissingExtensionAuthToken",
        });
        return;
      }

      await saveConnectionState({
        ...current,
        extensionAuthToken: data.extensionAuthToken,
        linked: true,
        lastSyncAt: new Date().toISOString(),
      });
      console.log("[ExtLink] extension auth token stored");
      postExtensionMessage({
        type: "EXTENSION_LINK_RESULT",
        requestId: msg.requestId,
        ok: true,
      });
    } catch (err) {
      console.error("[ExtLink] Error:", err);
      postExtensionMessage({
        type: "EXTENSION_LINK_RESULT",
        requestId: msg.requestId,
        ok: false,
        error: String(err),
      });
    }
  }

  // ---- 認証状態確認 ----
  if (msg.type === "EXTENSION_CHECK_AUTH") {
    const { loggedIn } = await checkStoredAuthState();
    postExtensionMessage({ type: "EXTENSION_AUTH_STATUS", requestId: msg.requestId, loggedIn });
  }
});

// ------------------------------------------------------
// Cookie取得ユーティリティ
// ------------------------------------------------------
function getCookies() {
  const cookies = document.cookie.split("; ");
  const cookieObj = {};
  for (const cookie of cookies) {
    const [key, value] = cookie.split("=");
    cookieObj[key] = decodeURIComponent(value || "");
  }
  return cookieObj;
}

// ------------------------------------------------------
// サービス URL ユーティリティ
// ------------------------------------------------------
const SERVICE_BASE_URL = {
  netflix: "https://www.netflix.com",
  prime: "https://www.primevideo.com",
  disneyplus: "https://www.disneyplus.com",
  youtube: "https://www.youtube.com"
};

const SERVICE_ALIASES = {
  "disney+": "disneyplus",
  disney: "disneyplus",
  primevideo: "prime",
  prime_video: "prime",
  amazonprime: "prime"
};

function normalizeService(service) {
  if (!service) return "";
  const normalized = service.toString().trim().toLowerCase().replace(/\s+/g, "");
  return SERVICE_ALIASES[normalized] || normalized;
}

function ensureAbsoluteUrl(rawUrl, baseUrl) {
  if (!rawUrl) return "";
  if (rawUrl.startsWith("http")) return rawUrl;
  const normalized = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  return `${baseUrl}${normalized}`;
}

function buildYoutubeUrl(rawUrl) {
  if (!rawUrl) return "";
  if (rawUrl.startsWith("http")) {
    return rawUrl;
  }
  if (
    rawUrl.startsWith("youtu.be") ||
    rawUrl.startsWith("www.youtube.com") ||
    rawUrl.startsWith("youtube.com")
  ) {
    return `https://${rawUrl}`;
  }
  const normalized = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  return `${SERVICE_BASE_URL.youtube}${normalized}`;
}

function appendStartTimeParam(baseUrl, paramKey, startTime) {
  try {
    const urlObj = new URL(baseUrl);
    urlObj.searchParams.set(paramKey, String(startTime));
    return urlObj.toString();
  } catch (error) {
    console.warn("⚠️ URL 解析に失敗しました:", baseUrl, error);
    return baseUrl;
  }
}

function buildServiceUrl(service, rawUrl, startTime, paramKey = "t") {
  const normalizedService = normalizeService(service);
  if (normalizedService === "youtube") {
    const base = buildYoutubeUrl(rawUrl);
    return appendStartTimeParam(base, paramKey, startTime);
  }
  const baseUrl = SERVICE_BASE_URL[normalizedService];
  if (!baseUrl) return "";
  const resolved = ensureAbsoluteUrl(rawUrl, baseUrl);
  return appendStartTimeParam(resolved, paramKey, startTime);
}

// ------------------------------------------------------
// プレイキュー再生ロジック
// ------------------------------------------------------
/**
 * @param {CacheItem[]} queue
 */
async function playQueue(queue) {
  console.log("▶️ Playing queue:", queue);

  if (!Array.isArray(queue) || queue.length === 0) {
    console.warn("⚠️ キューが空です");
    return;
  }

  // orderが最も小さい要素を選択
  /** @type {CacheItem} */
  const nextClip = queue.reduce((min, item) =>
    item.order < min.order ? item : min
  );

  console.log("🎯 Next clip to play:", nextClip);

  const normalizedService = normalizeService(nextClip.service);
  const startTime = Math.floor(nextClip.startTime) || 0;

  const serviceLogMessages = {
    netflix: "📺 Netflix のクリップを再生します",
    prime: "📺 Prime のクリップを再生します",
    disneyplus: "📺 Disney+ のクリップを再生します",
    youtube: "📺 YouTube のクリップを再生します"
  };

  function notifyUnsupportedService(targetService) {
    const message = `未対応のサービスです: ${targetService || "unknown"}`;
    console.warn("⚠️", message);
    window.alert(`⚠️ ${message}`);
  }

  const logMessage = serviceLogMessages[normalizedService];
  if (logMessage) {
    console.log(logMessage);
  }

  const url = buildServiceUrl(normalizedService, nextClip.url, startTime, "t");
  if (!url) {
    notifyUnsupportedService(normalizedService);
    return;
  }

  // 🎯 再生情報を保存（playmode/nextClip）
  try {
    await safeSetStorage({ playmode: "playlist", nextClip });
    console.log("✅ 再生情報を保存しました:", nextClip);
  } catch (err) {
    console.error("❌ safeSetStorage 失敗:", err);
  }

  if (!url) return console.warn("⚠️ URL が無効のため遷移をスキップ");

  // 遷移（遅延で確実にstorage書き込み完了後）
  setTimeout(() => {
    // playlist再生開始時に
    chrome.storage.local.set({playClipSystemKey: 0,playlistSystemKey: 1});
    chrome.storage.local.set({ currentClipOrder: 0 }, () => {
      console.log("🧭 currentClipOrder 初期化完了");
    });

    console.log("🌐 Navigating to:", url);
    window.location.href = url; 
  }, 300);
}
