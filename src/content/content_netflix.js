import "../css/content_button.css";
import "../image/moreDetailSVG.js";
import "../image/recordSVG.js";
import "../image/LoopButtonSVG.js";
import { getApiEndpoint } from './../api.js';
import {
  clearAutoNavigation,
  detectService,
  handleClipTransition,
  isAutoNavigation,
  markAutoNavigation,
  MEMO_SIDEBAR_ID,
  openMemoSidebar,
  sendData,
  requestSeek
} from './common.js';
import { setCookie } from '../util/cookies.js';
import { buildServiceUrl } from '../util/services.js';

/** @typedef {import('../types/clip').ClipDataProps} ClipDataProps */
/** @typedef {import('../types/clip').ClipListProps} ClipListProps */

let netflixPlaybackInitialized = false;

function onWindowLoad(callback) {
  if (document.readyState === "complete") {
    callback();
    return;
  }
  window.addEventListener("load", callback, { once: true });
}

function initializeNetflixPlayback() {
  if (netflixPlaybackInitialized) {
    return;
  }
  netflixPlaybackInitialized = true;

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
        });
      }
    });
    sessionStorage.setItem("nfClipInitialized", "true");
  }

  // ---------------------------------------------------------------------------
  // グローバル変数
  // ---------------------------------------------------------------------------
  let videoPlayer = null;
  /** @type {ClipDataProps | null} */
  let clipData = null;
  const EPSILON = 0.05;
  let countdownIntervalId = null;

  const BUTTON_ID = "nf-loop-toggle-btn";
  const NEXT_BUTTON_ID = "nf-next-clip-btn";
  const SIDEBAR_ID = MEMO_SIDEBAR_ID;
  const SIDEBAR_PCT = 30;

  const SELECTOR_STANDARD = '[data-uia="controls-standard"]';
  const SELECTOR_EPISODE  = '[data-uia="control-episodes"]';
  const SELECTOR_FWD10    = '[data-uia="control-forward10"]';
  const SELECTOR_SUBTITLE = '[data-uia="control-audio-subtitle"]';

  const COLOR_DEFAULT = window.COLOR_DETAIL_DEFAULT || "#FFFFFF";
  const COLOR_LOOPING = window.COLOR_DETAIL_ACTIVE  || "#FF0000";
  let isLooping = false;
  let togglekey = false;
  let uiWarmerInterval = null;

  clearAutoNavigation();
  bootstrapRecordControls();

  function bootstrapRecordControls() {
    const RECORD_BUTTON_ID = "record-button";
    const RECORD_SELECTORS = {
      videoPlayer: "video",
      videoTitle: '[data-uia="video-title"]',
      controlsStandard: '[data-uia="controls-standard"]',
      controlVolume: '[data-uia^="control-volume-"]',
      controlForward10: '[data-uia="control-forward10"]'
    };

    onWindowLoad(() => {
      injectHistoryHook("src/util/history_change.js");

      const buttonMargin = document.createElement("div");
      buttonMargin.style.minWidth = "3rem";
      buttonMargin.style.width = "3rem";

      const wrapButton = document.createElement("div");
      const recordButton = document.createElement("button");
      recordButton.id = RECORD_BUTTON_ID;
      recordButton.setAttribute("aria-label", "録画ボタン");

      const svgElement = window.createSVG?.();
      if (!svgElement) {
        return;
      }

      let isRecording = false;
      let startTime = null;
      let endTime = null;

      recordButton.addEventListener("click", () => {
        try {
          const videoPlayer = document.querySelector(RECORD_SELECTORS.videoPlayer);
          if (!videoPlayer) {
            throw new Error("ビデオプレーヤーが見つかりません。");
          }

          const allTitleName = document.querySelector(RECORD_SELECTORS.videoTitle);

          if (isRecording) {
            endTime = videoPlayer.currentTime;
            if (startTime > endTime) {
              throw new Error("録画終了時刻が開始時刻よりも早い値です");
            }

            const clipSeconds = Math.abs(endTime - startTime);
            if (clipSeconds < 1) {
              svgElement.setAttribute("color", window.COLOR_RECORDING);
              throw new Error("録画範囲が短すぎます");
            }

            const payload = {
              StartTime: startTime,
              EndTime: endTime,
              URL: window.location.pathname,
              service: detectService(),
              user: "test_user"
            };

            if (allTitleName) {
              const h4Element = allTitleName.querySelector("h4");
              if (h4Element) {
                payload.title = h4Element.textContent;
                const episodeNumberElement = allTitleName.querySelector("span:nth-of-type(1)");
                if (episodeNumberElement) {
                  payload.epnumber = episodeNumberElement.textContent;
                }
              } else {
                payload.title = allTitleName.textContent;
              }
            } else {
              throw new Error("タイトル要素が見つかりません。");
            }

            videoPlayer.pause();
            openMemoSidebar({
              data: payload,
              videoPlayer,
              onSave: (data) => sendData(data),
              sidebarTitle: "Clipを追加 - Netflix"
            });
            resetRecordState();
          } else {
            svgElement.setAttribute("color", window.COLOR_RECORDING);
            isRecording = true;
            startTime = videoPlayer.currentTime;
          }
        } catch (error) {
          console.error(error);
          alert(error.message);
          resetRecordState();
        }
      });

      const recordObserver = new MutationObserver(() => {
        const controlsForward10Element = document.querySelector(RECORD_SELECTORS.controlForward10);
        if (controlsForward10Element && !document.getElementById(RECORD_BUTTON_ID)) {
          const controlsStandardElement = document.querySelector(RECORD_SELECTORS.controlsStandard);
          const controlVolumeElement = document.querySelector(RECORD_SELECTORS.controlVolume);
          if (!controlsStandardElement || !controlVolumeElement) {
            return;
          }

          recordButton.className = controlVolumeElement.className;
          recordButton.appendChild(svgElement);
          wrapButton.className = controlVolumeElement.parentNode.className;
          controlVolumeElement.parentNode.after(wrapButton);
          wrapButton.appendChild(recordButton);
          controlVolumeElement.parentNode.after(buttonMargin);
          return;
        }

        if (!controlsForward10Element && document.getElementById(RECORD_BUTTON_ID)) {
          buttonMargin.remove();
          recordButton.remove();
        }
      });

      recordObserver.observe(document.body, { childList: true, subtree: true });
      window.addEventListener("beforeunload", () => recordObserver.disconnect());

      window.addEventListener("historyChange", (e) => {
        resetRecordState();
        chrome.runtime.sendMessage({ type: "HISTORY_CHANGE", data: e.detail });
      });

      function resetRecordState() {
        isRecording = false;
        startTime = null;
        endTime = null;
        svgElement.setAttribute("color", window.COLOR_DEFAULT);
      }
    });

    function injectHistoryHook(file, tag) {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL(file);
      script.onload = function onLoad() {
        this.remove();
      };
      (tag || document.head).appendChild(script);
    }
  }

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
    });
    return { btn, svg: svgIcon };
  }

  const uiObserver = new MutationObserver(() => {
    const controls    = document.querySelector(SELECTOR_STANDARD);
    const episodeBtn  = document.querySelector(SELECTOR_EPISODE);
    const subtitleBtn = document.querySelector(SELECTOR_SUBTITLE);

    const loopBtnExists = document.getElementById(BUTTON_ID);
    const nextBtnExists = document.getElementById(NEXT_BUTTON_ID);

    if (controls && !loopBtnExists && !nextBtnExists && (episodeBtn || subtitleBtn)) {
      const anchorBtn = episodeBtn || subtitleBtn;

      const { btn: loopButton, svg: loopSvg } = createLoopButton();
      const { btn: playNextButton, svg: playSvg } = createPlayNextClipButton();

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
      jumpBtn.onclick = () => onSelect?.(item.id);
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
    try {
      const res = await fetch(getApiEndpoint(`fetchClip?id=${encodeURIComponent(clipId)}`));
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const data = await res.json();
      setClipDataOnCookies(data);
      redirectToClip(data);
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
    window.open(finalUrl, "_blank");
  }

  // ---------------------------------------------------------------------------
  // Clip再生モード
  // ---------------------------------------------------------------------------
  function loadClipFromStorage() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(['playClipSystemKey', 'clip'], res => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        if (res.playClipSystemKey === 1 && res.clip) {
          clipData = {
            startTime: Number(res.clip.startTime ?? res.clip.starttime),
            endTime:   Number(res.clip.endTime   ?? res.clip.endtime),
            title:     res.clip.title
          };
          console.info('[Clip] loaded:', clipData);
          resolve();
        } else {
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
    chrome.storage.local.set({ playClipSystemKey: 1, playlistSystemKey: 0, playmode: "clip" });
    try {
      await loadClipFromStorage();
      videoPlayer = await waitForVideoElement();
      setupPlayer("clip");
    } catch (err) {
      console.error('[Clip] Initialization failed:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Playlist再生モード
  // ---------------------------------------------------------------------------
  async function startPlaylistMode() {
    chrome.storage.local.set({ playClipSystemKey: 0, playlistSystemKey: 1, playmode: "playlist" });
    chrome.storage.local.get(["playQueue", "currentClipOrder"], async ({ playQueue, currentClipOrder }) => {
      if (!Array.isArray(playQueue) || playQueue.length === 0) {
        console.warn("[Playlist] playQueue が存在しません");
        return;
      }
      playQueue.sort((a, b) => a.order - b.order);
      const order = Number.isInteger(currentClipOrder) ? currentClipOrder : 0;
      const currentClip = playQueue.find(c => c.order === order);
      if (!currentClip) {
        console.warn("[Playlist] 該当clipが見つかりません:", order);
        return;
      }
      clipData = {
        startTime: Number(currentClip.startTime ?? currentClip.starttime),
        endTime:   Number(currentClip.endTime   ?? currentClip.endtime),
        title:     currentClip.clipname
      };
      videoPlayer = await waitForVideoElement();
      setupPlayer("playlist");
    });
  }

  async function playlistNextClip(playQueue, currentOrder) {
    const sortedQueue = [...playQueue].sort((a, b) => a.order - b.order);
    const currentIndex = sortedQueue.findIndex(c => c.order === currentOrder);
    if (currentIndex === -1) {
      console.warn("[Playlist] 現在のclipが見つかりません:", currentOrder);
      return;
    }

    const current = sortedQueue[currentIndex];
    const isLast = currentIndex === sortedQueue.length - 1;
    const next = isLast ? sortedQueue[0] : sortedQueue[currentIndex + 1];

    await new Promise((resolve) => {
      chrome.storage.local.set({ currentClipOrder: next.order, currentClipId: next.id }, resolve);
    });

    clipData = {
      startTime: Number(next.startTime ?? next.starttime),
      endTime:   Number(next.endTime   ?? next.endtime),
      title:     next.clipname,
    };

    await handleClipTransition({
      currentUrl: current.url,
      nextUrl: next.url,

      onSameUrl: async () => {
        startUIWarmer();
        const targetTime = Math.floor(next.startTime);

        for (;;) {
          try {
            await requestSeek({ service: 'Netflix', seconds: targetTime });
          } catch (err) {
            console.warn("[Playlist] seekメッセージ送信失敗:", err);
          }

          await new Promise(r => setTimeout(r, 300));

          const currentSec = Math.floor(videoPlayer?.currentTime ?? 0);
          if (Math.abs(currentSec - targetTime) <= 1) {
            stopUIWarmer();
            break;
          }
        }

        monitorClipEnd(clipData.endTime, clipData.startTime, "playlist");
        startCountdownLogger(clipData.endTime);
      },

      onDifferentUrl: () => {
        markAutoNavigation("playlist");
        const url = `https://www.netflix.com${next.url}?t=${Math.floor(next.startTime)}`;
        setTimeout(() => { window.location.href = url; }, 150);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 共通：プレイヤー初期化・監視
  // ---------------------------------------------------------------------------
  function setupPlayer(mode /* "clip" | "playlist" */) {
    const end   = Number(clipData?.endTime);
    const start = Number(clipData?.startTime);

    if (!Number.isFinite(end) || !Number.isFinite(start)) {
      console.warn("[Clip] clipDataの時間が不正です:", clipData);
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

        if (mode === "playlist") {
          chrome.storage.local.get(
            ["playQueue", "currentClipOrder"],
            (res) => {
              const { playQueue, currentClipOrder } = res;
              if (Array.isArray(playQueue)) {
                playlistNextClip(playQueue, currentClipOrder ?? 0);
              } else {
                console.warn("[Playlist] playQueue が無効。playlist終了");
                chrome.storage.local.set({ playlistSystemKey: 0 });
              }
            }
          );
        } else {
          try {
            requestSeek({ service: 'Netflix', seconds: start, videoElement: videoPlayer });
          } catch(e) {
            try { videoPlayer.currentTime = start; videoPlayer.play?.(); } catch(_) {}
          }
          monitorClipEnd(end, start, mode);
          startCountdownLogger(end);
        }
      }
    }
    videoPlayer.addEventListener("timeupdate", onTimeUpdate);
  }

  function startCountdownLogger(end) {
    if (countdownIntervalId !== null) clearInterval(countdownIntervalId);
    countdownIntervalId = setInterval(() => {
      if (!videoPlayer) return;
      const remaining = Math.max(0, end - videoPlayer.currentTime);
      console.log(`[Countdown] ${remaining.toFixed(1)}s remaining`);
    }, 1000);
  }

  function startUIWarmer() {
    if (uiWarmerInterval !== null) return;

    uiWarmerInterval = setInterval(() => {
      const ui = document.querySelector('[data-uia="controls-standard"]')
               || document.querySelector('.watch-video--bottom-controls-container')
               || document.querySelector('.watch-video--player-view');

      if (!ui) return;

      const rect = ui.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + 5;

      ["mousedown", "mouseup"].forEach(type => {
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
  // ページロード時のモード起動
  // ---------------------------------------------------------------------------
  onWindowLoad(async () => {
    chrome.storage.local.get(["playClipSystemKey", "playlistSystemKey", "playmode"], async ({ playClipSystemKey, playlistSystemKey, playmode }) => {
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
        console.warn("[Clip] 両モードがON。Clipを優先して矯正します。");
        await chrome.storage.local.set({ playClipSystemKey: 1, playlistSystemKey: 0 });
        await init();
        return;
      }

      if (playClipSystemKey === 1) {
        await init();
      } else if (playlistSystemKey === 1) {
        await startPlaylistMode();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 離脱処理
  // ---------------------------------------------------------------------------
  window.addEventListener("beforeunload", () => {
    if (isAutoNavigation()) {
      return;
    }

    chrome.storage.local.set({
      playClipSystemKey: 0,
      playlistSystemKey: 0,
      currentClipOrder: 0,
      playmode: null
    });
  });
}

initializeNetflixPlayback();
