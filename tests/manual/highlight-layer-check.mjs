/**
 * 真实浏览器验证：HighlightLayer（批注可见高亮的渲染层）。
 *
 * 为什么单独测这一层：`HtmlDocEngine.ts` 当时有另一位成员在改（排版性能），
 * 先把"锚点 → 可见高亮"做成独立模块，用真实 Edge（Chromium）验证渲染路径、
 * 命中测试、以及"结构变化后重新应用"；引擎解冻后再做引擎级验证
 * （tests/manual/highlight-engine-check.mjs）。
 *
 * 用法：node tests/manual/highlight-layer-check.mjs
 * 输出：一行 JSON + 报告文件（pass / 每条断言与关键数字）
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BUNDLE = join(ROOT, "tests", "manual", ".highlight-layer-bundle.js");
const PORT = 9800 + Math.floor(Math.random() * 300);

async function bundleLayer() {
	mkdirSync(join(ROOT, "tests", "manual"), { recursive: true });
	const esbuild = await import("esbuild");
	await esbuild.build({
		entryPoints: [join(ROOT, "src/services/books/formats/html/HighlightLayer.ts")],
		bundle: true,
		format: "iife",
		globalName: "NyarHl",
		platform: "browser",
		outfile: BUNDLE,
		logLevel: "error",
		external: ["obsidian"],
	});
}

/** 页面内脚本：两种宿主（EPUB 章节 / TXT 段落）+ 场景执行。 */
function pageScript() {
	return `
window.__errors = [];
window.addEventListener("error", (e) => window.__errors.push(String(e.message || e)));

/** EPUB/MOBI 形状：章节锚点 span + 若干顶层块。 */
function collectChapterRegions(root) {
	const out = [];
	let current = null;
	const isAnchor = (n) => n.nodeType === 1 && n.matches && n.matches('span[id^="nyareader-epub-"]');
	for (const node of Array.from(root.childNodes)) {
		if (isAnchor(node)) {
			if (current) out.push(current);
			current = { key: node.id, nodes: [], paraIndex: out.length };
			continue;
		}
		if (current) current.nodes.push(node);
	}
	if (current) out.push(current);
	return out;
}

/** TXT 形状：每个 p[data-index] 是一个区域。 */
function collectParagraphRegions(root) {
	return Array.from(root.querySelectorAll('p[data-index]')).map((el) => ({
		key: el.dataset.index,
		nodes: [el],
		paraIndex: Number(el.dataset.index),
	}));
}

function makeHost(root, mode) {
	let stamp = 0;
	return {
		regions: () => (mode === "chapters" ? collectChapterRegions(root) : collectParagraphRegions(root)),
		documentRoot: () => root,
		structureStamp: () => stamp,
		goToProgression: (p) => { window.__progression = p; },
		bump: () => { stamp++; },
	};
}

function chapterHtml(i, paras) {
	return '<span id="nyareader-epub-' + i + '" class="nyareader-epub-anchor"></span>' + paras.map((p) => "<p>" + p + "</p>").join("");
}

function buildChapters(container) {
	container.innerHTML =
		'<div class="nyareader-book"><div class="nyareader-columns">' +
		chapterHtml(0, ["第一节 开端。", "这是第一段文字，用来测试锚点往返定位。"]) +
		chapterHtml(1, ["第二节 发展。", "被重复的句子。", "中间段落。", "被重复的句子。"]) +
		chapterHtml(2, ["第三节 结尾。", "目标句子内容就在这一节里。"]) +
		"</div></div>";
	return container.querySelector(".nyareader-columns");
}

function buildParagraphs(container) {
	const paras = [
		"第 0 段：很久很久以前。",
		"第 1 段：故事开始的地方。",
		"第 2 段：主人公出场。",
		"第 3 段：这一段会被移出虚拟窗口再移回来。",
		"第 4 段：冲突开始。",
		"第 5 段：结尾。",
	];
	container.innerHTML =
		'<div class="nyareader-txt-scroll"><div class="nyareader-txt-spacer"><div class="nyareader-txt-window">' +
		paras.map((t, i) => '<p class="nyareader-txt-para" data-index="' + i + '">' + t + "</p>").join("") +
		"</div></div></div>";
	return container.querySelector(".nyareader-txt-window");
}

function regionsOf(root, mode) {
	return mode === "chapters" ? collectChapterRegions(root) : collectParagraphRegions(root);
}

function regionTextOf(root, mode, key) {
	const region = regionsOf(root, mode).find((r) => r.key === key);
	return region ? region.nodes.map((n) => n.textContent || "").join("") : "";
}

function rangeAnchorOf(root, mode, key, needle) {
	const text = regionTextOf(root, mode, key);
	const i = text.indexOf(needle);
	if (i < 0) throw new Error("needle not found in " + key + ": " + needle);
	return { charStart: i, charEnd: i + needle.length };
}

/**
 * 在"目标文本正中间那个字符"上派发真实 click。
 * CSS Custom Highlight 不改 DOM，命中测试靠 caretRangeFromPoint，
 * 所以点击点必须落在高亮区间内（点段落左边缘会落在区间之外）。
 */
function clickOnNeedle(root, needle) {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	while (walker.nextNode()) {
		const t = walker.currentNode;
		const i = t.data.indexOf(needle);
		if (i < 0) continue;
		const mid = i + Math.floor(needle.length / 2);
		const range = document.createRange();
		range.setStart(t, mid);
		range.setEnd(t, mid + 1);
		const r = range.getBoundingClientRect();
		const x = Math.round(r.left + r.width / 2);
		const y = Math.round(r.top + r.height / 2);
		const el = document.elementFromPoint(x, y) || t.parentElement;
		el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
		return { x, y };
	}
	return null;
}

window.__run = async function (scenario) {
	const mode = scenario.mode || "chapters";
	const host = document.getElementById("host");
	host.innerHTML = "";
	const container = document.createElement("div");
	host.appendChild(container);
	const root = mode === "chapters" ? buildChapters(container) : buildParagraphs(container);
	const out = { scenario: scenario.name, mode, errors: window.__errors.slice() };

	// 降级路径：临时移除 CSS Custom Highlight API（真实兼容性风险场景）
	const savedCss = window.CSS && window.CSS.highlights;
	const savedHighlight = window.Highlight;
	if (scenario.disableHighlightApi) {
		if (window.CSS) delete window.CSS.highlights;
		delete window.Highlight;
	}

	const layerHost = makeHost(root, mode);
	const textBefore = root.textContent;
	const layer = new NyarHl.HighlightLayer(layerHost);
	layer.setClickHandler((id) => { window.__clicked = id; });

	let highlights;
	if (mode === "chapters") {
		const a0 = rangeAnchorOf(root, mode, "nyareader-epub-0", "第一段文字");
		const a2 = rangeAnchorOf(root, mode, "nyareader-epub-2", "目标句子内容");
		highlights = [
			{ id: "h-exact", color: "yellow", hasNote: false, text: "第一段文字",
				anchor: { kind: "chapter", primary: "nyareader-epub-0", charStart: a0.charStart, charEnd: a0.charEnd, quote: { exact: "第一段文字", prefix: "这是", suffix: "，用来" }, progression: 0.1, v: 1 } },
			{ id: "h-quote", color: "green", hasNote: true, text: "目标句子内容",
				anchor: { kind: "chapter", primary: "nyareader-epub-2", quote: { exact: "目标句子内容" }, progression: 0.8, v: 1 } },
			{ id: "h-twice", color: "blue", hasNote: false, text: "被重复的句子",
				anchor: { kind: "chapter", primary: "nyareader-epub-1", quote: { exact: "被重复的句子" }, progression: 0.5, v: 1 } },
			// primary 指向不存在的章节：必须靠整篇文本指纹兜底
			{ id: "h-docfallback", color: "purple", hasNote: false, text: "中间段落",
				anchor: { kind: "chapter", primary: "nyareader-epub-99", quote: { exact: "中间段落" }, progression: 0.6, v: 1 } },
			// 指纹过短且不存在：只能 progression-only
			{ id: "h-progress", color: "orange", hasNote: false, text: "不存在",
				anchor: { kind: "chapter", primary: "nyareader-epub-9", quote: { exact: "不存在" }, progression: 0.37, v: 1 } },
		];
	} else {
		const a3 = rangeAnchorOf(root, mode, "3", "移出虚拟窗口");
		highlights = [
			{ id: "p-exact", color: "yellow", hasNote: false, text: "移出虚拟窗口",
				anchor: { kind: "paragraph", primary: "3", paraIndex: 3, charStart: a3.charStart, charEnd: a3.charEnd, quote: { exact: "移出虚拟窗口" }, progression: 0.5, v: 1 } },
			{ id: "p-quote", color: "green", hasNote: false, text: "冲突开始",
				anchor: { kind: "paragraph", primary: "4", paraIndex: 4, quote: { exact: "冲突开始" }, progression: 0.7, v: 1 } },
			{ id: "p-missing", color: "blue", hasNote: false, text: "不存在",
				anchor: { kind: "paragraph", primary: "99", paraIndex: 99, quote: { exact: "不存在" }, progression: 0.42, v: 1 } },
		];
	}
	layer.setHighlights(highlights);
	const renderedTarget = mode === "chapters" ? 4 : 2;
	out.usesHighlightApi = layer.usesHighlightApi;
	out.renderedAfterSet = layer.renderedCount();
	out.spansAfterSet = document.querySelectorAll("span.nyar-hl").length;
	out.placements = layer.placements().map((p) => ({ id: p.id, quality: p.quality, approximate: p.approximate, rendered: p.rendered }));
	out.approximateCount = out.placements.filter((p) => p.approximate).length;
	out.textUnchangedAfterSet = root.textContent === textBefore;
	out.apiRangeCount = 0;
	if (window.CSS && window.CSS.highlights && window.CSS.highlights.get) {
		for (const color of ["yellow", "green", "blue", "pink", "purple", "orange"]) {
			const h = window.CSS.highlights.get("nyar-hl-" + color);
			if (h) out.apiRangeCount += typeof h.size === "number" ? h.size : 0;
		}
	}

	// 1) 模拟"改字号"（版式变化、DOM 不动）后刷新
	root.style.fontSize = "26px";
	layer.refresh();
	out.renderedAfterFontChange = layer.renderedCount();

	// 2) 模拟"切单双页/切滚动分页"：容器被搬动（节点换父元素）后刷新
	document.body.appendChild(root);
	container.appendChild(root);
	layer.refresh();
	out.renderedAfterReparent = layer.renderedCount();

	if (mode === "chapters") {
		// 3) 模拟"后台补章"：追加新章节 + 结构版本变化
		const extra = document.createElement("span");
		extra.id = "nyareader-epub-3";
		extra.className = "nyareader-epub-anchor";
		root.appendChild(extra);
		const p = document.createElement("p");
		p.textContent = "补章后的新章节，里面有一句补章新增的文字。";
		root.appendChild(p);
		layerHost.bump();
		layer.refresh();
		out.renderedAfterAppend = layer.renderedCount();
		const added = rangeAnchorOf(root, mode, "nyareader-epub-3", "补章新增的文字");
		layer.addHighlight({ id: "h-appended", color: "pink", hasNote: false, text: "补章新增的文字",
			anchor: { kind: "chapter", primary: "nyareader-epub-3", charStart: added.charStart, charEnd: added.charEnd, quote: { exact: "补章新增的文字" }, progression: 0.95, v: 1 } });
		out.renderedAfterAppendAdd = layer.renderedCount();
		out.appendedHighlightVisible = layer.placements().some((pl) => pl.id === "h-appended" && pl.rendered === true);
		out.originalsStillVisible = ["h-exact", "h-quote", "h-twice", "h-docfallback"].every((id) =>
			layer.placements().some((pl) => pl.id === id && pl.rendered === true));
		out.clickId = "h-quote";
		out.clickNeedle = "目标句子内容";
	} else {
		// 3') 虚拟滚动：目标段落移出窗口 → 未渲染；移回 → 重新应用
		const target = root.querySelector('p[data-index="3"]');
		const holder = document.createElement("div");
		document.body.appendChild(holder);
		holder.appendChild(target);
		layerHost.bump();
		layer.refresh();
		out.renderedAfterWindowOut = layer.renderedCount();
		out.windowOutPlacement = layer.placements().find((pl) => pl.id === "p-exact");
		out.windowOutStillInDom = !!root.querySelector('p[data-index="3"]');
		root.appendChild(target);
		holder.remove();
		layerHost.bump();
		layer.refresh();
		out.renderedAfterWindowBack = layer.renderedCount();
		out.windowBackPlacement = layer.placements().find((pl) => pl.id === "p-exact");
		out.clickId = "p-quote";
		out.clickNeedle = "冲突开始";
	}

	// 4) 点击命中测试
	window.__clicked = null;
	if (scenario.disableHighlightApi) {
		const span = root.querySelector('span.nyar-hl[data-nyar-hl-id="' + out.clickId + '"]');
		out.clickSpanFound = !!span;
		if (span) span.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	} else {
		out.clickCoords = clickOnNeedle(root, out.clickNeedle);
	}
	out.clickedId = window.__clicked;

	// 5) progression 兜底跳转（只有显式 focus 才跳）
	window.__progression = null;
	layer.focus(mode === "chapters" ? "h-progress" : "p-missing");
	out.progressionFallback = window.__progression;
	out.focusExpected = mode === "chapters" ? 0.37 : 0.42;

	// 6) 删除一条
	out.renderedBeforeRemove = layer.renderedCount();
	layer.removeHighlight(mode === "chapters" ? "h-quote" : "p-quote");
	out.renderedAfterRemove = layer.renderedCount();
	out.diagnostics = layer.diagnostics();

	// 7) 释放：DOM 文本必须完全恢复（span 降级路径尤其重要）
	const textBeforeDispose = root.textContent;
	layer.dispose();
	out.spansAfterDispose = document.querySelectorAll("span.nyar-hl").length;
	out.textUnchangedAfterDispose = root.textContent === textBeforeDispose;

	if (scenario.disableHighlightApi) {
		window.Highlight = savedHighlight;
		if (window.CSS && savedCss) window.CSS.highlights = savedCss;
	}
	out.renderedTarget = renderedTarget;
	out.disableHighlightApi = !!scenario.disableHighlightApi;
	return out;
};
`;
}

