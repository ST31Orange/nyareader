/**
 * 真实浏览器验证：**真实 HtmlDocEngine** 里的批注高亮（EPUB/MOBI 路径）。
 *
 * 为什么必须有这个 harness：`mount()` → `relayoutPages()` 是每次打开书都必经的路径，
 * 纯逻辑单测（node 环境、合成 DOM）覆盖不到它 —— 曾经出现过
 * `this.refreshHighlights is not a function` 这种"typecheck/vitest 全绿但打开书即崩"的回归。
 *
 * 断言（每条都取真实数字）：
 * 1. `mount()` 之后 `getTotalPages()` 正常返回，且**没有未捕获异常**；
 * 2. `setHighlights()` 后可见高亮节点数 > 0（CSS Custom Highlight API 的 Range 数 / 降级 span 数）；
 * 3. 改字号（applySettings）后仍 > 0；
 * 4. `switchMode` 往返（分页 → 滚动 → 分页）后仍 > 0；
 * 5. `notifyContentAppended()` 补章落盘后，指向新章节的高亮从未渲染变为已渲染；
 * 6. 点击高亮 → 回调拿到 id；
 * 7. 全程正文文本不变（不改内容）。
 *
 * 用法：node tests/manual/highlight-engine-check.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BUNDLE = join(ROOT, "tests", "manual", ".highlight-engine-bundle.js");
const PORT = 9500 + Math.floor(Math.random() * 300);

async function bundleEngine() {
	mkdirSync(join(ROOT, "tests", "manual"), { recursive: true });
	const esbuild = await import("esbuild");
	await esbuild.build({
		entryPoints: [join(ROOT, "src/services/books/formats/mobi/HtmlDocEngine.ts")],
		bundle: true,
		format: "iife",
		globalName: "NyarEngine",
		platform: "browser",
		outfile: BUNDLE,
		logLevel: "error",
		external: ["obsidian"],
	});
}

const UNIQUE = {
	0: "锚点往返定位的目标句子",
	1: "指纹唯一命中的目标句子",
	5: "补章后新增章节里的目标句子",
};

function syntheticHtml() {
	const para = (t) => `<p>${t}</p>`;
	let out = "";
	for (let c = 0; c <= 4; c++) {
		let body = `<span id="nyareader-epub-${c}" class="nyareader-epub-anchor"></span>`;
		// 标记句放在章节最前面：这样 goTo(章节锚点) 后它一定在可见页内（点击命中测试需要真实坐标）
		if (UNIQUE[c]) body += para(`第 ${c} 章标记句：这一段包含 ${UNIQUE[c]}，用于高亮定位。`);
		for (let k = 0; k < 60; k++) body += para(`第 ${c} 章第 ${k} 段：这里是用于分页测量的正文内容，需要足够长才能排满多页。`);
		out += body;
	}
	return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${out}</body></html>`;
}

function appendedChapterHtml() {
	const para = (t) => `<p>${t}</p>`;
	let body = `<span id="nyareader-epub-5" class="nyareader-epub-anchor"></span>`;
	body += para(`第 5 章标记句：这一段包含 ${UNIQUE[5]}，用于验证补章后的高亮。`);
	for (let k = 0; k < 30; k++) body += para(`第 5 章第 ${k} 段：补章追加的内容。`);
	return body;
}

function harnessHtml(bundleFileName) {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#host{position:relative;width:100vw;height:100vh}</style></head>
<body><div id="host"></div>
<script>window.__errors=[];window.addEventListener("error",function(e){window.__errors.push(String(e.message||e));});<\/script>
<script src="./${bundleFileName}"><\/script>
<script>
window.__loaded = typeof NyarEngine !== "undefined" && !!NyarEngine.HtmlDocEngine;
const COLORS = ["yellow", "green", "blue", "pink", "purple", "orange"];
// 被高亮的独特句子（用变量承载，避免拼进表达式时被当成标识符）
const U0 = "${UNIQUE[0]}";
const U1 = "${UNIQUE[1]}";
const U5 = "${UNIQUE[5]}";

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
	if (!el.addClass) el.addClass = function (c) { this.classList.add(c); };
	if (!el.toggleClass) el.toggleClass = function (c, on) { this.classList.toggle(c, on === undefined ? undefined : !!on); };
	return el;
}

/** 与引擎 highlightRegions() 一致的章节区域切分：锚点 span → 下一个锚点 span 之前。 */
function regionNodesOf(root, key) {
	const out = [];
	let current = null;
	for (const node of Array.from(root.childNodes)) {
		if (node.nodeType === 1 && /^nyareader-(epub|mobi)-\\d+$/.test(node.id)) {
			if (current) break;
			if (node.id === key) { current = []; out.push(node); continue; }
			continue;
		}
		if (current) out.push(node);
	}
	return out;
}

