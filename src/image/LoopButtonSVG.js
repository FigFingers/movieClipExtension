(() => {
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const COLOR_DEFAULT = "#FFFFFF";
  const COLOR_ACTIVE = "#FF0000";  // optional: 詳細表示時などに変更可

  function LoopButtonSVG(color = COLOR_DEFAULT) {
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
      { d: "M3.58 5.16H17.42c1.66 0 3 1.34 3 3v3.32" },
      { d: "M6.74 2l-3.16 3.16L6.74 8.32" },
      { d: "M20.42 18.84H6.58c-1.66 0-3-1.34-3-3v-3.32" },
      { d: "M17.26 22l3.16-3.16L17.26 15.68" }
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
  window.LoopButtonSVG = LoopButtonSVG;
  window.COLOR_RECT_DEFAULT = COLOR_DEFAULT;
  window.COLOR_RECT_ACTIVE = COLOR_ACTIVE;
})();