function harnessHtml(bundleName) {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0}#host{width:900px}
.nyareader-columns{column-width:400px;column-gap:20px;height:600px;column-fill:auto}</style></head>
<body><div id="host"></div>
<script src="./${bundleName}"><\/script>
<script>${pageScript()}<\/script></body></html>`;
}

async function cdpEval(url, expression) {
	const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
	const page = list.find((t) => t.type === "page");
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
	const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	ws.close();
	if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails.exception || res.exceptionDetails));
	return res.result.value;
}

function allScenariosExpression(scenarios) {
	return `(async () => {
		const deadline = Date.now() + 10000;
		while (typeof window.__run !== "function" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		if (typeof window.__run !== "function") return JSON.stringify({ fatal: "harness not ready" });
		const out = [];
		for (const s of ${JSON.stringify(scenarios)}) out.push(await window.__run(s));
		return JSON.stringify({ results: out });
	})()`;
}

function judge(payload) {
	const checks = [];
	for (const r of payload) {
		const n = r.scenario;
		const q = Object.fromEntries((r.placements || []).map((p) => [p.id, p.quality]));
		checks.push([`${n}: setHighlights 后渲染 ${r.renderedTarget} 条`, r.renderedAfterSet === r.renderedTarget]);
		checks.push([`${n}: 降级链 quality 正确`, r.mode === "chapters"
			? q["h-exact"] === "exact-range" && q["h-quote"] === "quote-unique" && q["h-twice"] === "quote-first" && q["h-docfallback"] === "quote-unique" && q["h-progress"] === "progression-only"
			: q["p-exact"] === "exact-range" && q["p-quote"] === "quote-unique" && q["p-missing"] === "progression-only"]);
		checks.push([`${n}: approximate 只标降级项`, r.mode === "chapters" ? r.approximateCount === 2 : r.approximateCount === 1]);
		checks.push([`${n}: 改字号后仍在`, r.renderedAfterFontChange === r.renderedTarget]);
		checks.push([`${n}: 容器被搬动（切模式）后仍在`, r.renderedAfterReparent === r.renderedTarget]);
		checks.push([`${n}: 高亮不改文本`, r.textUnchangedAfterSet === true && r.textUnchangedAfterDispose === true]);
		checks.push([`${n}: 点击命中返回 id`, r.clickedId === r.clickId]);
		checks.push([`${n}: progression 兜底跳转`, r.progressionFallback === r.focusExpected]);
		checks.push([`${n}: 删除后少一条`, r.renderedAfterRemove === r.renderedBeforeRemove - 1]);
		checks.push([`${n}: dispose 清理干净`, r.spansAfterDispose === 0]);
		if (r.disableHighlightApi) {
			checks.push([`${n}: 降级为 span 包裹`, r.usesHighlightApi === false && r.spansAfterSet === r.renderedTarget && r.clickSpanFound === true]);
		} else {
			checks.push([`${n}: 走 CSS Custom Highlight API（DOM 未改）`, r.usesHighlightApi === true && r.spansAfterSet === 0 && r.apiRangeCount === r.renderedTarget]);
		}
		if (r.mode === "chapters") {
			checks.push([`${n}: 追加章节后原 ${r.renderedTarget} 条仍在`, r.renderedAfterAppend === r.renderedTarget && r.originalsStillVisible === true]);
			checks.push([`${n}: 追加章节后新内容可高亮`, r.renderedAfterAppendAdd === r.renderedTarget + 1 && r.appendedHighlightVisible === true]);
		} else {
			checks.push([`${n}: 段落移出窗口 → 未渲染且标 pending`, r.renderedAfterWindowOut === r.renderedTarget - 1 && r.windowOutPlacement && r.windowOutPlacement.rendered === false]);
			checks.push([`${n}: 段落移回窗口 → 重新应用`, r.renderedAfterWindowBack === r.renderedTarget && r.windowBackPlacement && r.windowBackPlacement.rendered === true]);
		}
	}
	return checks;
}

async function main() {
	if (!existsSync(EDGE)) throw new Error("未找到 Edge");
	await bundleLayer();
	const bundleName = "layer-bundle.js";
	const dir = mkdtempSync(join(tmpdir(), "nyar-hl-"));
	writeFileSync(join(dir, "harness.html"), harnessHtml(bundleName), "utf8");
	writeFileSync(join(dir, bundleName), readFileSync(BUNDLE, "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-hl-profile-"));
	const file = join(dir, "harness.html");
	const url = `file:///${file.replace(/\\/g, "/")}`;
	const child = spawn(
		EDGE,
		["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1200,800", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, url],
		{ stdio: "ignore" }
	);

	const scenarios = [
		{ name: "css-highlight-api", mode: "chapters" },
		{ name: "span-fallback", mode: "chapters", disableHighlightApi: true },
		{ name: "txt-window", mode: "paragraphs" },
		{ name: "txt-window-span-fallback", mode: "paragraphs", disableHighlightApi: true },
	];
	try {
		let payload = null;
		for (let i = 0; i < 40 && !payload; i++) {
			try {
				await new Promise((r) => setTimeout(r, 300));
				const raw = await cdpEval(url, allScenariosExpression(scenarios));
				const parsed = JSON.parse(raw);
				if (parsed.fatal) throw new Error(parsed.fatal);
				payload = parsed.results;
			} catch (e) {
				if (i === 39) throw e;
			}
		}
		if (!payload) throw new Error("harness 未就绪");
		const checks = judge(payload);
		const report = { results: payload, checks: checks.map(([name, pass]) => ({ name, pass: !!pass })), pass: checks.every(([, ok]) => !!ok) };
		const outFile = process.env.NYAR_HL_REPORT || join(tmpdir(), "nyar-highlight-layer-report.json");
		writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
		console.log(`report: ${outFile}`);
		console.log(JSON.stringify({ pass: report.pass, failed: report.checks.filter((c) => !c.pass).map((c) => c.name) }, null, 2));
		process.exitCode = report.pass ? 0 : 1;
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("highlight-layer-check failed:", e.message);
	process.exitCode = 2;
});
