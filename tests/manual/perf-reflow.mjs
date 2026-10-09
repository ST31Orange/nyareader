/**
 * 大文件「排版卡顿」真实浏览器基准（task-7 / stream-f）。
 *
 * 目的：为「大文件调字号卡死」「目录跳远章节卡死」「后台补章周期性卡顿」三件事
 * 提供真实 Edge + 真实 HtmlDocEngine 的墙钟数字（改动前 / 改动后同口径对比）。
 *
 * 测量方法（全部在真实 Chromium 渲染管线里）：
 * - 把真实 `HtmlDocEngine.ts` 用 esbuild 打成 IIFE，注入到无头 Edge 页面；
 * - iframe 里挂载一本 N 段（≈2000/6000 页）的合成书，等两帧让首次布局稳定；
 * - `performance.now()` 直接夹住被测调用（同步墙钟 = 用户感知的"卡死"时长）；
 * - `PerformanceObserver({entryTypes:["longtask"]})` 记录 >50ms 的长任务
 *   （长任务 = 单帧主线程阻塞，浏览器自己量的，不依赖我们的插桩）；
 * - 另有「原始 DOM 分解」实验：直接对 `.nyareader-columns` 做
 *   「只插入不读布局」vs「每批插入后读一次 offsetLeft」，用来分离
 *   "DOM 插入成本" 与 "强制整篇布局成本"。
 *
 * 用法：
 *   node tests/manual/perf-reflow.mjs                     # 默认 20000 段
 *   NYAR_PERF_PARAS=60000 node tests/manual/perf-reflow.mjs
 *   NYAR_PERF_LABEL=before node tests/manual/perf-reflow.mjs
 *   NYAR_ENGINE_ENTRY=<相对路径> 可换被测引擎源码（用于 A/B 对照同一脚本）
 * 输出：一行 JSON 摘要 + 完整报告写到 NYAR_REPORT 或 tests/manual/perf-reflow-<label>.json
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT_DIR = join(ROOT, "tests", "manual");
const ENGINE_ENTRY = process.env.NYAR_ENGINE_ENTRY || "src/services/books/formats/mobi/HtmlDocEngine.ts";
const LABEL = process.env.NYAR_PERF_LABEL || "run";
const PARAS = Number(process.env.NYAR_PERF_PARAS || 20000);
const BUNDLE = join(OUT_DIR, `.perf-reflow-bundle-${LABEL}.js`);
const PORT = 9200 + Math.floor(Math.random() * 500);

async function bundleEngine() {
	mkdirSync(OUT_DIR, { recursive: true });
	const esbuild = await import("esbuild");
	await esbuild.build({
		entryPoints: [join(ROOT, ENGINE_ENTRY)],
		bundle: true,
		format: "iife",
		globalName: "NyarEngine",
		platform: "browser",
		outfile: BUNDLE,
		logLevel: "error",
		external: ["obsidian"],
	});
}

function harnessHtml(bundleName) {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
	html,body{margin:0;padding:0;height:100%;overflow:hidden}
	#host{position:relative;width:100vw;height:100vh}
	</style></head>
<body><div id="host"></div>
<script>window.__errors=[];window.addEventListener("error",function(e){window.__errors.push(String(e.message||e));});<\/script>
<script src="./${bundleName}"><\/script>
<script>
window.__loaded = typeof NyarEngine !== "undefined" && !!NyarEngine.HtmlDocEngine;

/** Obsidian 的 createEl/empty 等最小复刻（与 real-engine-check.mjs 同口径） */
function decorate(el) {
	el.createEl = function (tag, o) {
		const c = document.createElement(tag);
		if (o && o.cls) c.className = o.cls;
		if (o && o.text != null) c.textContent = o.text;
		if (o && o.attr) for (const k in o.attr) c.setAttribute(k, o.attr[k]);
		this.appendChild(c);
		return c;
	};
	el.createDiv = function (o) { return this.createEl("div", o); };
	el.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
	return el;
}
const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
const raf2 = async () => { await raf(); await raf(); };

/**
 * 合成书：n 段中文正文，每 cfg.chapterEvery 段（默认 200）插一个章节锚点。
 *
 * 同时输出两种 id（相邻两个 span）：
 * - nyareader-epub-N：真实格式的章节锚点前缀，引擎据此按章切分（task-10 窗口化分页）；
 * - nyar-anchor-N：harness 自己的目录跳转目标（历史用例都在用它）。
 */
window.__mkHtml = function (n, startIndex) {
	const from = startIndex || 0;
	const text = "这是一段用于测量排版重排耗时的中文正文样本，长度大致均等，用来产生足够多的分栏内容与断行。";
	const parts = ['<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'];
	for (let i = 0; i < n; i++) {
		const idx = from + i;
		if (idx % 200 === 0) {
			parts.push('<span id="nyareader-epub-' + idx + '"></span><span id="nyar-anchor-' + idx + '"></span>');
		}
		parts.push("<p>第" + (idx + 1) + "段：" + text + "</p>");
	}
	parts.push("</body></html>");
	return parts.join("");
};

window.__settings = function (o) {
	return Object.assign({ fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24,
		theme: "light", layout: "single", scrollMode: false, pageWidth: 640 }, o || {});
};

/** 长任务采集：跑完取 top N；浏览器自量，不靠我们插桩 */
window.__longTasks = [];
window.__ltObserver = null;
window.__startLongTasks = function () {
	window.__longTasks = [];
	try {
		if (PerformanceObserver.supportedEntryTypes && PerformanceObserver.supportedEntryTypes.indexOf("longtask") >= 0) {
			window.__ltObserver = new PerformanceObserver(function (list) {
				const es = list.getEntries();
				for (let i = 0; i < es.length; i++) window.__longTasks.push({ start: Math.round(es[i].startTime), dur: Math.round(es[i].duration) });
			});
			window.__ltObserver.observe({ entryTypes: ["longtask"] });
			return true;
		}
	} catch (e) {}
	return false;
};
window.__stopLongTasks = function () {
	try { window.__ltObserver && window.__ltObserver.disconnect(); } catch (e) {}
	window.__ltObserver = null;
	return window.__longTasks.slice();
};
function ltSummary(list) {
	if (!list.length) return { count: 0, totalMs: 0, maxMs: 0, worst: [] };
	let total = 0, max = 0;
	for (const e of list) { total += e.dur; if (e.dur > max) max = e.dur; }
	const worst = list.slice().sort((a, b) => b.dur - a.dur).slice(0, 5);
	return { count: list.length, totalMs: Math.round(total), maxMs: Math.round(max), worst };
}