function chapterTextOf(root, key) {
	return regionNodesOf(root, key).map((n) => n.textContent || "").join("");
}

/** 真实可见高亮计数：API 路径数 Range 总数，降级路径数 span 数。 */
function highlightNodeCount(doc) {
	let api = 0;
	const registry = doc.defaultView && doc.defaultView.CSS && doc.defaultView.CSS.highlights;
	if (registry && registry.get) {
		for (const c of COLORS) {
			const h = registry.get("nyar-hl-" + c);
			if (h && typeof h.size === "number") api += h.size;
		}
	}
	const spans = doc.querySelectorAll("span.nyar-hl").length;
	return { api: api, spans: spans, total: api + spans };
}

function renderedCount(engine) {
	return (engine.getHighlightPlacements() || []).filter((p) => p.rendered === true).length;
}

window.__run = async function (scenario) {
	const result = { scenario: scenario.name, steps: [] };
	const step = (name, extra) => result.steps.push(Object.assign({ name: name }, extra || {}));
	try {
		const host = decorate(document.getElementById("host"));
		const settings = { fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24, theme: "light",
			layout: "single", scrollMode: false, pageWidth: 640 };
		const engine = new NyarEngine.HtmlDocEngine({
			book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
			html: scenario.html,
			formatLabel: "epub",
		});
		let clicked = null;
		engine.setHighlightClickHandler((id) => { clicked = id; });
		await engine.mount(host);
		engine.applySettings(settings);
		await new Promise((r) => setTimeout(r, 200));
		const iframe = host.querySelector("iframe");
		const doc = iframe.contentDocument;
		doc.defaultView.addEventListener("error", (e) => window.__errors.push("iframe: " + String(e.message || e)));
		result.errorsAfterMount = window.__errors.slice();
		result.pages = engine.getTotalPages();
		result.mountOk = result.pages > 0;
		step("mount", { pages: result.pages, errors: result.errorsAfterMount.length });

		const root = doc.querySelector(".nyareader-columns") || doc.body;
		result.hasColumns = !!doc.querySelector(".nyareader-columns");
		const textBefore = root.textContent;

		// 组装三条高亮：结构定位 / 指纹唯一 / 尚未加载的章节
		const t0 = chapterTextOf(root, "nyareader-epub-0");
		const i0 = t0.indexOf(U0);
		result.anchorComputed = i0 >= 0;
		const highlights = [
			{ id: "h-exact", color: "yellow", hasNote: false, text: U0,
				anchor: { kind: "chapter", primary: "nyareader-epub-0", charStart: i0, charEnd: i0 + U0.length,
					quote: { exact: U0, prefix: "包含 ", suffix: "，用于" }, progression: 0.05, v: 1 } },
			{ id: "h-quote", color: "green", hasNote: true, text: U1,
				anchor: { kind: "chapter", primary: "nyareader-epub-1", quote: { exact: U1 }, progression: 0.3, v: 1 } },
			{ id: "h-late", color: "blue", hasNote: false, text: U5,
				anchor: { kind: "chapter", primary: "nyareader-epub-5", quote: { exact: U5 }, progression: 0.9, v: 1 } },
		];
		engine.setHighlights(highlights);
		await new Promise((r) => setTimeout(r, 60));
		result.countAfterSet = highlightNodeCount(doc);
		result.renderedAfterSet = renderedCount(engine);
		result.placementsAfterSet = engine.getHighlightPlacements().map((p) => ({ id: p.id, quality: p.quality, rendered: p.rendered, approximate: p.approximate }));
		step("setHighlights", { total: result.countAfterSet.total, rendered: result.renderedAfterSet });

		// 3) 改字号
		engine.applySettings(Object.assign({}, settings, { fontSize: 26 }));
		engine.getTotalPages(); // 同步落地（stream-f：applySettings 可能推迟到下一帧）
		await new Promise((r) => setTimeout(r, 120));
		result.pagesAfterFont = engine.getTotalPages();
		result.countAfterFont = highlightNodeCount(doc);
		result.renderedAfterFont = renderedCount(engine);
		step("fontSize18to26", { pages: result.pagesAfterFont, total: result.countAfterFont.total, rendered: result.renderedAfterFont });

		// 4) 切滚动 → 回分页
		engine.switchMode(true);
		await new Promise((r) => setTimeout(r, 80));
		result.countAfterScroll = highlightNodeCount(doc);
		result.renderedAfterScroll = renderedCount(engine);
		engine.switchMode(false);
		engine.getTotalPages();
		await new Promise((r) => setTimeout(r, 80));
		result.countAfterBackToPaged = highlightNodeCount(doc);
		result.renderedAfterBackToPaged = renderedCount(engine);
		step("switchMode-roundtrip", { scroll: result.countAfterScroll.total, paged: result.countAfterBackToPaged.total, renderedPaged: result.renderedAfterBackToPaged });

		// 5) 后台补章：h-late 指向的章节此前不存在，落盘后必须变成已渲染
		result.lateBeforeAppend = engine.getHighlightPlacements().find((p) => p.id === "h-late");
		engine.notifyContentAppended(scenario.appendedHtml);
		await new Promise((r) => setTimeout(r, 400));
		engine.getTotalPages();
		result.pagesAfterAppend = engine.getTotalPages();
		result.countAfterAppend = highlightNodeCount(doc);
		result.renderedAfterAppend = renderedCount(engine);
		result.lateAfterAppend = engine.getHighlightPlacements().find((p) => p.id === "h-late");
		step("appendChapter", { pages: result.pagesAfterAppend, total: result.countAfterAppend.total, rendered: result.renderedAfterAppend, lateRendered: !!(result.lateAfterAppend && result.lateAfterAppend.rendered) });

		// 6) 点击命中（CSS Highlight 路径靠坐标命中，必须在 iframe 内派发真实坐标的 click）
		//    先跳到该高亮所在章节：分页模式下视口外的坐标 elementFromPoint 拿不到元素
		await engine.goTo("#nyareader-epub-1");
		await new Promise((r) => setTimeout(r, 80));
		const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
		while (walker.nextNode()) {
			const t = walker.currentNode;
			const i = t.data.indexOf(U1);
			if (i < 0) continue;
			const mid = i + Math.floor(U1.length / 2);
			const range = doc.createRange();
			range.setStart(t, mid);
			range.setEnd(t, mid + 1);
			const r = range.getBoundingClientRect();
			const x = Math.round(r.left + r.width / 2);
			const y = Math.round(r.top + r.height / 2);
			const target = doc.elementFromPoint(x, y) || t.parentElement;
			target.dispatchEvent(new doc.defaultView.MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
			result.clickPoint = { x: x, y: y };
			break;
		}
		result.clickedId = clicked;
		step("click", { clicked: clicked });

		// 6') 按章独立分页的耦合：章节被移出布局区（冷区 display:none）后，
		//     高亮应变成"待激活/未渲染"；章节回到布局区并调用 refreshHighlights() 后必须自动恢复。
		if (scenario.coldZone) {
			const root2 = doc.querySelector(".nyareader-columns") || doc.body;
			const anchor2 = doc.getElementById("nyareader-epub-2");
			const moved = [];
			let capture = false;
			for (const child of Array.from(root2.childNodes)) {
				if (child.nodeType === 1 && child.id === "nyareader-epub-1") capture = true;
				else if (child === anchor2) capture = false;
				if (capture) moved.push(child);
			}
			result.coldZoneNodes = moved.length;
			const cold = doc.createElement("div");
			cold.style.display = "none";
			doc.body.appendChild(cold);
			for (const n of moved) cold.appendChild(n);
			engine.refreshHighlights();
			result.coldOut = engine.getHighlightPlacements().find((p) => p.id === "h-quote");
			result.countWhileCold = highlightNodeCount(doc);
			// 章节回到布局区（插回第 2 章锚点前）+ 显式重放
			for (const n of moved) root2.insertBefore(n, anchor2);
			cold.remove();
			engine.refreshHighlights();
			result.coldBack = engine.getHighlightPlacements().find((p) => p.id === "h-quote");
			result.countAfterColdBack = highlightNodeCount(doc);
			step("cold-zone-roundtrip", {
				whileColdRendered: !!(result.coldOut && result.coldOut.rendered),
				backRendered: !!(result.coldBack && result.coldBack.rendered),
				totalAfterColdBack: result.countAfterColdBack.total,
			});
		}

		// 7) 正文文本必须没被改动（注意：切模式会重建多栏容器，所以要重新取当前根节点）
		const rootNow = doc.querySelector(".nyareader-columns") || doc.body;
		result.textPrefixPreserved = rootNow.textContent.indexOf(textBefore.slice(0, 200)) === 0;
		result.rootTextLengthBefore = textBefore.length;
		result.rootTextLengthNow = rootNow.textContent.length;
		result.finalErrors = window.__errors.slice();
		engine.destroy();
		result.destroyedOk = true;
	} catch (e) {
		result.fatal = String((e && e.stack) || e);
		result.finalErrors = window.__errors.slice();
	}
	return result;
};
<\/script></body></html>`;
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

async function main() {
	if (!existsSync(EDGE)) throw new Error("未找到 Edge");
	await bundleEngine();
	const bundleName = "engine-bundle.js";
	const page = harnessHtml(bundleName);
	const dir = mkdtempSync(join(tmpdir(), "nyar-hl-engine-"));
	writeFileSync(join(dir, "harness.html"), page, "utf8");
	writeFileSync(join(dir, bundleName), readFileSync(BUNDLE, "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-hl-engine-profile-"));
	const file = join(dir, "harness.html");
	const url = `file:///${file.replace(/\\/g, "/")}`;
	const child = spawn(
		EDGE,
		["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1200,800", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, url],
		{ stdio: "ignore" }
	);

	const scenarios = [
		{ name: "epub-paged", html: syntheticHtml(), appendedHtml: appendedChapterHtml() },
		{ name: "epub-cold-zone", html: syntheticHtml(), appendedHtml: appendedChapterHtml(), coldZone: true },
	];
	const expression = (list) => `(async () => {
		const deadline = Date.now() + 10000;
		while (typeof window.__run !== "function" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		if (typeof window.__run !== "function") return JSON.stringify({ fatal: "harness not ready", loaded: window.__loaded, errors: window.__errors });
		const out = [];
		for (const s of ${JSON.stringify(list)}) out.push(await window.__run(s));
		return JSON.stringify({ results: out });
	})()`;

	try {
		let payload = null;
		for (let i = 0; i < 40 && !payload; i++) {
			try {
				await new Promise((r) => setTimeout(r, 300));
				const raw = await cdpEval(url, expression(scenarios));
				const parsed = JSON.parse(raw);
				if (parsed.fatal) throw new Error(String(parsed.fatal));
				payload = parsed.results;
			} catch (e) {
				if (i === 39) throw e;
			}
		}
		if (!payload) throw new Error("harness 未就绪");
		const checks = [];
		for (const r of payload) {
			const n = r.scenario;
			checks.push([`${n}: mount 未抛异常`, !r.fatal && (r.errorsAfterMount || []).length === 0]);
			checks.push([`${n}: mount 后可正常测量页数`, r.mountOk === true && r.pages > 1]);
			checks.push([`${n}: 分页容器存在`, r.hasColumns === true]);
			checks.push([`${n}: 锚点结构定位可计算`, r.anchorComputed === true]);
			checks.push([`${n}: setHighlights 后高亮节点数 > 0`, r.countAfterSet && r.countAfterSet.total > 0]);
			checks.push([`${n}: setHighlights 后已渲染 2 条（第 3 条章节未加载）`, r.renderedAfterSet === 2]);
			checks.push([`${n}: 降级链 exact-range / quote-unique / progression-only`,
				(r.placementsAfterSet || []).some((p) => p.id === "h-exact" && p.quality === "exact-range") &&
				(r.placementsAfterSet || []).some((p) => p.id === "h-quote" && p.quality === "quote-unique") &&
				(r.placementsAfterSet || []).some((p) => p.id === "h-late" && p.quality === "progression-only")]);
			checks.push([`${n}: 改字号后高亮仍在且 > 0`, r.renderedAfterFont === 2 && r.countAfterFont.total > 0]);
			checks.push([`${n}: 改字号真的重排了页数`, r.pagesAfterFont !== r.pages]);
			checks.push([`${n}: 切滚动后高亮仍在`, r.renderedAfterScroll === 2 && r.countAfterScroll.total > 0]);
			checks.push([`${n}: 切回分页后高亮仍在`, r.renderedAfterBackToPaged === 2 && r.countAfterBackToPaged.total > 0]);
			checks.push([`${n}: 补章前 h-late 未渲染`, r.lateBeforeAppend && r.lateBeforeAppend.rendered === false]);
			checks.push([`${n}: 补章落盘后 h-late 已渲染`, r.lateAfterAppend && r.lateAfterAppend.rendered === true]);
			checks.push([`${n}: 补章后总渲染 3 条`, r.renderedAfterAppend === 3]);
			checks.push([`${n}: 补章后总页数增长`, r.pagesAfterAppend > r.pagesAfterFont]);
			checks.push([`${n}: 点击高亮回调拿到 id`, r.clickedId === "h-quote"]);
			checks.push([`${n}: 正文文本前缀未被破坏`, r.textPrefixPreserved === true]);
			checks.push([`${n}: 全程无未捕获异常`, (r.finalErrors || []).length === 0]);
			checks.push([`${n}: destroy 正常`, r.destroyedOk === true]);
			if (r.coldOut) {
				checks.push([`${n}: 章节进入冷区 → 高亮未渲染且原因是"不在布局区"`,
					r.coldOut.rendered === false && /布局区/.test(r.coldOut.reason || "")]);
				checks.push([`${n}: 章节回到布局区 + refreshHighlights() → 高亮自动恢复`,
					r.coldBack && r.coldBack.rendered === true && r.countAfterColdBack.total === 3]);
			}
		}
		const r0 = payload[0];
		const report = { results: payload, checks: checks.map(([name, pass]) => ({ name, pass: !!pass })), pass: checks.every(([, ok]) => !!ok) };
		const outFile = process.env.NYAR_HL_ENGINE_REPORT || join(tmpdir(), "nyar-highlight-engine-report.json");
		writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
		console.log(`report: ${outFile}`);
		console.log(JSON.stringify({ pass: report.pass, failed: report.checks.filter((c) => !c.pass).map((c) => c.name), numbers: {
			pagesAfterMount: r0.pages, pagesAfterFont: r0.pagesAfterFont, pagesAfterAppend: r0.pagesAfterAppend,
			highlightsAfterSet: r0.countAfterSet, highlightsAfterFont: r0.countAfterFont,
			highlightsAfterScroll: r0.countAfterScroll, highlightsAfterBackToPaged: r0.countAfterBackToPaged,
			highlightsAfterAppend: r0.countAfterAppend, clicked: r0.clickedId,
			coldZoneWhileColdRendered: r0.coldOut && r0.coldOut.rendered,
			coldZoneAfterBack: r0.coldBack && r0.coldBack.rendered,
			errors: (r0.finalErrors || []).length,
		} }, null, 2));
		process.exitCode = report.pass ? 0 : 1;
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("highlight-engine-check failed:", e.message);
	process.exitCode = 2;
});
