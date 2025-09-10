(function () {
	function injectScript(file, tag) {
		const script = document.createElement("script");
		script.src = chrome.runtime.getURL(file);
		script.onload = function () {
			this.remove();
		};
		(tag || document.head).appendChild(script);
	}

	injectScript("src/util/history_change.js");
})();