/** 主测量：字号变更 / 补章 50 批 / 目录跳转 */
window.__perf = async function (cfg) {
	const out = { cfg: cfg, longTaskSupported: window.__startLongTasks() };
	const host = decorate(document.getElementById("host"));
	host.style.width = "100vw";
	host.style.height = "100vh";
	host.style.position = "relative";
	const settings = window.__settings({});
	const factory = () => new NyarEngine.HtmlDocEngine({
		book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
		html: window.__mkHtml(cfg.paras, 0),
		formatLabel: "epub",
	});

	// ---------- 挂载（上下文数字，不是被测项） ----------
	host.empty();
	let t0 = performance.now();
	const engine = factory();
	await engine.mount(host);
	engine.applySettings(settings);
	await raf2();
	out.mountMs = Math.round(performance.now() - t0);
	out.pages = engine.getTotalPages();

	const iframe = host.querySelector("iframe");
	const doc = iframe.contentDocument;
	const cols = doc.querySelector(".nyareader-columns");
	const marker = doc.getElementById("nyareader-end-marker");
	const stride = parseFloat(doc.documentElement.style.getPropertyValue("--nyar-page-w")) +
		parseFloat(doc.documentElement.style.getPropertyValue("--nyar-gutter"));
	out.pageW = Math.round(parseFloat(doc.documentElement.style.getPropertyValue("--nyar-page-w")));
	out.stride = Math.round(stride);

	// ---------- 1. 改字号（18 -> 20，再 20 -> 18） ----------
	const font = {};
	let a = performance.now();
	engine.applySettings(window.__settings({ fontSize: 20 }));
	font.to20Ms = Math.round(performance.now() - a);
	await raf2();
	// 到"新字号这一帧画完"的墙钟（含浏览器自己的布局/绘制）
	font.to20UntilFrameMs = Math.round(performance.now() - a);
	font.pagesAt20 = engine.getTotalPages();
	a = performance.now();
	engine.applySettings(window.__settings({ fontSize: 18 }));
	font.back18Ms = Math.round(performance.now() - a);
	await raf2();
	font.back18UntilFrameMs = Math.round(performance.now() - a);
	font.pagesBack18 = engine.getTotalPages();
	// 纯字号 nudge（键盘 Ctrl +/- 走的是 setZoom，同样触发整篇重排）
	a = performance.now();
	engine.setZoom("custom", 1.1);
	font.nudgeZoomSyncMs = Math.round(performance.now() - a);
	await raf2();
	font.nudgeZoomUntilFrameMs = Math.round(performance.now() - a);
	await new Promise(function (r) { setTimeout(r, 300); });
	await raf2();
	engine.setZoom("custom", 1);
	await raf2();
	out.fontChange = font;

	// ---------- 2. 后台补章 50 批 ----------
	window.__startLongTasks();
	const batchParas = Math.max(1, Math.round(cfg.paras * (cfg.appendFraction || 0.02)));
	const perBatch = [];
	const pagesBefore = engine.getTotalPages();
	a = performance.now();
	for (let b = 0; b < cfg.batches; b++) {
		const html = window.__mkHtml(batchParas, cfg.paras + b * batchParas);
		const b0 = performance.now();
		engine.notifyContentAppended(html);
		perBatch.push(Math.round((performance.now() - b0) * 10) / 10);
	}
	const appendSyncMs = performance.now() - a;
	const loopEnd = performance.now();
	// 等过"静默窗口"（引擎把暂存补章落盘 + 一次重排 + 浏览器首次绘制这些新块）。
	// 这一步必须计入，否则落盘成本会被算到下一个场景里（第一版 harness 就踩了这个坑）。
	await new Promise(function (r) { setTimeout(r, 400); });
	await raf2();
	const settleMs = performance.now() - loopEnd;
	const ltAppend = ltSummary(window.__stopLongTasks());
	const pagesAfterAppend = engine.getTotalPages();
	out.append = {
		batches: cfg.batches,
		batchParas: batchParas,
		syncTotalMs: Math.round(appendSyncMs),
		syncMaxMs: perBatch.length ? Math.max.apply(null, perBatch) : 0,
		syncAvgMs: perBatch.length ? Math.round((appendSyncMs / perBatch.length) * 10) / 10 : 0,
		settleMs: Math.round(settleMs),
		totalMs: Math.round(appendSyncMs + settleMs),
		pagesBefore: pagesBefore,
		pagesAfter: pagesAfterAppend,
		longTasks: ltAppend
	};

	// ---------- 2b. 补章 50 批（批间让出宏任务 = 真实后台补章节奏） ----------
	window.__startLongTasks();
	const spreadStart = performance.now();
	const spreadSync = [];
	for (let b = 0; b < cfg.batches; b++) {
		const html = window.__mkHtml(batchParas, cfg.paras + cfg.batches * batchParas + b * batchParas);
		const b0 = performance.now();
		engine.notifyContentAppended(html);
		spreadSync.push(Math.round((performance.now() - b0) * 10) / 10);
		await new Promise(function (r) { setTimeout(r, 0); });
	}
	const spreadLoopMs = performance.now() - spreadStart;
	await new Promise(function (r) { setTimeout(r, 400); });
	await raf2();
	out.appendSpread = {
		batches: cfg.batches,
		loopWallMs: Math.round(spreadLoopMs),
		syncTotalMs: Math.round(spreadSync.reduce(function (s, v) { return s + v; }, 0)),
		syncMaxMs: spreadSync.length ? Math.max.apply(null, spreadSync) : 0,
		totalMs: Math.round(performance.now() - spreadStart),
		pagesAfter: engine.getTotalPages(),
		longTasks: ltSummary(window.__stopLongTasks())
	};

	// ---------- 2c. 字号连续 nudge（Ctrl+滚轮 / 连点缩放，10 次） ----------
	window.__startLongTasks();
	const zoomStart = performance.now();
	for (let i = 1; i <= 10; i++) engine.setZoom("custom", 1 + i * 0.01);
	const zoomSyncMs = performance.now() - zoomStart;
	await raf2();
	const zoomFrameMs = performance.now() - zoomStart;
	await new Promise(function (r) { setTimeout(r, 300); });
	await raf2();
	out.zoomBurst = {
		calls: 10,
		syncMs: Math.round(zoomSyncMs),
		untilFrameMs: Math.round(zoomFrameMs),
		totalMs: Math.round(performance.now() - zoomStart),
		longTasks: ltSummary(window.__stopLongTasks())
	};
	engine.setZoom("custom", 1);
	await raf2();

	// ---------- 3. 目录锚点跳远章节（跳到最末锚点） ----------
	const lastAnchorIdx = Math.floor((cfg.paras + cfg.batches * batchParas - 1) / 200) * 200;
	const anchorId = "nyar-anchor-" + lastAnchorIdx;
	const target = doc.getElementById(anchorId);
	out.jump = { anchorId: anchorId, anchorExists: !!target };
	if (target) {
		window.__startLongTasks();
		a = performance.now();
		await engine.goTo("#" + anchorId);
		const jumpMs = performance.now() - a;
		await raf2();
		out.jump.syncMs = Math.round(jumpMs);
		out.jump.totalMs = Math.round(performance.now() - a);
		out.jump.longTasks = ltSummary(window.__stopLongTasks());
		out.jump.reachedLocation = engine.currentLocation();
		const m = /translateX\\((-?[\\d.]+)px\\)/.exec(cols.style.transform || "translateX(0px)");
		out.jump.visibleColumn = m ? Math.round(Math.abs(parseFloat(m[1])) / stride) : null;
	}

	// ---------- 4. 一致性探针（功能不回退） ----------
	out.integrity = {
		markerIsLastChild: cols.lastElementChild === marker,
		markerOffsetLeft: marker ? Math.round(marker.offsetLeft) : null,
		pagesMatchesMarker: marker ? engine.getTotalPages() === Math.floor(Math.round(marker.offsetLeft / stride)) + 1 : false,
		totalPagesGrew: engine.getTotalPages() > pagesBefore,
		doubleActive: false,
		errors: window.__errors.slice(0, 5)
	};
	engine.destroy();
	window.__stopLongTasks();
	return out;
};

