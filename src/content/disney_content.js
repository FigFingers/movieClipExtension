import "../css/content_button.css";
import "../image/moreDetailSVG.js";
import "../image/recordSVG.js";
import "../image/LoopButtonSVG.js";
(function () {
const BTN_ID = "dplus-helper-button";


function inject() {
if (document.getElementById(BTN_ID)) return; // 二重挿入防止
if (!document.body) return;


const btn = document.createElement("button");
btn.id = BTN_ID;
btn.textContent = "Log"; // 表示テキストは任意


// シンプルな固定表示（プレイヤーUIに依存しない）
Object.assign(btn.style, {
position: "fixed",
left: "16px",
bottom: "16px",
zIndex: 999999,
padding: "10px 14px",
fontSize: "14px",
borderRadius: "12px",
border: "1px solid rgba(255,255,255,0.25)",
background: "rgba(0,0,0,0.6)",
color: "#fff",
cursor: "pointer",
backdropFilter: "blur(4px)",
WebkitBackdropFilter: "blur(4px)",
});


btn.addEventListener("click", () => {
const timestamp = new Date().toISOString();
console.log(`[Disney+ Ext] Button clicked @ ${timestamp} | url=`, location.href);
});


document.body.appendChild(btn);
}


// SPA（ルーター遷移）対応：URL 変化を検知して再注入
function hookHistory() {
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
// 初回 & ルート遷移後に実行
window.addEventListener("locationchange", () => setTimeout(inject, 300));
if (document.readyState === "loading") {
document.addEventListener("DOMContentLoaded", inject);
} else {
inject();
}
window.addEventListener("load", inject);
}


main();
})();