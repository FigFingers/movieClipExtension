// contentMain.originalObserver.js
// 単一のMutationObserverでNetflix UI出現時に3ボタンを注入する「元ロジック」実装
// - 録画 / 次クリップ / サイドバー（一覧）
// - 既存のAPIエンドポイント/ヘルパに準拠
// - UI消失時はボタンを撤去

import "../css/content_button.css";
import "../image/moreDetailSVG.js"; // window.createMoreDetailSVG(color)
import "../image/recordSVG.js"; // window.createSVG()
import "../image/LoopButtonSVG.js"; // window.LoopButtonSVG(color)
import { getApiEndpoint } from "./../api.js";

(function () {
	"use strict";

	// ---------------------------------------------------------------------------
	// 定数/セレクタ/ID
	// ---------------------------------------------------------------------------
	const SELECTOR_STANDARD = '[data-uia="controls-standard"]';
	const SELECTOR_EPISODE = '[data-uia="control-episodes"]';
	const SELECTOR_FWD10 = '[data-uia="control-forward10"]';
	const SELECTOR_VOLUME = '[data-uia="control-volume-high"]';
	const SELECTOR_TITLE = '[data-uia="video-title"]';

	const IDS = {
		recordBtn: "nf-record-button",
		toggleSidebarBtn: "nf-loop-toggle-btn",
		nextClipBtn: "nf-next-clip-btn",
		wrapper: "nf-controls-wrapper",
		spacer: "nf-controls-spacer",
		sidebar: "nf-memo-sidebar",
		listContainer: "nf-api-list",
	};

	const COLORS = {
		default: window.COLOR_DETAIL_DEFAULT || "#FFFFFF",
		active: window.COLOR_DETAIL_ACTIVE || "#FF0000",
		recording: window.COLOR_RECORDING || "#FF5252",
	};

	const EPSILON = 0.05; // クリップ終了判定
	const SIDEBAR_PCT = 24; // サイドバー幅

	// ---------------------------------------------------------------------------
	// 状態
	// ---------------------------------------------------------------------------
	let videoEl = null; // <video>
	let isRecording = false;
	let recordStart = null;
	let recordEnd = null;

	let clipData = null; // { starttime, endtime, ... }
	let isLoopSidebarOn = false; // サイドバー（一覧）トグル
	let nextClipToggleOn = false; // 次のクリップ自動再生トグル
	let countdownIntervalId = null;

	// ---------------------------------------------------------------------------
	// ユーティリティ
	// ---------------------------------------------------------------------------
	const q = (sel, root = document) => root.querySelector(sel);
	const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

	function formatTime(sec) {
		const s = Math.floor(sec % 60)
			.toString()
			.padStart(2, "0");
		const m = Math.floor(sec / 60);
		return `${m}:${s}`;
	}

	function detectService() {
		const host = location.hostname;
		if (host.includes("netflix.com")) return "Netflix";
		if (host.includes("primevideo.com")) return "Prime Video";
		if (host.includes("youtube.com")) return "YouTube";
		if (host.includes("disneyplus.com")) return "Disney+";
		if (host.includes("hulu.jp") || host.includes("hulu.com")) return "Hulu";
		return "Unknown";
	}

	function setCookie(name, value, maxAgeSec = 3600) {
		document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSec}; SameSite=Lax; secure`;
	}

	// ---------------------------------------------------------------------------
	// サイドバー（一覧/録画）
	// ---------------------------------------------------------------------------
	function resizePlayerForSidebar(enable) {
		const player = q(".watch-video--player-view") || videoEl?.parentElement;
		if (!player) return;
		player.style.transition = "width .3s";
		player.style.width = enable ? `calc(100% - ${SIDEBAR_PCT}%)` : "100%";
	}

	function openSidebarList() {
		closeSidebar();
		resizePlayerForSidebar(true);

		const sb = document.createElement("div");
		sb.id = IDS.sidebar;
		sb.style.cssText = `position:fixed;top:0;right:0;width:${SIDEBAR_PCT}%;height:100%;background:rgba(0,0,0,.9);color:#fff;padding:10px;box-sizing:border-box;z-index:9999;display:flex;flex-direction:column;gap:10px;overflow-y:auto;font-size:12px;`;

		// ヘッダー
		const header = document.createElement("div");
		header.style.cssText =
			"display:flex;justify-content:space-between;align-items:center;";
		const title = document.createElement("strong");
		title.textContent = "記録一覧";
		const closeBtn = document.createElement("button");
		closeBtn.textContent = "×";
		closeBtn.style.cssText =
			"background:red;color:#fff;border:none;cursor:pointer;font-size:14px;";
		closeBtn.onclick = () => {
			isLoopSidebarOn = false;
			closeSidebar();
		};
		header.append(title, closeBtn);

		const list = document.createElement("div");
		list.id = IDS.listContainer;
		list.textContent = "読込中…";

		sb.append(header, list);
		document.body.appendChild(sb);

		// データ取得
		fetchListAndRender(list);
	}

	async function fetchListAndRender(container) {
		try {
			const res = await fetch(getApiEndpoint("random10"));
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			const items = data.allReceivedData || [];
			if (!items.length) {
				container.textContent = "データがありません。";
				return;
			}
			container.innerHTML = "";
			for (const item of items) {
				const entry = document.createElement("div");
				entry.style.cssText = "border-bottom:1px solid #555;padding:4px 0;";
				entry.innerHTML = `
          <div><strong>${item.title}（${item.epnumber ?? "-"}）</strong></div>
          <div>ユーザー: ${item.user ?? "-"}</div>
          <div>範囲: ${formatTime(item.startTime)} - ${formatTime(item.endTime)}</div>`;
				const jump = document.createElement("button");
				jump.textContent = "▶ このClipへジャンプ";
				jump.style.cssText =
					"margin-top:4px;background:#0f0;color:#000;border:none;padding:4px 8px;cursor:pointer;";
				jump.onclick = () => selectClip(item.id);
				entry.appendChild(jump);
				container.appendChild(entry);
			}
		} catch (e) {
			console.error("一覧取得失敗:", e);
			container.textContent = "データの取得に失敗しました。";
		}
	}

	function openSidebarRecord(data) {
		closeSidebar();
		resizePlayerForSidebar(true);

		const sb = document.createElement("div");
		sb.id = IDS.sidebar;
		sb.style.cssText = `position:fixed;top:0;right:0;width:${SIDEBAR_PCT}%;height:100%;background:rgba(0,0,0,.9);color:#fff;padding:10px;box-sizing:border-box;z-index:9999;display:flex;flex-direction:column;gap:10px;overflow-y:auto;font-size:12px;`;

		const header = document.createElement("div");
		header.style.cssText =
			"display:flex;justify-content:space-between;align-items:center;";
		const title = document.createElement("strong");
		title.textContent = "録画メモ";
		const closeBtn = document.createElement("button");
		closeBtn.textContent = "×";
		closeBtn.style.cssText =
			"background:red;color:#fff;border:none;cursor:pointer;font-size:14px;";
		closeBtn.onclick = () => {
			closeSidebar();
			videoEl?.play?.();
		};
		header.append(title, closeBtn);

		const info = document.createElement("div");
		info.style.fontSize = "12px";
		const start = Math.floor(data?.StartTime || 0);
		const end = Math.floor(data?.EndTime || 0);
		const format = (s) =>
			`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
		info.innerHTML = `
      <div><b>タイトル:</b> ${data?.title || "(不明)"}</div>
      <div><b>エピソード:</b> ${data?.epnumber || "-"}</div>
      <div><b>サービス:</b> ${data?.service || "-"}</div>
      <div><b>開始:</b> ${format(start)}</div>
      <div><b>終了:</b> ${format(end)}</div>
      <div><b>URL:</b> ${data?.URL || location.pathname}</div>`;

		const nameLabel = document.createElement("label");
		nameLabel.style.cssText = "font-size:12px;";
		nameLabel.textContent = "名前:";
		const nameInput = document.createElement("input");
		nameInput.style.cssText = "width:100%;margin-top:4px;";
		nameLabel.appendChild(nameInput);

		const save = document.createElement("button");
		save.textContent = "保存";
		save.style.cssText =
			"background:#00c853;border:none;color:#fff;padding:6px;cursor:pointer;";
		save.onclick = () => {
			const enriched = { ...data, clipName: nameInput.value.trim() };
			sendRecord(enriched);
			alert("送信しました！");
			videoEl?.play?.();
			closeSidebar();
		};

		sb.append(header, info, nameLabel, save);
		document.body.appendChild(sb);
	}

	function closeSidebar() {
		resizePlayerForSidebar(false);
		q("#" + IDS.sidebar)?.remove();
	}

	function sendRecord(payload) {
		fetch(getApiEndpoint("receive"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		})
			.then((r) => r.json())
			.then((j) => console.log("保存OK", j))
			.catch((e) => console.error("保存NG", e));
	}

	// ---------------------------------------------------------------------------
	// 録画ハンドリング
	// ---------------------------------------------------------------------------
	function handleRecordClick() {
		try {
			if (!videoEl) throw new Error("ビデオプレーヤーが見つかりません。");
			const titleRoot = q(SELECTOR_TITLE);

			if (isRecording) {
				recordEnd = videoEl.currentTime;
				if (recordStart > recordEnd)
					throw new Error("録画終了時刻が開始時刻より早い値です");
				if (Math.abs(recordEnd - recordStart) < 1)
					throw new Error("録画範囲が短すぎます");

				const data = {
					StartTime: recordStart,
					EndTime: recordEnd,
					URL: location.pathname,
					service: detectService(),
					user: "test_user",
				};
				if (titleRoot) {
					const h4 = titleRoot.querySelector("h4");
					if (h4) {
						data.title = h4.textContent;
						const ep = titleRoot.querySelector("span:nth-of-type(1)");
						if (ep) data.epnumber = ep.textContent;
					} else {
						data.title = titleRoot.textContent;
					}
				} else {
					throw new Error("タイトル要素が見つかりません。");
				}

				videoEl.pause();
				openSidebarRecord(data);
				// リセット
				isRecording = false;
				recordStart = null;
				recordEnd = null;
			} else {
				isRecording = true;
				recordStart = videoEl.currentTime;
			}
		} catch (e) {
			console.error(e);
			alert(e.message);
			isRecording = false;
			recordStart = null;
			recordEnd = null;
		}
	}

	// ---------------------------------------------------------------------------
	// クリップ選択/ジャンプ/次クリップ
	// ---------------------------------------------------------------------------
	async function selectClip(clipId) {
		try {
			const url = `http://localhost:3000/api/fetchClip?id=${encodeURIComponent(clipId)}`;
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const clip = await res.json();
			// Cookie保存
			["title", "user", "startTime", "endTime", "url", "service"].forEach(
				(k) => {
					if (clip[k] !== undefined) setCookie(k, clip[k]);
				},
			);
			redirectToClip(clip);
		} catch (e) {
			console.error("Clip取得失敗:", e);
		}
	}

	function redirectToClip({ url, service, startTime }) {
		if (!url || !service) {
			alert("URL または サービス情報が不正です");
			return;
		}
		let base;
		switch (String(service).toLowerCase()) {
			case "netflix":
				base = `https://www.netflix.com${url}`;
				break;
			case "amazon":
			case "prime video":
				base = `https://www.amazon.co.jp${url}`;
				break;
			case "youtube":
				base = `https://www.youtube.com${url}`;
				break;
			default:
				alert(`未対応のサービス: ${service}`);
				return;
		}
		const finalUrl =
			base +
			(base.includes("?") ? "&" : "?") +
			"t=" +
			Math.floor(startTime || 0);
		window.location.assign(finalUrl);
	}

	async function playNextClip() {
		await new Promise((resolve) =>
			chrome.storage.local.set({ playClipSystemKey: 1 }, resolve),
		);
		const platform = "Netflix";
		const currentClipId =
			(document.cookie.match(/(?:^|; )clipId=([^;]*)/) || [])[1] || "000000";
		const userId =
			(document.cookie.match(/(?:^|; )username=([^;]*)/) || [])[1] ||
			"anonymous";
		try {
			const res = await fetch("http://localhost:3000/api/nextClip", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ platform, currentClipId, userId }),
			});
			if (!res.ok) throw new Error("サーバーエラー");
			const data = await res.json();
			if (data?.url && typeof data.startTime === "number") {
				const url = `https://www.netflix.com${data.url}?t=${Math.floor(data.startTime)}`;
				location.href = url;
			}
		} catch (e) {
			console.error("次クリップ取得エラー:", e);
		}
	}

	// ---------------------------------------------------------------------------
	// クリップ再生監視
	// ---------------------------------------------------------------------------
	function waitForVideo() {
		return new Promise((resolve) => {
			const exist = q("video");
			if (exist) return resolve(exist);
			const obs = new MutationObserver(() => {
				const v = q("video");
				if (v) {
					obs.disconnect();
					resolve(v);
				}
			});
			obs.observe(document.body, { childList: true, subtree: true });
		});
	}

	function loadClipFromStorage() {
		return new Promise((resolve, reject) => {
			chrome.storage.local.get(["playClipSystemKey", "clip"], (res) => {
				if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
				if (res.playClipSystemKey === 1 && res.clip) {
					clipData = res.clip;
					console.info("[Clip] loaded:", clipData);
				} else {
					clipData = null;
				}
				resolve();
			});
		});
	}

	function setupClipPlayback() {
		if (!clipData || !videoEl) return;
		const end = Number(clipData.endtime);
		const start = Number(clipData.starttime);

		const onReady = () => {
			monitorClipEnd(end, start);
			startCountdownLogger(end);
		};
		if (videoEl.readyState >= 1) onReady();
		else videoEl.addEventListener("loadedmetadata", onReady, { once: true });

		videoEl.addEventListener("error", (e) =>
			console.error("[Video] error:", e),
		);
	}

	function monitorClipEnd(end, start) {
		function onTimeUpdate() {
			if (videoEl.currentTime + EPSILON >= end) {
				videoEl.removeEventListener("timeupdate", onTimeUpdate);
				clearInterval(countdownIntervalId);
				if (nextClipToggleOn) {
					playNextClip();
				} else {
					chrome.runtime.sendMessage({ type: "seek", sec: start });
					// 先頭へ戻して再監視
					loadClipFromStorage().then(() => setupClipPlayback());
				}
			}
		}
		videoEl.addEventListener("timeupdate", onTimeUpdate);
	}

	function startCountdownLogger(end) {
		if (countdownIntervalId !== null) clearInterval(countdownIntervalId);
		countdownIntervalId = setInterval(() => {
			if (!videoEl) return;
			const remaining = Math.max(0, end - videoEl.currentTime);
			console.log(
				`[Countdown] ${remaining.toFixed(1)} seconds remaining until end.`,
			);
		}, 1000);
	}

	// ---------------------------------------------------------------------------
	// ボタン（3種）生成：元ロジック（UIが出たら一括注入）
	// ---------------------------------------------------------------------------
	function createButtonsIfNeeded() {
		const controls = q(SELECTOR_STANDARD);
		const episodeBtn = q(SELECTOR_EPISODE);
		const fwd10 = q(SELECTOR_FWD10);

		const hasRecord = document.getElementById(IDS.recordBtn);
		const hasSidebar = document.getElementById(IDS.toggleSidebarBtn);
		const hasNext = document.getElementById(IDS.nextClipBtn);

		// UIが揃っており、まだ生成されていない場合に作成
		if (
			controls &&
			episodeBtn &&
			fwd10 &&
			(!hasRecord || !hasSidebar || !hasNext)
		) {
			// ラッパ
			const wrapper = document.createElement("div");
			wrapper.id = IDS.wrapper;
			wrapper.className = episodeBtn.parentNode.className; // ネイティブUI風に
			wrapper.style.display = "flex";
			wrapper.style.alignItems = "center";
			wrapper.style.gap = "0.5rem";

			// 録画ボタン
			const recordBtn = document.createElement("button");
			recordBtn.id = IDS.recordBtn;
			recordBtn.setAttribute("aria-label", "録画ボタン");
			recordBtn.className = episodeBtn.className;
			recordBtn.style.cursor = "pointer";
			const recordSvg = window.createSVG?.();
			if (recordSvg) {
				recordBtn.appendChild(recordSvg);
			}
			recordBtn.addEventListener("click", handleRecordClick);

			// 次クリップトグル
			const nextBtn = document.createElement("button");
			nextBtn.id = IDS.nextClipBtn;
			nextBtn.setAttribute("aria-label", "次のクリップを再生");
			nextBtn.className = episodeBtn.className;
			nextBtn.style.cursor = "pointer";
			const nextSvg = window.LoopButtonSVG?.(COLORS.default);
			if (nextSvg) nextBtn.appendChild(nextSvg);
			nextBtn.addEventListener("click", () => {
				nextClipToggleOn = !nextClipToggleOn;
				if (nextSvg?.style)
					nextSvg.style.color = nextClipToggleOn
						? COLORS.active
						: COLORS.default;
				console.log("▶️ 次のクリップを再生トグル:", nextClipToggleOn);
			});

			// サイドバー開閉
			const toggleBtn = document.createElement("button");
			toggleBtn.id = IDS.toggleSidebarBtn;
			toggleBtn.setAttribute("aria-label", "メモサイドバー開閉");
			toggleBtn.className = episodeBtn.className;
			toggleBtn.style.cursor = "pointer";
			const detailSvg = window.createMoreDetailSVG?.(COLORS.default);
			if (detailSvg) toggleBtn.appendChild(detailSvg);
			toggleBtn.addEventListener("click", () => {
				isLoopSidebarOn = !isLoopSidebarOn;
				if (detailSvg?.style)
					detailSvg.style.color = isLoopSidebarOn
						? COLORS.active
						: COLORS.default;
				isLoopSidebarOn ? openSidebarList() : closeSidebar();
			});

			// DOMへ配置
			wrapper.appendChild(recordBtn);
			wrapper.appendChild(nextBtn);
			wrapper.appendChild(toggleBtn);
			episodeBtn.parentNode.after(wrapper);

			// スペーサ
			const spacer = document.createElement("div");
			spacer.id = IDS.spacer;
			spacer.style.minWidth = "3rem";
			episodeBtn.parentNode.after(spacer);
		}

		// UIが消えたら撤去
		if (!fwd10) {
			document.getElementById(IDS.recordBtn)?.remove();
			document.getElementById(IDS.toggleSidebarBtn)?.remove();
			document.getElementById(IDS.nextClipBtn)?.remove();
			document.getElementById(IDS.wrapper)?.remove();
			document.getElementById(IDS.spacer)?.remove();
		}
	}

	// ---------------------------------------------------------------------------
	// 初期化/監視
	// ---------------------------------------------------------------------------
	const uiObserver = new MutationObserver(() => {
		createButtonsIfNeeded();
	});
	uiObserver.observe(document.body, { childList: true, subtree: true });

	window.addEventListener("beforeunload", () => uiObserver.disconnect());

	// 動画/クリップ監視の初期化
	async function initMain() {
		try {
			await loadClipFromStorage();
			videoEl = await (async () => {
				const v = q("video");
				return (
					v ||
					(await new Promise((resolve) => {
						const mo = new MutationObserver(() => {
							const nv = q("video");
							if (nv) {
								mo.disconnect();
								resolve(nv);
							}
						});
						mo.observe(document.body, { childList: true, subtree: true });
					}))
				);
			})();
			setupClipPlayback();
		} catch (e) {
			console.error("[Clip] init failed", e);
		}
	}

	window.addEventListener("load", () => {
		chrome.runtime.sendMessage({ type: "nf:init-bridge" });
		initMain();
	});
})();