/**
 * 原始 DOM 分解：把"DOM 插入"与"强制整篇布局"分开量。
 * 直接操作真实引擎产出的列容器，不经过引擎方法。
 */
window.__rawBreakdown = async function (cfg) {
	const out = { cfg: cfg };
	const host = decorate(document.getElementById("host"));
	host.style.width = "100vw";
	host.style.height = "100vh";
	host.style.position = "relative";
	host.empty();
	const engine = new NyarEngine.HtmlDocEngine({
		book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
		html: window.__mkHtml(cfg.paras, 0),
		formatLabel: "epub"
	});
	await engine.mount(host);
	engine.applySettings(window.__settings({}));
	await raf2();
	const doc = host.querySelector("iframe").contentDocument;
	const cols = doc.querySelector(".nyareader-columns");
	const marker = doc.getElementById("nyareader-end-marker");
	const stride = parseFloat(doc.documentElement.style.getPropertyValue("--nyar-page-w")) +
		parseFloat(doc.documentElement.style.getPropertyValue("--nyar-gutter"));
	const hook = doc.createElement("span");
	out.pages0 = engine.getTotalPages();

	// 4a. 50 批"只插入、不读布局"（隐藏宿主不可能，这里就是纯插入成本）
	const batchParas = Math.max(1, Math.round(cfg.paras * 0.02));
	let a = performance.now();
	for (let b = 0; b < cfg.batches; b++) {
		const full = window.__mkHtml(batchParas, cfg.paras + b * batchParas);
		const bodyStart = full.indexOf("<body>") + 6;
		const bodyEnd = full.lastIndexOf("</body>");
		cols.insertAdjacentHTML("beforeend", full.slice(bodyStart, bodyEnd));
		cols.appendChild(hook); // 与引擎一致：标记恒在末尾
	}
	cols.appendChild(marker);
	out.insertOnlyMs = Math.round(performance.now() - a);
	// 4b. 插入后读一次标记（= 一次整篇布局，即"卡顿"的物理成本）
	a = performance.now();
	void marker.offsetLeft;
	out.singleFullLayoutMs = Math.round(performance.now() - a);
	out.pagesAfterInsert = Math.round(marker.offsetLeft / stride) + 1;

	engine.destroy();
	return out;
};

/**
 * 大文档"改一次字号"的干净测量（task-7 硬性要求：2000+ / 6000+ 页）。
 *
 * 先补章到目标页数、等完全落盘 + 两帧静置（避免和落盘/绘制成本混在一起），
 * 再**只**做一次字号变更：量同步墙钟与"到这一帧画完"的墙钟，并采集长任务。
 */
window.__fontAtSize = async function (cfg) {
	const out = { cfg: cfg, steps: [] };
	const host = decorate(document.getElementById("host"));
	host.style.width = "100vw";
	host.style.height = "100vh";
	host.style.position = "relative";
	host.empty();
	const engine = new NyarEngine.HtmlDocEngine({
		book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
		html: window.__mkHtml(cfg.paras, 0),
		formatLabel: "epub"
	});
	await engine.mount(host);
	engine.applySettings(window.__settings({}));
	await raf2();
	out.pagesAtMount = engine.getTotalPages();
	for (let b = 0; b < cfg.batches; b++) {
		engine.notifyContentAppended(window.__mkHtml(cfg.chunkParas, cfg.paras + b * cfg.chunkParas));
		await new Promise(function (r) { setTimeout(r, 0); });
	}
	// 完全落盘 + 静置（把"补章成本"彻底排除在被测项之外）
	await new Promise(function (r) { setTimeout(r, 500); });
	await raf2();
	out.pagesBeforeChange = engine.getTotalPages();
	out.blocksBefore = host.querySelector("iframe").contentDocument.querySelectorAll(".nyareader-columns > *").length;

	const measure = async function (size) {
		window.__startLongTasks();
		const t0 = performance.now();
		engine.applySettings(window.__settings({ fontSize: size }));
		const syncMs = performance.now() - t0;
		await raf2();
		const untilFrameMs = performance.now() - t0;
		const lt = ltSummary(window.__stopLongTasks());
		out.steps.push({
			fontSize: size,
			syncMs: Math.round(syncMs),
			untilFrameMs: Math.round(untilFrameMs),
			pages: engine.getTotalPages(),
			longTasks: lt
		});
		await new Promise(function (r) { setTimeout(r, 400); });
		await raf2();
	};
	await measure(19);
	await measure(20);
	await measure(18);
	out.pagesAfter = engine.getTotalPages();
	engine.destroy();
	return out;
};

/**
 * 栅格几何探针：列容器宽 2_000_000px / column-count 10000 是否在拖慢整篇布局？
 * 在同一文档上改 --nyar-cols-width / --nyar-cols-count 后强制一次整篇布局，对比耗时。
 * （结果决定要不要把 columnGridWidth 从"固定最大栅格"改为"按需栅格"）
 */
window.__gridProbe = async function (cfg) {	const out = { cfg: cfg, variants: [] };
	const host = decorate(document.getElementById("host"));
	host.style.width = "100vw";
	host.style.height = "100vh";
	host.style.position = "relative";
	host.empty();
	const engine = new NyarEngine.HtmlDocEngine({
		book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
		html: window.__mkHtml(cfg.paras, 0),
		formatLabel: "epub"
	});
	await engine.mount(host);
	engine.applySettings(window.__settings({}));
	await raf2();
	const doc = host.querySelector("iframe").contentDocument;
	const root = doc.documentElement;
	const cols = doc.querySelector(".nyareader-columns");
	const marker = doc.getElementById("nyareader-end-marker");
	const stride = parseFloat(root.style.getPropertyValue("--nyar-page-w")) +
		parseFloat(root.style.getPropertyValue("--nyar-gutter"));
	out.pages = engine.getTotalPages();
	out.defaultColsWidth = Math.round(parseFloat(root.style.getPropertyValue("--nyar-cols-width")));
	out.defaultColsCount = parseInt(root.style.getPropertyValue("--nyar-cols-count"), 10);
	const probe = (colsWidth, colsCount, label) => {
		root.style.setProperty("--nyar-cols-width", colsWidth + "px");
		root.style.setProperty("--nyar-cols-count", String(colsCount));
		// 改字号强制整篇重排（与真实"改字号"同一路径），再改回来
		const t0 = performance.now();
		engine.applySettings(window.__settings({ fontSize: 19 }));
		const ms = performance.now() - t0;
		engine.applySettings(window.__settings({ fontSize: 18 }));
		return { label: label, colsWidth: Math.round(colsWidth), colsCount: colsCount, relayoutMs: Math.round(ms) };
	};
	out.variants.push(probe(out.defaultColsWidth, out.defaultColsCount, "default(2e6/10000)"));
	out.variants.push(probe((out.pages + 16) * stride - 30, out.pages + 16, "fitted(pages+16)"));
	out.variants.push(probe((out.pages * 4 + 16) * stride - 30, out.pages * 4 + 16, "4x(pages*4)"));
	out.variants.push(probe(out.defaultColsWidth, out.defaultColsCount, "default-again"));
	out.markerOkAfterProbe = cols.lastElementChild === marker && Math.abs(marker.offsetLeft / stride + 1 - engine.getTotalPages()) < 2;
	engine.destroy();
	return out;
};
/**
 * 目录跳远章节（用户主诉 #2）：首屏很小 → 连续补 25 批（模拟 ensureChaptersThrough
 * 的预加载循环，批间让出一个宏任务，和 loader 里 await buildChapterChunk 一致）
 * → 立刻跳到最后一个锚点。量"用户点目录到画面更新"的整段墙钟 + 期间长任务。
 */
