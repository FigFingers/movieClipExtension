import "../css/content_button.css";
import "../image/moreDetailSVG.js";
import "../image/recordSVG.js";
import "../image/LoopButtonSVG.js";
import "./playClipNetflix.js";
import { detectService, openMemoSidebar, sendData } from './common.js';
import {
  fetchSession,
  isLoggedIn
} from '../auth/authClient.js'; // NOTE: authClient path is relative to src/content

(function() {
  const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
  const BUTTON_ID = 'record-button';
  const AUTH_MESSAGE_ID = 'mc-auth-message';

  const SELECTORS = {
    videoPlayer: 'video',
    videoTitle: '[data-uia="video-title"]',
    controlsStandard: '[data-uia="controls-standard"]',
    controlVolume: '[data-uia^="control-volume-"]', 
    controlForward10: '[data-uia="control-forward10"]',
  };

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
    return false;
  }

  async function ensureAuthAndBootstrap() {
    const ok = await requireAuthOrShowLogin();
    if (!ok) return;

    if (!hasBootstrapped) {
      bootstrapApp();
      hasBootstrapped = true;
      return;
    }

    if (typeof window.mcResetState === 'function') {
      window.mcResetState();
    }
  }

  function bootstrapApp() {
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
          openMemoSidebar({
            data,
            videoPlayer,
            onSave: (payload) => sendData(payload),
            sidebarTitle: "Clipを追加 - Netflix",
          }); // サイドバーを開く
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

    window.mcResetState = init;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'AUTH_DONE') {
      authInProgress = false;
      ensureAuthAndBootstrap();
    }
  });

  if (document.readyState === 'loading') {
    window.addEventListener('load', ensureAuthAndBootstrap, { once: true });
  } else {
    ensureAuthAndBootstrap();
  }
})();
