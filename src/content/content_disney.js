import { detectService, openMemoSidebar, sendData } from './common.js';
(() => {
  const PLAYER_CONTROLS_SELECTOR = '.controls__footer__wrapper';
  const LEFT_CONTROLS_SELECTORS = [
    '.controls__left',
    '.controls__footer__left',
    '.controls__column--left'
  ];
  const RIGHT_CONTROLS_SELECTORS = [
    '.controls__right',
    '.controls__footer__right',
    '.controls__column--right'
  ];
  const HOST_IDS = {
    left: 'dext-control-host-left',
    right: 'dext-control-host-right'
  };
  const STYLE_ID = 'dext-control-style';
  const HISTORY_HOOK_FLAG = '__dext_history_hooked__';

  const BUTTONS = [
    { id: 'dext-left-button', area: 'left', label: 'Left Button', action: myCustomActionLeft },
    { id: 'dext-right-button-1', area: 'right', label: 'Right Button 1', action: myCustomActionRight1 },
    { id: 'dext-right-button-2', area: 'right', label: 'Right Button 2', action: myCustomActionRight2 }
  ];


  let observer = null;
  let injectionScheduled = false;

  // Playlist mode state for Disney+
  const PLAYLIST_CHECK_INTERVAL_MS = 300;
  const PLAYLIST_END_CHECK_INTERVAL_MS = 250;
  let playlistState = {
    playlist: [],
    currentIndex: 0,
    startTimerId: null,
    endTimerId: null,
    isRunning: false,
  };

  function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* --- Disney+ 風にクリックが通る構造 --- */
    .dext-button-container.button-container {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 18px;
      cursor: pointer;
      background: rgba(3, 37, 65, 0.8);
      transition: background 160ms ease, transform 160ms ease;
      pointer-events: auto; /* ←クリック通す */
      position: relative;
      z-index: 9999;        /* ←上に出したい場合 */
    }

    .dext-button-container.button-container:hover {
      background: rgba(3, 37, 65, 1);
      transform: translateY(-1px);
    }

    .dext-button-container.button-container:active {
      transform: translateY(0);
    }

    .dext-button-container.button-container:focus-visible {
      outline: 2px solid rgba(255,255,255,0.7);
      outline-offset: 2px;
    }

    /* 内側のダミーアイコン（Disney+は button.control を置いてる） */
    .dext-control.control {
      all: unset;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #fff; /* ←ここで丸アイコン色を調整 */
      flex: 0 0 18px;
    }

    /* テキストラベル */
    .dext-button-label {
      color: #ffffff;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: .02em;
      user-select: none;
    }

    /* ホスト領域（左右にまとめる） */
    .dext-host {
      display: inline-flex;
      gap: 8px;
      align-items: center;
    }
    .dext-host.dext-host--right {
      justify-content: flex-end;
    }

    .dext-button-container.button-container.active {
    background: rgba(200, 50, 50, 0.9); /* 赤系に変更例 */
}

  `;

  (document.head || document.documentElement).appendChild(style);
}


  function querySelectorFromList(root, selectors) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node) {
        return node;
      }
    }
    return null;
  }

  function ensureHost(area, controls) {
    const hostId = HOST_IDS[area];
    let host = document.getElementById(hostId);

    if (host && controls.contains(host)) {
      return host;
    }

    if (host && host.parentNode) {
      host.parentNode.removeChild(host);
    }

    host = document.createElement('div');
    host.id = hostId;
    host.className = `dext-host dext-host--${area}`;

    const selectors = area === 'left' ? LEFT_CONTROLS_SELECTORS : RIGHT_CONTROLS_SELECTORS;
    const targetContainer = querySelectorFromList(controls, selectors) || controls;
    targetContainer.appendChild(host);

    return host;
  }
    
  function addButton(config, host) {
    // これまでの「button要素にid」をやめて、コンテナにidを付けます
    let container = document.getElementById(config.id);

    if (!container || !host.contains(container)) {
      if (container && container.parentNode) container.parentNode.removeChild(container);

      // Disney+ に寄せた構造: [div.button-container(tabindex=0, role="button")] ＞ [button.control] ＋ [span.label]
      container = document.createElement('div');
      container.id = config.id;
      container.className = 'dext-button-container button-container';
      container.setAttribute('role', 'button');
      container.tabIndex = 0; // キーボード対応

      // 内側のダミーbutton（Disney+は内側buttonに .control を置いている）
      const innerBtn = document.createElement('button');
      innerBtn.className = 'dext-control control';
      innerBtn.tabIndex = -1;
      innerBtn.setAttribute('aria-hidden', 'true');

      // ラベル
      const label = document.createElement('span');
      label.className = 'dext-button-label';
      label.textContent = config.label;

      container.append(innerBtn, label);

      // クリック＆キーボードで発火（captureも保険で使用）
      const onActivate = (e) => {
        if (typeof config.action === 'function') {
          config.action();   // ボタンごとに関数を実行
        }
        container.classList.toggle('active');
        e.stopPropagation();                  // 他のハンドラに奪われないように
      };

      container.addEventListener('click', onActivate, { capture: true });
      container.addEventListener('pointerdown', (e) => {
        // 一部サイトはpointerdownで奪うので、先に捕まえておく
        e.stopPropagation();
      }, { capture: true });

      container.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate(e);
        }
      });

      host.appendChild(container);
    }

    return container;
  }


  const DPlusTime = (() => {

    function formatTime(sec) {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;

      return h > 0
        ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
        : `${m}:${String(s).padStart(2, "0")}`;
    }

    function getThumb() {
      const el = document.querySelector("progress-bar");
      return el?.shadowRoot?.querySelector(".progress-bar__thumb") || null;
    }

    function getTime() {
      const thumb = getThumb();
      if (!thumb) return null;

      const current = Number(thumb.getAttribute("aria-valuenow"));
      const total   = Number(thumb.getAttribute("aria-valuemax"));

      if (!Number.isFinite(current) || !Number.isFinite(total)) return null;

      return {
        currentSeconds: current,
        totalSeconds  : total,
        currentTime   : formatTime(current),
        totalTime     : formatTime(total),
        progress      : ((current / total) * 100).toFixed(2) + "%"
      };
    }

    function log() {
      const t = getTime();
      if (!t) {
        console.warn("[Disney+] 再生時間を取得できません");
        return;
      }

      console.table(t);
    }

    return {
      get: getTime,
      log: log
    };

  })();


  let clickStateLeft = 0;
  let starttime = null; 
  function myCustomActionLeft() {
    clickStateLeft++;

    if (clickStateLeft === 1) {
      starttime = DPlusTime.get()?.currentSeconds;
      console.log("【1回目】開始時間:", starttime);
      return;
    }

    if (clickStateLeft === 2) {
      const t = DPlusTime.get();
      const endtime = t?.currentSeconds;

      const videoPlayer = document.querySelector('video');
      videoPlayer?.pause();

      console.log("【2回目】終了時間:", endtime);

      const urldata = location.href;
      const title = document.querySelector(".title-bug-container .title-field span")?.textContent.trim() || "";
      const subtitle = document.querySelector(".title-bug-container .subtitle-field span")?.textContent.trim() || "";

      const clipName = `${title}${subtitle ? `｜${subtitle}` : ""}`;

      console.log("start:", starttime, "end:", endtime);
      console.log("url:", urldata);

      const payload = {
        clipName: clipName,
        user: "testUser",
        service: detectService(),
        StartTime: starttime,   // Netflix 形式に合わせる
        EndTime: endtime,       // Netflix 形式に合わせる
        URL: urldata,               // Netflix 形式に合わせる
        title: title,
        epnumber: subtitle,
      };

      openMemoSidebar({
        data: payload,
        videoPlayer,
        onSave: (data) => sendData(data),
        sidebarTitle: "Clipを追加 - Disney+",
      });


      clickStateLeft = 0;
    }
  }

  function myCustomActionRight1() {
    console.log("右ボタン1の本処理を実行！");
  }

  function myCustomActionRight2() {
    console.log("右ボタン2の本処理を実行！");
  }

  function injectButtons() {
    const controls = document.querySelector(PLAYER_CONTROLS_SELECTOR);
    if (!controls) {
      return;
    }

    ensureStyle();

    const hosts = {
      left: ensureHost('left', controls),
      right: ensureHost('right', controls)
    };

    for (const config of BUTTONS) {
      const host = hosts[config.area];
      if (!host) {
        continue;
      }
      addButton(config, host);
    }
  }

  function scheduleInjection() {
    if (injectionScheduled) {
      return;
    }

    injectionScheduled = true;
    requestAnimationFrame(() => {
      injectionScheduled = false;
      injectButtons();
    });
  }

  function startObserver() {
    if (observer) {
      return;
    }

    observer = new MutationObserver(() => scheduleInjection());

    const attach = () => {
      if (!document.body) {
        requestAnimationFrame(attach);
        return;
      }

      observer.observe(document.body, { childList: true, subtree: true });
    };

    attach();
  }

  function hookHistory() {
    if (window[HISTORY_HOOK_FLAG]) {
      return;
    }

    window[HISTORY_HOOK_FLAG] = true;

    const dispatch = () => window.dispatchEvent(new Event('locationchange'));

    for (const type of ['pushState', 'replaceState']) {
      const original = history[type];
      if (typeof original !== 'function') {
        continue;
      }

      history[type] = function historyPatched() {
        const result = original.apply(this, arguments);
        dispatch();
        return result;
      };
    }

    window.addEventListener('popstate', dispatch);
  }

  function bootstrap() {
    hookHistory();
    startObserver();
    scheduleInjection();
  }

  async function init() {
    console.log("disneyplus content.js init()");

    const { playClipSystemKey, clip } = await chrome.storage.local.get([
      'playClipSystemKey',
      'clip'
    ]);

    if (playClipSystemKey !== 1 || !clip) {
      console.log('[Clip] No clip data or disabled');
      return;
    }

    const clipData = {
      startTime: Number(clip.startTime ?? clip.starttime),
      endTime:   Number(clip.endTime   ?? clip.endtime),
      title:     String(clip.title || '')
    };

    console.log('[Clip] Playing clip:', clipData);

    // ① 再生開始位置へ移動（成功するまで再試行）
    const startTimer = setInterval(() => {
      const t = DPlusTime.get();
      if (!t) {
        console.log("再生時間を再チェックします...");
        return;
      }

      console.log("再生時間を取得:", t);
      seekDisney(clipData.startTime);

      clearInterval(startTimer);

      console.log("[Clip] Start position reached. Begin end-monitoring.");

      // ② 終了監視を開始
      startEndMonitor(clipData);

    }, 100);
  }

  /**
   * endTime に到達したら次の処理へ
   */
  function startEndMonitor(clipData) {
    const endTimer = setInterval(() => {
      const t = DPlusTime.get();
      if (!t) return;

      if (t.currentSeconds >= clipData.endTime) {
        console.log("[Clip] End reached:", t.currentSeconds, "/", clipData.endTime);

        clearInterval(endTimer);

        // ★ここで次のクリップへ行く or clip 終了 or playlist ロジック
        // 今回は「init を再実行するタイプ」なら以下
        init(); // ← ループ動作
      }

    }, 500); // 1秒で十分
  }

  function clearPlaylistTimers() {
    if (playlistState.startTimerId) {
      clearInterval(playlistState.startTimerId);
      playlistState.startTimerId = null;
    }

    if (playlistState.endTimerId) {
      clearInterval(playlistState.endTimerId);
      playlistState.endTimerId = null;
    }
  }

  function normalizePlaylistClip(raw) {
    return {
      id: raw?.id ?? raw?.clipId ?? null,
      startTime: Number(raw?.startTime ?? raw?.starttime),
      endTime: Number(raw?.endTime ?? raw?.endtime),
      title: String(raw?.title || raw?.clipname || ""),
    };
  }

  function finalizePlaylist() {
    clearPlaylistTimers();
    playlistState.isRunning = false;
    playlistState.playlist = [];
    playlistState.currentIndex = 0;
    chrome.storage.local.set({ playlistSystemKey: 0 }, () => {
      console.log("[Playlist] ✅ 全クリップの再生が完了しました");
    });
  }

  function advancePlaylistClip() {
    playlistState.currentIndex += 1;

    if (playlistState.currentIndex >= playlistState.playlist.length) {
      finalizePlaylist();
      return;
    }

    startPlaylistClip(playlistState.currentIndex);
  }

  function startPlaylistClip(index) {
    if (!playlistState.isRunning || !Array.isArray(playlistState.playlist)) {
      return;
    }

    clearPlaylistTimers();

    const clip = normalizePlaylistClip(playlistState.playlist[index]);

    if (!Number.isFinite(clip.startTime) || !Number.isFinite(clip.endTime)) {
      console.warn("[Playlist] ⚠️ クリップ時間が不正です", clip);
      advancePlaylistClip();
      return;
    }

    if (clip.startTime >= clip.endTime) {
      console.warn("[Playlist] ⚠️ startTime >= endTime のためスキップします", clip);
      advancePlaylistClip();
      return;
    }

    console.log(`[Playlist] ▶️ 開始: #${index + 1} ${clip.title || "(no title)"}`);

    playlistState.startTimerId = setInterval(() => {
      const t = DPlusTime.get();

      if (!t) {
        console.log("[Playlist] 再生位置を取得できません。リトライします…");
        return;
      }

      if (Number.isFinite(t.totalSeconds) && clip.startTime >= t.totalSeconds) {
        console.warn(`⚠️ startTime が総再生時間を超過 (${clip.startTime} >= ${t.totalSeconds})`);
        clearInterval(playlistState.startTimerId);
        playlistState.startTimerId = null;
        advancePlaylistClip();
        return;
      }

      if (Number.isFinite(t.totalSeconds) && clip.endTime > t.totalSeconds) {
        console.warn(`⚠️ endTime が総再生時間を超過 (${clip.endTime} > ${t.totalSeconds})`);
        clip.endTime = Math.min(clip.endTime, t.totalSeconds);
      }

      seekDisney(clip.startTime);

      clearInterval(playlistState.startTimerId);
      playlistState.startTimerId = null;

      monitorPlaylistClipEnd(clip);
    }, PLAYLIST_CHECK_INTERVAL_MS);
  }

  function monitorPlaylistClipEnd(clip) {
    playlistState.endTimerId = setInterval(() => {
      const t = DPlusTime.get();

      if (!t) {
        console.log("[Playlist] endTime監視: 再試行します");
        return;
      }

      if (t.currentSeconds >= clip.endTime) {
        console.log(`[Playlist] ⏹️ 終了: ${clip.title || "(no title)"}`);
        clearInterval(playlistState.endTimerId);
        playlistState.endTimerId = null;
        advancePlaylistClip();
      }
    }, PLAYLIST_END_CHECK_INTERVAL_MS);
  }

  async function initPlaylistMode() {
    clearPlaylistTimers();

    const { playlist } = await chrome.storage.local.get(["playlist"]);

    if (!Array.isArray(playlist) || playlist.length === 0) {
      console.warn("[Playlist] ⚠️ playlist が空または無効です");
      return;
    }

    playlistState = {
      ...playlistState,
      playlist,
      currentIndex: 0,
      isRunning: true,
      startTimerId: null,
      endTimerId: null,
    };

    console.log(`[Playlist] 🎬 Disney+ プレイリストモード開始 (全${playlist.length}件)`);
    startPlaylistClip(0);
  }

  function seekDisney(seconds) {
    const t = DPlusTime.get();
    const bar = document.querySelector("progress-bar");
    const root = bar?.shadowRoot;
    const seekable = root?.querySelector(".progress-bar__seekable-range");
    if (!seekable) return console.warn("seekable-range が見つからない");

    const rect = seekable.getBoundingClientRect();
    const ratio = seconds / t.totalSeconds;

    // クリック位置を算出
    const x = rect.left + rect.width * ratio;
    const y = rect.top + rect.height / 2;

    // イベント発火
    ["pointerdown", "pointerup"].forEach(type =>
      seekable.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          composed: true,
          cancelable: true,
          clientX: x,
          clientY: y
        })
      )
    );
  }

  window.addEventListener('beforeunload', () => clearPlaylistTimers());



  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }

  window.addEventListener('locationchange', () => scheduleInjection());
  window.addEventListener('load', () => scheduleInjection(), { once: true });
  window.addEventListener("load", async () => {
    chrome.storage.local.get(["playClipSystemKey", "playlistSystemKey"], async ({ playClipSystemKey, playlistSystemKey }) => {
      console.log("再生機能の起動キー:", playClipSystemKey);
      console.log("プレイリスト再生機能の起動キー:", playlistSystemKey);

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
        await initPlaylistMode();        // playlistモード起動
      } else {
        console.log("⏸ 再生機能は未活性、待機状態");
      }
    });
  });
})();