window.__lazyJump = async function (cfg) {
	const out = { cfg: cfg };
	const host = decorate(document.getElementById("host"));
	host.style.width = "100vw";
	host.style.height = "100vh";
	host.style.position = "relative";
	host.empty();
	window.__lazyJumpEvents = [];
	const engine = new NyarEngine.HtmlDocEngine({
		book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
		html: window.__mkHtml(cfg.initialParas, 0),
		formatLabel: "epub"
	});
	if (typeof engine.setLayoutStateHandler === "function") {
		engine.setLayoutStateHandler(function (s) {
			window.__lazyJumpEvents.push({ busy: s.busy, reason: s.reason, elapsedMs: s.elapsedMs == null ? null : Math.round(s.elapsedMs) });
		});
	}
	await engine.mount(host);
	engine.applySettings(window.__settings({}));
	await raf2();
	const doc = host.querySelector("iframe").contentDocument;
	const cols = doc.querySelector(".nyareader-columns");
	const stride = parseFloat(doc.documentElement.style.getPropertyValue("--nyar-page-w")) +
		parseFloat(doc.documentElement.style.getPropertyValue("--nyar-gutter"));
	out.pagesInitial = engine.getTotalPages();
	const blocksInitial = cols.children.length;

	window.__startLongTasks();
	const actionStart = performance.now();
	// —— 预加载循环（loader 的 appendUpTo：每批一次 append 回调）
	const perBatch = [];
	for (let b = 0; b < cfg.batches; b++) {
		const html = window.__mkHtml(cfg.chunkParas, cfg.initialParas + b * cfg.chunkParas);
		const b0 = performance.now();
		engine.notifyContentAppended(html);
		perBatch.push(Math.round((performance.now() - b0) * 10) / 10);
		// 让出一个宏任务：与 loader 里 await buildChapterChunk(i) 的节奏一致
		await new Promise(function (r) { setTimeout(r, 0); });
	}
	const appendWallMs = performance.now() - actionStart;
	out.preload = {
		batches: cfg.batches,
		chunkParas: cfg.chunkParas,
		wallMs: Math.round(appendWallMs),
		syncMaxMs: perBatch.length ? Math.max.apply(null, perBatch) : 0,
		pagesAfterAppend: engine.getTotalPages()
	};
	// —— 立刻跳转到最末锚点（目录点最后一章）
	const lastIdx = Math.floor((cfg.initialParas + cfg.batches * cfg.chunkParas - 1) / 200) * 200;
	const target = doc.getElementById("nyar-anchor-" + lastIdx);
	out.jump = { anchorId: "nyar-anchor-" + lastIdx, anchorExists: !!target };
	// 关键：补章之后**不再给浏览器额外帧**，直接跳（baseline 下这里会读锚点几何）
	const jumpStart = performance.now();
	await engine.goTo("#nyar-anchor-" + lastIdx);
	out.jump.callMs = Math.round(performance.now() - jumpStart);
	await raf2();
	out.actionTotalMs = Math.round(performance.now() - actionStart);
	out.jump.pagesAfter = engine.getTotalPages();
	out.jump.location = engine.currentLocation();
	const m = /translateX\\((-?[\\d.]+)px\\)/.exec(cols.style.transform || "translateX(0px)");
	out.jump.visibleColumn = m ? Math.round(Math.abs(parseFloat(m[1])) / stride) : null;
	out.longTasks = ltSummary(window.__stopLongTasks());
	out.blocksBefore = blocksInitial;
	out.blocksAfter = cols.children.length;
	out.layoutStates = window.__lazyJumpEvents.slice(0, 12);
	engine.destroy();
	return out;
};

/**
 * 功能一致性回归（Lead 验收项）：
 * mount → 追加到 3000 页左右 → 跳到 80% → switchMode 两次
 * 断言：正文块数与文本总长不变、锚点无重复、总页数与跳转前一致。
 */
