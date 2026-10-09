/**
 * 真实浏览器验证：**真实 TxtEngine** 的高亮（虚拟滚动下"移出窗口再回来"必须重新应用）。
 *
 * task-9 验收里明确要求这一条：TXT 是虚拟滚动，段落被回收时其 DOM 节点被删除，
 * 高亮只能靠"重新解析锚点"恢复 —— 纯逻辑单测覆盖不到，必须用真实引擎跑。
 *
 * 用法：node tests/manual/highlight-txt-engine-check.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BUNDLE = join(ROOT, "tests", "manual", ".highlight-txt-engine-bundle.js");
const PORT = 9900 + Math.floor(Math.random() * 90);
const NEEDLE_FIRST = "第三段里面的独特句子";
const NEEDLE_FAR = "第一百五十段里面的独特句子";

async function bundleEngine() {
	mkdirSync(join(ROOT, "tests", "manual"), { recursive: true });
	const esbuild = await import("esbuild");
	await esbuild.build({
		entryPoints: [join(ROOT, "src/services/books/formats/txt/TxtEngine.ts")],
		bundle: true,
		format: "iife",
		globalName: "NyarTxt",
		platform: "browser",
		outfile: BUNDLE,
		logLevel: "error",
		external: ["obsidian"],
	});
}

function harnessHtml(bundleName) {
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%}#host{position:relative;width:800px;height:600px}
.nyareader-txt-scroll{position:relative;overflow:auto;height:100%;padding:16px}
.nyareader-txt-spacer{position:relative}
.nyareader-txt-window{position:absolute;left:0;right:0}
.nyareader-txt-para{margin:0;padding-bottom:0.6em}
</style></head>
<body><div id="host"></div>
<script src="./${bundleName}"><\/script>
<script>
window.__errors = [];
window.addEventListener("error", (e) => window.__errors.push(String(e.message || e)));

function decorate(el) {
	el.createEl = function (tag, o) {
		const c = document.createElement(tag);
		if (o && o.cls) c.className = o.cls;
		if (o && o.text != null) c.textContent = o.text;
		if (o && o.attr) for (const k in o.attr) c.setAttribute(k, o.attr[k]);
		this.appendChild(c);
		// Obsidian 的 createEl 返回的元素本身也带这套方法（TxtEngine 会连续 createDiv 两层）
		return decorate(c);
	};
	el.createDiv = function (o) { return this.createEl("div", o); };
	el.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
	if (!el.addClass) el.addClass = function (c) { this.classList.add(c); };
	if (!el.toggleClass) el.toggleClass = function (c, on) { this.classList.toggle(c, on === undefined ? undefined : !!on); };
	return el;
}

const COLORS = ["yellow", "green", "blue", "pink", "purple", "orange"];
function highlightCount(doc) {
	let api = 0;
	const reg = window.CSS && window.CSS.highlights;
	if (reg && reg.get) for (const c of COLORS) { const h = reg.get("nyar-hl-" + c); if (h && typeof h.size === "number") api += h.size; }
	const spans = doc.querySelectorAll("span.nyar-hl").length;
	return { api: api, spans: spans, total: api + spans };
}
function renderedIds(engine) {
	return (engine.getHighlightPlacements() || []).filter((p) => p.rendered === true).map((p) => p.id);
}
function renderedParagraphs(doc) {
	return Array.from(doc.querySelectorAll("p.nyareader-txt-para[data-index]")).map((p) => p.dataset.index);
}

function makeParagraphs() {
	const out = [];
	for (let i = 0; i < 300; i++) {
		let text = "第 " + i + " 段：这是一段用于虚拟滚动验证的正文，长度足够产生多行高度，确保段落高度估算与测量都能生效。";
		if (i === 3) text += " " + "${NEEDLE_FIRST}";
		if (i === 150) text += " " + "${NEEDLE_FAR}";
		out.push(text);
	}
	return out;
}

window.__run = async function () {
	const out = { scenario: "txt-engine-highlight" };
	try {
		const host = decorate(document.getElementById("host"));
		const settings = { fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24, theme: "light",
			layout: "single", scrollMode: true, pageWidth: 640 };
		const engine = new NyarTxt.TxtEngine({
			book: { format: "txt", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
			content: { title: "T", paragraphs: makeParagraphs(), chapters: [] },
		});
		await engine.mount(host);
		engine.applySettings(settings);
		await new Promise((r) => setTimeout(r, 250));
		const doc = document;
		out.errorsAfterMount = window.__errors.slice();

		const highlights = [
			{ id: "p3", color: "yellow", hasNote: false, text: "${NEEDLE_FIRST}",
				anchor: { kind: "paragraph", primary: "3", paraIndex: 3, quote: { exact: "${NEEDLE_FIRST}" }, progression: 0.01, v: 1 } },
			{ id: "p150", color: "green", hasNote: false, text: "${NEEDLE_FAR}",
				anchor: { kind: "paragraph", primary: "150", paraIndex: 150, quote: { exact: "${NEEDLE_FAR}" }, progression: 0.5, v: 1 } },
		];
		engine.setHighlights(highlights);
		await new Promise((r) => setTimeout(r, 80));
		out.renderedAtStart = renderedIds(engine);
		out.countAtStart = highlightCount(doc);
		out.paragraphsAtStart = renderedParagraphs(doc);

		// 跳远：p3 的段落被回收，p150 进入窗口
		engine.goTo("150");
		await new Promise((r) => setTimeout(r, 150));
		out.renderedAfterJumpFar = renderedIds(engine);
		out.countAfterJumpFar = highlightCount(doc);
		out.paragraphsAfterJumpFar = renderedParagraphs(doc);
		out.p3StillInDom = !!doc.querySelector('p[data-index="3"]');

		// 跳回：p3 重新进入窗口 → 高亮必须重新应用
		engine.goTo("3");
		await new Promise((r) => setTimeout(r, 150));
		out.renderedAfterJumpBack = renderedIds(engine);
		out.countAfterJumpBack = highlightCount(doc);
		out.p3Placment = engine.getHighlightPlacements().find((p) => p.id === "p3");

		// 改字号：窗口重建 + 布局重算后仍要在
		engine.applySettings(Object.assign({}, settings, { fontSize: 26 }));
		await new Promise((r) => setTimeout(r, 200));
		out.renderedAfterFont = renderedIds(engine);
		out.countAfterFont = highlightCount(doc);

		// 切分页 → 回滚动
		engine.switchMode(false);
		await new Promise((r) => setTimeout(r, 120));
		out.renderedInPaged = renderedIds(engine);
		engine.switchMode(true);
		await new Promise((r) => setTimeout(r, 150));
		out.renderedBackToScroll = renderedIds(engine);
		out.countAfterModeRoundtrip = highlightCount(doc);

		// 点击高亮（TXT 在主文档里渲染，span 降级路径直接命中；API 路径用坐标）
		let clicked = null;
		engine.setHighlightClickHandler((id) => { clicked = id; });
		const span = doc.querySelector('span.nyar-hl');
		if (span) {
			span.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		} else {
			const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
			while (walker.nextNode()) {
				const t = walker.currentNode;
				const i = t.data.indexOf("${NEEDLE_FIRST}");
				if (i < 0) continue;
				const mid = i + Math.floor("${NEEDLE_FIRST}".length / 2);
				const range = doc.createRange();
				range.setStart(t, mid);
				range.setEnd(t, mid + 1);
				const r = range.getBoundingClientRect();
				const el = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) || t.parentElement;
				el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
				break;
			}
		}
		out.clickedId = clicked;

		// 移除一条后：它必须从高亮集合里消失（当前窗口里它本就不在，所以看集合而不是节点数）
		engine.removeHighlight("p150");
		await new Promise((r) => setTimeout(r, 50));
		out.idsAfterRemove = (engine.getHighlightPlacements() || []).map((p) => p.id);
		out.countAfterRemove = highlightCount(doc);
		out.finalErrors = window.__errors.slice();
		engine.destroy();
		out.destroyedOk = true;
	} catch (e) {
		out.fatal = String((e && e.stack) || e);
		out.finalErrors = window.__errors.slice();
	}
	return out;
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
	const bundleName = "txt-engine-bundle.js";
	const page = harnessHtml(bundleName).replaceAll("${NEEDLE_FIRST}", NEEDLE_FIRST).replaceAll("${NEEDLE_FAR}", NEEDLE_FAR);
	const dir = mkdtempSync(join(tmpdir(), "nyar-hl-txt-"));
	writeFileSync(join(dir, "harness.html"), page, "utf8");
	writeFileSync(join(dir, bundleName), readFileSync(BUNDLE, "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-hl-txt-profile-"));
	const file = join(dir, "harness.html");
	const url = `file:///${file.replace(/\\/g, "/")}`;
	const child = spawn(
		EDGE,
		["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1200,900", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, url],
		{ stdio: "ignore" }
	);
	const expression = `(async () => {
		const deadline = Date.now() + 10000;
		while (typeof window.__run !== "function" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		if (typeof window.__run !== "function") return JSON.stringify({ fatal: "harness not ready", errors: window.__errors });
		return JSON.stringify(await window.__run());
	})()`;
	try {
		let r = null;
		for (let i = 0; i < 40 && !r; i++) {
			try {
				await new Promise((res) => setTimeout(res, 300));
				const parsed = JSON.parse(await cdpEval(url, expression));
				if (parsed.fatal) throw new Error(String(parsed.fatal));
				r = parsed;
			} catch (e) {
				if (i === 39) throw e;
			}
		}
		if (!r) throw new Error("harness 未就绪");
		const has = (list, id) => Array.isArray(list) && list.indexOf(id) >= 0;
		const checks = [
			["mount 未抛异常", !r.fatal && (r.errorsAfterMount || []).length === 0],
			["起始窗口内 p3 已渲染（真实高亮节点 > 0）", has(r.renderedAtStart, "p3") && r.countAtStart.total > 0],
			["远段 p150 起始未渲染", !has(r.renderedAtStart, "p150")],
			["跳到 150 段后 p150 已渲染", has(r.renderedAfterJumpFar, "p150") && r.countAfterJumpFar.total > 0],
			["p3 段落已滚出 DOM（虚拟滚动回收）", r.p3StillInDom === false],
			["滚回第 3 段后 p3 高亮重新应用", has(r.renderedAfterJumpBack, "p3") && r.countAfterJumpBack.total > 0],
			["改字号 18→26 后高亮仍在", has(r.renderedAfterFont, "p3") && r.countAfterFont.total > 0],
			["切分页后高亮仍在", has(r.renderedInPaged, "p3")],
			["切回滚动后高亮仍在", has(r.renderedBackToScroll, "p3") && r.countAfterModeRoundtrip.total > 0],
			["点击高亮回调拿到 id", r.clickedId === "p3"],
			["删除后该条从高亮集合移除", Array.isArray(r.idsAfterRemove) && r.idsAfterRemove.indexOf("p150") < 0 && r.idsAfterRemove.indexOf("p3") >= 0],
			["全程无未捕获异常", (r.finalErrors || []).length === 0],
			["destroy 正常", r.destroyedOk === true],
		];
		const report = { result: r, checks: checks.map(([name, pass]) => ({ name, pass: !!pass })), pass: checks.every(([, ok]) => !!ok) };
		const outFile = process.env.NYAR_HL_TXT_REPORT || join(tmpdir(), "nyar-highlight-txt-report.json");
		writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
		console.log(`report: ${outFile}`);
		console.log(JSON.stringify({ pass: report.pass, failed: checks.filter(([, ok]) => !ok).map(([n]) => n), numbers: {
			highlightNodesAtStart: r.countAtStart, paragraphsAtStart: (r.paragraphsAtStart || []).length,
			paragraphsAfterJumpFar: (r.paragraphsAfterJumpFar || []).length,
			renderedAtStart: r.renderedAtStart, renderedAfterJumpFar: r.renderedAfterJumpFar,
			renderedAfterJumpBack: r.renderedAfterJumpBack, renderedAfterFont: r.renderedAfterFont,
			renderedInPaged: r.renderedInPaged, renderedBackToScroll: r.renderedBackToScroll,
			clicked: r.clickedId, errors: (r.finalErrors || []).length,
		} }, null, 2));
		process.exitCode = report.pass ? 0 : 1;
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("highlight-txt-engine-check failed:", e.message);
	process.exitCode = 2;
});
