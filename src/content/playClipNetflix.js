import { getApiEndpoint } from './../api.js';
import {
  clearAutoNavigation,
  handleClipTransition,
  isAutoNavigation,
  markAutoNavigation,
  MEMO_SIDEBAR_ID,
  requestSeek
} from './common.js';
import { setCookie } from '../util/cookies.js';
import { buildServiceUrl } from '../util/services.js';

/** @typedef {import('../types/clip').ClipDataProps} ClipDataProps */
/** @typedef {import('../types/clip').ClipListProps} ClipListProps */

(() => {
  'use strict';

// --------------------------------------------------
// 🔰 起動時初期化ガード（モードが有効でなければリセット）
// --------------------------------------------------
if (!sessionStorage.getItem("nfClipInitialized")) {
  chrome.storage.local.get(["playClipSystemKey", "playlistSystemKey", "playmode"], (res) => {
    const clipModeActive = res.playClipSystemKey === 1;
    const playlistActive = res.playlistSystemKey === 1;
    const playmodeActive = res.playmode === "clip" || res.playmode === "playlist";

    if (!clipModeActive && !playlistActive && !playmodeActive) {
      chrome.storage.local.set({
        playClipSystemKey: 0,
        playlistSystemKey: 0,
        currentClipOrder: 0,
        playmode: null,
        clip: null
      }, () => {
        console.log("🧹 初期化ガード: 不要データをクリーンアップしました");
      });
    } else {
      console.log("🔄 モード継続中のため、初期化をスキップ");
    }
  });

  sessionStorage.setItem("nfClipInitialized", "true");
}


  // ---------------------------------------------------------------------------
  // グローバル変数
  // ---------------------------------------------------------------------------
  let videoPlayer = null;            // <video> element
  /** @type {ClipDataProps | null} */
  let clipData    = null;            // { startTime, endTime, title, ... }
  const EPSILON = 0.05;
  let countdownIntervalId = null;

  const BUTTON_ID = "nf-loop-toggle-btn";
  const NEXT_BUTTON_ID = "nf-next-clip-btn";
  const SIDEBAR_ID = MEMO_SIDEBAR_ID;
  const SIDEBAR_PCT = 30;

  const SELECTOR_STANDARD  = '[data-uia="controls-standard"]';
  const SELECTOR_EPISODE   = '[data-uia="control-episodes"]';
  const SELECTOR_FWD10     = '[data-uia="control-forward10"]';
  const SELECTOR_SUBTITLE  = '[data-uia="control-audio-subtitle"]';

  const COLOR_DEFAULT = window.COLOR_DETAIL_DEFAULT || "#FFFFFF";
  const COLOR_LOOPING = window.COLOR_DETAIL_ACTIVE  || "#FF0000";
  let isLooping = false;
  let togglekey = false;

  let uiWarmerInterval = null;

  clearAutoNavigation();

  // storage.set を await できるユーティリティ
  function setStorageAsync(data) {
    return new Promise((resolve) => chrome.storage.local.set(data, resolve));
  }

  // ループ設定の取得（未設定なら true を既定）
  function getLoopPlaylist() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["loopPlaylist"], (res) => {
        resolve(typeof res.loopPlaylist === "boolean" ? res.loopPlaylist : true);
      });
    });
  }


  // 起動時のメッセージ送信（受け側未起動対策として try/catch）
  try { chrome.runtime.sendMessage({ type: "nf:init-bridge" }); } catch(e) { /* noop */ }

  // ---------------------------------------------------------------------------
  // UI生成
  // ---------------------------------------------------------------------------
  function createLoopButton() {
    const svgIcon = window.createMoreDetailSVG(COLOR_DEFAULT);
    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.setAttribute("aria-label", "メモサイドバー開閉");
    btn.appendChild(svgIcon);
    btn.style.cursor = "pointer";
    btn.addEventListener("click", () => {
      isLooping = !isLooping;
      svgIcon.style.color = isLooping ? COLOR_LOOPING : COLOR_DEFAULT;
      toggleSidebar();
    });
    return { btn, svg: svgIcon };
  }

  function createPlayNextClipButton() {
    const svgIcon = window.LoopButtonSVG(COLOR_DEFAULT);
    const btn = document.createElement("button");
    btn.id = NEXT_BUTTON_ID;
    btn.setAttribute("aria-label", "次のクリップを再生");
    btn.appendChild(svgIcon);
    btn.style.cursor = "pointer";
    btn.addEventListener("click", () => {
      togglekey = !togglekey;
      svgIcon.style.color = togglekey ? COLOR_LOOPING : COLOR_DEFAULT;
      console.log("▶️ 次のクリップを再生トグル:", togglekey);
    });
    return { btn, svg: svgIcon };
  }

  const uiObserver = new MutationObserver(() => {
    const controls    = document.querySelector(SELECTOR_STANDARD);
    const episodeBtn  = document.querySelector(SELECTOR_EPISODE);
    const subtitleBtn = document.querySelector(SELECTOR_SUBTITLE);

    const loopBtnExists = document.getElementById(BUTTON_ID);
    const nextBtnExists = document.getElementById(NEXT_BUTTON_ID);

    // 重複生成防止：両方無いときだけ生成
    if (controls && !loopBtnExists && !nextBtnExists && (episodeBtn || subtitleBtn)) {
      const anchorBtn = episodeBtn || subtitleBtn;

      const { btn: loopButton,      svg: loopSvg } = createLoopButton();
      const { btn: playNextButton,  svg: playSvg } = createPlayNextClipButton();

      loopButton.className     = anchorBtn.className;
      playNextButton.className = anchorBtn.className;

      loopSvg.style.color = isLooping ? COLOR_LOOPING : COLOR_DEFAULT;
      playSvg.style.color = togglekey ? COLOR_LOOPING : COLOR_DEFAULT;

      const wrapper = document.createElement("div");
      wrapper.className = anchorBtn.parentNode.className;
      wrapper.style.display = "flex";
      wrapper.style.alignItems = "center";
      wrapper.style.gap = "0.5rem";

      const separator = document.createElement("div");
      separator.style.width = "1rem";
      separator.style.height = "100%";

      wrapper.appendChild(loopButton);
      wrapper.appendChild(separator);
      wrapper.appendChild(playNextButton);

      anchorBtn.parentNode.after(wrapper);

      const spacer = document.createElement("div");
      spacer.style.minWidth = "3rem";
      anchorBtn.parentNode.after(spacer);
    }

    // プレイヤーUIが消えた時にボタンも消す
    if (!document.querySelector(SELECTOR_FWD10)) {
      document.getElementById(BUTTON_ID)?.remove();
      document.getElementById(NEXT_BUTTON_ID)?.remove();
    }
  });
  uiObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("beforeunload", () => uiObserver.disconnect());

  // ---------------------------------------------------------------------------
  // サイドバー
  // ---------------------------------------------------------------------------
  function toggleSidebar() {
    const sb = document.getElementById(SIDEBAR_ID);
    sb ? closeSidebar() : openSidebar();
  }

  function openSidebar() {
    const player = document.querySelector(".watch-video--player-view");
    if (!player) return;
    player.style.transition = "width .3s";
    player.style.width = `calc(100% - ${SIDEBAR_PCT}%)`;

    const sb = document.createElement("div");
    sb.id = SIDEBAR_ID;
    sb.style.cssText = `
      position:fixed;top:0;right:0;width:${SIDEBAR_PCT}%;
      height:100%;background:rgba(0,0,0,.9);color:white;
      padding:10px;box-sizing:border-box;z-index:9999;
      display:flex;flex-direction:column;gap:10px;overflow-y:auto;
      font-size:12px;`;

    const header = document.createElement("div");
    header.style.cssText = "display:flex;justify-content:space-between;align-items:center;";
    const title = document.createElement("strong");
    title.textContent = "記録一覧";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = "background:red;color:#fff;border:none;cursor:pointer;font-size:14px;";
    closeBtn.onclick = toggleSidebar;
    header.append(title, closeBtn);
    sb.appendChild(header);

    const listContainer = document.createElement("div");
    listContainer.id = "nf-api-list";
    listContainer.textContent = "読込中…";
    sb.appendChild(listContainer);

    document.body.appendChild(sb);

    fetchDataAndRender(listContainer);
  }

  function closeSidebar() {
    const player = document.querySelector(".watch-video--player-view");
    if (player) player.style.width = "100%";
    document.getElementById(SIDEBAR_ID)?.remove();
  }

  /**
   * @param {HTMLElement} container
   * @param {ClipListProps} props
   */
  function renderClipList(container, { items, onSelect }) {
    container.innerHTML = "";
    for (const item of items) {
      const entry = document.createElement("div");
      entry.style.cssText = "border-bottom:1px solid #555;padding:4px 0;";
      entry.innerHTML = `
          <div><strong>${item.title}（${item.epnumber}）</strong></div>
          <div>ユーザー: ${item.user}</div>
          <div>範囲: ${formatTime(item.startTime)} - ${formatTime(item.endTime)}</div>
        `;
      const jumpBtn = document.createElement("button");
      jumpBtn.textContent = "▶ このClipへジャンプ";
      jumpBtn.style.cssText = "margin-top:4px;background:#0f0;color:#000;border:none;padding:4px 8px;cursor:pointer;";
      jumpBtn.onclick = () => {
        console.log("このclipを選択しました！");
        onSelect?.(item.id);
      };
      entry.appendChild(jumpBtn);
      container.appendChild(entry);
    }
  }

  async function fetchDataAndRender(container) {
    try {
      const res = await fetch(getApiEndpoint('random10'));
      const data = await res.json();
      /** @type {ClipDataProps[]} */
      const items = data.allReceivedData || [];

      if (!items.length) {
        container.textContent = "データがありません。";
        return;
      }
      renderClipList(container, { items, onSelect: (clipId) => selectClip(clipId) });
    } catch (err) {
      container.textContent = "データの取得に失敗しました。";
      console.error("API取得失敗:", err);
    }
  }

  function formatTime(sec) {
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    const m = Math.floor(sec / 60);
    return `${m}:${s}`;
  }

  // ---------------------------------------------------------------------------
  // Clip選択 → Cookie保存 → サービス別ジャンプ
  // ---------------------------------------------------------------------------
  async function selectClip(clipId) {
    console.log("Clip selected:", clipId);
    const url = `http://localhost:3000/api/fetchClip?id=${encodeURIComponent(clipId)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

      const raw = await res.text();
      console.log("Raw response:", raw);

      const data = JSON.parse(raw);
      console.log("取得クリップデータ:", data);

      setClipDataOnCookies(data);
      redirectToClip(data);

      // Clipモードで起動することを明示（相互排他）
      chrome.storage.local.set({ playClipSystemKey: 1, playlistSystemKey: 0 });

    } catch (err) {
      console.error("クリップ選択処理でエラー:", err);
    }
  }

  /**
   * @param {ClipDataProps} data
   */
  function setClipDataOnCookies(data) {
    const keys = ["title", "user", "startTime", "endTime", "url", "service", "clipId", "username"];
    for (const key of keys) {
      if (data[key] !== undefined) {
        const encoded = encodeURIComponent(data[key]);
        setCookie(key, encoded, {
          path: "/",
          maxAge: 3600,
          sameSite: "Lax",
          secure: location.protocol === "https:"
        });
      }
    }
  }

  function redirectToClip({ url, service, startTime }) {
    if (!url || !service) {
      alert("URL または サービス情報が不正です");
      return;
    }
    const finalUrl = buildServiceUrl(service, url, Math.floor(startTime), "t");
    if (!finalUrl) {
      alert(`未対応のサービス: ${service}`);
      return;
    }
    // 修正：新規タブで開く場合は window.open
    window.open(finalUrl, "_blank");
    console.log("再生位置付きで開きます:", finalUrl);
  }

  // ---------------------------------------------------------------------------
  // Clip再生モード
  // ---------------------------------------------------------------------------
  function ensureClipTagInURL() {
    chrome.storage.local.get(["playClipSystemKey"], (result) => {
      console.log("再生機能の起動キー:", result.playClipSystemKey);
    });
  }

  function loadClipFromStorage() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(['playClipSystemKey', 'clip'], res => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        if (res.playClipSystemKey === 1 && res.clip) {
          // 統一：camelCase
          clipData = {
            startTime: Number(res.clip.startTime ?? res.clip.starttime),
            endTime:   Number(res.clip.endTime   ?? res.clip.endtime),
            title:     res.clip.title
          };
          console.info('[Clip] loaded:', clipData);
          resolve();
        } else {
          console.log('[Clip] No clip data or playClipSystemKey is not 1');
          resolve();
        }
      });
    });
  }

  function waitForVideoElement() {
    return new Promise(resolve => {
      const existing = document.querySelector('video');
      if (existing) return resolve(existing);
      const observer = new MutationObserver(() => {
        const v = document.querySelector('video');
        if (v) { observer.disconnect(); resolve(v); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  async function init() {
    // Clipモードの明示（相互排他）
    chrome.storage.local.set({ playClipSystemKey: 1, playlistSystemKey: 0, playmode: "clip" });

    //ensureClipTagInURL(); 不要コード
    try {
      await loadClipFromStorage();
      videoPlayer = await waitForVideoElement();
      setupPlayer("clip");                 // ← モードを明示
    } catch (err) {
      console.error('[Clip] Initialization failed:', err);
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Playlist再生モード
  // ---------------------------------------------------------------------------
  async function startPlaylistMode() {
    // Playlistモードの明示（相互排他）
    chrome.storage.local.set({ playClipSystemKey: 0, playlistSystemKey: 1, playmode: "playlist" });

    console.log("▶️ プレイリスト再生モードを起動します");
    chrome.storage.local.get(["playQueue", "currentClipOrder"], async ({ playQueue, currentClipOrder }) => {
      if (!Array.isArray(playQueue) || playQueue.length === 0) {
        console.warn("⚠️ playQueue が存在しません");
        return;
      }
      playQueue.sort((a, b) => a.order - b.order);
      const order = Number.isInteger(currentClipOrder) ? currentClipOrder : 0;
      const currentClip = playQueue.find(c => c.order === order);
      if (!currentClip) {
        console.warn("⚠️ 該当clipが見つかりません:", order);
        return;
      }
      console.log("🎬 現在clip:", currentClip);
      clipData = {
        startTime: Number(currentClip.startTime ?? currentClip.starttime),
        endTime:   Number(currentClip.endTime   ?? currentClip.endtime),
        title:     currentClip.clipname
      };
      videoPlayer = await waitForVideoElement();
      setupPlayer("playlist");             // ← モードを明示
    });
  }

  // --------------------------------------------------
  // 次のクリップへ遷移（同URLならseek・別URLなら移行）
  // 最後のclipでは最初に戻る（ループ再生）
  // --------------------------------------------------
  function setStorageAsync(data) {
    return new Promise((resolve) => chrome.storage.local.set(data, resolve));
  }

  // --------------------------------------------------
// プレイリスト内で次のclipへ移行
// （最後なら自動的に order:0 のclipに戻る）
// --------------------------------------------------
// --------------------------------------------------
// 次のクリップへ遷移（同URLなら無限リトライでseek / 異URLなら移行）
// 最終clipなら自動的に order:0 に戻る
// --------------------------------------------------
async function playlistNextClip(playQueue, currentOrder) {
  console.log("▶️ playlistNextClip: 現在のorder =", currentOrder);

  // 並び順を保証
  const sortedQueue = [...playQueue].sort((a, b) => a.order - b.order);
  const currentIndex = sortedQueue.findIndex(c => c.order === currentOrder);
  if (currentIndex === -1) {
    console.warn("⚠️ 現在のclipが見つかりません:", currentOrder);
    return;
  }

  const current = sortedQueue[currentIndex];
  const isLast = currentIndex === sortedQueue.length - 1;
  const next = isLast ? sortedQueue[0] : sortedQueue[currentIndex + 1];

  if (isLast) console.log("🔁 最終clip → order 0 のclipへループ再生します");

  // ---------------------------------------
  // 🧭 遷移前に状態を保存
  // ---------------------------------------
  await new Promise((resolve) => {
    chrome.storage.local.set(
      { currentClipOrder: next.order, currentClipId: next.id },
      () => {
        console.log(`💾 currentClipOrder=${next.order} を保存完了`);
        resolve();
      }
    );
  });

  // clipData更新（monitorClipEndで参照される）
  clipData = {
    startTime: Number(next.startTime ?? next.starttime),
    endTime:   Number(next.endTime   ?? next.endtime),
    title:     next.clipname,
  };

  // --------------------------------------------------
  // 🎯 分岐：同じURL内ならseek、異なるURLならページ遷移
  // --------------------------------------------------
await handleClipTransition({
  currentUrl: current.url,
  nextUrl: next.url,

  onSameUrl: async () => {
    console.log("🔁 同じURL内のclipに移動 → ui seek使用（無限リトライ）");
    startUIWarmer(); // seek成功までUIクリックブースト開始
    const targetTime = Math.floor(next.startTime);

    for (;;) {
      try {
        await requestSeek({ service: 'Netflix', seconds: targetTime });
      } catch (err) {
        console.warn("⚠️ seekメッセージ送信失敗:", err);
      }

      await new Promise(r => setTimeout(r, 300));

      const currentSec = Math.floor(videoPlayer?.currentTime ?? 0);
      if (Math.abs(currentSec - targetTime) <= 1) {
        console.log(`✅ seek成功: ${currentSec}s に到達`);
        stopUIWarmer();
        break;
      } else {
        console.log(`🔁 seek再送: current=${currentSec}s / target=${targetTime}s`);
      }
    }

    // 成功後、再監視をセット
    monitorClipEnd(clipData.endTime, clipData.startTime, "playlist");
    startCountdownLogger(clipData.endTime);
  },

  onDifferentUrl: () => {
    // playlist継続中であることを通知（beforeunloadリセット回避）
    markAutoNavigation("playlist");

    console.log("🌐 異なるURL → ページ遷移を実行");
    const url = `https://www.netflix.com${next.url}?t=${Math.floor(next.startTime)}`;
    console.log("➡️ 次clipへ移動:", url);

    setTimeout(() => {
      window.location.href = url;
    }, 150);
  }
});
}


  // ---------------------------------------------------------------------------
  // 共通：プレイヤー初期化・監視（モードを引数で固定）
  // ---------------------------------------------------------------------------
  function setupPlayer(mode /* "clip" | "playlist" */) {
    const end   = Number(clipData?.endTime);
    const start = Number(clipData?.startTime);

    if (!Number.isFinite(end) || !Number.isFinite(start)) {
      console.warn("⚠️ clipDataの時間が不正です:", clipData);
      return;
    }

    const onReady = () => {
      monitorClipEnd(end, start, mode);
      startCountdownLogger(end);
    };

    if (videoPlayer.readyState >= 1) {
      onReady();
    } else {
      videoPlayer.addEventListener('loadedmetadata', onReady, { once: true });
    }

    videoPlayer.addEventListener('error', e => console.error('[Video] error:', e));
  }

  function monitorClipEnd(end, start, mode /* "clip" | "playlist" */) {
    function onTimeUpdate() {
      if (videoPlayer.currentTime + EPSILON >= end) {
        console.info("[Clip] Reached end:", clipData?.title || "unknown");
        videoPlayer.removeEventListener("timeupdate", onTimeUpdate);
        clearInterval(countdownIntervalId);

        // ★ 重要：storageを見直さない。モードは上位から固定伝播。
        if (mode === "playlist") {
          chrome.storage.local.get(
            ["playQueue", "currentClipOrder"],
            (res) => {
              const { playQueue, currentClipOrder } = res;
              if (Array.isArray(playQueue)) {
                playlistNextClip(playQueue, currentClipOrder ?? 0);
              } else {
                console.warn("⚠️ playQueue が無効。playlist終了");
                chrome.storage.local.set({ playlistSystemKey: 0 });
              }
            }
          );
        } else {
          // 単体Clipモード：init()再帰はしない。seekのみでループ。
          try {
            requestSeek({ service: 'Netflix', seconds: start, videoElement: videoPlayer });
          } catch(e) {
            // 念のため、失敗時はvideo直操作のフォールバック
            try { videoPlayer.currentTime = start; videoPlayer.play?.(); } catch(_) {}
          }
          // 再初期化は不要。監視は loadedmetadata/onReady で再装着済みのため軽量に保つ。
          monitorClipEnd(end, start, mode); // 軽い再装着（多重登録回避のため上で一旦remove）
          startCountdownLogger(end);
        }
      }
    }
    videoPlayer.addEventListener("timeupdate", onTimeUpdate);
    console.log("👁️‍🗨️ 時間監視を開始:", end, "mode:", mode);
  }

  function startCountdownLogger(end) {
    if (countdownIntervalId !== null) clearInterval(countdownIntervalId);
    countdownIntervalId = setInterval(() => {
      if (!videoPlayer) return;
      const remaining = Math.max(0, end - videoPlayer.currentTime);
      console.log(`[Countdown] ${remaining.toFixed(1)} seconds remaining until end.`);
    }, 1000);
  }