window.__integrity = async function (cfg) {
	const out = { cfg: cfg, checks: [] };
	const push = function (name, ok, detail) { out.checks.push({ name: name, pass: !!ok, detail: detail === undefined ? null : detail }); };
	const host = decorate(document.getElementById("host"));
	host.style.width = "100vw";
	host.style.height = "100vh";
	host.style.position = "relative";
	host.empty();
	const engine = new NyarEngine.HtmlDocEngine({
		book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
		html: window.__mkHtml(cfg.paras, 0),
		formatLabel: "epub"
	});
	await engine.mount(host);
	engine.applySettings(window.__settings({}));
	await raf2();
	const doc = host.querySelector("iframe").contentDocument;
	const pagesInitial = engine.getTotalPages();
	// 追加到 3000 页左右
	for (let b = 0; b < cfg.batches; b++) {
		engine.notifyContentAppended(window.__mkHtml(cfg.chunkParas, cfg.paras + b * cfg.chunkParas));
		await new Promise(function (r) { setTimeout(r, 0); });
	}
	// 读一次状态（触发落盘/测量）
	const pagesBefore = engine.getTotalPages();
	// 注意（task-10）：按章独立分页下 .nyareader-columns 只装活动窗口，
	// 所以"内容完整性"必须按**整篇文档**统计（窗口 + 冷区）。
	const countParas = () => doc.querySelectorAll(".nyareader-columns p, .nyareader-cold p").length;
	const textLen = () => (doc.querySelector(".nyareader-columns") || { textContent: "" }).textContent.length +
		(doc.querySelector(".nyareader-cold") || { textContent: "" }).textContent.length;
	const countAnchors = () => doc.querySelectorAll('[id^="nyar-anchor-"]').length;
	const blocksBefore = doc.querySelectorAll(".nyareader-columns > *, .nyareader-cold > *").length;
	const textLenBefore = textLen();
	const anchorsBefore = countAnchors();
	const parasBefore = countParas();
	out.pagesBeforeJump = pagesBefore;
	out.blocksBefore = blocksBefore;
	out.textLenBefore = textLenBefore;
	out.chaptersRegistered = typeof engine.getTotalPagesInfo === "function" ? engine.getTotalPagesInfo().chapters : null;

	// ① 跳到 80%
	engine.goToFraction(0.8);
	await raf2();
	const pagesAfterJump = engine.getTotalPages();
	const pctAfterJump = engine.currentPercentage();
	// 注意：按章独立分页下，跳到新章节会把该窗口从"估计"变成"精确测量"，
	// 因此总页数会有几个百分点的**合理**变化（不是内容丢失）——断言用相对偏差。
	push("跳到 80% 后总页数偏差 ≤ 8%（估计值会因激活章节而微调）",
		Math.abs(pagesAfterJump - pagesBefore) / Math.max(1, pagesBefore) <= 0.08, pagesAfterJump + " vs " + pagesBefore);
	push("跳到 80% 后当前位置 ≈ 80%（±5%）", Math.abs(pctAfterJump - 0.8) <= 0.05, pctAfterJump.toFixed(3));
	push("跳到 80% 后文本总长不变", textLen() === textLenBefore);

	// ② switchMode 两次（分页 → 滚动 → 分页）
	engine.switchMode(true);
	await raf2();
	const scrollOk = engine.getTotalPages() === 0;
	// 滚动模式必须**连续**：没有分栏容器、没有冷区，所有章节按顺序回到正常流
	const scrollNoPagedShim = !doc.querySelector(".nyareader-book");
	const scrollNoCold = !doc.querySelector(".nyareader-cold");
	const scrollBodyText = doc.body.textContent.length;
	const firstAnchor = doc.getElementById("nyareader-epub-0");
	const lastAnchor = doc.getElementById("nyareader-epub-" + (Math.floor((cfg.paras + cfg.batches * cfg.chunkParas - 1) / 200) * 200));
	const scrollOrderOk = !!(firstAnchor && lastAnchor &&
		(firstAnchor.compareDocumentPosition(lastAnchor) & 4) !== 0); // 4 = DOCUMENT_POSITION_FOLLOWING
	push("滚动模式：无分栏容器/无冷区", scrollNoPagedShim && scrollNoCold,
		"shim=" + !scrollNoPagedShim + " cold=" + !scrollNoCold);
	push("滚动模式：正文全部回到正常流（连续）", scrollBodyText >= textLenBefore, scrollBodyText + " vs " + textLenBefore);
	push("滚动模式：章节顺序保持（首章在末章之前）", scrollOrderOk);
	engine.switchMode(false);
	await raf2();
	const pagesAfterSwitch = engine.getTotalPages();
	push("切滚动模式后不再报总页数", scrollOk);
	push("切回分页后总页数偏差 ≤ 8%", Math.abs(pagesAfterSwitch - pagesBefore) / Math.max(1, pagesBefore) <= 0.08,
		pagesAfterSwitch + " vs " + pagesBefore);
	push("切回分页后文本总长不变", textLen() === textLenBefore,
		textLen() + " vs " + textLenBefore);
	push("锚点不重复（每个锚点恰好一个）", countAnchors() === anchorsBefore,
		countAnchors() + " vs " + anchorsBefore);
	push("正文段落数 = 首屏 + 追加（一页不丢）", countParas() === parasBefore,
		countParas() + " vs " + parasBefore);
	push("正文段落数 = 期望值", countParas() === cfg.paras + cfg.batches * cfg.chunkParas,
		countParas() + " vs " + (cfg.paras + cfg.batches * cfg.chunkParas));
	// ③ 追加不丢页：页数必须随内容增长
	push("追加后页数增长（> 首屏）", pagesBefore > pagesInitial, pagesBefore + " vs " + pagesInitial);
	push("marker 恒为最后一个子元素", doc.querySelector(".nyareader-columns").lastElementChild === doc.getElementById("nyareader-end-marker"));
	// ④ 尾页可达
	engine.goTo("10000");
	await raf2();
	push("末页可达（进度 ≥ 90%）", parseInt(engine.currentLocation(), 10) >= 9000, engine.currentLocation());
	engine.destroy();
	out.allPass = out.checks.every(function (c) { return c.pass; });
	return out;
};

/**
 * 内嵌字体（@font-face）探针：srcdoc iframe 没有基础 URL，相对路径字体必然 404。
 * 量：document.fonts.ready 何时 resolve、等待期间/之后的布局耗时。
 */
window.__fontProbe = async function (cfg) {
	const out = { cfg: cfg };
	const host = decorate(document.getElementById("host"));
	host.style.width = "100vw";
	host.style.height = "100vh";
	host.style.position = "relative";
	host.empty();
	// 只有在同一 iframe 文档里才能拿到 fonts.ready，因此这里手动建 iframe + 直接问它
	const full = window.__mkHtml(cfg.paras, 0);
	const bodyHtml = full.slice(full.indexOf("<body>") + 6, full.lastIndexOf("</body>"));
	const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
		+ '@font-face{font-family:NyarMissing;src:url("fonts/missing-3mb.ttf") format("truetype");font-weight:400;}'
		+ 'body{font-family:NyarMissing,serif}'
		+ '</style></head><body>'
		+ bodyHtml
		+ "</body></html>";
	const iframe = document.createElement("iframe");
	iframe.style.cssText = "width:100%;height:100%;border:0";
	host.appendChild(iframe);
	const loaded = new Promise(function (r) { iframe.addEventListener("load", function () { r(); }, { once: true }); });
	iframe.srcdoc = html;
	await loaded;
	const fdoc = iframe.contentDocument;
	const t0 = performance.now();
	let readyAt = null;
	try {
		await Promise.race([
			fdoc.fonts.ready.then(function () { readyAt = performance.now() - t0; }),
			new Promise(function (r) { setTimeout(r, 4000); })
		]);
	} catch (e) {}
	out.fontsReadyAfterMs = readyAt === null ? null : Math.round(readyAt);
	out.fontsStatus = fdoc.fonts ? fdoc.fonts.status : null;
	out.fontsSizeAfterWait = fdoc.fonts ? fdoc.fonts.size : null;
	// 等待结束后强制一次布局，量含"未就绪字体"的整篇布局成本
	const body = fdoc.body;
	const t1 = performance.now();
	void fdoc.documentElement.offsetHeight;
	out.layoutAfterWaitMs = Math.round(performance.now() - t1);
	// 再等一次 fonts.ready（若之前超时）
	let lateReady = null;
	try {
		await Promise.race([
			fdoc.fonts.ready.then(function () { lateReady = performance.now() - t0; }),
			new Promise(function (r) { setTimeout(r, 2500); })
		]);
	} catch (e) {}
	out.fontsReadyLateMs = lateReady === null ? null : Math.round(lateReady);
	out.paragraphs = body.querySelectorAll("p").length;
	return out;
};

/**
 * 按章追加构建大书（给 D 方案的窗口化分页用：每批 = 一章，引擎按批切章）。
 * 返回构建耗时，方便把"构建"与"被测项"分开。
 */
window.__buildByChapters = async function (engine, cfg) {
	const t0 = performance.now();
	for (let b = 0; b < cfg.chapters; b++) {
		engine.notifyContentAppended(window.__mkHtml(cfg.chunkParas, cfg.initialParas + b * cfg.chunkParas));
		await new Promise(function (r) { setTimeout(r, 0); });
	}
	// 等落盘（静默窗口 + 最长持有）+ 两帧
	await new Promise(function (r) { setTimeout(r, 500); });
	await raf2();
	return Math.round(performance.now() - t0);
};

/** 位置（0~10000）→ 页号（用引擎当前总页数换算，版本无关） */
window.__pageFromLocation = function (engine) {
	const pct = parseInt(engine.currentLocation(), 10);
	const pages = engine.getTotalPages();
	return pages > 0 ? Math.max(1, Math.min(pages, Math.round((pct / 10000) * pages) || 1)) : 1;
};

