// プレイヤー内ボタンの SVG アイコン定義とファクトリ。各アイコンは寸法・色を持たず、
// 色は currentColor を通じて呼び出し側が決める。

/** アイコンのデフォルト色（白）。 */
export const COLOR_DEFAULT = "#FFFFFF";
/** アイコンのアクティブ色（赤。録画中・ループ ON など）。 */
export const COLOR_ACTIVE = "#FF0000";

/**
 * アイコン名 → SVG マークアップ。
 * stroke は currentColor 固定・寸法は持たない（寸法は createIcon が付与）。
 * @type {Record<string, string>}
 */
const MARKUP = {
  // 録画ボタン（旧 recordSVG.createSVG）
  record: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10"
         aria-hidden="true" focusable="false">
      <rect x="1.5" y="9.14" width="15.27" height="12.41" />
      <polygon points="16.77 17.73 21.55 21.55 22.5 21.55 22.5 9.14 21.55 9.14 16.77 12.96 16.77 17.73" />
      <circle cx="4.84" cy="5.8" r="3.34" />
      <circle cx="13.43" cy="5.8" r="3.34" />
      <polygon points="7.23 16.77 7.23 13.91 10.09 15.34 7.23 16.77" />
    </svg>`,
  // ループ矢印（旧 LoopButtonSVG）
  loop: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10"
         stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <path d="M3.58 5.16H17.42c1.66 0 3 1.34 3 3v3.32" />
      <path d="M6.74 2l-3.16 3.16L6.74 8.32" />
      <path d="M20.42 18.84H6.58c-1.66 0-3-1.34-3-3v-3.32" />
      <path d="M17.26 22l3.16-3.16L17.26 15.68" />
    </svg>`,
  // 一覧（コンパス風。旧 moreDetailSVG.createMoreDetailSVG）
  list: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10"
         stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <path d="M12 2a10 10 0 1 1 0 20a10 10 0 1 1 0-20z" />
      <path d="M10 10l6 -2l-2 6l-6 2z" />
    </svg>`,
};

/** 色変化をアニメーションするアイコン（旧 moreDetailSVG / LoopButtonSVG の挙動）。 */
const COLOR_TRANSITION = new Set(["loop", "list"]);

/** アイコン名の一覧（凍結）。 */
export const ICON_NAMES = Object.freeze(Object.keys(MARKUP));

/**
 * 既知のアイコン名かどうかを判定する純粋関数（DOM 非依存・テスト対象）。
 * @param {string} name
 * @returns {boolean}
 */
export function isIconName(name) {
  return Object.hasOwn(MARKUP, name);
}

/**
 * このファイル内の静的マークアップ定数から <svg> 要素を生成する。
 * innerHTML を使うが、入力は必ずこのファイル内の定数のみ。
 * ページ / API 由来の文字列を渡さないこと（refs #96 / #97 の制約とは別物）。
 * @param {string} markup
 * @returns {SVGSVGElement}
 */
function fromMarkup(markup) {
  const template = document.createElement("template");
  template.innerHTML = markup.trim();
  return /** @type {SVGSVGElement} */ (template.content.firstElementChild);
}

/**
 * アイコン名から SVG 要素を生成する。未知の名前は Error を投げる。
 * @param {'record'|'loop'|'list'} name
 * @returns {SVGSVGElement}
 */
export function createIcon(name) {
  if (!isIconName(name)) {
    throw new Error(`Unknown icon name: ${name}`);
  }
  const icon = fromMarkup(MARKUP[name]);
  // 従来の実寸（120%）を保つため生成時に明示する。
  icon.setAttribute("width", "120%");
  icon.setAttribute("height", "120%");
  if (COLOR_TRANSITION.has(name)) {
    icon.style.transition = "color 0.2s ease";
  }
  return icon;
}
