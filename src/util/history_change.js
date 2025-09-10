(function () {
	const originalPushState = history.pushState;
	const originalReplaceState = history.replaceState;

	function notifyHistoryChange(method, args) {
		const event = new CustomEvent("historyChange", {
			detail: {
				method: method,
				url: args[2] || window.location.href,
			},
		});
		window.dispatchEvent(event);
	}

	history.pushState = function (...args) {
		const result = originalPushState.apply(this, args);
		notifyHistoryChange("pushState", args);
		return result;
	};

	history.replaceState = function (...args) {
		const result = originalReplaceState.apply(this, args);
		notifyHistoryChange("replaceState", args);
		return result;
	};

	// popstate イベントも監視
	window.addEventListener("popstate", function (event) {
		const changeEvent = new CustomEvent("historyChange", {
			detail: {
				method: "popstate",
				url: window.location.href,
			},
		});
		window.dispatchEvent(changeEvent);
	});
})();