/**
 * 连续翻页：nextPage 100 次 + prevPage 100 次。
 * 量：总墙钟、单次最长、长任务；并断言"页码单调不跳页"（窗口化分页不能让翻页变慢/跳页）。
 */
window.__pageTurns = async function (cfg) {
	const out = { cfg: cfg };
	const host = decorate(document.getElementById("host"));
	host.style.width = "100vw";
	host.style.height = "100vh";
	host.style.position = "relative";
	host.empty();
	const engine = new NyarEngine.HtmlDocEngine({
		book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
		html: window.__mkHtml(cfg.initialParas, 0),
		formatLabel: "epub",
		chapterPagedPagination: cfg.chapterPagedPagination !== false
	});
	await engine.mount(host);
	engine.applySettings(window.__settings({}));
	await raf2();
	out.pagesInitial = engine.getTotalPages();
	out.buildMs = await window.__buildByChapters(engine, cfg);
	// 先显式落地一次（把补章落盘/首帧绘制成本排除在"翻页"之外）
	engine.getTotalPages();
	await raf2();
	await new Promise(function (r) { setTimeout(r, 200); });
	await raf2();
	out.pages = engine.getTotalPages();
	out.totalPagesInfo = typeof engine.getTotalPagesInfo === "function" ? engine.getTotalPagesInfo() : null;

	const run = async function (dir, times) {
		window.__startLongTasks();
		const locs = [];
		const perCall = [];
		const t0 = performance.now();
		for (let i = 0; i < times; i++) {
			const c0 = performance.now();
			if (dir > 0) await engine.nextPage();
			else await engine.prevPage();
			perCall.push(Math.round((performance.now() - c0) * 100) / 100);
			locs.push(parseInt(engine.currentLocation(), 10));
		}
		const syncMs = performance.now() - t0;
		await raf2();
		const totalMs = performance.now() - t0;
		const lt = ltSummary(window.__stopLongTasks());
		let monotonic = true;
		let changed = 0;
		for (let i = 1; i < locs.length; i++) {
			if (dir > 0 ? locs[i] < locs[i - 1] : locs[i] > locs[i - 1]) monotonic = false;
			if (locs[i] !== locs[i - 1]) changed++;
		}
		return {
			dir: dir > 0 ? "next" : "prev",
			times: times,
			syncMs: Math.round(syncMs),
			totalMs: Math.round(totalMs),
			maxCallMs: perCall.length ? Math.max.apply(null, perCall) : 0,
			changedTurns: changed,
			monotonic: monotonic,
			firstLocation: locs[0],
			lastLocation: locs[locs.length - 1],
			longTasks: lt
		};
	};
	out.next = await run(1, cfg.turns || 100);
	out.prev = await run(-1, cfg.turns || 100);
	out.pagesAfter = engine.getTotalPages();
	out.blocksAfter = host.querySelector("iframe").contentDocument.querySelectorAll(".nyareader-columns > *").length;
	engine.destroy();
	return out;
};

/**
 * 改字号后的"总页数估计值 vs 整本布局真值"。
 *
 * 同一内容 + 同一版式建两个引擎：
 *  - windowed：chapterPagedPagination: true（D 方案，按章布局 + 估计页数）；
 *  - full：chapterPagedPagination: false（整本布局 = 真值）。
 * 各做一次字号变更，比较总页数与偏差百分比。
 * （D 方案落地前：两个引擎都是整本布局 ⇒ 偏差 0、estimationSupported=false。）
 */
window.__estimateDeviation = async function (cfg) {
	const out = { cfg: cfg };
	const host = decorate(document.getElementById("host"));
	const build = async function (windowed) {
		host.empty();
		host.style.width = "100vw";
		host.style.height = "100vh";
		host.style.position = "relative";
		const engine = new NyarEngine.HtmlDocEngine({
			book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
			html: window.__mkHtml(cfg.initialParas, 0),
			formatLabel: "epub",
			chapterPagedPagination: windowed
		});
		await engine.mount(host);
		engine.applySettings(window.__settings({}));
		await raf2();
		await window.__buildByChapters(engine, cfg);
		// 改字号：被测的重排 + 页数估计刷新
		window.__startLongTasks();
		const t0 = performance.now();
		engine.applySettings(window.__settings({ fontSize: 20 }));
		const syncMs = performance.now() - t0;
		await raf2();
		await new Promise(function (r) { setTimeout(r, 400); });
		await raf2();
		const untilFrameMs = performance.now() - t0;
		const lt = ltSummary(window.__stopLongTasks());
		const info = typeof engine.getTotalPagesInfo === "function" ? engine.getTotalPagesInfo() : null;
		const res = {
			windowed: windowed,
			syncMs: Math.round(syncMs),
			untilFrameMs: Math.round(untilFrameMs),
			pages: engine.getTotalPages(),
			pagesInfo: info,
			estimationSupported: !!info,
			longTasks: lt
		};
		engine.destroy();
		return res;
	};
	out.windowed = await build(true);
	out.full = await build(false);
	const truth = out.full.pages;
	out.deviationPages = out.windowed.pages - truth;
	out.deviationPercent = truth > 0 ? Math.round(((out.windowed.pages - truth) / truth) * 10000) / 100 : null;
	out.speedupUntilFrame = out.windowed.untilFrameMs > 0 ? Math.round((out.full.untilFrameMs / out.windowed.untilFrameMs) * 100) / 100 : null;
	return out;
};
/**
 * 高亮 × 按章独立分页的契约检查（task-10 验收项，等价于 stream-i 的
 * highlight-engine-check，但按**窗口化分页的新契约**断言）：
 *  1. 高亮在"改字号""switchMode 往返"后仍然渲染；
 *  2. 指向**冷区**（尚未进入布局区）章节的高亮 → rendered:false（设计好的降级）；
 *  3. goTo("#锚点") 把该章激活进窗口 + refreshHighlights() → 高亮自动恢复渲染；
 *  4. 全程正文块数/文本长度不变。
 */
