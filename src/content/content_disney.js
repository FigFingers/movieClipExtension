import {
  clearAutoNavigation,
  detectService,
  EXT_UI_CLASS,
  handleOwnedPlaybackRouteChange,
  markAutoNavigation,
  markExtUi,
  openMemoSidebar,
  requestSeek,
  sendData,
  startTabVisibilityToggle
} from './common.js';
import {
  COMMENT_PANEL_ID,
  closeCommentPanel,
  isCommentPanelOpen,
  toggleCommentPanel
} from './commentPanel.js';
import {
  clearPlaybackContext,
  ensurePlaybackContext,
  setPlaybackContext
} from './playbackContext.js';
import { setTextContentIfChanged } from './domUpdates.js';
import { normalizePlaybackRoute } from '../shared/playbackBridgeValidation.js';
import {
  addPlaybackOwnerToUrl,
  claimPlaybackOwnership,
  getTabPlaybackOwnerNonce,
  preparePlaybackNavigation,
  releasePlaybackOwnership,
  updatePlaybackOwnership
} from './playbackOwnership.js';

(() => {
  ensurePlaybackContext();
  clearAutoNavigation();
  let activePlaybackOwnerNonce = null;
  let playbackLocation = null;

  function routeIdentity(url) {
    return normalizePlaybackRoute(url, location.href) || String(url || '');
  }

  function applyPlaybackContext(context, ownerNonce) {
    setPlaybackContext(context);
    activePlaybackOwnerNonce = ownerNonce;
    playbackLocation = routeIdentity(location.href);
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
    clearAutoNavigation();
    clearPlaybackContext();
    closeCommentPanel();
    releasePlaybackOwnership(ownerNonce);
    Mode.stop();
  }

  async function beginAutoNavigation({ mode, nextUrl, nextOrder, nextId }) {
    const prepared = await preparePlaybackNavigation(
      activePlaybackOwnerNonce,
      nextUrl
    );
    if (!prepared?.ok) {
      deactivatePlaybackContext();
      return false;
    }
    const marked = markAutoNavigation({
      ownerNonce: activePlaybackOwnerNonce,
      expectedRoute: routeIdentity(nextUrl),
      reason: `${mode}:${nextOrder ?? ''}:${nextId ?? ''}`,
    });
    if (!marked) {
      deactivatePlaybackContext();
      return false;
    }
    return true;
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

    const BUTTONS = [
      { id: 'dext-left-button', area: 'left', label: '録画', action: myCustomActionLeft },
      { id: 'dext-right-button-1', area: 'right', label: 'ループ', action: myCustomActionRight1 },
      {
        id: 'dext-right-button-2',
        area: 'right',
        label: 'コメント',
        action: myCustomActionRight2,
        controls: COMMENT_PANEL_ID
      }
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
        markExtUi(overlay);

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
        if (container?.parentNode) container.parentNode.removeChild(container);

        // Disney+ に寄せた構造: [div.button-container(tabindex=0, role="button")] ＞ [button.control] ＋ [span.label]
        container = document.createElement('div');
        container.id = config.id;
        container.className = 'dext-button-container button-container';
        container.setAttribute('role', 'button');
        container.setAttribute('aria-label', config.label);
        if (config.controls) {
          container.setAttribute('aria-haspopup', 'dialog');
          container.setAttribute('aria-controls', config.controls);
          container.setAttribute('aria-expanded', 'false');
        }
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
          let nextActiveState;
          if (typeof config.action === 'function') {
            nextActiveState = config.action(container);   // ボタンごとに関数を実行
          }
          if (typeof nextActiveState === 'boolean') {
            container.classList.toggle('active', nextActiveState);
          } else {
            container.classList.toggle('active');
          }
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

      const label = container.querySelector('.dext-button-label');
      setTextContentIfChanged(label, config.label);
      container.setAttribute('aria-label', config.label);
      if (config.controls) {
        const panelOpen = isCommentPanelOpen();
        container.classList.toggle('active', panelOpen);
        container.setAttribute('aria-expanded', String(panelOpen));
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

    function myCustomActionRight2(triggerEl) {
      return toggleCommentPanel({
        mountEl: getPlayerRoot() || document.body,
        triggerEl,
        onOpenChange: (open) => {
          if (!triggerEl?.isConnected) return;
          triggerEl.classList.toggle('active', open);
          triggerEl.setAttribute('aria-expanded', String(open));
        }
      });
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

    // Disney+ はマウス静止でネイティブのコントロール行が自動的に消える。拡張ボタンも
    // それに追随させ、(1) 一定時間ポインタ操作が無いアイドル時 (2) ウィンドウが blur した
    // ときに隠す。停止中はネイティブ同様に出したままにする。表示制御は共通の EXT_UI_CLASS
    // に対し <html>.dext-player-idle で行うため、再注入されたボタンにも効く。
    const PLAYER_IDLE_CLASS = 'dext-player-idle';
    const PLAYER_IDLE_STYLE_ID = 'dext-player-idle-style';
    const PLAYER_IDLE_MS = 3000;

    function ensurePlayerIdleStyle() {
      if (document.getElementById(PLAYER_IDLE_STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = PLAYER_IDLE_STYLE_ID;
      style.textContent = `.${PLAYER_IDLE_CLASS} .${EXT_UI_CLASS} { opacity: 0; pointer-events: none; }`;
      (document.head || document.documentElement).appendChild(style);
    }

    function startPlayerActivityToggle() {
      ensurePlayerIdleStyle();
      const root = document.documentElement;
      let idleTimer = null;
      // 起動直後やタブ復帰直後は、ユーザーがまだページをクリックしていないと
      // document.hasFocus() が false を返すことがある。可視タブはひとまずアクティブとし、
      // 以降は focus / blur / visibilitychange で状態を追跡する。
      let pageActive = !document.hidden;

      const setIdle = (v) => root.classList.toggle(PLAYER_IDLE_CLASS, v);
      const goIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = null;
        setIdle(true);
      };
      // 停止中・video 未生成のときはネイティブ同様に出したまま。再生中だけ一定時間で隠す。
      const isPlaying = () => getVideoElement()?.paused === false;
      const activate = () => {
        setIdle(false);
        clearTimeout(idleTimer);
        idleTimer = isPlaying() ? setTimeout(goIdle, PLAYER_IDLE_MS) : null;
      };
      // blur / 非表示中は play・pause など操作以外のイベントで復帰させない。
      const markActive = () => (pageActive ? activate() : goIdle());
      // 表示中のプレイヤー上にカーソルが戻った時点で、クリックを待たずに復帰する。
      const handleUserActivity = () => {
        pageActive = !document.hidden;
        markActive();
      };
      const handleBlur = () => {
        pageActive = false;
        goIdle();
      };
      const handleFocus = () => {
        pageActive = true;
        activate();
      };
      const handleVisibilityChange = () => {
        pageActive = !document.hidden;
        if (pageActive) {
          activate();
        } else {
          goIdle();
        }
      };

      // Disney+ のマスクや Shadow DOM 内でイベント伝播が止められても拾えるよう、
      // window のキャプチャ段階で監視する。
      for (const type of ['pointerover', 'pointermove', 'pointerdown', 'keydown']) {
        window.addEventListener(type, handleUserActivity, {
          capture: true,
          passive: true,
        });
      }
      // ウィンドウが非アクティブになったら即座に隠す / 戻ったら復帰。
      window.addEventListener('blur', handleBlur);
      window.addEventListener('focus', handleFocus);
      // タブ切り替えでは window.focus が発火しない場合があるため、可視性でも復帰させる。
      document.addEventListener('visibilitychange', handleVisibilityChange);
      // 再生/停止（media イベントは bubble しないため capture で拾う）。
      document.addEventListener('play', markActive, true);
      document.addEventListener('pause', markActive, true);

      handleVisibilityChange();
    }

    function bootstrap() {
      startObserver();
      scheduleInjection();
      startTabVisibilityToggle();
      startPlayerActivityToggle();
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
          progress      : `${((current / total) * 100).toFixed(2)}%`
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
    let currentSession = null;

    function loadClipData(session = currentSession) {
      const snapshot = session?.snapshot;
      const clip = snapshot?.clip;
      if (session?.context?.mode !== 'clip' || snapshot?.playClipSystemKey !== 1 || !clip) {
        console.log('[Clip] No clip data or disabled');
        return null;
      }

      return {
        startTime: Number(clip.startTime ?? clip.starttime),
        endTime:   Number(clip.endTime   ?? clip.endtime),
        title:     String(clip.title || ''),
        clipId:    clip.clipId ?? clip.id
      };
    }

    async function startClipMode(session) {
      currentSession = session;
      const clipData = loadClipData(session);
      if (!clipData) return;
      stopCurrent = Playlist.play([clipData], {
        loop: loopEnabled,
        onStart: clearAutoNavigation
      });
    }

async function startPlaylistMode(session) {
  stopActiveMode();
  currentSession = session;
  const { playQueue, currentClipOrder } = session?.snapshot || {};
  if (session?.context?.mode !== 'playlist') return;

  if (!Array.isArray(playQueue) || playQueue.length === 0) {
    clearPlaybackContext();
    console.warn('[Playlist] playQueue が存在しません');
    return;
  }

  const sortedQueue = [...playQueue].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const fallbackOrder = sortedQueue[0]?.order ?? 0;

  const order = Number.isInteger(currentClipOrder) ? currentClipOrder : fallbackOrder;
  const currentClip = sortedQueue.find((clip) => clip.order === order) || sortedQueue[0];
  let activeOrder = currentClip?.order ?? order;

  if (!currentClip) {
    clearPlaybackContext();
    console.warn('[Playlist] 該当clipが見つかりません:', order);
    return;
  }

  const clipData = normalizeClipData(currentClip);
  if (!clipData) return;

  playPlaylistClip(clipData);

  function playPlaylistClip(clipData) {
    stopCurrent = Clip.play(clipData, {
      onStart: clearAutoNavigation,
      onEnd: handlePlaylistEnd
    });
  }

  function handlePlaylistEnd() {
    void playlistNextClip(sortedQueue, activeOrder ?? fallbackOrder);
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
    const nextId = next.clipId ?? next.id;

    const transitioned = await transitionPlaybackSession('playlist', next, {
      playQueue: sortedQueue,
      currentClipOrder: nextOrder,
      currentClipId: nextId,
      nextClip: next,
      playClipSystemKey: 0,
      playlistSystemKey: 1,
      playmode: 'playlist'
    });
    if (!transitioned) return;
    currentSession = transitioned;
    activeOrder = nextOrder;

    const nextClipData = normalizeClipData(next);
    if (!nextClipData) {
      console.warn('[Playlist] 次クリップのデータが不正です');
      return;
    }

    const currentUrl = normalizeClipUrl(current);
    const nextUrl = normalizeClipUrl(next);

    if (currentUrl && nextUrl && currentUrl !== nextUrl) {
      const baseUrl = buildClipUrl(nextUrl, nextClipData.startTime);
      if (!baseUrl) return;
      const url = addPlaybackOwnerToUrl(baseUrl, activePlaybackOwnerNonce);
      console.log('[Playlist] 異なるURLへページ遷移します');

      setTimeout(async () => {
        const prepared = await beginAutoNavigation({
          mode: 'playlist',
          nextUrl: url,
          nextOrder,
          nextId
        });
        if (!prepared) return;
        window.location.href = url;
      }, 150);
      return;
    }

    playPlaylistClip(nextClipData);
  }
}


    async function startPreferredMode() {
      const ownerNonce = getTabPlaybackOwnerNonce();
      const session = await claimPlaybackSession(ownerNonce);
      if (!session) return;
      currentSession = session;
      if (session.context.mode === 'playlist') {
        await startPlaylistMode(session);
      } else if (session.context.mode === 'clip') {
        await startClipMode(session);
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
        const clipData = loadClipData();
        if (!clipData) {
          loopEnabled = false;
          return;
        }
        stopActiveMode();
        stopCurrent = Playlist.play([clipData], { loop: loopEnabled });
      } else {
        console.log('[Loop] OFF - stop playback');
        stopActiveMode();
      }
    }

    function bootstrap() {
      const start = () => {
        stopActiveMode();
        void startPreferredMode();
      };
      if (document.readyState === 'complete') {
        start();
      } else {
        window.addEventListener('load', start, { once: true });
      }
    }

    return {
      bootstrap,
      toggleLoop,
      stop: stopActiveMode
    };
  })();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', UI.bootstrap, { once: true });
  } else {
    UI.bootstrap();
  }

  Mode.bootstrap();

  window.addEventListener('historyChange', (event) => {
    UI.scheduleInjection();
    const nextLocation = routeIdentity(event.detail?.url || location.href);
    handleOwnedPlaybackRouteChange({
      ownerNonce: activePlaybackOwnerNonce,
      currentRoute: playbackLocation,
      nextRoute: nextLocation,
      onAutoNavigation: (route) => {
        playbackLocation = route;
      },
      onManualNavigation: deactivatePlaybackContext,
    });
  });
  window.addEventListener('load', () => UI.scheduleInjection(), { once: true });

  window.addEventListener('beforeunload', () => {
    clearPlaybackContext();
    closeCommentPanel();
  });
})();
