chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'HISTORY_CHANGE') {
      console.log('URLが変更されました:', message.data.url);
    }
  });

//再生と録画を切り替える値
  let playClipSystemKey = "initialValue";


//netflix用ブリッジ注入
// content から {type:"nf:init-bridge"} を受けたタブに、MAINワールドでブリッジを注入
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "nf:init-bridge") return;

  const tabId = sender?.tab?.id;
  if (!tabId) return;

  chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      if (window.__nfBridgeInjected__) return; // 二重注入防止
      window.__nfBridgeInjected__ = true;

      (function pageBridge() {
        function getNetflixPlayer() {
          try {
            const appCtx    = window.netflix?.appContext;
            const playerApp = appCtx?.state?.playerApp?.getAPI?.();
            const vp        = playerApp?.videoPlayer;
            const ids       = vp?.getAllPlayerSessionIds?.();
            if (!ids?.length) return null;
            return vp?.getVideoPlayerBySessionId?.(ids[0]) || null;
          } catch { return null; }
        }
        // 秒⇔ミリ秒の自動判定（duration が 1e5 超なら ms 系）
        function seekSeconds(p, sec) {
          let dur = 0;
          try { dur = p.getDuration?.() ?? 0; } catch {}
          const useMs  = dur > 1e5;
          const target = useMs ? sec * 1000 : sec;
          p.seek?.(target);
        }
        function doSeek(sec) {
          if (!Number.isFinite(sec)) return;
          let tries = 30;
          (function go() {
            const p = getNetflixPlayer();
            if (!p) { if (tries-- > 0) return setTimeout(go, 200); else return; }
            seekSeconds(p, sec);
          })();
        }
        // content → page のコマンド受け口
        window.addEventListener("message", (ev) => {
          const d = ev.data;
          if (!d || d.__nf_cmd !== "seek") return;
          doSeek(Number(d.sec));
        });
      })();
    }
  }, () => sendResponse({ ok: true }));

  return true; // async sendResponse
});


