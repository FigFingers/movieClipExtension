(() => {
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const COLOR_DEFAULT = "#FFFFFF";
  const COLOR_RECORDING = "#FF0000";

  function createSVG(width = "120%", height = "120%") {//デフォルトは120%でnetflixにフィットさせています。
    const svg = createSVGElement("svg", {
      id: "Layer_1",
      "data-name": "Layer 1",
      xmlns: SVG_NAMESPACE,
      viewBox: "0 0 24 24",
      "stroke-width": "1.5",
      width: width,
      height: height,
      color: COLOR_DEFAULT
    });

    const style = createSVGElement("style", {});
    style.textContent = ".cls-637630c1c3a86d32eae6f029-1{fill:none;stroke:currentColor;stroke-miterlimit:10;}";
    svg.appendChild(style);

    svg.appendChild(createSVGElement("rect", {
      class: "cls-637630c1c3a86d32eae6f029-1",
      x: "1.5",
      y: "9.14",
      width: "15.27",
      height: "12.41"
    }));

    svg.appendChild(createSVGElement("polygon", {
      class: "cls-637630c1c3a86d32eae6f029-1",
      points: "16.77 17.73 21.55 21.55 22.5 21.55 22.5 9.14 21.55 9.14 16.77 12.96 16.77 17.73"
    }));

    svg.appendChild(createSVGElement("circle", {
      class: "cls-637630c1c3a86d32eae6f029-1",
      cx: "4.84",
      cy: "5.8",
      r: "3.34"
    }));

    svg.appendChild(createSVGElement("circle", {
      class: "cls-637630c1c3a86d32eae6f029-1",
      cx: "13.43",
      cy: "5.8",
      r: "3.34"
    }));

    svg.appendChild(createSVGElement("polygon", {
      class: "cls-637630c1c3a86d32eae6f029-1",
      points: "7.23 16.77 7.23 13.91 10.09 15.34 7.23 16.77"
    }));

    return svg;
  }

  function createSVGElement(type, attributes) {
    const elem = document.createElementNS(SVG_NAMESPACE, type);
    for (const [key, value] of Object.entries(attributes)) {
      elem.setAttribute(key, value);
    }
    return elem;
  }

  //グローバルに登録
  window.createSVG = createSVG;
  window.COLOR_DEFAULT = COLOR_DEFAULT;
  window.COLOR_RECORDING = COLOR_RECORDING;
})();
