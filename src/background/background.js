chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'HISTORY_CHANGE') {
      console.log('URLが変更されました:', message.data.url);
    }
  });

//再生と録画を切り替える値
  let playClipSystemKey = "initialValue";


//netflix用ブリッジ注入
// background.js — content から {type:"seek", sec:数字} を受け取ってシーク
chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
  if (msg?.type !== "seek") return;

  const sec = Number(msg.sec);
  if (!Number.isFinite(sec)) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (!/^https:\/\/www\.netflix\.com\/watch\//.test(tab.url || "")) return;// Clip再生ページを判定するロジックをここで追加　クエリで要れる

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    args: [sec],
    func: (sec) => {
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

      function seekSeconds(p, sec) {
        let dur = 0;
        try { dur = p.getDuration?.() ?? 0; } catch {}
        const useMs = dur > 1e5;
        const target = useMs ? sec * 1000 : sec;
        p.seek?.(target);
      }

      let tries = 30;
      (function go() {
        const p = getNetflixPlayer();
        if (!p) { if (tries-- > 0) return setTimeout(go, 200); else return; }
        seekSeconds(p, sec);
      })();
    }
  });

  sendResponse({ ok: true });
  return true; // async sendResponse のため
});



