import "../css/content_button.css";
import "../image/moreDetailSVG.js";
import "../image/recordSVG.js";
import "../image/LoopButtonSVG.js";
import "./playClipNetflix.js";
import { getApiEndpoint } from './../api.js';

(function() {
  const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
  const BUTTON_ID = 'record-button';

  const SELECTORS = {
    videoPlayer: 'video',
    videoTitle: '[data-uia="video-title"]',
    controlsStandard: '[data-uia="controls-standard"]',
    controlVolume: '[data-uia^="control-volume-"]', 
    controlForward10: '[data-uia="control-forward10"]',
  };



  window.addEventListener('load', () => {
    // 履歴変更フック用スクリプトをページワールドへ注入
    injectScript('src/util/history_change.js');

    // 要素の作成
    const buttonMargin = createButtonMargin();
    const wrapButton = document.createElement('div');
    const recordButton = createRecordButton();
    const svgElement = window.createSVG();

    // 状態管理変数
    let isRecording = false;
    let startTime;
    let endTime;
    let currentPath;

    // イベントリスナーの設定
    recordButton.addEventListener('click', handleRecordButtonClick);

    // MutationObserverの設定
    const observer = new MutationObserver(mutationCallback);
    observer.observe(document.body, { childList: true, subtree: true });

    // ページを離れたときにオブザーバーを停止
    window.addEventListener('beforeunload', () => {
      observer.disconnect();
    });

    window.addEventListener('historyChange', function(e) {
      const detail = e.detail;
      console.log('History changed:', detail);
      init();

      // 必要に応じてバックグラウンドスクリプトにメッセージを送信
      chrome.runtime.sendMessage({
        type: 'HISTORY_CHANGE',
        data: detail
      });
    });

    // 関数定義

    function injectScript(file, tag) {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(file);
      script.onload = function() {
        console.log(`Injected script: ${file}`);
        this.remove();
      };
      (tag || document.head).appendChild(script);
    }

    function createButtonMargin() {
      const margin = document.createElement('div');
      margin.style.minWidth = '3rem';
      margin.style.width = '3rem';
      return margin;
    }

    function createRecordButton() {
      const button = document.createElement('button');
      button.id = BUTTON_ID;
      button.setAttribute('aria-label', '録画ボタン');
      return button;
    }
    function createSVGElement(type, attributes) {
      const elem = document.createElementNS(SVG_NAMESPACE, type);
      for (const [key, value] of Object.entries(attributes)) {
        elem.setAttribute(key, value);
      }
      return elem;
    }

    function handleRecordButtonClick() {
      try { // 関数内でエラーハンドリング
        const videoPlayer = document.querySelector(SELECTORS.videoPlayer);
        if (!videoPlayer) {
          throw new Error('ビデオプレーヤーが見つかりません。');
        }
        const allTitleName = document.querySelector(SELECTORS.videoTitle);

        if (isRecording) {
          endTime = videoPlayer.currentTime;
          currentPath = window.location.pathname;
          if(startTime > endTime){
            throw new Error('録画終了時刻が開始時刻よりも早い値です');
          }
          const checkSecond = Math.abs(endTime - startTime);
          if(checkSecond < 1){
            svgElement.setAttribute('color', window.COLOR_RECORDING);
            throw new Error('録画範囲が短すぎます');
          }

          const data = {
            StartTime: startTime,
            EndTime: endTime,
            URL: currentPath,
          };
          data.service = detectService();
          data.user = 'test_user';


          if (allTitleName) {
            const h4Element = allTitleName.querySelector('h4');
            if (h4Element) {
              // シリーズ作品の場合
              data.title = h4Element.textContent;
              const episodeNumberElement = allTitleName.querySelector('span:nth-of-type(1)');
              if (episodeNumberElement) {
                data.epnumber = episodeNumberElement.textContent;
              }
            } else {
              // シリーズ作品ではない場合
              data.title = allTitleName.textContent;
            }
          } else {
            throw new Error('タイトル要素が見つかりません。');
          }
          console.log("録画データ:", data);
          //動画を一時停止
          videoPlayer.pause();
          openSidebar(data, videoPlayer); // サイドバーを開く
          init();
        } else {
          svgElement.setAttribute('color', window.COLOR_RECORDING);
          isRecording = true;
          startTime = videoPlayer.currentTime;
        }
      } catch (error) {
        console.error(error);
        // ユーザーにエラーを通知するUIをここに追加可能
        alert(error.message); // 例: アラートで通知
        init();
      }
    }

    function addElements() {
      const controlsStandardElement = document.querySelector(SELECTORS.controlsStandard);
      if (controlsStandardElement) {
        const controlVolumeElement = document.querySelector(SELECTORS.controlVolume);
        if (controlVolumeElement) {
          recordButton.className = controlVolumeElement.className;
          recordButton.appendChild(svgElement);
          wrapButton.className = controlVolumeElement.parentNode.className;
          controlVolumeElement.parentNode.after(wrapButton);
          wrapButton.appendChild(recordButton);
          controlVolumeElement.parentNode.after(buttonMargin);
        }
      }
    }

    function mutationCallback(mutationsList) {

      const controlsForward10Element = document.querySelector(SELECTORS.controlForward10);
      if (controlsForward10Element && !document.getElementById(BUTTON_ID)) {
        addElements();
      } else if (!controlsForward10Element && document.getElementById(BUTTON_ID)) {
        buttonMargin.remove();
        recordButton.remove();
      }
    }

    function init() { // 必要なリセット処理があればここに追加
      isRecording = false;
      startTime = null;
      endTime = null;
      svgElement.setAttribute('color', window.COLOR_DEFAULT);
    }
  });
  /**
   * 今いる動画サービスをホスト名から判定
   * @returns {string} サービス名
   */
    function detectService() {
      const host = window.location.hostname;
      if (host.includes('netflix.com')) return 'Netflix';
      if (host.includes('primevideo.com')) return 'Prime Video';
      if (host.includes('youtube.com')) return 'YouTube';
      if (host.includes('disneyplus.com')) return 'Disney+';
      if (host.includes('hulu.jp') || host.includes('hulu.com')) return 'Hulu';
      return 'Unknown';
    }
    function openSidebar(data, videoPlayer) {
      const SIDEBAR_ID = "nf-memo-sidebar";
      const SIDEBAR_PCT = 20;

      const player = document.querySelector(".watch-video--player-view") || videoPlayer?.parentElement;
      if (!player) return;

      document.getElementById(SIDEBAR_ID)?.remove();

      player.style.transition = "width .3s";
      player.style.width = `calc(100% - ${SIDEBAR_PCT}%)`;

      const sb = document.createElement("div");
      sb.id = SIDEBAR_ID;
      sb.style.cssText = `
        position:fixed;top:0;right:0;width:${SIDEBAR_PCT}%;
        height:100%;background:rgba(0,0,0,.85);padding:10px;
        box-sizing:border-box;z-index:9999;display:flex;flex-direction:column;gap:8px;`;

      const header = document.createElement("div");
      header.style.cssText = "display:flex;justify-content:space-between;align-items:center;";
      const title = document.createElement("strong");
      title.textContent = "録画メモ";
      const closeBtn = document.createElement("button");
      closeBtn.textContent = "×";
      closeBtn.style.cssText = "background:red;color:#fff;border:none;cursor:pointer;";
      closeBtn.onclick = () => {
        player.style.width = "100%";
        sb.remove();
      };
      header.append(title, closeBtn);
      sb.appendChild(header);

      const infoBox = document.createElement("div");
      infoBox.style.fontSize = "12px";
      const start = Math.floor(data?.StartTime || 0);
      const end = Math.floor(data?.EndTime || 0);
      const formatTime = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
      infoBox.innerHTML = `
        <div><b>タイトル:</b> ${data?.title || '(不明)'}</div>
        <div><b>エピソード:</b> ${data?.epnumber || '-'}</div>
        <div><b>サービス:</b> ${data?.service || '-'}</div>
        <div><b>開始:</b> ${formatTime(start)}</div>
        <div><b>終了:</b> ${formatTime(end)}</div>
        <div><b>URL:</b> ${data?.URL || location.href}</div>`;
      sb.appendChild(infoBox);

      const nameLabel = document.createElement("label");
      nameLabel.style.cssText = "font-size:12px;color:#000;";
      nameLabel.textContent = "名前:";
      const nameInput = document.createElement("input");
      nameInput.style.cssText = "width:100%;margin-top:4px;";
      nameLabel.appendChild(nameInput);
      sb.appendChild(nameLabel);

      const saveBtn = document.createElement("button");
      saveBtn.textContent = "保存";
      saveBtn.style.cssText = "background:#00c853;border:none;color:#fff;padding:6px;cursor:pointer;";

      saveBtn.onclick = () => {
        const enriched = {
          ...data,
          clipName: nameInput.value.trim(),
        };
        console.log("保存データ:", enriched);
        sendData(enriched);
        //alert("送信しました！");
        videoPlayer.play(); // ← ここで再生
        closeBtn.click();
      };
      sb.appendChild(saveBtn);

      document.body.appendChild(sb);
    }


      /**
   * データをサーバーに送信する関数
   * @param {Object} dataToSend - 送信するデータ
   */
  function sendData(dataToSend) {
    fetch(getApiEndpoint('receive'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(dataToSend),
    })
    .then((response) => response.json())
    .then((data) => {
      console.log('Success:', data);
      // ユーザーに成功を通知するUIを追加可能
    })
    .catch((error) => {
      console.error('Error:', error);
      // ユーザーにエラーを通知するUIを追加可能
    });
  }
})();
