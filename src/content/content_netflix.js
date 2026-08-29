import "../css/content_button.css";
import {
  COLOR_ACTIVE as ICON_COLOR_ACTIVE,
  COLOR_DEFAULT as ICON_COLOR_DEFAULT,
  createIcon
} from "../ui/icons.js";
import { getApiEndpoint } from './../api.js';
import {
  clearAutoNavigation,
  closeMemoSidebar,
  createElementWait,
  detectService,
  handleClipTransition,
  handleOwnedPlaybackRouteChange,
  markAutoNavigation,
  markExtUi,
  MEMO_SIDEBAR_ID,
  openMemoSidebar,
  requestCloseCommentPanel,
  sendData,
  startTabVisibilityToggle,
  requestSeek
} from './common.js';
import {
  COMMENT_PANEL_ID,
  COMMENT_PANEL_OPEN_STATE_EVENT,
  closeCommentPanel,
  isCommentPanelOpen,
  toggleCommentPanel
} from './commentPanel.js';
import {
  clearPlaybackContext,
  ensurePlaybackContext,
  setPlaybackContext
} from './playbackContext.js';
import { commitSelectedClip } from './netflixClipSelection.js';
import {
  addPlaybackOwnerToUrl,
  beginPlaybackHandoff,
  claimPlaybackOwnership,
  createPlaybackOwnerNonce,
  getTabPlaybackOwnerNonce,
  preparePlaybackNavigation,
  releasePlaybackOwnership,
  updatePlaybackOwnership
} from './playbackOwnership.js';
import { setCookie } from '../util/cookies.js';
import { buildServiceUrl } from '../util/services.js';
import { normalizePlaybackRoute } from '../shared/playbackBridgeValidation.js';

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
  ensurePlaybackContext();

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
  const COMMENT_BUTTON_ID = "nf-comment-toggle-btn";
  const SIDEBAR_ID = MEMO_SIDEBAR_ID;
  const SIDEBAR_PCT = 30;

  const SELECTOR_STANDARD = '[data-uia="controls-standard"]';
  const SELECTOR_EPISODE  = '[data-uia="control-episodes"]';
  const SELECTOR_FWD10    = '[data-uia="control-forward10"]';
  const SELECTOR_SUBTITLE = '[data-uia="control-audio-subtitle"]';

  const COLOR_DEFAULT = ICON_COLOR_DEFAULT;
  const COLOR_LOOPING = ICON_COLOR_ACTIVE;
  let isLooping = false;
  let togglekey = false;
  let uiWarmerInterval = null;
  let activePlaybackOwnerNonce = null;
  let playbackLocation = null;
  let stopClipEndMonitor = null;
  let activePlaylistQueue = null;
  let activePlaylistOrder = null;
  let playbackGeneration = 0;
  let cancelPendingVideoWait = null;
  let removePendingMetadataListener = null;
  let removeVideoErrorListener = null;

  function applyPlaybackContext(context, ownerNonce) {
    setPlaybackContext(context);
    activePlaybackOwnerNonce = ownerNonce;
    playbackLocation = routeIdentity(location.href);
    playbackGeneration += 1;
  }

  async function claimPlaybackSession(ownerNonce) {
    try {
      const claim = await claimPlaybackOwnership({ nonce: ownerNonce });
      if (
        !claim?.ok ||
        typeof claim.nonce !== 'string' ||
        claim.nonce.length < 8
      ) {
        throw new Error(claim?.reason || 'Playback claim failed');
      }
      applyPlaybackContext(claim.context, claim.nonce);
      return claim;
    } catch {
      clearPlaybackContext();
      return null;
    }
  }

  async function transitionPlaybackSession(mode, clip, patch) {
    const clipId = clip?.clipId ?? clip?.id;
    const update = await updatePlaybackOwnership({
      nonce: activePlaybackOwnerNonce,
      mode,
      clipId,
      patch
    });
    if (!update?.ok) {
      deactivatePlaybackContext();
      return null;
    }
    applyPlaybackContext(update.context, activePlaybackOwnerNonce);
    return update;
  }

  function deactivatePlaybackContext() {
    const ownerNonce = activePlaybackOwnerNonce;
    activePlaybackOwnerNonce = null;
    playbackLocation = null;
    playbackGeneration += 1;
    clearAutoNavigation();
    clearPlaybackContext();
    closeCommentPanel();
    releasePlaybackOwnership(ownerNonce);

    stopPlaybackRuntime();
    clipData = null;
    activePlaylistQueue = null;
    activePlaylistOrder = null;
  }

  function stopPlaybackRuntime() {
    cancelPendingVideoWait?.();
    cancelPendingVideoWait = null;
    stopClipEndMonitor?.();
    stopClipEndMonitor = null;
    removePendingMetadataListener?.();
    removePendingMetadataListener = null;
    removeVideoErrorListener?.();
    removeVideoErrorListener = null;
    if (countdownIntervalId !== null) {
      clearInterval(countdownIntervalId);
      countdownIntervalId = null;
    }
    stopUIWarmer();
  }

  function handlePlaybackRouteChange(nextUrl) {
    const resolvedUrl = routeIdentity(nextUrl || location.href);
    handleOwnedPlaybackRouteChange({
      ownerNonce: activePlaybackOwnerNonce,
      currentRoute: playbackLocation,
      nextRoute: resolvedUrl,
      onAutoNavigation: (route) => {
        playbackLocation = route;
      },
      onManualNavigation: deactivatePlaybackContext,
    });
  }

  clearAutoNavigation();
  bootstrapRecordControls();
  startTabVisibilityToggle();

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

      const svgElement = createIcon("record");
      // 旧 recordSVG が持っていた初期色（白）を移設。currentColor の継承に頼らず明示する。
      svgElement.setAttribute("color", ICON_COLOR_DEFAULT);

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
              svgElement.setAttribute("color", ICON_COLOR_ACTIVE);
              throw new Error("録画範囲が短すぎます");
            }

            const payload = {
              StartTime: startTime,
              EndTime: endTime,
              URL: window.location.pathname,
              service: detectService()
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
            svgElement.setAttribute("color", ICON_COLOR_ACTIVE);
            isRecording = true;
            startTime = videoPlayer.currentTime;
          }
        } catch (error) {
          console.error('[Clip] recording action failed');
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
          markExtUi(recordButton);
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
        handlePlaybackRouteChange(e.detail?.url);
      });

      function resetRecordState() {
        isRecording = false;
        startTime = null;
        endTime = null;
        svgElement.setAttribute("color", ICON_COLOR_DEFAULT);
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

  // ---------------------------------------------------------------------------
  // UI生成
  // ---------------------------------------------------------------------------
  function createLoopButton() {
    const svgIcon = createIcon("list");
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
    const svgIcon = createIcon("loop");
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

  function createCommentButton() {
    const svgIcon = createIcon("comment");
    const btn = document.createElement("button");
    btn.id = COMMENT_BUTTON_ID;
    btn.setAttribute("aria-label", "コメント表示");
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-controls", COMMENT_PANEL_ID);
    btn.appendChild(svgIcon);
    btn.style.cursor = "pointer";

    const updateOpenState = (open) => {
      btn.setAttribute("aria-expanded", String(open));
      svgIcon.style.color = open ? COLOR_LOOPING : COLOR_DEFAULT;
    };
    updateOpenState(isCommentPanelOpen());

    btn.addEventListener("click", () => {
      const mountEl =
        document.querySelector('div[data-uia="player"]') ||
        document.querySelector(".watch-video--player-view") ||
        document.body;
      const open = toggleCommentPanel({
        mountEl,
        triggerEl: btn,
        onOpenChange: updateOpenState
      });
      updateOpenState(open);
    });
    return { btn, svg: svgIcon };
  }

  function updateCurrentCommentButton(open) {
    const button = document.getElementById(COMMENT_BUTTON_ID);
    if (!button) return;
    button.setAttribute("aria-expanded", String(open));
    const icon = button.querySelector("svg");
    if (icon) icon.style.color = open ? COLOR_LOOPING : COLOR_DEFAULT;
  }

  const handleCommentPanelOpenState = (event) => {
    updateCurrentCommentButton(Boolean(event?.detail?.open));
  };
  window.addEventListener(COMMENT_PANEL_OPEN_STATE_EVENT, handleCommentPanelOpenState);

  const uiObserver = new MutationObserver(() => {
    const controls    = document.querySelector(SELECTOR_STANDARD);
    const episodeBtn  = document.querySelector(SELECTOR_EPISODE);
    const subtitleBtn = document.querySelector(SELECTOR_SUBTITLE);

    const loopBtnExists = document.getElementById(BUTTON_ID);
    const nextBtnExists = document.getElementById(NEXT_BUTTON_ID);
    const commentBtnExists = document.getElementById(COMMENT_BUTTON_ID);

    if (
      controls &&
      !loopBtnExists &&
      !nextBtnExists &&
      !commentBtnExists &&
      (episodeBtn || subtitleBtn)
    ) {
      const anchorBtn = episodeBtn || subtitleBtn;

      const { btn: loopButton, svg: loopSvg } = createLoopButton();
      const { btn: playNextButton, svg: playSvg } = createPlayNextClipButton();
      const { btn: commentButton, svg: commentSvg } = createCommentButton();

      loopButton.className     = anchorBtn.className;
      playNextButton.className = anchorBtn.className;
      commentButton.className  = anchorBtn.className;
      markExtUi(loopButton);
      markExtUi(playNextButton);
      markExtUi(commentButton);

      loopSvg.style.color = isLooping ? COLOR_LOOPING : COLOR_DEFAULT;
      playSvg.style.color = togglekey ? COLOR_LOOPING : COLOR_DEFAULT;
      commentSvg.style.color = isCommentPanelOpen() ? COLOR_LOOPING : COLOR_DEFAULT;

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
      wrapper.appendChild(commentButton);

      anchorBtn.parentNode.after(wrapper);

      const spacer = document.createElement("div");
      spacer.style.minWidth = "3rem";
      anchorBtn.parentNode.after(spacer);
    }

    if (!document.querySelector(SELECTOR_FWD10)) {
      document.getElementById(BUTTON_ID)?.remove();
      document.getElementById(NEXT_BUTTON_ID)?.remove();
      document.getElementById(COMMENT_BUTTON_ID)?.remove();
    }
  });
  uiObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("beforeunload", () => {
    uiObserver.disconnect();
    window.removeEventListener(
      COMMENT_PANEL_OPEN_STATE_EVENT,
      handleCommentPanelOpenState
    );
  });

  // ---------------------------------------------------------------------------
  // サイドバー
  // ---------------------------------------------------------------------------
  function toggleSidebar() {
    const sb = document.getElementById(SIDEBAR_ID);
    sb?.dataset?.sidebarType === "clip-list" ? closeSidebar() : openSidebar();
  }

  function openSidebar() {
    const player = document.querySelector(".watch-video--player-view");
    if (!player) return;
    closeMemoSidebar();
    requestCloseCommentPanel();
    const originalPlayerWidth = player.style.width;
    player.style.transition = "width .3s";
    player.style.width = `calc(100% - ${SIDEBAR_PCT}%)`;

    const sb = document.createElement("div");
    sb.id = SIDEBAR_ID;
    sb.dataset.sidebarType = "clip-list";
    sb.dataset.originalPlayerWidth = originalPlayerWidth;
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
    closeMemoSidebar();
  }

  /**
   * @param {HTMLElement} container
   * @param {ClipListProps} props
   */
  function renderClipList(container, { items, onSelect }) {
    container.replaceChildren();
    for (const item of items) {
      const entry = document.createElement("div");
      entry.style.cssText = "border-bottom:1px solid #555;padding:4px 0;";
      // API 由来の文字列を扱うため innerHTML は使わない (refs #97)
      const heading = document.createElement("div");
      const headingText = document.createElement("strong");
      headingText.textContent = `${item.title}（${item.epnumber}）`;
      heading.appendChild(headingText);
      const userRow = document.createElement("div");
      userRow.textContent = `ユーザー: ${item.user}`;
      const rangeRow = document.createElement("div");
      rangeRow.textContent = `範囲: ${formatTime(item.startTime)} - ${formatTime(item.endTime)}`;
      entry.append(heading, userRow, rangeRow);
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
    } catch {
      container.textContent = "データの取得に失敗しました。";
      console.error("API取得に失敗しました");
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
      const ownerNonce = createPlaybackOwnerNonce();
      await commitSelectedClip({
        data,
        requestedClipId: clipId,
        ownerNonce,
        storage: {
          async set(snapshot) {
            const handoff = await beginPlaybackHandoff({
              nonce: ownerNonce,
              mode: 'clip',
              clipId: snapshot.currentClipId,
              snapshot
            });
            if (!handoff?.ok) {
              throw new Error('Playback handoff registration failed');
            }
          }
        },
        setCookies: setClipDataOnCookies,
        openClip: (selectedClip) => redirectToClip(selectedClip, ownerNonce)
      });
    } catch (err) {
      console.error("クリップ選択処理でエラーが発生しました");
      const unsupported = err?.message?.includes('invalid_service');
      window.alert(
        unsupported
          ? 'このクリップの配信サービスには対応していません。'
          : 'クリップを開けませんでした。時間をおいて再度お試しください。'
      );
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

  function redirectToClip({ url, service, startTime }, ownerNonce) {
    if (!url || !service) {
      alert("URL または サービス情報が不正です");
      return;
    }
    const finalUrl = buildServiceUrl(service, url, Math.floor(startTime), "t");
    if (!finalUrl) {
      alert(`未対応のサービス: ${service}`);
      return;
    }
    window.open(addPlaybackOwnerToUrl(finalUrl, ownerNonce), "_blank");
  }

  // ---------------------------------------------------------------------------
  // Clip再生モード
  // ---------------------------------------------------------------------------
  function loadClipFromSession(session) {
    const snapshot = session?.snapshot;
    if (session?.context?.mode !== 'clip' || snapshot?.playClipSystemKey !== 1 || !snapshot.clip) {
      clipData = null;
      clearPlaybackContext();
      return false;
    }
    clipData = {
      startTime: Number(snapshot.clip.startTime ?? snapshot.clip.starttime),
      endTime: Number(snapshot.clip.endTime ?? snapshot.clip.endtime),
      title: snapshot.clip.title,
      clipId: snapshot.clip.clipId ?? snapshot.clip.id
    };
    console.info('[Clip] loaded');
    return true;
  }

  async function waitForVideoElement(generation) {
    cancelPendingVideoWait?.();
    const wait = createElementWait('video');
    cancelPendingVideoWait = wait.cancel;
    try {
      const player = await wait.promise;
      return generation === playbackGeneration ? player : null;
    } finally {
      if (cancelPendingVideoWait === wait.cancel) {
        cancelPendingVideoWait = null;
      }
    }
  }

  async function init(session) {
    try {
      const loaded = loadClipFromSession(session);
      if (!loaded) return;
      const generation = playbackGeneration;
      const player = await waitForVideoElement(generation);
      if (!player || generation !== playbackGeneration || !clipData) return;
      videoPlayer = player;
      setupPlayer("clip");
    } catch {
      console.error('[Clip] Initialization failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Playlist再生モード
  // ---------------------------------------------------------------------------
  async function startPlaylistMode(session) {
      let { playQueue, currentClipOrder } = session?.snapshot || {};
      if (session?.context?.mode !== 'playlist') return;
      if (!Array.isArray(playQueue) || playQueue.length === 0) {
        clearPlaybackContext();
        console.warn("[Playlist] playQueue が存在しません");
        return;
      }
      playQueue = [...playQueue].sort((a, b) => a.order - b.order);
      const order = Number.isInteger(currentClipOrder) ? currentClipOrder : 0;
      const currentClip = playQueue.find(c => c.order === order);
      if (!currentClip) {
        clearPlaybackContext();
        console.warn("[Playlist] 該当clipが見つかりません:", order);
        return;
      }
      activePlaylistQueue = playQueue;
      activePlaylistOrder = currentClip.order;
      clipData = {
        startTime: Number(currentClip.startTime ?? currentClip.starttime),
        endTime:   Number(currentClip.endTime   ?? currentClip.endtime),
        title:     currentClip.clipname
      };
      const generation = playbackGeneration;
      const player = await waitForVideoElement(generation);
      if (!player || generation !== playbackGeneration || !clipData) return;
      videoPlayer = player;
      setupPlayer("playlist");
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

    const transitioned = await transitionPlaybackSession('playlist', next, {
      playQueue: sortedQueue,
      currentClipOrder: next.order,
      currentClipId: next.clipId ?? next.id,
      nextClip: next,
      playClipSystemKey: 0,
      playlistSystemKey: 1,
      playmode: 'playlist'
    });
    if (!transitioned) return;
    activePlaylistQueue = sortedQueue;
    activePlaylistOrder = next.order;

    clipData = {
      startTime: Number(next.startTime ?? next.starttime),
      endTime:   Number(next.endTime   ?? next.endtime),
      title:     next.clipname,
    };

    await handleClipTransition({
      currentUrl: current.url,
      nextUrl: next.url,

      onSameUrl: async () => {
        const transitionGeneration = playbackGeneration;
        startUIWarmer();
        const targetTime = Math.floor(next.startTime);

        for (;;) {
          if (transitionGeneration !== playbackGeneration) return;
          try {
            await requestSeek({ service: 'Netflix', seconds: targetTime });
          } catch (err) {
            console.warn("[Playlist] seekメッセージ送信失敗:", err);
          }

          await new Promise(r => setTimeout(r, 300));
          if (transitionGeneration !== playbackGeneration) return;

          const currentSec = Math.floor(videoPlayer?.currentTime ?? 0);
          if (Math.abs(currentSec - targetTime) <= 1) {
            stopUIWarmer();
            break;
          }
        }

        if (transitionGeneration !== playbackGeneration || !clipData) return;
        monitorClipEnd(clipData.endTime, clipData.startTime, "playlist");
        startCountdownLogger(clipData.endTime);
      },

      onDifferentUrl: async () => {
        const targetUrl = buildServiceUrl(
          next.service,
          next.url,
          Math.floor(next.startTime),
          't'
        );
        if (!targetUrl) {
          deactivatePlaybackContext();
          return;
        }
        const url = addPlaybackOwnerToUrl(targetUrl, activePlaybackOwnerNonce);
        const prepared = await preparePlaybackNavigation(
          activePlaybackOwnerNonce,
          url
        );
        if (!prepared?.ok) {
          deactivatePlaybackContext();
          return;
        }
        const marked = markAutoNavigation({
          ownerNonce: activePlaybackOwnerNonce,
          expectedRoute: routeIdentity(url),
          reason: 'playlist',
        });
        if (!marked) {
          deactivatePlaybackContext();
          return;
        }
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
      console.warn("[Clip] clipDataの時間が不正です");
      return;
    }

    // 差し替え後のプレイヤーにはメタデータがある一方、旧要素はまだ待機中の場合がある。
    // readyState分岐の前に古いリスナーを外し、後から旧監視処理を開始しないようにする。
    removePendingMetadataListener?.();
    removePendingMetadataListener = null;

    const setupGeneration = playbackGeneration;
    const onReady = () => {
      removePendingMetadataListener = null;
      if (setupGeneration !== playbackGeneration || !clipData) return;
      monitorClipEnd(end, start, mode);
      startCountdownLogger(end);
    };

    if (videoPlayer.readyState >= 1) {
      onReady();
    } else {
      const metadataPlayer = videoPlayer;
      const removeMetadataListener = () =>
        metadataPlayer.removeEventListener('loadedmetadata', onReady);
      removePendingMetadataListener = removeMetadataListener;
      metadataPlayer.addEventListener('loadedmetadata', onReady, { once: true });
    }

    removeVideoErrorListener?.();
    const errorPlayer = videoPlayer;
    const onVideoError = () => console.error('[Video] playback error');
    const removeErrorListener = () => {
      errorPlayer.removeEventListener('error', onVideoError);
      if (removeVideoErrorListener === removeErrorListener) {
        removeVideoErrorListener = null;
      }
    };
    errorPlayer.addEventListener('error', onVideoError);
    removeVideoErrorListener = removeErrorListener;
  }

  function monitorClipEnd(end, start, mode /* "clip" | "playlist" */) {
    stopClipEndMonitor?.();
    const monitoredPlayer = videoPlayer;
    let stopped = false;
    const stopMonitor = () => {
      if (stopped) return;
      stopped = true;
      monitoredPlayer?.removeEventListener("timeupdate", onTimeUpdate);
      if (stopClipEndMonitor === stopMonitor) stopClipEndMonitor = null;
    };
    stopClipEndMonitor = stopMonitor;

    function onTimeUpdate() {
      if (monitoredPlayer.currentTime + EPSILON >= end) {
        console.info("[Clip] Reached end");
        stopMonitor();
        clearInterval(countdownIntervalId);

        if (mode === "playlist") {
          if (Array.isArray(activePlaylistQueue)) {
            void playlistNextClip(
              activePlaylistQueue,
              activePlaylistOrder ?? 0
            );
          } else {
            console.warn("[Playlist] playQueue が無効。playlist終了");
          }
        } else {
          try {
            requestSeek({ service: 'Netflix', seconds: start, videoElement: videoPlayer });
          } catch {
            try { videoPlayer.currentTime = start; videoPlayer.play?.(); } catch {}
          }
          monitorClipEnd(end, start, mode);
          startCountdownLogger(end);
        }
      }
    }
    monitoredPlayer.addEventListener("timeupdate", onTimeUpdate);
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
    const ownerNonce = getTabPlaybackOwnerNonce();
    const session = await claimPlaybackSession(ownerNonce);
    if (!session) return;
    if (session.context.mode === 'playlist') {
      await startPlaylistMode(session);
    } else if (session.context.mode === 'clip') {
      await init(session);
    }
  });

  // ---------------------------------------------------------------------------
  // 離脱処理
  // ---------------------------------------------------------------------------
  window.addEventListener("beforeunload", () => {
    playbackGeneration += 1;
    stopPlaybackRuntime();
    clearPlaybackContext();
    closeCommentPanel();
  });
}

initializeNetflixPlayback();

function routeIdentity(url) {
  return normalizePlaybackRoute(url, location.href) || String(url || '');
}
