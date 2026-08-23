(() => {
    // manifest / inject_script.js / content_netflix.js の複数経路から注入されうるため、
    // 同一 world 内での二重フック（historyChange の重複発火）をガードする。
    if (window.__extHistoryChangeHooked__) return;
    window.__extHistoryChangeHooked__ = true;

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
  
    function notifyHistoryChange(method, args) {
      const event = new CustomEvent('historyChange', {
        detail: {
          method: method,
          url: args[2] || window.location.href
        }
      });
      window.dispatchEvent(event);
    }
  
    history.pushState = function(...args) {
      const result = originalPushState.apply(this, args);
      notifyHistoryChange('pushState', args);
      return result;
    };
  
    history.replaceState = function(...args) {
      const result = originalReplaceState.apply(this, args);
      notifyHistoryChange('replaceState', args);
      return result;
    };
  
    // popstate イベントも監視
    window.addEventListener('popstate', () => {
      const changeEvent = new CustomEvent('historyChange', {
        detail: {
          method: 'popstate',
          url: window.location.href
        }
      });
      window.dispatchEvent(changeEvent);
    });
  })();
