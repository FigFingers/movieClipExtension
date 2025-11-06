// カスタムイベントが実行されたら実行
window.addEventListener("clipListElementsRendered", () => {
    console.log("このclipリストを読み込みました！");
});
window.addEventListener("clipSelected", () => {
    console.log("このclipを選択しました！");
    //cookieを読み込む
    // Clipの再生用データ
    const playClipData = getCookies();
    // 取得したCookieをコンソールに表示
    console.log("Cookies on video:", playClipData);
    chrome.storage.local.set({ clip: playClipData});
    //再生機能の起動キー 1が起動 0が不活性化
    chrome.storage.local.set({ playClipSystemKey: 1});
    chrome.storage.local.get(["playClipSystemKey"], (result) => {
        console.log("再生機能の起動キー:", result.playClipSystemKey);
    });
  
});

console.log("✅ getClipData.js: content script injected on localhost:3000");

// ------------------------------
// 汎用セーフブリッジ関数
// ------------------------------
async function safeSetStorage(data) {
  try {
    const hasChrome =
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.session;

    if (hasChrome) {
      // ✅ content script or 拡張側 → chrome.storage 直接OK
      await chrome.storage.session.set(data);
      console.log("💾 [EXT] chrome.storage.session.set:", data);
    } else {
      // ❌ ページ側だった場合（理論上ここは来ない）
      window.postMessage(
        { type: "EXT/SET_SESSION", payload: data },
        "*"
      );
      console.warn("⚠️ chrome.storage not available, re-posted:", data);
    }
  } catch (err) {
    console.error("❌ safeSetStorage failed:", err);
  }
}

// ------------------------------
// window.postMessage 受信ハンドラ
// ------------------------------
window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const msg = event.data;

  // ---- クリップデータの受信 ----
  if (msg.type === "SET_CLIP_DATA") {
    const { clip, playClipSystemKey } = msg.payload;
    await chrome.storage.local.set({ clip, playClipSystemKey });
    console.log("🎬 clipデータを保存:", clip, playClipSystemKey);
  }

  // ---- プレイリスト再生開始 ----

  if (msg.type === "PLAY_PLAYLIST_START") {
    console.log("🎬 PLAY_PLAYLIST_START 受信");

    const stored = localStorage.getItem("playQueue");
    const queue = stored ? JSON.parse(stored) : null;
    if (!queue) return console.warn("⚠️ プレイキューが空です");

    playQueue(queue);
  }
  

  // ---- 外部から直接ストレージ設定 ----
  if (msg.type === "EXT/SET_SESSION") {
    await safeSetStorage(msg.payload);
  }
});

// ------------------------------
// Cookie取得ユーティリティ
// ------------------------------
function getCookies() {
  const cookies = document.cookie.split("; ");
  const cookieObj = {};
  for (const cookie of cookies) {
    const [key, value] = cookie.split("=");
    cookieObj[key] = decodeURIComponent(value || "");
  }
  return cookieObj;
}

// ------------------------------
// プレイキュー再生ロジック
// ------------------------------
async function playQueue(queue) {
  console.log("▶️ Playing queue:", queue);

  if (!Array.isArray(queue) || queue.length === 0) {
    return console.warn("⚠️ キューが空です");
  }

  const nextClip = queue.reduce((min, item) =>
    item.order < min.order ? item : min
  );

  console.log("Next clip to play:", nextClip);

  const service = nextClip.service?.toLowerCase();
  const startTime = Math.floor(nextClip.startTime) || 0;

  let url = "";

  switch (service) {
    case "netflix": {
      console.log("Netflixのクリップを再生します");
      const base = nextClip.url.startsWith("http")
        ? nextClip.url
        : `https://www.netflix.com${nextClip.url}`;
      url = `${base}?t=${startTime}`;
      break;
    }
    case "prime":
      console.log("Primeは現在未対応です");
      return;
    default:
      console.warn("対応していないサービス:", service);
      return;
  }

  // 🎯 安全に保存してから遷移
  try {
    await safeSetStorage({ playmode: "playlist", nextClip });
    console.log("✅ 再生情報を保存しました:", nextClip);
  } catch (err) {
    console.error("⚠️ safeSetStorage 失敗:", err);
  }

  if (!url) return console.warn("⚠️ URL が無効のため遷移をスキップ");

  setTimeout(() => {
    window.location.href = url;
  }, 300);
}

// ------------------------------
// デバッグ用（現在の文脈確認）
// ------------------------------
console.log("📍 location:", location.href);
console.log("📦 chrome.storage available:", typeof chrome?.storage);
