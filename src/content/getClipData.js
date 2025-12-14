// ======================================================
// getClipData.js - localhost:3000 用 content script
// ======================================================

// ------------------------------------------------------
// 初期化ログ
// ------------------------------------------------------
console.log("✅ getClipData.js: content script injected on", location.origin);
console.log("📍 location:", location.href);
console.log("📦 chrome.storage available:", typeof chrome?.storage);

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
window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const msg = event.data;

  // ---- クリップデータ受信 ----
  if (msg.type === "SET_CLIP_DATA") {
    const { clip, playClipSystemKey } = msg.payload;
    await chrome.storage.local.set({ clip});
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
    await chrome.storage.local.set({ playQueue: queue });
    console.log("💾 playQueue 全体を chrome.storage.local に保存しました");

    playQueue(queue);
  }

  // ---- 外部から直接ストレージ設定 ----
  if (msg.type === "EXT/SET_SESSION") {
    await safeSetStorage(msg.payload);
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
// プレイキュー再生ロジック
// ------------------------------------------------------
async function playQueue(queue) {
  console.log("▶️ Playing queue:", queue);

  if (!Array.isArray(queue) || queue.length === 0) {
    console.warn("⚠️ キューが空です");
    return;
  }

  // orderが最も小さい要素を選択
  const nextClip = queue.reduce((min, item) =>
    item.order < min.order ? item : min
  );

  console.log("🎯 Next clip to play:", nextClip);

  const service = nextClip.service?.toLowerCase();
  const startTime = Math.floor(nextClip.startTime) || 0;

  let url = "";
  switch (service) {
    case "netflix": {
      console.log("📺 Netflix のクリップを再生します");
      const base = nextClip.url.startsWith("http")
        ? nextClip.url
        : `https://www.netflix.com${nextClip.url}`;
      url = `${base}?t=${startTime}`;
      break;
    }
    case "disneyplus":
      console.log("disneyplusのクリップを再生します");
      const dplusBase = nextClip.url.startsWith("http")
        ? nextClip.url
        : `https://www.disneyplus.com${nextClip.url}`;
      url = dplusBase;
      break;
    case "prime":
      console.log("📺 Prime は現在未対応です");
      return;
    default:
      console.warn("⚠️ 未対応のサービス:", service);
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
