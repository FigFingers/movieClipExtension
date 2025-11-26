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
  const LEFT_CONTROLS_SELECTOR = LEFT_CONTROLS_SELECTORS[0];
  const RIGHT_CONTROLS_SELECTOR = RIGHT_CONTROLS_SELECTORS[0];
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
function findRealDPlusVideo() {
  const videos = Array.from(document.querySelectorAll("video"));

  // 本命条件：duration が Infinity ＆ blob src
  let real = videos.find(v =>
    v.duration === Infinity &&
    typeof v.currentSrc === "string" &&
    v.currentSrc.startsWith("blob:https://www.disneyplus.com")
  );

  if (real) return real;

  // fallback: readyState >= 2 の video
  real = videos.find(v => v.readyState >= 2 && v.duration > 0);
  if (real) return real;

  // 最悪 video[0]
  return videos[0] || null;
}
function findAllTextNodesDeep(root = document) {
  const stack = [root];
  const results = [];

  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;

    if (node.nodeType === Node.TEXT_NODE) {
      results.push(node);
    }

    if (node.shadowRoot) {
      stack.push(node.shadowRoot);
    }

    if (node.childNodes) {
      for (const child of node.childNodes) {
        stack.push(child);
      }
    }
  }

  return results;
}

function findDisneyPlusUITimeAny() {
  const textNodes = findAllTextNodesDeep();
  const regex = /^(\d{1,2}:)?\d{1,2}:\d{2}$/;  
  // 例: "1:23", "12:34", "1:02:03"

  for (const node of textNodes) {
    const text = node.textContent.trim();
    if (regex.test(text)) {
      return text;  // UI で表示されている "00:20" の文字列
    }
  }
  return null;
}

function parseTimeToSeconds(str) {
  const parts = str.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return NaN;
}

function myCustomActionLeft() {
  const raw = findDisneyPlusUITimeAny();

  if (!raw) {
    console.warn("UI 時刻が見つかりません（セレクタ変更 or UI未表示）");
    return;
  }

  console.log("[Disney+] UI 時刻（生テキスト）:", raw);
  console.log("[Disney+] UI 時刻（秒換算）:", parseTimeToSeconds(raw));
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

  function sendData(dataToSend) {
      fetch(getApiEndpoint("receive"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(dataToSend),
      })
        .then((response) => response.json())
        .then((data) => {
          console.log("Success:", data);
          // ユーザーに成功を通知するUIを追加可能
        })
        .catch((error) => {
          console.error("Error:", error);
          // ユーザーにエラーを通知するUIを追加可能
        });
    }

  function bootstrap() {
    hookHistory();
    startObserver();
    scheduleInjection();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }

  window.addEventListener('locationchange', () => scheduleInjection());
  window.addEventListener('load', () => scheduleInjection(), { once: true });
})();
