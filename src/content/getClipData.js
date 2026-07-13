/** @typedef {import('../types/clip').CacheItem} CacheItem */

window.addEventListener("clipSelected", () => {
  const playClipData = getCookies();
  chrome.storage.local.set({ clip: playClipData });
  chrome.storage.local.set({ playClipSystemKey: 1 });
  safeSetStorage({ playmode: "clip" });
});

// ------------------------------------------------------
// Chrome storage 安全書き込みユーティリティ
// ------------------------------------------------------
const SENSITIVE_LOG_KEYS = new Set([
  "authorization",
  "extensionauthtoken",
]);

function sanitizeForLog(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_LOG_KEYS.has(key.toLowerCase()) ? "[redacted]" : sanitizeForLog(item),
    ])
  );
}

async function safeSetStorage(data) {
  try {
    await chrome.storage.local.set(data);
  } catch (err) {
    console.warn("[EXT] chrome.storage.local.set failed:", sanitizeForLog(data), err);
  }
}

// ------------------------------------------------------
// window.postMessage 受信ハンドラ
// ------------------------------------------------------
// 認証・連携 (EXTENSION_CHECK_AUTH / EXT_LINK_WITH_AUTH_TOKEN / instanceId 発行) は
// extension_link.js + extensionSync.js に一本化。getClipData.js は再生専用 (refs #110)。

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const msg = event.data;
  if (!msg || typeof msg.type !== "string") return;

  // ---- クリップデータ受信 ----
  if (msg.type === "SET_CLIP_DATA") {
    const { clip } = msg.payload;
    await chrome.storage.local.set({ clip });
    await safeSetStorage({ playmode: "clip" });
    chrome.storage.local.set({ playClipSystemKey: 1, playlistSystemKey: 0 });
  }

  // ---- プレイリスト再生開始 ----
  if (msg.type === "PLAY_PLAYLIST_START") {
    const stored = localStorage.getItem("playQueue");
    let queue = null;
    try {
      queue = stored ? JSON.parse(stored) : null;
    } catch (err) {
      console.warn("[EXT] PLAY_PLAYLIST_START: playQueue の JSON 解析に失敗しました", err);
      return;
    }

    if (!queue || !Array.isArray(queue) || queue.length === 0) {
      console.warn("[EXT] PLAY_PLAYLIST_START: playQueue が空です");
      return;
    }

    // サイト側の playQueue は表示順の配列で order フィールドを持たない。
    // 再生側 (content_netflix / content_disney) は order を正として現在位置・次クリップを
    // 解決するため、欠落時は配列添字で補完しておく（order 付きで来た場合はそれを尊重）。
    const normalizedQueue = queue.map((item, index) => ({
      ...item,
      order: Number.isFinite(Number(item?.order)) ? Number(item.order) : index,
    }));

    const firstOrder = normalizedQueue.reduce(
      (min, item) => (item.order < min ? item.order : min),
      normalizedQueue[0].order
    );

    await safeSetStorage({ playQueue: normalizedQueue, currentClipOrder: firstOrder, playmode: "playlist" });
    playQueue(normalizedQueue);
  }

  // EXT/SET_SESSION ハンドラは削除済み (issue #98)。ペイロードを無検証で
  // chrome.storage.local に書き込める経路であり、サイト側も送信していなかった。
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
    console.warn("[EXT] URL 解析に失敗しました:", baseUrl, error);
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
  if (!Array.isArray(queue) || queue.length === 0) {
    console.warn("[EXT] playQueue: キューが空です");
    return;
  }

  /** @type {CacheItem} */
  const nextClip = queue.reduce((min, item) =>
    item.order < min.order ? item : min
  );

  const normalizedService = normalizeService(nextClip.service);
  const startTime = Math.floor(nextClip.startTime) || 0;
  const url = buildServiceUrl(normalizedService, nextClip.url, startTime, "t");

  if (!url) {
    const message = `未対応のサービスです: ${normalizedService || "unknown"}`;
    console.warn("[EXT]", message);
    window.alert(message);
    return;
  }

  await safeSetStorage({ playmode: "playlist", nextClip });

  setTimeout(() => {
    // 再生開始位置は先頭固定(0)ではなく、実際に選んだ最小 order のクリップに合わせる。
    chrome.storage.local.set({
      playClipSystemKey: 0,
      playlistSystemKey: 1,
      currentClipOrder: Number.isFinite(Number(nextClip.order)) ? Number(nextClip.order) : 0,
    });
    window.location.href = url;
  }, 300);
}
