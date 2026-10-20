// 擬似の Disney+（https://www.disneyplus.com に見せかけて配信する）。
// 拡張が触る部分だけを本物に合わせる（拡張の docs/research/disney-player-dom-2026-07-21.md）:
//   - <disney-web-player-ui> の中に、src の無いダミーの <video style="display:none"> と #hivePlayer1
//   - <main-app-controls-overlay> の shadowRoot に <title-bug>（.title-field / .subtitle-field）と
//     <progress-bar>（shadowRoot の .progress-bar__seekable-range、aria-valuenow は整数秒）
//   - video.currentTime は作品の時刻からずれている（timelineOffsetSeconds）。本物は MSE のため
//   - 進行バーへのポインタ操作でシークする
// 状態は window.__fake に出す。
(() => {
  'use strict';

  const catalog = JSON.parse(document.getElementById('fake-catalog').textContent);
  const settings = JSON.parse(document.getElementById('fake-settings').textContent);
  const mount = document.getElementById('appMountPoint');
  const OFFSET = Number(settings.disney.timelineOffsetSeconds) || 0;

  const fake = {
    service: 'disney',
    titleId: null,
    offset: OFFSET,
    /** { method: 'progress-bar' | 'video' | 'ui', content, at } */
    seeks: [],
    events: [],
  };
  window.__fake = fake;

  let video = null;
  let current = null;
  let hideTimer = null;
  let overlayRoot = null;
  const internalSeekTargets = [];
  const wavCache = new Map();
  const round = (value) => Math.round(value * 1000) / 1000;

  function log(type, detail = {}) {
    fake.events.push({ type, at: Date.now(), content: video ? round(contentTime()) : null, ...detail });
    if (fake.events.length > 1000) fake.events.shift();
  }

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

  /**
   * 作品の長さ。動画があれば「動画の長さ − ずれ」（先頭のずれの分は作品の前の部分として扱う）、
   * 無音の音声だけのときはカタログの長さ（音声はずれの分だけ長く作る）。
   */
  function contentDuration() {
    if (video && Number.isFinite(video.duration) && video.duration > 0) return Math.max(0, video.duration - OFFSET);
    return current?.durationSeconds ?? 0;
  }

  function contentTime() {
    return video ? Math.max(0, video.currentTime - OFFSET) : 0;
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(total / 60);
    return `${m}:${String(total % 60).padStart(2, '0')}`;
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      // style 属性は CSP（style-src）の対象になるため、CSSOM で入れる。
      else if (key === 'style') node.style.cssText = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  }

  /** CSP の style-src に左右されないよう、shadowRoot のスタイルは adoptedStyleSheets で入れる。 */
  function sheet(css) {
    const styleSheet = new CSSStyleSheet();
    styleSheet.replaceSync(css);
    return styleSheet;
  }

  const OVERLAY_CSS = sheet(`
    :host { position: absolute; inset: 0; z-index: 10; pointer-events: none; font-family: system-ui, sans-serif; color: #fff; }
    .overlay { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between; transition: opacity .3s; }
    .overlay.idle { opacity: 0; }
    .overlay.idle * { pointer-events: none !important; }
    .top { padding: 24px 32px; background: linear-gradient(#000a, transparent); pointer-events: auto; }
    .bottom { padding: 16px 32px 28px; background: linear-gradient(transparent, #000c); pointer-events: auto; }
    .buttons { display: flex; gap: 12px; align-items: center; margin-top: 12px; }
    button.control { all: unset; cursor: pointer; padding: 6px 12px; border-radius: 16px; background: #fff2; }
    button.control:hover { background: #fff4; }
    .time { margin-left: auto; font-variant-numeric: tabular-nums; }
  `);
  const TITLE_CSS = sheet(`
    .title-field { font-size: 20px; font-weight: 700; }
    .subtitle-field { font-size: 14px; opacity: .85; margin-top: 4px; }
  `);
  const PROGRESS_CSS = sheet(`
    .progress-bar__seekable-range { position: relative; height: 10px; border-radius: 5px; background: #fff4; cursor: pointer; }
    .progress-bar__fill { position: absolute; inset: 0 auto 0 0; background: #1ce7ff; border-radius: 5px; width: 0; }
  `);

  class ShadowHost extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
    }
  }
  for (const name of ['disney-web-player-ui', 'main-app-controls-overlay', 'title-bug', 'progress-bar', 'pointer-actions']) {
    if (!customElements.get(name)) {
      customElements.define(name, name === 'disney-web-player-ui' || name === 'pointer-actions'
        ? class extends HTMLElement {}
        : class extends ShadowHost {});
    }
  }

  function internalSeek(content, method) {
    if (!video) return;
    const clamped = Math.max(0, Math.min(content, contentDuration()));
    const target = clamped + OFFSET;
    internalSeekTargets.push(target);
    fake.seeks.push({ method, content: round(clamped), at: Date.now() });
    log('seek', { method, to: round(clamped) });
    video.currentTime = target;
  }

  // モックのオリジンで直接開いたとき（/__fake/disney/ja-jp/play/...）は、この前置きを除いて振り分ける。
  const PREFIX = location.pathname.startsWith('/__fake/disney') ? '/__fake/disney' : '';
  const currentPath = () => location.pathname.slice(PREFIX.length) || '/';

  function navigate(path) {
    history.pushState({}, '', `${PREFIX}${path}`);
    render();
  }

  function teardown() {
    clearTimeout(hideTimer);
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    video = null;
    current = null;
    overlayRoot = null;
    fake.titleId = null;
  }

  function renderHome() {
    teardown();
    document.title = 'Disney+（モック）';
    mount.replaceChildren(el('div', { class: 'browse disney-home' }, [
      el('header', { class: 'browse-header' }, [
        el('strong', { class: 'fake-logo', text: 'Disney+' }),
        el('span', { class: 'fake-badge', text: 'MOCK' }),
      ]),
      el('h1', { text: '作品' }),
      el('ul', { class: 'title-grid' }, catalog.disney.map((title) => el('li', {}, [
        el('button', {
          type: 'button',
          class: 'title-card',
          'data-testid': `open-${title.id}`,
          onclick: () => navigate(`/ja-jp/play/${title.id}`),
        }, [el('strong', { text: title.title }), el('span', { text: title.subtitle || '映画' })]),
      ]))),
    ]));
  }

  function setIdle(idle) {
    overlayRoot?.querySelector('.overlay')?.classList.toggle('idle', idle);
  }

  function wake() {
    setIdle(false);
    clearTimeout(hideTimer);
    if (settings.disney.controlsAutoHide && video && !video.paused) {
      hideTimer = setTimeout(() => setIdle(true), settings.disney.controlsHideMs);
    }
  }

  function updateProgress() {
    if (!video || !overlayRoot) return;
    const progress = overlayRoot.querySelector('progress-bar');
    const slider = progress?.shadowRoot?.querySelector('.progress-bar__seekable-range');
    if (!slider) return;
    const content = contentTime();
    slider.setAttribute('aria-valuenow', String(Math.floor(content)));
    slider.setAttribute('aria-valuetext', formatTime(content));
    const total = contentDuration();
    slider.setAttribute('aria-valuemax', String(Math.floor(total)));
    progress.shadowRoot.querySelector('.progress-bar__fill').style.width = `${total ? (content / total) * 100 : 0}%`;
    const time = overlayRoot.querySelector('.time');
    if (time) time.textContent = `${formatTime(content)} / ${formatTime(total)}`;
    const screen = mount.querySelector('.fake-time');
    if (screen) screen.textContent = `作品 ${content.toFixed(2)} 秒（video.currentTime ${video.currentTime.toFixed(2)}）`;
  }

  function buildOverlay(title) {
    const overlay = el('main-app-controls-overlay');
    overlayRoot = overlay.shadowRoot;
    overlayRoot.adoptedStyleSheets = [OVERLAY_CSS];

    const titleBug = el('title-bug');
    titleBug.shadowRoot.adoptedStyleSheets = [TITLE_CSS];
    titleBug.shadowRoot.append(
      el('div', { class: 'title-field' }, [el('span', { text: title.title })]),
      el('div', { class: 'subtitle-field' }, [el('span', { text: title.subtitle })]),
    );

    const progress = el('progress-bar');
    progress.shadowRoot.adoptedStyleSheets = [PROGRESS_CSS];
    const slider = el('div', {
      class: 'progress-bar__seekable-range',
      role: 'slider',
      tabindex: '0',
      'aria-label': '再生位置',
      'aria-valuemin': '0',
      'aria-valuenow': '0',
      'aria-valuemax': String(title.durationSeconds),
    }, [el('div', { class: 'progress-bar__fill' })]);
    let pressed = false;
    slider.addEventListener('pointerdown', () => { pressed = true; });
    slider.addEventListener('pointerup', (event) => {
      if (!pressed) return;
      pressed = false;
      const rect = slider.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      internalSeek(ratio * contentDuration(), 'progress-bar');
    });
    progress.shadowRoot.append(slider);

    overlayRoot.append(el('div', { class: 'overlay' }, [
      el('div', { class: 'top' }, [titleBug]),
      el('div', { class: 'bottom' }, [
        progress,
        el('div', { class: 'buttons' }, [
          el('button', { class: 'control play-pause', text: '⏯', onclick: () => (video.paused ? video.play() : video.pause()) }),
          el('button', { class: 'control', text: '⟲10', onclick: () => internalSeek(contentTime() - 10, 'ui') }),
          el('button', { class: 'control', text: '10⟳', onclick: () => internalSeek(contentTime() + 10, 'ui') }),
          el('button', { class: 'control', text: '⛶', onclick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {})) }),
          el('span', { class: 'time' }),
        ]),
      ]),
    ]));
    return overlay;
  }

  function renderPlayer(title, search) {
    teardown();
    current = title;
    fake.titleId = title.id;
    document.title = `${title.title} | Disney+（モック）`;

    const hasPicture = Boolean(title.mediaUrl);
    fake.media = title.media;
    video = el('video', { id: 'hivePlayer1', class: hasPicture ? 'hive-video has-picture' : 'hive-video', playsinline: '' });
    video.muted = true;
    const startParam = new URLSearchParams(search).get('t');
    const start = settings.disney.honorStartParam && startParam !== null ? Number(startParam) : 0;
    log('load', { titleId: title.id, startParam, start });
    video.addEventListener('loadedmetadata', () => {
      internalSeek(Number.isFinite(start) ? start : 0, 'load');
      // 進行バーの最大値を、動画の長さが分かった時点で作品の長さにする（拡張はこの値でシーク先を計算する）。
      updateProgress();
      if (settings.disney.autoplay) video.play().catch((error) => log('play-rejected', { message: String(error) }));
    }, { once: true });
    video.addEventListener('durationchange', updateProgress);
    video.addEventListener('seeking', () => {
      const at = video.currentTime;
      const index = internalSeekTargets.findIndex((target) => Math.abs(target - at) < 0.05);
      if (index >= 0) {
        internalSeekTargets.splice(index, 1);
        return;
      }
      fake.seeks.push({ method: 'video', content: round(at - OFFSET), at: Date.now() });
      log('seek', { method: 'video', to: round(at - OFFSET) });
    });
    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('play', () => { log('play'); wake(); });
    video.addEventListener('pause', () => { log('pause'); wake(); });
    video.addEventListener('ended', () => log('ended'));
    video.addEventListener('error', () => {
      const code = video.error?.code ?? null;
      fake.mediaError = code;
      log('media-error', { code });
      const message = mount.querySelector('.fake-time');
      if (message) message.textContent = `動画を再生できません（MediaError ${code}）。Playwright の Chromium は H.264・AAC を再生できないため、WebM を使ってください。`;
    });
    video.src = title.mediaUrl || silentWavUrl(title.durationSeconds + OFFSET);

    const mask = el('pointer-actions', { class: 'pointer-mask' });
    mask.addEventListener('click', () => (video.paused ? video.play() : video.pause()));

    const player = el('disney-web-player-ui', { class: 'disney-player' }, [
      el('video', { style: 'display:none' }),
      el('div', { class: 'btm-media-player' }, [video]),
      el('div', { class: hasPicture ? `fake-screen hud${settings.disney.hud === false ? ' hidden' : ''}` : 'fake-screen' }, [
        el('div', { class: 'fake-logo', text: 'Disney+（モック）' }),
        el('div', { class: 'fake-screen-title', text: `${title.title}${title.subtitle ? ` ${title.subtitle}` : ''}` }),
        el('div', { class: 'fake-time', 'data-testid': 'time', text: '' }),
      ]),
      mask,
      buildOverlay(title),
    ]);
    player.addEventListener('pointermove', wake);
    mount.replaceChildren(player);
    wake();
  }

  function render() {
    const match = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:play|video)\/([^/?#]+)/.exec(currentPath());
    if (match) {
      const title = catalog.disney.find((entry) => entry.id === match[1]);
      if (title) {
        renderPlayer(title, location.search);
        return;
      }
      mount.replaceChildren(el('p', { class: 'fake-missing', text: `作品 ${match[1]} はありません（モック）。` }));
      return;
    }
    renderHome();
  }

  window.addEventListener('popstate', render);
  fake.navigate = navigate;
  fake.contentTime = contentTime;
  render();
})();