window.__highlightCheck = async function (cfg) {
	const out = { cfg: cfg, checks: [] };
	const push = function (name, ok, detail) { out.checks.push({ name: name, pass: !!ok, detail: detail === undefined ? null : detail }); };
	const host = decorate(document.getElementById("host"));
	host.style.width = "100vw";
	host.style.height = "100vh";
	host.style.position = "relative";
	host.empty();
	window.__errors = [];
	const U0 = "用于测量排版重排耗时的中文正文样本";
	const engine = new NyarEngine.HtmlDocEngine({
		book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
		html: window.__mkHtml(cfg.initialParas, 0),
		formatLabel: "epub"
	});
	if (typeof engine.setHighlightClickHandler === "function") engine.setHighlightClickHandler(function () {});
	await engine.mount(host);
	engine.applySettings(window.__settings({}));
	await raf2();
	const doc = host.querySelector("iframe").contentDocument;
	const placements = function () { return typeof engine.getHighlightPlacements === "function" ? engine.getHighlightPlacements() : []; };
	const placed = function (id) { return placements().find(function (p) { return p.id === id; }) || null; };
	const isRendered = function (id) { const p = placed(id); return !!(p && p.rendered); };
	const textLen = function () {
		const cols = doc.querySelector(".nyareader-columns");
		const cold = doc.querySelector(".nyareader-cold");
		return (cols ? cols.textContent.length : 0) + (cold ? cold.textContent.length : 0);
	};
	const paras = function () { return doc.querySelectorAll(".nyareader-columns p, .nyareader-cold p").length; };

	const lateAnchor = "nyareader-epub-" + cfg.initialParas; // 追加章的第一个锚点
	const lateText = "冷区专属目标句LATE-ONLY-9001";
	const lateHtml = '<span id="' + lateAnchor + '"></span><p>' + lateText + "</p>";
	const highlights = [
		{ id: "h-f0", color: "yellow", hasNote: false, text: U0,
			anchor: { kind: "chapter", primary: "nyareader-epub-0", quote: { exact: U0 }, progression: 0.02, v: 1 } },
		{ id: "h-f1", color: "green", hasNote: true, text: U0,
			anchor: { kind: "chapter", primary: "nyareader-epub-200", quote: { exact: U0 }, progression: 0.15, v: 1 } },
		// 用**全文唯一**的句子：否则文本指纹会命中第一个同文本段落而"提前渲染"
		{ id: "h-late", color: "blue", hasNote: false, text: lateText,
			anchor: { kind: "chapter", primary: lateAnchor, quote: { exact: lateText }, progression: 0.9, v: 1 } }
	];
	const tLen0 = textLen();
	const paras0 = paras();
	if (typeof engine.setHighlights !== "function") {
		push("引擎支持 setHighlights", false);
		engine.destroy();
		out.allPass = false;
		return out;
	}
	engine.setHighlights(highlights);
	await new Promise(function (r) { setTimeout(r, 60); });
	push("设置高亮后窗口内两条已渲染", isRendered("h-f0") && isRendered("h-f1"),
		JSON.stringify(placements().map(function (p) { return { id: p.id, rendered: p.rendered }; })));
	push("指向未加载章节的高亮此刻未渲染（合理降级）", !isRendered("h-late"));

	// ① 改字号
	engine.applySettings(window.__settings({ fontSize: 22 }));
	engine.getTotalPages();
	await new Promise(function (r) { setTimeout(r, 120); });
	push("改字号后窗口内高亮仍渲染", isRendered("h-f0") && isRendered("h-f1"),
		JSON.stringify(placements().map(function (p) { return { id: p.id, rendered: p.rendered }; })));

	// ② switchMode 往返
	engine.switchMode(true);
	await new Promise(function (r) { setTimeout(r, 80); });
	const scrollRendered = isRendered("h-f0") && isRendered("h-f1");
	engine.switchMode(false);
	engine.getTotalPages();
	await new Promise(function (r) { setTimeout(r, 80); });
	push("切滚动模式后高亮仍渲染（滚动模式=全量正常流）", scrollRendered);
	push("切回分页后窗口内高亮仍渲染", isRendered("h-f0") && isRendered("h-f1"),
		JSON.stringify(placements().map(function (p) { return { id: p.id, rendered: p.rendered }; })));

	// ③ 追加一章（落进冷区）→ 该章高亮仍未渲染；goTo 激活后恢复
	engine.notifyContentAppended(lateHtml);
	engine.getTotalPages();
	await new Promise(function (r) { setTimeout(r, 300); });
	await raf2();
	out.windowBeforeJump = typeof engine.getTotalPagesInfo === "function" ? engine.getTotalPagesInfo() : null;
	out.lateAnchorParent = (doc.getElementById(lateAnchor) && doc.getElementById(lateAnchor).parentElement)
		? doc.getElementById(lateAnchor).parentElement.className : null;
	push("补章落盘后：正文段落数增加", paras() > paras0, paras() + " vs " + paras0);
	push("补章后指向冷区章节的高亮未渲染（设计好的降级）", !isRendered("h-late"),
		JSON.stringify(placements().map(function (p) { return { id: p.id, rendered: p.rendered }; })));
	await engine.goTo("#" + lateAnchor);
	await raf2();
	await new Promise(function (r) { setTimeout(r, 80); });
	out.windowAfterJump = typeof engine.getTotalPagesInfo === "function" ? engine.getTotalPagesInfo() : null;
	const anchorEl = doc.getElementById(lateAnchor);
	out.lateAnchorParentAfter = anchorEl && anchorEl.parentElement ? anchorEl.parentElement.className : null;
	push("goTo 激活该章后高亮自动恢复渲染", isRendered("h-late"),
		JSON.stringify(placements().map(function (p) { return { id: p.id, rendered: p.rendered }; })));
	push("跳转后目标锚点落在参与布局的窗口里", !!(anchorEl && anchorEl.closest && anchorEl.closest(".nyareader-columns")),
		String(out.lateAnchorParentAfter));
	push("全程正文文本长度 = 原文本 + 追加文本", textLen() === tLen0 + lateText.length,
		textLen() + " vs " + (tLen0 + lateText.length));
	push("无未捕获异常", window.__errors.length === 0, window.__errors.slice(0, 3).join(" | "));
	engine.destroy();
	out.allPass = out.checks.every(function (c) { return c.pass; });
	return out;
};
<\/script></body></html>`;
}

async function cdpEval(url, expression) {
	const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
	// 只挑我们的 file:// 页面：headless=new 下 Edge 还会开 edge://sync-confirmation-dialog 等
	// 干扰目标，按 type 取第一个会挑错。
	const pages = list.filter((t) => t.type === "page");
	const page = pages.find((t) => typeof t.url === "string" && t.url.startsWith("file://")) || pages[0];
	if (!page) throw new Error("no page target");
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => {
		ws.addEventListener("open", res, { once: true });
		ws.addEventListener("error", rej, { once: true });
	});
	let id = 0;
	const send = (method, params = {}) =>
		new Promise((resolve) => {
			const myId = ++id;
			const onMsg = (ev) => {
				const msg = JSON.parse(ev.data);
				if (msg.id !== myId) return;
				ws.removeEventListener("message", onMsg);
				resolve(msg.result);
			};
			ws.addEventListener("message", onMsg);
			ws.send(JSON.stringify({ id: myId, method, params }));
		});
	await send("Runtime.enable");
	const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 600000 });
	ws.close();
	if (res.exceptionDetails) {
		const ex = res.exceptionDetails;
		throw new Error(`${ex.text || "page error"} :: ${ex.exception?.description || JSON.stringify(ex)}`);
	}
	return res.result.value;
}

async function main() {
	if (!existsSync(EDGE)) throw new Error("未找到 Edge");
	// NYAR_ENGINE_BUNDLE：直接测一个预先打好的 IIFE 包（用于"改动前"基线重放，
	// 源码在队友并发编辑时也能拿到同口径的 before 数字）
	const prebuilt = process.env.NYAR_ENGINE_BUNDLE;
	if (prebuilt) copyFileSync(join(ROOT, prebuilt), BUNDLE);
	else await bundleEngine();
	const bundleName = "engine-bundle.js";
	const page = harnessHtml(bundleName);
	const dir = mkdtempSync(join(tmpdir(), "nyar-perf-reflow-"));
	const file = join(dir, "harness.html");
	writeFileSync(file, page, "utf8");
	writeFileSync(join(dir, bundleName), readFileSync(BUNDLE, "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-perf-reflow-profile-"));
	const url = `file:///${file.replace(/\\/g, "/")}`;
	const child = spawn(
		EDGE,
		["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1200,800", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, url],
		{ stdio: "ignore" }
	);
	try {
		let ready = false;
		for (let i = 0; i < 60 && !ready; i++) {
			await new Promise((r) => setTimeout(r, 300));
			try {
				ready = (await cdpEval(url, "typeof window.__perf === 'function'")) === true;
			} catch {
				/* 等 CDP */
			}
		}
		if (!ready) {
			let diag = "n/a";
			try {
				diag = await cdpEval(url, "JSON.stringify({perf: typeof window.__perf, loaded: window.__loaded, errors: window.__errors, url: location.href})");
			} catch (e) {
				diag = "diag failed: " + e.message;
			}
			throw new Error("perf harness 未就绪: " + diag);
		}
		// 场景可按需跳过（重跑局部时省时间）：NYAR_PERF_SKIP=integrity,grid
		const SKIP = new Set(String(process.env.NYAR_PERF_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean));
		const runScenario = async (name, expression) =>
			SKIP.has(name) ? null : JSON.parse(await cdpEval(url, expression));
		const cfg = { paras: PARAS, batches: 50, appendFraction: 0.02 };
		const mainRes = await runScenario("perf", `(async () => JSON.stringify(await window.__perf(${JSON.stringify(cfg)})))()`);
		// 大文档（6000+ 页）单次改字号：干净测量
		const fontSizeCfg = { paras: 28000, batches: 50, chunkParas: 1120 };
		const fontAtSize = await runScenario("fontAtSize", `(async () => JSON.stringify(await window.__fontAtSize(${JSON.stringify(fontSizeCfg)})))()`);
		const raw = await runScenario("raw", `(async () => JSON.stringify(await window.__rawBreakdown(${JSON.stringify({ paras: PARAS, batches: 50 })})))()`);
		const grid = await runScenario("grid", `(async () => JSON.stringify(await window.__gridProbe(${JSON.stringify({ paras: PARAS })})))()`);
		// 目录跳远章节：首屏 400 段（≈30 页），预加载 25 批 × 800 段（≈2100 页）后直接跳最末锚点
		const lazyCfg = { initialParas: 400, batches: 25, chunkParas: 800 };
		const lazy = await runScenario("lazy", `(async () => JSON.stringify(await window.__lazyJump(${JSON.stringify(lazyCfg)})))()`);
		// 功能一致性回归（Lead 验收项）
		const integCfg = { paras: 28000, batches: 25, chunkParas: 2400 };
		const integ = await runScenario("integrity", `(async () => JSON.stringify(await window.__integrity(${JSON.stringify(integCfg)})))()`);
		// 内嵌字体（srcdoc 无基础 URL）探针
		const font = await runScenario("font", `(async () => JSON.stringify(await window.__fontProbe(${JSON.stringify({ paras: 2000 })})))()`);
		// 连续翻页 100 次（窗口化分页不能让翻页变慢/跳页）
		const turnsCfg = { initialParas: 400, chapters: 80, chunkParas: 350, turns: 100 };
		const turns = await runScenario("turns", `(async () => JSON.stringify(await window.__pageTurns(${JSON.stringify(turnsCfg)})))()`);
		// 改字号后 总页数估计值 vs 整本布局真值
		const devCfg = { initialParas: 28000, chapters: 25, chunkParas: 1120 };
		const deviation = await runScenario("deviation", `(async () => JSON.stringify(await window.__estimateDeviation(${JSON.stringify(devCfg)})))()`);
		// 高亮 × 窗口化分页契约（task-10 验收项）
		const hlCfg = { initialParas: 400, chunkParas: 200 };
		const highlights = await runScenario("highlights", `(async () => JSON.stringify(await window.__highlightCheck(${JSON.stringify(hlCfg)})))()`);
		const report = {
			meta: {
				label: LABEL,
				generatedAt: new Date().toISOString(),
				engineEntry: ENGINE_ENTRY,
				viewport: "1200x800 (--headless=new)",
				method:
					"真实 Edge + 真实 HtmlDocEngine（esbuild IIFE）；performance.now() 夹住被测调用；longtask = PerformanceObserver 浏览器自量 >50ms 长任务",
				params: cfg
			},
			main: mainRes,
			fontAtSize: fontAtSize,
			rawBreakdown: raw,
			gridProbe: grid,
			lazyJump: lazy,
			integrityRegression: integ,
			fontProbe: font,
			pageTurns: turns,
			estimateDeviation: deviation
		};
		const outFile = process.env.NYAR_REPORT || join(OUT_DIR, `perf-reflow-${LABEL}.json`);
		writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
		const summary = {
			label: LABEL,
			paras: PARAS,
			pages: mainRes ? mainRes.pages : null,
			mountMs: mainRes ? mainRes.mountMs : null,
			font18to20Ms: mainRes ? mainRes.fontChange.to20Ms : null,
			font18to20UntilFrameMs: mainRes ? mainRes.fontChange.to20UntilFrameMs : null,
			font20to18Ms: mainRes ? mainRes.fontChange.back18Ms : null,
			font20to18UntilFrameMs: mainRes ? mainRes.fontChange.back18UntilFrameMs : null,
			zoomBurst10: mainRes ? mainRes.zoomBurst : null,
			appendSyncTotalMs: mainRes ? mainRes.append.syncTotalMs : null,
			appendSyncMaxMs: mainRes ? mainRes.append.syncMaxMs : null,
			appendSettleMs: mainRes ? mainRes.append.settleMs : null,
			appendTotalMs: mainRes ? mainRes.append.totalMs : null,
			appendLongTasks: mainRes ? mainRes.append.longTasks : null,
			appendPagesBefore: mainRes ? mainRes.append.pagesBefore : null,
			appendPagesAfter: mainRes ? mainRes.append.pagesAfter : null,
			appendSpread: mainRes ? mainRes.appendSpread : null,
			fontAtSize: fontAtSize,
			rawInsertOnlyMs: raw ? raw.insertOnlyMs : null,
			rawSingleFullLayoutMs: raw ? raw.singleFullLayoutMs : null,
			lazyJump: lazy
				? {
						pagesInitial: lazy.pagesInitial,
						preloadWallMs: lazy.preload.wallMs,
						preloadSyncMaxMs: lazy.preload.syncMaxMs,
						pagesAfterAppend: lazy.preload.pagesAfterAppend,
						jumpCallMs: lazy.jump.callMs,
						actionTotalMs: lazy.actionTotalMs,
						longTasks: lazy.longTasks,
						layoutStates: lazy.layoutStates
				  }
				: null,
			integrity: integ
				? {
						allPass: integ.allPass,
						failed: integ.checks.filter((c) => !c.pass),
						pagesBeforeJump: integ.pagesBeforeJump,
						blocksBefore: integ.blocksBefore
				  }
				: null,
			fontProbe: font,
			pageTurns: turns,
			estimateDeviation: deviation,
			highlightCheck: highlights,
			report: outFile
		};
		console.log(JSON.stringify(summary, null, 2));
		if (integ && !integ.allPass) process.exitCode = 1;
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("perf-reflow failed:", e.stack || e.message);
	process.exitCode = 2;
});