function startUIWarmer() {
  if (uiWarmerInterval !== null) return;

  uiWarmerInterval = setInterval(() => {
    // 最も信頼できるターゲット
    const ui = document.querySelector('[data-uia="controls-standard"]')
             || document.querySelector('.watch-video--bottom-controls-container')
             || document.querySelector('.watch-video--player-view'); // fallback

    if (!ui) return;

    const rect = ui.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + 5; // 下側ではなく「上端の透明領域」の方が安定

    ["mousedown","mouseup"].forEach(type => {
      ui.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        view: window
      }));
    });

  }, 800);
}

function stopUIWarmer() {
  if (uiWarmerInterval !== null) {
    clearInterval(uiWarmerInterval);
    uiWarmerInterval = null;
  }
}

  // ---------------------------------------------------------------------------
  // ページロード時のモード起動（排他保証）
  // ---------------------------------------------------------------------------
  window.addEventListener("load", async () => {
    chrome.storage.local.get(["playClipSystemKey", "playlistSystemKey", "playmode"], async ({ playClipSystemKey, playlistSystemKey, playmode }) => {
      console.log("再生機能の起動キー:", playClipSystemKey);
      console.log("プレイリスト再生機能の起動キー:", playlistSystemKey);

      if (playmode === "playlist") {
        await chrome.storage.local.set({ playClipSystemKey: 0, playlistSystemKey: 1 });
        await startPlaylistMode();
        return;
      }

      if (playmode === "clip") {
        await chrome.storage.local.set({ playClipSystemKey: 1, playlistSystemKey: 0 });
        await init();
        return;
      }

      if (playClipSystemKey === 1 && playlistSystemKey === 1) {
        // どちらもONは異常。Clip優先で矯正。
        console.warn("⚠️ 両モードがON。Clipを優先して矯正します。");
        await chrome.storage.local.set({ playClipSystemKey: 1, playlistSystemKey: 0 });
        await init();
        return;
      }

      if (playClipSystemKey === 1) {
        await init();                   // clipモード起動
      } else if (playlistSystemKey === 1) {
        await startPlaylistMode();      // playlistモード起動
      } else {
        console.log("⏸ 再生機能は未活性、待機状態");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 離脱処理（両モード残留を防止）
  // ---------------------------------------------------------------------------
  window.addEventListener("beforeunload", () => {

    if (isAutoNavigation()) {
      console.log("▶️ 自動遷移検知：beforeunloadでのリセットをスキップ");
      return;
    }

    console.log("ユーザー操作（手動リロード or ページ遷移）検知");
    // ★ 重要：両方のキーを落とす（残留防止）
    chrome.storage.local.set({
      playClipSystemKey: 0,
      playlistSystemKey: 0,
      currentClipOrder: 0,
      playmode: null
    }, () => {
      console.log("systemKey を 0 に設定しました（両モード）");
    });
  });

  // （必要なら）スクリプト側から明示リロードする場合のラッパ
  function reloadPageFromScript() {
    markAutoNavigation("script-reload");
    location.reload();
  }

})();
