import {
  clearAutoNavigation,
  detectService,
  isAutoNavigation,
  markAutoNavigation,
  openMemoSidebar,
  requestSeek,
  sendData
} from './common.js';
import { fetchSession, isLoggedIn } from '../auth/authClient.js'; // NOTE: authClient path is relative to src/content

(() => {
  const AUTO_NAV_STORAGE_KEY = 'autoNav';
  const AUTO_NAV_TTL_MS = 15000;
  const AUTH_MESSAGE_ID = 'mc-auth-message';
  let autoNavCache = null;
  let hasBootstrapped = false;
  let authInProgress = false;

  function showAuthMessage(message) {
    let container = document.getElementById(AUTH_MESSAGE_ID);

    if (!container) {
      container = document.createElement('div');
      container.id = AUTH_MESSAGE_ID;
      container.style.cssText = [
        'position: fixed',
        'top: 16px',
        'right: 16px',
        'z-index: 2147483647',
        'background: rgba(0, 0, 0, 0.85)',
        'color: #fff',
        'padding: 10px 14px',
        'border-radius: 6px',
        'font-size: 12px',
        'font-family: sans-serif'
      ].join(';');
      document.body.appendChild(container);
    }

    container.textContent = message;
  }

  function clearAuthMessage() {
    const container = document.getElementById(AUTH_MESSAGE_ID);
    if (container) {
      container.remove();
    }
  }

  async function requireAuthOrShowLogin() {
    if (authInProgress) return false;
    authInProgress = true;

    try {
      const session = await fetchSession();
      if (isLoggedIn(session)) {
        clearAuthMessage();
        authInProgress = false;
        return true;
      }
    } catch (error) {
      showAuthMessage(`Session check failed: ${error.message}`);
      authInProgress = false;
      return false;
    }

    showAuthMessage('ログインが必要です。ログインタブを開きます...');
    chrome.runtime.sendMessage({ type: 'AUTH_START' });
    authInProgress = false;
    return false;
  }

  async function ensureAuthAndBootstrap() {
    const ok = await requireAuthOrShowLogin();
    if (!ok) return;

    if (!hasBootstrapped) {
      startApp();
      hasBootstrapped = true;
    }
  }

  function isAutoNavValid(autoNav) {
    if (!autoNav || typeof autoNav !== 'object') return false;
    const ts = Number(autoNav.ts);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts <= AUTO_NAV_TTL_MS;
  }

  function isAutoNavActive() {
    return isAutoNavValid(autoNavCache);
  }

  async function loadAutoNav() {
    const { [AUTO_NAV_STORAGE_KEY]: autoNav } = await chrome.storage.local.get([
      AUTO_NAV_STORAGE_KEY
    ]);

    if (!isAutoNavValid(autoNav)) {
      if (autoNav) {
        await chrome.storage.local.remove(AUTO_NAV_STORAGE_KEY);
        clearAutoNavigation();
      }
      autoNavCache = null;
      return null;
    }

    autoNavCache = autoNav;
    return autoNav;
  }

  async function clearAutoNavState() {
    autoNavCache = null;
    clearAutoNavigation();
    await chrome.storage.local.remove(AUTO_NAV_STORAGE_KEY);
  }

  async function beginAutoNavigation({ mode, nextUrl, nextOrder, nextId }) {
    const autoNav = {
      ts: Date.now(),
      mode,
      nextUrl,
      nextOrder,
      nextId
    };

    autoNavCache = autoNav;
    markAutoNavigation(mode || 'auto');

    const update = { [AUTO_NAV_STORAGE_KEY]: autoNav };

    if (mode === 'playlist') {
      update.playClipSystemKey = 0;
      update.playlistSystemKey = 1;
      update.playmode = 'playlist';
    } else if (mode === 'clip') {
      update.playClipSystemKey = 1;
      update.playlistSystemKey = 0;
      update.playmode = 'clip';
    }

    if (Number.isFinite(nextOrder)) {
      update.currentClipOrder = nextOrder;
    }

    if (nextId !== undefined) {
      update.currentClipId = nextId;
    }

    await chrome.storage.local.set(update);
  }
  // === UI ===
  const UI = (() => {
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

    let clickStateLeft = 0;
    let starttime = null;
    function myCustomActionLeft() {
      clickStateLeft++;

      if (clickStateLeft === 1) {
        starttime = Service.DPlusTime.get()?.currentSeconds;
        console.log("【1回目】開始時間:", starttime);
        return;
      }

      if (clickStateLeft === 2) {
        const t = Service.DPlusTime.get();
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
      // loop toggle
      Mode.toggleLoop();
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

    return {
      bootstrap,
      scheduleInjection
    };
  })();

  // === Service ===
  const Service = (() => {
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

    function seek(seconds) {
      const t = DPlusTime.get();
      if (!t) return console.warn("再生時間が取得できません");
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

    return { DPlusTime, seek };
  })();

  const playerAdapter = {
    getTime: () => Service.DPlusTime.get(),
    seek: (seconds) => Service.seek(seconds)
  };

  // === Clip ===
  const Clip = (() => {
    let activeStopFn = null;

    function play(clipData, { onStart, onEnd } = {}) {
      stop();

      if (!clipData) {
        console.log('[Clip] No clip data provided');
        return () => {};
      }

      console.log('[Clip] Playing clip:', clipData);

      activeStopFn = startLifecycle(clipData, { onStart, onEnd });
      return activeStopFn;
    }

    function stop() {
      if (typeof activeStopFn === 'function') {
        activeStopFn();
      }
      activeStopFn = null;
    }

    function startLifecycle(clipData, { onStart, onEnd }) {
      const timers = { startTimer: null, endTimer: null };

      timers.startTimer = setInterval(() => {
        const t = playerAdapter.getTime();
        if (!t) {
          console.log("再生時間を再チェックします...");
          return;
        }

        console.log("再生時間を取得:", t);
        requestSeek({
          service: detectService(),
          seconds: clipData.startTime,
          adapter: playerAdapter
        });

        clearInterval(timers.startTimer);
        timers.startTimer = null;

        console.log("[Clip] Start position reached. Begin end-monitoring.");

        if (typeof onStart === 'function') {
          onStart(clipData);
        }

        timers.endTimer = startEndMonitor(clipData, onEnd);

      }, 100);

      return () => stopTimers(timers);
    }

    /**
     * endTime に到達したら終了通知
     */
    function startEndMonitor(clipData, onEnd) {
      const endTimer = setInterval(() => {
        const t = playerAdapter.getTime();
        if (!t) return;

        if (t.currentSeconds >= clipData.endTime) {
          console.log("[Clip] End reached:", t.currentSeconds, "/", clipData.endTime);

          clearInterval(endTimer);

          if (typeof onEnd === 'function') {
            onEnd(clipData);
          }
        }

      }, 500); // 1秒で十分

      return endTimer;
    }

    function stopTimers(timers) {
      if (timers.startTimer) {
        clearInterval(timers.startTimer);
        timers.startTimer = null;
      }

      if (timers.endTimer) {
        clearInterval(timers.endTimer);
        timers.endTimer = null;
      }
    }

    return { play, stop };
  })();

  function normalizeClipData(clip) {
    if (!clip) return null;
    return {
      startTime: Number(clip.startTime ?? clip.starttime),
      endTime: Number(clip.endTime ?? clip.endtime),
      title: String(clip.clipname ?? clip.title ?? ''),
      url: clip.url ?? clip.URL ?? clip.Url ?? ''
    };
  }

  function normalizeClipUrl(clip) {
    return clip?.url ?? clip?.URL ?? clip?.Url ?? '';
  }

  function buildClipUrl(url, startTime) {
    if (!url) return '';
    const base = url.startsWith('http') ? url : new URL(url, location.origin).toString();
    const target = new URL(base);
    target.searchParams.set('t', Math.floor(startTime || 0).toString());
    return target.toString();
  }

  // === Playlist ===
  const Playlist = (() => {
    const state = {
      clips: [],
      index: 0,
      stopClip: null,
      loop: false
    };

    function loadClips(clips) {
      state.clips = Array.isArray(clips) ? clips : [];
      state.index = 0;
    }

    function currentClip() {
      return state.clips[state.index] || null;
    }

    function play(clips, options = {}) {
      stop();
      if (clips) {
        loadClips(clips);
      }

      state.loop = Boolean(options.loop);
      const callbacks = {
        onStart: options.onStart,
        onEnd: options.onEnd
      };

      const clipData = currentClip();
      if (!clipData) {
        console.log('[Playlist] No clips to play');
        return () => {};
      }

      state.stopClip = Clip.play(clipData, {
        onStart: callbacks?.onStart,
        onEnd: () => handleClipEnd(callbacks)
      });

      return stop;
    }

    function handleClipEnd(callbacks) {
      const endedClip = currentClip();

      if (typeof callbacks?.onEnd === 'function') {
        callbacks.onEnd(endedClip);
      }

      const nextClip = advance();
      if (!nextClip) {
        if (state.loop) {
          state.index = 0; // loop playback
          const loopClip = currentClip();
          if (loopClip) {
            state.stopClip = Clip.play(loopClip, {
              onStart: callbacks?.onStart,
              onEnd: () => handleClipEnd(callbacks)
            });
          }
        } else {
          stop();
        }
        return;
      }

      state.stopClip = Clip.play(nextClip, {
        onStart: callbacks?.onStart,
        onEnd: () => handleClipEnd(callbacks)
      });
    }

    function advance() {
      if (state.index + 1 >= state.clips.length) {
        return null;
      }

      state.index += 1;
      return currentClip();
    }

    function stop() {
      if (typeof state.stopClip === 'function') {
        state.stopClip();
      }
      state.stopClip = null;
      state.loop = false;
    }

    return {
      play,
      stop
    };
  })();

  // === Mode ===
  const Mode = (() => {
    let stopCurrent = null;
    let loopEnabled = false; // loop state

    async function loadClipData() {
      const { playClipSystemKey, clip } = await chrome.storage.local.get([
        'playClipSystemKey',
        'clip'
      ]);

      if (playClipSystemKey !== 1 || !clip) {
        console.log('[Clip] No clip data or disabled');
        return null;
      }

      return {
        startTime: Number(clip.startTime ?? clip.starttime),
        endTime:   Number(clip.endTime   ?? clip.endtime),
        title:     String(clip.title || '')
      };
    }

    async function startClipMode() {
      const clipData = await loadClipData();
      if (!clipData) return;

      await chrome.storage.local.set({ playClipSystemKey: 1, playlistSystemKey: 0, playmode: "clip" });
      stopCurrent = Playlist.play([clipData], { loop: loopEnabled });
    }

    async function loadPlaylistClip() {
      const { playQueue, currentClipOrder } = await chrome.storage.local.get([
        'playQueue',
        'currentClipOrder'
      ]);

      if (!Array.isArray(playQueue) || playQueue.length === 0) {
        console.warn('⚠️ playQueue が存在しません');
        return null;
      }

      const order = Number.isInteger(currentClipOrder) ? currentClipOrder : 0;
      const currentClip = playQueue.find((clip) => clip.order === order) ?? playQueue[0];

      if (!currentClip) {
        console.warn('⚠️ 該当clipが見つかりません:', order);
        return null;
      }

      return {
        startTime: Number(currentClip.startTime ?? currentClip.starttime),
        endTime:   Number(currentClip.endTime   ?? currentClip.endtime),
        title:     String(currentClip.clipname || currentClip.title || '')
      };
    }

async function startPlaylistMode() {
  stopActiveMode();

  await chrome.storage.local.set({ playClipSystemKey: 0, playlistSystemKey: 1, playmode: "playlist" });

  const { playQueue, currentClipOrder } = await chrome.storage.local.get([
    'playQueue',
    'currentClipOrder'
  ]);

  if (!Array.isArray(playQueue) || playQueue.length === 0) {
    console.warn('[Playlist] playQueue が存在しません');
    return;
  }

  const sortedQueue = [...playQueue].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const fallbackOrder = sortedQueue[0]?.order ?? 0;

  const order = Number.isInteger(currentClipOrder) ? currentClipOrder : fallbackOrder;
  const currentClip = sortedQueue.find((clip) => clip.order === order) || sortedQueue[0];

  if (!currentClip) {
    console.warn('[Playlist] 該当clipが見つかりません:', order);
    return;
  }

  if (currentClipOrder !== currentClip.order) {
    await chrome.storage.local.set({ currentClipOrder: currentClip.order });
  }

  await chrome.storage.local.set({ currentClipId: currentClip.id });

  const clipData = normalizeClipData(currentClip);
  if (!clipData) return;

  playPlaylistClip(clipData);

  function playPlaylistClip(clipData) {
    stopCurrent = Clip.play(clipData, {
      onEnd: handlePlaylistEnd
    });
  }

  function handlePlaylistEnd() {
    chrome.storage.local.get(['playQueue', 'currentClipOrder'], (res) => {
      const { playQueue, currentClipOrder } = res;
      if (Array.isArray(playQueue)) {
        playlistNextClip(playQueue, currentClipOrder ?? fallbackOrder);
      } else {
        console.warn('[Playlist] playQueue が無効。playlist終了');
        chrome.storage.local.set({ playlistSystemKey: 0 });
      }
    });
  }

  async function playlistNextClip(playQueue, currentOrder) {
    const sortedQueue = [...playQueue].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const currentIndex = sortedQueue.findIndex((clip) => clip.order === currentOrder);

    if (currentIndex === -1) {
      console.warn('[Playlist] 現在のclipが見つかりません:', currentOrder);
      return;
    }

    const current = sortedQueue[currentIndex];
    const isLast = currentIndex === sortedQueue.length - 1;

    // 最終clipは先頭へ戻る
    if (isLast && !loopEnabled) {
      console.log('[Playlist] 最終clip。先頭に戻ります');
    }

    const next = isLast ? sortedQueue[0] : sortedQueue[currentIndex + 1];
    const nextOrder = next.order ?? 0;
    const nextId = next.id;

    await chrome.storage.local.set({
      currentClipOrder: nextOrder,
      currentClipId: nextId
    });

    const nextClipData = normalizeClipData(next);
    if (!nextClipData) {
      console.warn('[Playlist] 次クリップのデータが不正です:', next);
      return;
    }

    const currentUrl = normalizeClipUrl(current);
    const nextUrl = normalizeClipUrl(next);

    if (currentUrl && nextUrl && currentUrl !== nextUrl) {
      const url = buildClipUrl(nextUrl, nextClipData.startTime);
      console.log('[Playlist] 異なるURL → ページ遷移:', url);
      if (!url) return;

      setTimeout(async () => {
        await beginAutoNavigation({
          mode: 'playlist',
          nextUrl: url,
          nextOrder,
          nextId
        });
        window.location.href = url;
      }, 150);
      return;
    }

    playPlaylistClip(nextClipData);
  }
}


    function resolvePlayMode(playmode, playClipSystemKey, playlistSystemKey) {
      if (playmode === 'playlist' || playmode === 'clip') {
        return playmode;
      }

      if (playClipSystemKey === 1 && playlistSystemKey === 1) {
        return 'clip';
      }

      if (playClipSystemKey === 1) {
        return 'clip';
      }

      if (playlistSystemKey === 1) {
        return 'playlist';
      }

      return null;
    }

    async function startPreferredMode() {
      const autoNav = await loadAutoNav();
      if (autoNav?.mode === 'playlist') {
        console.log('[AutoNav] Restore playlist:', autoNav);
        await chrome.storage.local.set({ playClipSystemKey: 0, playlistSystemKey: 1, playmode: 'playlist' });
        await startPlaylistMode();
        await clearAutoNavState();
        return;
      }

      if (autoNav?.mode === 'clip') {
        console.log('[AutoNav] Restore clip:', autoNav);
        await chrome.storage.local.set({ playClipSystemKey: 1, playlistSystemKey: 0, playmode: 'clip' });
        await startClipMode();
        await clearAutoNavState();
        return;
      }

      if (autoNav) {
        console.warn('[AutoNav] Unknown mode, clearing:', autoNav);
        await clearAutoNavState();
      }

      const { playClipSystemKey, playlistSystemKey, playmode } = await chrome.storage.local.get([
        'playClipSystemKey',
        'playlistSystemKey',
        'playmode'
      ]);

      const resolvedMode = resolvePlayMode(playmode, playClipSystemKey, playlistSystemKey);

      console.log("再生機能の起動キー:", playClipSystemKey);
      console.log("プレイリスト再生機能の起動キー:", playlistSystemKey);

      if (resolvedMode === 'playlist') {
        await chrome.storage.local.set({ playClipSystemKey: 0, playlistSystemKey: 1, playmode: 'playlist' });
        await startPlaylistMode();
        return;
      }

      if (resolvedMode === 'clip') {
        if (playClipSystemKey === 1 && playlistSystemKey === 1 && !playmode) {
          console.warn("⚠️ 両モードがON。Clipを優先して矯正します。");
        }

        await chrome.storage.local.set({ playClipSystemKey: 1, playlistSystemKey: 0, playmode: 'clip' });
        await startClipMode();
        return;
      }

      console.log("⏸ 再生機能は未活性、待機状態");
    }

    function stopActiveMode() {
      if (typeof stopCurrent === 'function') {
        stopCurrent();
      }
      stopCurrent = null;
    }

    async function toggleLoop() {
      loopEnabled = !loopEnabled;
      if (loopEnabled) {
        console.log('[Loop] ON');
        stopActiveMode();
        const clipData = await loadClipData();
        if (!clipData) {
          loopEnabled = false;
          return;
        }
        stopCurrent = Playlist.play([clipData], { loop: loopEnabled });
      } else {
        console.log('[Loop] OFF - stop playback');
        stopActiveMode();
      }
    }

    function bootstrap() {
      window.addEventListener('load', () => {
        stopActiveMode();
        startPreferredMode();
      });
    }

    return {
      bootstrap,
      toggleLoop
    };
  })();

  function startApp() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', UI.bootstrap, { once: true });
    } else {
      UI.bootstrap();
    }

    Mode.bootstrap();

    window.addEventListener('locationchange', () => UI.scheduleInjection());
    window.addEventListener('load', () => UI.scheduleInjection(), { once: true });

    window.addEventListener('beforeunload', () => {
      const autoFlag = isAutoNavigation();
      const autoStored = isAutoNavActive();

      if (autoFlag || autoStored) {
        console.log(`▶️ 自動遷移検知：beforeunloadでのリセットをスキップ (flag=${autoFlag}, storage=${autoStored})`);
        return;
      }

      console.log("ユーザー操作（手動リロード or ページ遷移）検知");
      chrome.storage.local.set({
        playClipSystemKey: 0,
        playlistSystemKey: 0,
        currentClipOrder: 0,
        playmode: null
      }, () => {
        console.log("systemKey を 0 に設定しました（両モード）");
      });
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'AUTH_DONE') {
      ensureAuthAndBootstrap();
    }
  });

  if (document.readyState === 'loading') {
    window.addEventListener('load', ensureAuthAndBootstrap, { once: true });
  } else {
    ensureAuthAndBootstrap();
  }
})();
