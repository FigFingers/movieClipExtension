import {
  clearAutoNavigation,
  detectService,
  isAutoNavigation,
  markAutoNavigation,
  openMemoSidebar,
  requestSeek,
  sendData
} from './common.js';

(() => {
  const AUTO_NAV_STORAGE_KEY = 'autoNav';
  const AUTO_NAV_TTL_MS = 15000;
  let autoNavCache = null;

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

  // === Disney+ DOM ヘルパー（Shadow DOM 対応） ===
  // 現行プレイヤーは <main-app-controls-overlay> の shadowRoot 配下にコントロール・
  // タイトル・プログレスバーを描画する。各要素はさらに独自の shadowRoot を持つため、
  // document 直下の querySelector では取得できない。
  function getOverlayRoot() {
    return document.querySelector('main-app-controls-overlay')?.shadowRoot || null;
  }

  function getTitleBugRoot() {
    return getOverlayRoot()?.querySelector('title-bug')?.shadowRoot || null;
  }

  function getProgressBar() {
    return getOverlayRoot()?.querySelector('progress-bar') || null;
  }

  // 再生位置スライダー。role="slider" で aria-valuenow / aria-valuemax（秒）を保持し、
  // シーク時のポインタターゲットも兼ねる。
  function getProgressSlider() {
    return getProgressBar()?.shadowRoot?.querySelector('.progress-bar__seekable-range') || null;
  }

  // 実際に再生している video は #hivePlayer1 (.hive-video)。
  // 先頭の <video style="display:none"> は src を持たないダミーなので優先的に避ける。
  function getVideoElement() {
    return (
      document.querySelector('video.hive-video') ||
      document.getElementById('hivePlayer1') ||
      Array.from(document.querySelectorAll('video')).find((v) => v.currentSrc || v.src) ||
      document.querySelector('video')
    );
  }

  // === UI ===
  const UI = (() => {
    // Disney+ の <pointer-actions> は、プレイヤー全面を覆う SVG パス
    // (.pointer-mask-path, pointer-events:auto) でクリックを横取りし、ネイティブ操作
    // ボタンの位置にだけ evenodd で「穴」を開けて通す。コントロール行に要素を挿しても
    // この穴が無いため押せない。そこで <pointer-actions>/<main-app-controls-overlay> の
    // 兄弟として「最後」に自前オーバーレイを差し込み、マスクより上に載せてクリックを成立させる。
    // （フルスクリーンでも有効。Disney 側の要素は改変しない。）
    const OVERLAY_ID = 'dext-overlay';
    const BAR_ID = 'dext-bar';
    // オーバーレイの挿入先（プレイヤー配下・フルスクリーン対象の内側）。上から順に試す。
    const PLAYER_ROOT_SELECTORS = [
      'disney-web-player-ui',
      '.btm-media-clients',
      '.player-container-root',
      '.mini-player-inner'
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

    // オーバーレイは light DOM に置くため、スタイルは document.head で問題ない。
    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;

      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
    /* --- マスクより上に載る自前オーバーレイ --- */
    #${OVERLAY_ID} {
      position: absolute;
      inset: 0;
      pointer-events: none;         /* 素通し。ボタンだけ pointer-events:auto にする */
      z-index: 2147483000;          /* Disney の pointer-mask より上 */
    }

    #${BAR_ID} {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 150px;                /* ネイティブのシークバー/操作行の上。必要に応じ調整 */
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      padding: 0 34px;
      box-sizing: border-box;
      pointer-events: none;
    }

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

    /* ホスト領域（左右にまとめる）。バーは素通しなのでホストだけクリック可に戻す。 */
    .dext-host {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      pointer-events: auto;
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

    // プレイヤー配下（フルスクリーン対象の内側）を探す。
    function getPlayerRoot() {
      for (const selector of PLAYER_ROOT_SELECTORS) {
        const node = document.querySelector(selector);
        if (node) {
          return node;
        }
      }
      // 最後の手段: overlay ホスト要素の親（= disney-web-player-ui 相当）。
      return document.querySelector('main-app-controls-overlay')?.parentElement || null;
    }

    // マスクより上の自前オーバーレイ（#dext-overlay > #dext-bar > 左右ホスト）を用意する。
    function ensureOverlay() {
      const playerRoot = getPlayerRoot();
      if (!playerRoot) {
        return null;
      }

      let overlay = document.getElementById(OVERLAY_ID);
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;

        const bar = document.createElement('div');
        bar.id = BAR_ID;

        for (const area of ['left', 'right']) {
          const host = document.createElement('div');
          host.id = HOST_IDS[area];
          host.className = `dext-host dext-host--${area}`;
          bar.appendChild(host);
        }

        overlay.appendChild(bar);
      }

      // playerRoot 配下に無い（新規/差し替え後）ときだけ付け直す。z-index でマスクより
      // 上に出るため「最後の子」への固定は不要。毎回付け直すと observer ループになるので避ける。
      if (overlay.parentNode !== playerRoot) {
        playerRoot.appendChild(overlay);
      }

      return {
        left: overlay.querySelector(`#${HOST_IDS.left}`),
        right: overlay.querySelector(`#${HOST_IDS.right}`)
      };
    }

    function addButton(config, host) {
      // コンテナに id を付ける。ホストは light DOM 配下なので document で検索できる。
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
          return;
      }

      if (clickStateLeft === 2) {
        const t = Service.DPlusTime.get();
        const endtime = t?.currentSeconds;

        const videoPlayer = getVideoElement();
        videoPlayer?.pause();

        const urldata = location.href;
        // タイトル/サブタイトルは title-bug の shadowRoot 配下にある。
        const titleRoot = getTitleBugRoot();
        const title = titleRoot?.querySelector(".title-field span")?.textContent.trim() || "";
        const subtitle = titleRoot?.querySelector(".subtitle-field span")?.textContent.trim() || "";

        const clipName = `${title}${subtitle ? `｜${subtitle}` : ""}`;

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
    }

    function injectButtons() {
      // プレイヤーが出るまで待つ（overlay の shadowRoot を目印にする）。
      if (!getOverlayRoot()) {
        return;
      }

      ensureStyle();

      const hosts = ensureOverlay();
      if (!hosts) {
        return;
      }

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

      function getTime() {
        // aria-valuenow/valuemax（秒）は .progress-bar__seekable-range 側に付く。
        const slider = getProgressSlider();
        if (!slider) return null;

        const current = Number(slider.getAttribute("aria-valuenow"));
        const total   = Number(slider.getAttribute("aria-valuemax"));

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
      const seekable = getProgressSlider();
      if (!seekable) return console.warn("seekable-range が見つからない");

      const rect = seekable.getBoundingClientRect();
      const ratio = seconds / t.totalSeconds;

      // クリック位置を算出
      const x = rect.left + rect.width * ratio;
      const y = rect.top + rect.height / 2;

      // イベント発火
      ["pointerdown", "pointerup"].forEach(type => {
        seekable.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            composed: true,
            cancelable: true,
            clientX: x,
            clientY: y
          })
        );
      });
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
        return () => {};
      }

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
          return;
        }

        requestSeek({
          service: detectService(),
          seconds: clipData.startTime,
          adapter: playerAdapter
        });

        clearInterval(timers.startTimer);
        timers.startTimer = null;

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

    // 最終clipは先頭へ戻る（loopEnabled=falseでも先頭に戻る）

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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', UI.bootstrap, { once: true });
  } else {
    UI.bootstrap();
  }

  Mode.bootstrap();

  window.addEventListener('locationchange', () => UI.scheduleInjection());
  window.addEventListener('load', () => UI.scheduleInjection(), { once: true });

  window.addEventListener('beforeunload', () => {
    if (isAutoNavigation() || isAutoNavActive()) {
      return;
    }

    chrome.storage.local.set({
      playClipSystemKey: 0,
      playlistSystemKey: 0,
      currentClipOrder: 0,
      playmode: null
    });
  });
})();
