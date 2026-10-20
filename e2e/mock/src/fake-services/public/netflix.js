// 擬似の Netflix（https://www.netflix.com に見せかけて配信する）。
// 拡張が触る部分だけを本物に合わせる:
//   - 視聴ページ /watch/<id> の DOM（.watch-video--player-view、data-uia の操作ボタン、作品名の要素）
//   - window.netflix.appContext.state.playerApp.getAPI().videoPlayer（ミリ秒の seek）
//   - 操作バーはマウスが止まると DOM から外れる（拡張のボタンの付け直しを確かめる）
//   - 画面の移動は history.pushState（拡張の historyChange フックを通る）
//   - video.currentTime を直接書き換えると、本物と同じくエラーになる（strictSeek）
// 状態は window.__fake（ページの MAIN world）に出す。ハーネスはこれを読んで確かめる。
(() => {
  'use strict';

  const catalog = JSON.parse(document.getElementById('fake-catalog').textContent);
  const settings = JSON.parse(document.getElementById('fake-settings').textContent);
  const mount = document.getElementById('appMountPoint');

  const fake = {
    service: 'netflix',
    titleId: null,
    sessionId: null,
    apiReady: false,
    /** プレイヤー API の seek（ミリ秒） */
    seeks: [],
    /** video.currentTime の直接の書き換え（本物ではエラーになる操作） */
    directSeeks: [],
    events: [],
    errors: [],
  };
  window.__fake = fake;

  let video = null;
  let current = null;
  let sessionCounter = 0;
  let hideTimer = null;
  let apiTimer = null;
  let controlsVisible = false;
  /** 自分で起こしたシークの目標。seeking で照合し、残りを直接の書き換えとみなす。 */
  const internalSeekTargets = [];
  const wavCache = new Map();

  const round = (value) => Math.round(value * 1000) / 1000;

  function log(type, detail = {}) {
    fake.events.push({ type, at: Date.now(), time: video ? round(video.currentTime) : null, ...detail });
    if (fake.events.length > 1000) fake.events.shift();
  }

  /** 無音の WAV（8 kHz・8 bit・モノラル）。blob: で渡すとシークも効く。 */
  function silentWavUrl(seconds) {
    if (wavCache.has(seconds)) return wavCache.get(seconds);
    const rate = 8000;
    const size = Math.ceil(seconds * rate);
    const bytes = new Uint8Array(44 + size);
    const view = new DataView(bytes.buffer);
    const text = (offset, value) => { for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i); };
    text(0, 'RIFF');
    view.setUint32(4, 36 + size, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    text(36, 'data');
    view.setUint32(40, size, true);
    bytes.fill(0x80, 44);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    wavCache.set(seconds, url);
    return url;
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child) node.append(child);
    }
    return node;
  }

  // -------------------------------------------------------------------------
  // プレイヤー API（MAIN world）
  // -------------------------------------------------------------------------

  function internalSeek(seconds) {
    if (!video) return;
    const target = Math.max(0, Math.min(seconds, video.duration || seconds));
    internalSeekTargets.push(target);
    video.currentTime = target;
  }

  const playerApi = {
    seek(ms) {
      if (!Number.isFinite(ms)) throw new TypeError('seek requires milliseconds');
      fake.seeks.push({ ms, at: Date.now() });
      log('api-seek', { ms });
      const latency = Number(settings.netflix.seekLatencyMs) || 0;
      setTimeout(() => internalSeek(ms / 1000), latency);
    },
    getCurrentTime: () => (video ? Math.round(video.currentTime * 1000) : 0),
    getDuration: () => (video ? Math.round((video.duration || 0) * 1000) : 0),
    getMovieId: () => Number(fake.titleId),
    isPaused: () => (video ? video.paused : true),
    play: () => video?.play(),
    pause: () => video?.pause(),
  };

  window.netflix = {
    appContext: {
      state: {
        playerApp: {
          getAPI: () => ({
            videoPlayer: {
              getAllPlayerSessionIds: () => (fake.apiReady && fake.sessionId ? [fake.sessionId] : []),
              getVideoPlayerBySessionId: (id) => (fake.apiReady && id === fake.sessionId ? playerApi : null),
            },
          }),
        },
      },
    },
  };

  // -------------------------------------------------------------------------
  // 画面
  // -------------------------------------------------------------------------

  // モックのオリジンで直接開いたとき（/__fake/netflix/watch/...）は、この前置きを除いて振り分ける。
  const PREFIX = location.pathname.startsWith('/__fake/netflix') ? '/__fake/netflix' : '';
  const currentPath = () => location.pathname.slice(PREFIX.length) || '/';

  function navigate(path) {
    history.pushState({}, '', `${PREFIX}${path}`);
    render();
  }

  function teardownPlayer() {
    clearTimeout(hideTimer);
    clearTimeout(apiTimer);
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    video = null;
    current = null;
    fake.titleId = null;
    fake.sessionId = null;
    fake.apiReady = false;
    controlsVisible = false;
  }

  function renderBrowse() {
    teardownPlayer();
    document.title = 'ホーム - Netflix（モック）';
    mount.replaceChildren(el('div', { class: 'browse', 'data-uia': 'browse' }, [
      el('header', { class: 'browse-header' }, [
        el('strong', { class: 'fake-logo', text: 'NETFLIX' }),
        el('span', { class: 'fake-badge', text: 'MOCK' }),
      ]),
      el('h1', { text: '作品' }),
      el('ul', { class: 'title-grid' }, catalog.netflix.map((title) => el('li', {}, [
        el('button', {
          type: 'button',
          class: 'title-card',
          'data-testid': `open-${title.id}`,
          onclick: () => navigate(`/watch/${title.id}`),
        }, [
          el('strong', { text: title.series }),
          el('span', { text: title.kind === 'episode' ? `${title.episodeNumber} ${title.episodeTitle}` : '映画' }),
        ]),
      ]))),
    ]));
  }

  function titleElement(title) {
    if (title.kind === 'episode') {
      return el('div', { class: 'video-title', 'data-uia': 'video-title' }, [
        el('h4', { text: title.series }),
        el('span', { text: title.episodeNumber }),
        el('span', { text: title.episodeTitle }),
      ]);
    }
    return el('div', { class: 'video-title', 'data-uia': 'video-title', text: title.series });
  }

  function controlButton(uia, label, onClick) {
    return el('div', { class: 'ctrl-group' }, [
      el('button', { type: 'button', class: 'ctrl-btn', 'data-uia': uia, 'aria-label': label, text: label, onclick: onClick }),
    ]);
  }

  function buildControls(title) {
    const timeline = el('div', { class: 'timeline', 'data-uia': 'timeline-bar' }, [
      el('div', { class: 'timeline-fill' }),
    ]);
    timeline.addEventListener('click', (event) => {
      if (!video?.duration) return;
      const rect = timeline.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      log('ui-seek', { to: round(ratio * video.duration) });
      internalSeek(ratio * video.duration);
    });
    const playing = video && !video.paused;
    return el('div', { class: 'watch-video--bottom-controls-container', 'data-uia': 'controls-container' }, [
      el('div', { class: 'controls-standard', 'data-uia': 'controls-standard' }, [
        timeline,
        el('div', { class: 'ctrl-row' }, [
          controlButton(playing ? 'control-play-pause-pause' : 'control-play-pause-play', playing ? '⏸' : '▶', () => {
            if (video.paused) video.play(); else video.pause();
          }),
          controlButton('control-back10', '⟲10', () => internalSeek(video.currentTime - 10)),
          controlButton('control-forward10', '10⟳', () => internalSeek(video.currentTime + 10)),
          controlButton(video?.muted ? 'control-volume-off' : 'control-volume-high', video?.muted ? '🔇' : '🔊', () => {
            video.muted = !video.muted;
            refreshControls();
          }),
          el('div', { class: 'ctrl-spacer' }, [titleElement(title)]),
          title.nextId ? controlButton('control-next', '⏭', () => navigate(`/watch/${title.nextId}`)) : null,
          title.kind === 'episode' ? controlButton('control-episodes', '☰', () => log('episodes')) : null,
          controlButton('control-audio-subtitle', '💬', () => log('audio-subtitle')),
          controlButton('control-fullscreen-enter', '⛶', () => {
            if (document.fullscreenElement) document.exitFullscreen();
            else document.documentElement.requestFullscreen().catch(() => {});
          }),
        ]),
      ]),
    ]);
  }

  function showControls() {
    const view = mount.querySelector('.watch-video--player-view');
    if (!view || !current) return;
    if (!controlsVisible) {
      controlsVisible = true;
      view.append(buildControls(current));
      updateTimeDisplay();
    }
    clearTimeout(hideTimer);
    if (settings.netflix.controlsAutoHide && video && !video.paused) {
      hideTimer = setTimeout(hideControls, settings.netflix.controlsHideMs);
    }
  }

  function hideControls() {
    controlsVisible = false;
    mount.querySelector('.watch-video--bottom-controls-container')?.remove();
  }

  function refreshControls() {
    if (!controlsVisible) return;
    hideControls();
    showControls();
  }

  function updateTimeDisplay() {
    if (!video) return;
    const screen = mount.querySelector('.fake-time');
    if (screen) screen.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}（${video.currentTime.toFixed(2)} 秒）`;
    const fill = mount.querySelector('.timeline-fill');
    if (fill && video.duration) fill.style.width = `${(video.currentTime / video.duration) * 100}%`;
  }

  function showError(message) {
    fake.errors.push({ message, at: Date.now() });
    const view = mount.querySelector('.watch-video--player-view');
    if (!view) return;
    view.querySelector('.fake-error')?.remove();
    view.append(el('div', { class: 'fake-error', role: 'alert', 'data-testid': 'player-error', text: message }));
  }

  function renderWatch(title, search) {
    teardownPlayer();
    current = title;
    fake.titleId = title.id;
    sessionCounter += 1;
    fake.sessionId = `mock-session-${sessionCounter}`;
    document.title = `${title.series} - Netflix（モック）`;

    // 動画（カタログの video かテスト用の動画）があれば映像を見せる。無ければ無音の音声だけで再生する。
    const hasPicture = Boolean(title.mediaUrl);
    fake.media = title.media;
    video = el('video', { class: hasPicture ? 'fake-video has-picture' : 'fake-video', playsinline: '' });
    video.muted = true;
    const startParam = new URLSearchParams(search).get('t');
    const start = settings.netflix.honorStartParam && startParam !== null ? Number.parseInt(startParam, 10) : 0;
    log('load', { titleId: title.id, startParam, start: Number.isFinite(start) ? start : 0 });

    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(start) && start > 0) internalSeek(start);
      clearTimeout(apiTimer);
      apiTimer = setTimeout(() => {
        fake.apiReady = true;
        log('api-ready');
      }, Number(settings.netflix.playerApiDelayMs) || 0);
      if (settings.netflix.autoplay) video.play().catch((error) => log('play-rejected', { message: String(error) }));
    }, { once: true });
    video.addEventListener('seeking', () => {
      const at = video.currentTime;
      const index = internalSeekTargets.findIndex((target) => Math.abs(target - at) < 0.05);
      if (index >= 0) {
        internalSeekTargets.splice(index, 1);
        return;
      }
      fake.directSeeks.push({ to: round(at), at: Date.now() });
      log('direct-seek', { to: round(at) });
      if (settings.netflix.strictSeek) showError('M7375（モック）: video.currentTime が直接書き換えられました。本物の Netflix ではエラーで再生が止まります。');
    });
    video.addEventListener('seeked', () => log('seeked'));
    video.addEventListener('timeupdate', updateTimeDisplay);
    video.addEventListener('play', () => { log('play'); refreshControls(); });
    video.addEventListener('pause', () => { log('pause'); refreshControls(); });
    video.addEventListener('ended', () => log('ended'));
    video.addEventListener('error', () => {
      const code = video.error?.code ?? null;
      fake.mediaError = code;
      log('media-error', { code });
      showError(`動画を再生できません（MediaError ${code}）。Playwright の Chromium は H.264・AAC を再生できないため、WebM（VP9・VP8・AV1）を使ってください。`);
    });
    video.src = title.mediaUrl || silentWavUrl(title.durationSeconds);

    const playerView = el('div', { class: 'watch-video--player-view', 'data-uia': 'player' }, [
      video,
      el('div', { class: hasPicture ? `fake-screen hud${settings.netflix.hud === false ? ' hidden' : ''}` : 'fake-screen' }, [
        el('div', { class: 'fake-logo', text: 'NETFLIX（モック）' }),
        el('div', { class: 'fake-screen-title', text: title.kind === 'episode' ? `${title.series} ${title.episodeNumber}「${title.episodeTitle}」` : title.series }),
        el('div', { class: 'fake-time', 'data-testid': 'time', text: '0:00' }),
      ]),
      el('button', {
        type: 'button',
        class: 'nav-back',
        'data-uia': 'control-nav-back',
        'aria-label': '戻る',
        text: '←',
        onclick: () => navigate('/browse'),
      }),
    ]);
    playerView.addEventListener('pointermove', showControls);
    playerView.addEventListener('pointerdown', showControls);
    playerView.addEventListener('click', (event) => {
      if (event.target === playerView || event.target.closest('.fake-screen')) {
        if (video.paused) video.play(); else video.pause();
      }
    });
    mount.replaceChildren(el('div', { class: 'watch-video', 'data-uia': 'watch-video' }, [playerView]));
    if (!settings.netflix.controlsAutoHide) showControls();
  }

  function render() {
    const match = /^\/watch\/([^/?#]+)/.exec(currentPath());
    if (match) {
      const title = catalog.netflix.find((entry) => entry.id === match[1]);
      if (title) {
        renderWatch(title, location.search);
        return;
      }
      mount.replaceChildren(el('p', { class: 'fake-missing', text: `作品 ${match[1]} はありません（モック）。` }));
      return;
    }
    renderBrowse();
  }

  window.addEventListener('popstate', render);
  fake.navigate = navigate;
  fake.showControls = showControls;
  render();
})();
