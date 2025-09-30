import { getApiEndpoint } from './../api.js';

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // グローバル変数の定義
  // ---------------------------------------------------------------------------
  let videoPlayer = null;   // <video> element reference
  let clipData    = null;   // { starttime, endtime, name, title, username }
  let isScriptReloading = false;// スクリプトによるリロードフラグ

  // End-time detection tolerance (seconds)
  const EPSILON = 0.05;
  let countdownIntervalId = null;

  const BUTTON_ID = "nf-loop-toggle-btn";
  const NEXT_BUTTON_ID = "nf-next-clip-btn";
  const SIDEBAR_ID = "nf-memo-sidebar";
  const SIDEBAR_PCT = 30; // サイドバーの幅（%）
  const SELECTOR_STANDARD = '[data-uia="controls-standard"]';
  const SELECTOR_EPISODE = '[data-uia="control-episodes"]';
  const SELECTOR_FWD10 = '[data-uia="control-forward10"]';
  const SELECTOR_SUBTITLE = '[data-uia="control-audio-subtitle"]';
    

  const COLOR_DEFAULT = window.COLOR_DETAIL_DEFAULT || "#FFFFFF";
  const COLOR_LOOPING = window.COLOR_DETAIL_ACTIVE || "#FF0000";
  let isLooping = false;
  let togglekey = false; // 次のClipを再生するかどうかのトグル状態

  chrome.runtime.sendMessage({ type: "nf:init-bridge" });

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
    return {btn,svg : svgIcon};
  }

  function createPlayNextClipButton() {
    const svgIcon = window.LoopButtonSVG(COLOR_DEFAULT);
    const btn = document.createElement("button");
    btn.id = NEXT_BUTTON_ID;
    btn.setAttribute("aria-label", "次のクリップを再生");
    btn.appendChild(svgIcon);
    btn.style.cursor = "pointer";
    btn.addEventListener("click", () => {
      togglekey = !togglekey; // トグル状態を切り替え
      svgIcon.style.color = togglekey ? COLOR_LOOPING : COLOR_DEFAULT;
      console.log("▶️ 次のクリップを再生ボタンがクリックされました");
    });
    return { btn,svg: svgIcon};
  }

  const uiObserver = new MutationObserver(() => {
    const controls = document.querySelector(SELECTOR_STANDARD);
    const episodeBtn = document.querySelector(SELECTOR_EPISODE);
    const subtitleBtn = document.querySelector(SELECTOR_SUBTITLE);

    const loopBtnExists = document.getElementById(BUTTON_ID);
    const nextBtnExists = document.getElementById(NEXT_BUTTON_ID);

    if (controls && episodeBtn && (!loopBtnExists || !nextBtnExists)) {
      const { btn: loopButton, svg: loopSvg } = createLoopButton();
      const { btn: playNextClipButton, svg: playSvg } = createPlayNextClipButton();

      loopButton.className = episodeBtn.className;
      playNextClipButton.className = episodeBtn.className;

      // SVGの色を設定（再描画時にも反映）
      loopSvg.style.color = isLooping ? COLOR_LOOPING : COLOR_DEFAULT;
      playSvg.style.color = togglekey ? COLOR_LOOPING : COLOR_DEFAULT;

      const wrapper = document.createElement("div");
      wrapper.className = episodeBtn.parentNode.className;
      wrapper.style.display = "flex";
      wrapper.style.alignItems = "center";
      wrapper.style.gap = "0.5rem";

      const separator = document.createElement("div");
      separator.style.width = "1rem";
      separator.style.height = "100%";

      wrapper.appendChild(loopButton);
      wrapper.appendChild(separator);
      wrapper.appendChild(playNextClipButton);
      episodeBtn.parentNode.after(wrapper);

      const spacer = document.createElement("div");
      spacer.style.minWidth = "3rem";
      episodeBtn.parentNode.after(spacer);
    }else if (controls && subtitleBtn && (!loopBtnExists || !nextBtnExists) ){
      // エピソードボタンが検出されない場合、subtitleボタンの横に配置
      const { btn: loopButton, svg: loopSvg } = createLoopButton();
      const { btn: playNextClipButton, svg: playSvg } = createPlayNextClipButton();

      loopButton.className = subtitleBtn.className;
      playNextClipButton.className = subtitleBtn.className;

      // SVGの色を設定（再描画時にも反映）
      loopSvg.style.color = isLooping ? COLOR_LOOPING : COLOR_DEFAULT;
      playSvg.style.color = togglekey ? COLOR_LOOPING : COLOR_DEFAULT;

      const wrapper = document.createElement("div");
      wrapper.className = subtitleBtn.parentNode.className;
      wrapper.style.display = "flex";
      wrapper.style.alignItems = "center";
      wrapper.style.gap = "0.5rem";

      const separator = document.createElement("div");
      separator.style.width = "1rem";
      separator.style.height = "100%";

      wrapper.appendChild(loopButton);
      wrapper.appendChild(separator);
      wrapper.appendChild(playNextClipButton);
      subtitleBtn.parentNode.after(wrapper);

      const spacer = document.createElement("div");
      spacer.style.minWidth = "3rem";
      subtitleBtn.parentNode.after(spacer);
      
    }

    // プレイヤーUIが消えた時にボタンも消す
    if (!document.querySelector(SELECTOR_FWD10)) {
      document.getElementById(BUTTON_ID)?.remove();
      document.getElementById(NEXT_BUTTON_ID)?.remove();
    }
  });
  // 初期化：ページ読み込み時にUIを監視
  uiObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("beforeunload", () => uiObserver.disconnect());


  // サイドバーのトグル
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

  // API 取得 → 表示
  async function fetchDataAndRender(container) {
    try {
      const res = await fetch(getApiEndpoint('random10'));
      const data = await res.json();
      const items = data.allReceivedData || [];

      if (!items.length) {
        container.textContent = "データがありません。";
        return;
      }

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
          selectClip(item.id);
        };
        entry.appendChild(jumpBtn);
        container.appendChild(entry);
      }
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
  //Clip選択時の処理
  async function selectClip(clipId) {
    console.log("Clip selected:", clipId);

    const url = `http://localhost:3000/api/fetchClip?id=${encodeURIComponent(clipId)}`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

      const raw = await res.text();
      console.log("Raw response:", raw);

      const clipData = JSON.parse(raw);
      console.log("取得クリップデータ:", clipData);

      setClipDataOnCookies(clipData);  // Cookie保存
      redirectToClip(clipData);        // リンクにジャンプ

    } catch (err) {
      console.error("クリップ選択処理でエラー:", err);
    }
  }

  //Cookieへ保存
  function setClipDataOnCookies(data) {
    const keys = ["title", "user", "startTime", "endTime", "url", "service"];
    for (const key of keys) {
      if (data[key] !== undefined) {
        const encoded = encodeURIComponent(data[key]);
        document.cookie = `${key}=${encoded}; path=/; max-age=3600; SameSite=Lax; secure`;
        console.log(`Cookie set: ${key} = ${encoded}`);
      }
    }
  }
  // ---------------------------------------------------------------------------
  // 次のClipを再生するための関数
  // ---------------------------------------------------------------------------
  async function playNextClip() {
    // 起動フラグの設定
    await new Promise(resolve => chrome.storage.local.set({ playClipSystemKey: 1 }, resolve));

    chrome.storage.local.get(["playClipSystemKey"], (result) => {
      console.log("再生機能の起動キー:", result.playClipSystemKey);
    });

    // cookieから必要なデータを取得
    const getCookie = (name) => {
      const value = document.cookie.match(`(?:^|; )${name}=([^;]*)`);
      return value ? decodeURIComponent(value[1]) : null;
    };

    const platform =  "Netflix"; // 仮：cookieから取得、またはデフォルト
    const currentClipId = getCookie("clipId") || "000000";    // 仮：現在のclipId（任意の方法で埋め込む）
    const userId = getCookie("username") || "anonymous"; // 仮：ユーザーID

    try {
      const res = await fetch('http://localhost:3000/api/nextClip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, currentClipId, userId })
      });

      if (!res.ok) throw new Error("サーバーエラー");

      const data = await res.json();
      console.log("次のクリップ情報:", data);

      if (data?.url && typeof data.startTime === 'number') {
        // クエリパラメータで再生位置を指定して遷移
        const url = `https://www.netflix.com${data.url}?t=${Math.floor(data.startTime)}`;
        location.href = url;
      } else {
        console.warn("無効なクリップデータ:", data);
      }

    } catch (err) {
      console.error("次クリップ取得エラー:", err);
    }
  }
  // ---------------------------------------------------------------------------

  //対象サービスごとにジャンプ
  function redirectToClip({ url, service, startTime }) {
    if (!url || !service) {
      alert("URL または サービス情報が不正です");
      return;
    }

    let baseUrl;
    switch (service.toLowerCase()) {
      case "netflix":
        baseUrl = `https://www.netflix.com${url}`;
        break;
      case "amazon":
        baseUrl = `https://www.amazon.co.jp${url}`;
        break;
      case "youtube":
        baseUrl = `https://www.youtube.com${url}`;
        break;
      default:
        alert(`未対応のサービス: ${service}`);
        return;
    }

    const finalUrl = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "t=" + Math.floor(startTime);
    window.location.assign(finalUrl, "_blank");
    console.log("再生位置付きで開きます:", finalUrl);
  }

  // ---------------------------------------------------------------------------
  // URLに "clip=1" が含まれていない場合は追加し、ページをリロード
  // 理由：SPAのURL状態管理用フラグとして使用するため
  // clipDataの判断を行う　別関数化を検討中
  // ---------------------------------------------------------------------------
  function ensureClipTagInURL() {
    //clipdataの有無を取得
    chrome.storage.local.get(["playClipSystemKey"], (result) => {
    console.log("再生機能の起動キー:", result.playClipSystemKey);
    });

  }

  // ---------------------------------------------------------------------------
  // Chrome拡張のローカルストレージからclipデータを読み込む関数
  // playClipSystemKeyが1かつclipデータが存在する時だけ有効
  // ---------------------------------------------------------------------------
  function loadClipFromStorage() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(['playClipSystemKey', 'clip'], res => {
        if (chrome.runtime.lastError) {
          return reject(chrome.runtime.lastError);// 読み取りエラー処理
        }

        if (res.playClipSystemKey === 1 && res.clip) {
          clipData = res.clip;
          console.info('[Clip] loaded:', clipData);
          resolve(); // 読み込み成功
        } else {
          console.log('[Clip] No clip data or playClipSystemKey is not 1');
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Netflixの<video>タグが出現するまで待つ（SPAなので後からDOMに追加される）
  // DOM変更を監視して、<video>が現れたらresolve
  // ---------------------------------------------------------------------------
  function waitForVideoElement() {
    return new Promise(resolve => {
      const existing = document.querySelector('video');
      if (existing) return resolve(existing);

      const observer = new MutationObserver(() => {
        const v = document.querySelector('video');
        if (v) {
          observer.disconnect();
          resolve(v);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  // ---------------------------------------------------------------------------
  // メイン処理の開始：URL・clipデータ・video要素の準備ができたら再生処理へ
  // ---------------------------------------------------------------------------
  async function init() {
    ensureClipTagInURL();

    try {
      await loadClipFromStorage();
      videoPlayer = await waitForVideoElement();
      setupPlayer();
    } catch (err) {
      console.error('[Clip] Initialization failed:', err);
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // videoの再生が始まったら、endtimeまで監視し、到達したら停止・リロード
  // ---------------------------------------------------------------------------
  function setupPlayer() {
    const end = Number(clipData.endtime);
    const start = Number(clipData.starttime);

    if (videoPlayer.readyState >= 1) {
      monitorClipEnd(end,start);
      startCountdownLogger(end);
    } else {
      videoPlayer.addEventListener('loadedmetadata', () => {
        monitorClipEnd(end,start);
        startCountdownLogger(end);
      });
    }
    // エラー発生時のログ出力
    videoPlayer.addEventListener('error', e => {
      console.error('[Video] error:', e);
    });
  }

  // ---------------------------------------------------------------------------
  // 終了時間を監視し、達したらvideoを停止・イベント解除・リロード
  // ---------------------------------------------------------------------------
  function monitorClipEnd(end,start) {
    function onTimeUpdate() {
      if (videoPlayer.currentTime + EPSILON >= end) {
        console.info('[Clip] Reached end, pausing and reloading.');
        videoPlayer.removeEventListener('timeupdate', onTimeUpdate);

        clearInterval(countdownIntervalId);
        //ifで場合分けするbool値で管理
        // クリップモード終了
        if (togglekey){
          console.log("次のClipを再生");
          playNextClip(); // 次のクリップを再生
        }else {
          console.log("クリップ再度再生");
          chrome.runtime.sendMessage({ type: "seek", sec: start }); 
          init(); // クリップの最初に戻る
        }
      }
    }
    videoPlayer.addEventListener('timeupdate', onTimeUpdate);
  }
  // ---------------------------------------------------------------------------
  //毎秒、残り時間をログ出力する（開発・デバッグ用）
  // ---------------------------------------------------------------------------
  function startCountdownLogger(end) {
    if (countdownIntervalId !== null) clearInterval(countdownIntervalId);

    countdownIntervalId = setInterval(() => {
      if (!videoPlayer) return;
      const remaining = Math.max(0, end - videoPlayer.currentTime);
      console.log(`[Countdown] ${remaining.toFixed(1)} seconds remaining until end.`);
    }, 1000);
  }



  // ---------------------------------------------------------------------------
  // リロード周りでのsystem終了処理
  //-----------------------------------------------------------------------------
  //リロードイベントのスクリプト
  function reloadPageFromScript() {
    isScriptReloading = true;
    location.reload();
  }

  window.addEventListener('beforeunload', (event) => {
  if (!isScriptReloading) {
    console.log('ユーザー操作など、スクリプト以外による再読み込みまたはページ遷移');
    // ここでスクリプト以外による再読み込み時の処理を行う
    chrome.storage.local.set({ playClipSystemKey: 0 }, () => {
      console.log("playClipSystemKeyを0に設定しました。");
    });
  } else {
    console.log('スクリプトによる再読み込み');
    // スクリプトによる再読み込み後の処理が必要な場合は、
    // localStorage や sessionStorage にフラグを保存し、
    // load イベントなどで確認する方法を検討してください。
    isScriptReloading = false; // フラグをリセット
  }
  });
  // ---------------------------------------------------------------------------
  // ページの読み込みが完了したらinit()を実行
  // ---------------------------------------------------------------------------
  window.addEventListener('load', init);

})();
