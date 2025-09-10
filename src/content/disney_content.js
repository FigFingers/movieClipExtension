import "../css/content_button.css";
import "../image/moreDetailSVG.js";
import "../image/recordSVG.js";
import "../image/LoopButtonSVG.js";

(function () {
	const BTN_ID = "dplus-helper-button";
	const HISTORY_HOOK_FLAG = "__dplus_history_hooked__";

	const ARIA_LABEL = "Record";

	function inject() {
		if (document.getElementById(BTN_ID)) return;
		if (!document.body) return;

		const btn = document.createElement("button");
		btn.id = BTN_ID;
		btn.type = "button";
		btn.className = "dplus-helper-btn";
		btn.setAttribute("aria-label", ARIA_LABEL);
		btn.title = ARIA_LABEL;

		Object.assign(btn.style, {
			position: "fixed",
			left: "0px",
			bottom: "0px",
			zIndex: 2147483647,
		});

		// --- SVGを直接描画する ---
		const svgElement = window.createSVG("20%", "20%"); // ここでサイズを指定
		btn.appendChild(svgElement);

		btn.addEventListener("click", () => {
			const timestamp = new Date().toISOString();
			console.log(
				`[Disney+ Ext] ${ARIA_LABEL} clicked @ ${timestamp} | url=`,
				location.href,
			);
		});

		document.body.appendChild(btn);
	}

	// SPA対応
	function hookHistory() {
		if (window[HISTORY_HOOK_FLAG]) return;
		window[HISTORY_HOOK_FLAG] = true;
		const dispatch = () => window.dispatchEvent(new Event("locationchange"));
		["pushState", "replaceState"].forEach((type) => {
			const orig = history[type];
			if (typeof orig !== "function") return;
			history[type] = function () {
				const ret = orig.apply(this, arguments);
				dispatch();
				return ret;
			};
		});
		window.addEventListener("popstate", dispatch);
	}

	function main() {
		hookHistory();
		window.addEventListener("locationchange", () => setTimeout(inject, 300));
		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", inject, { once: true });
		} else {
			inject();
		}
		window.addEventListener("load", inject, { once: true });
	}

	main();
})();
