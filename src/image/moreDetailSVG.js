(() => {
	const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
	const COLOR_DEFAULT = "#FFFFFF";
	const COLOR_ACTIVE = "#FF0000"; // optional: 詳細表示時などに変更可

	function createMoreDetailSVG(color = COLOR_DEFAULT) {
		const svg = document.createElementNS(SVG_NAMESPACE, "svg");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("width", "120%");
		svg.setAttribute("height", "120%");
		svg.style.color = color;
		svg.style.transition = "color 0.2s ease";

		const style = document.createElementNS(SVG_NAMESPACE, "style");
		style.textContent = `
      .more-detail-icon {
        fill: none;
        stroke: currentColor;
        stroke-width: 1.5;
        stroke-miterlimit: 10;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
    `;
		svg.appendChild(style);

		const paths = [
			{ d: "M12 2a10 10 0 1 1 0 20a10 10 0 1 1 0-20z" }, // 外円
			{ d: "M10 10l6 -2l-2 6l-6 2z" }, // 針（ひし形）
		];

		for (const { d } of paths) {
			const path = document.createElementNS(SVG_NAMESPACE, "path");
			path.setAttribute("d", d);
			path.setAttribute("class", "more-detail-icon");
			svg.appendChild(path);
		}

		return svg;
	}

	// グローバル登録
	window.createMoreDetailSVG = createMoreDetailSVG;
	window.COLOR_DETAIL_DEFAULT = COLOR_DEFAULT;
	window.COLOR_DETAIL_ACTIVE = COLOR_ACTIVE;
})();
