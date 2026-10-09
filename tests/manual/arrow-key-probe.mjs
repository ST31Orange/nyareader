/**
 * 方向键路由探针：验证**滚动模式下 ↑/↓ 是小格滚动**，且**不会双触发**。
 *
 * 背景（两个真实缺陷）：
 * 1. `ReaderView` 的按键路由用 `capabilities.pageNav` 判断——而 EPUB/MOBI/AZW3 的
 *    pageNav **恒为 true**，导致滚动模式下 ↑/↓ 走的是"翻一页"，`scrollStep()` 永不被调用；
 * 2. 引擎在 iframe 内也有 keydown 监听，而 iframe 内按键会**冒泡到父文档**，
 *    若父文档再处理一次，就会滚动两次（本探针用"滚动距离"来判定）。
 *
 * 用法：node tests/manual/arrow-key-probe.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = join(ROOT, "tests", "manual");
const PORT = 9500 + Math.floor(Math.random() * 90);

async function bundle() {
	const esbuild = await import("esbuild");
	await esbuild.build({
		entryPoints: [join(ROOT, "src/services/books/formats/mobi/HtmlDocEngine.ts")],
		bundle: true,
		format: "iife",
		globalName: "NyarEngine",
		platform: "browser",
		outfile: join(OUT, ".arrow-engine.js"),
		logLevel: "error",
		external: ["obsidian"],
	});
}

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
	html,body{margin:0;height:100%;overflow:hidden}
	#host{position:relative;width:1200px;height:800px}
	.nyareader-reading{position:absolute;inset:0;overflow:hidden}
</style></head><body>
<div id="host" class="nyareader-root"><div class="nyareader-reading" id="reading"></div></div>
<script src="./arrow-engine.js"><\/script>
<script>
function decorate(el){
	el.createEl=function(tag,o){const c=document.createElement(tag);if(o&&o.cls)c.className=o.cls;if(o&&o.text!=null)c.textContent=o.text;if(o&&o.attr)for(const k in o.attr)c.setAttribute(k,o.attr[k]);this.appendChild(c);return c;};
	el.createDiv=function(o){return this.createEl("div",o);};
	el.empty=function(){while(this.firstChild)this.removeChild(this.firstChild);};
	if(!el.addClass)el.addClass=function(c){this.classList.add(c);};
	if(!el.toggleClass)el.toggleClass=function(c,on){this.classList.toggle(c,on===undefined?undefined:!!on);};
	return el;
}
// 一章足够长，滚动模式下能滚很多格
const PARA = "<p>这是用于验证方向键滚动步进的中文段落文本，重复足够多次以产生足够高度。</p>";
window.__probe = async function () {
	const host = decorate(document.getElementById("reading"));
	host.empty();
	const engine = new NyarEngine.HtmlDocEngine({
		book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
		html: "<!DOCTYPE html><html><head></head><body><span id='nyareader-epub-0'></span>" + PARA.repeat(200) + "</body></html>",
		formatLabel: "epub",
		chapterAnchorPrefix: "nyareader-epub-"
	});
	await engine.mount(host);
	engine.applySettings({
		fontFamily: "system-ui", fontSize: 20, lineHeight: 1.8, margin: 24,
		theme: "light", layout: "single", scrollMode: true, pageWidth: 640
	});
	await new Promise((r) => setTimeout(r, 400));

	const iframe = host.querySelector("iframe");
	const win = iframe.contentWindow;
	const linePx = 20 * 1.8;              // 一个"行"
	const expectedStep = linePx * 3;      // 设计要求：一格 ≈ 3 行
	const y = () => Math.round(win.scrollY);
	const setY = (v) => win.scrollTo(0, v);

	// 捕获父文档上的 keydown：用于判断"是否还会在父文档再处理一次"
	let parentKeydowns = 0;
	const parentHandler = () => { parentKeydowns++; };
	document.addEventListener("keydown", parentHandler, true);

	const press = (key) => {
		const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
		iframe.contentDocument.dispatchEvent(ev);
	};
	const pressParent = (key) => {
		const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
		document.getElementById("reading").dispatchEvent(ev);
	};

	// 1) 引擎自身：↑/↓ 的滚动距离应当 ≈ 3 行
	setY(500);
	await new Promise((r) => setTimeout(r, 30));
	const before1 = y();
	press("ArrowDown");
	await new Promise((r) => setTimeout(r, 60));
	const after1 = y();
	const downDelta = after1 - before1;

	setY(500);
	await new Promise((r) => setTimeout(r, 30));
	press("ArrowUp");
	await new Promise((r) => setTimeout(r, 60));
	const upDelta = 500 - y();

	// 2) 是否在父文档被再次处理（双触发）：记下父文档处理次数
	press("ArrowDown");
	await new Promise((r) => setTimeout(r, 60));
	const parentKeydownsDuringEnginePress = parentKeydowns;
	document.removeEventListener("keydown", parentHandler, true);

	// 3) 父文档路径（真实场景：焦点在 iframe 外时）：模拟 ReaderView 的路由决策
	//    只读取引擎对外暴露的"当前是否分页"，判定该走滚动还是翻页
	setY(500);
	await new Promise((r) => setTimeout(r, 30));
	const pagedReported = engine.isPagedMode ? engine.isPagedMode() : null;
	const before3 = y();
	// 模拟修复后的 ReaderView 路由：非分页 → scrollStep
	if (engine.isPagedMode && !engine.isPagedMode()) engine.scrollStep(1);
	await new Promise((r) => setTimeout(r, 60));
	const routedDelta = y() - before3;

	// 4) 对照：分页模式下 isPagedMode() 必须为 true（↑/↓ 应走翻页而非滚动）
	engine.applySettings({
		fontFamily: "system-ui", fontSize: 20, lineHeight: 1.8, margin: 24,
		theme: "light", layout: "single", scrollMode: false, pageWidth: 640
	});
	await new Promise((r) => setTimeout(r, 300));
	const pagedWhenPaged = engine.isPagedMode ? engine.isPagedMode() : null;

	const result = {
		linePx,
		expectedStep,
		downDelta,
		upDelta,
		parentKeydownsDuringEnginePress,
		pagedReported,
		routedDelta,
		pagedWhenPaged,
		errors: []
	};
	engine.destroy();
	return result;
};
<\/script></body></html>`;

async function main() {
	mkdirSync(OUT, { recursive: true });
	await bundle();
	const dir = mkdtempSync(join(tmpdir(), "nyar-arrow-"));
	writeFileSync(join(dir, "p.html"), PAGE, "utf8");
	writeFileSync(join(dir, "arrow-engine.js"), readFileSync(join(OUT, ".arrow-engine.js"), "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-arrow-prof-"));
	const url = `file:///${join(dir, "p.html").replace(/\\/g, "/")}`;
	const child = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1200,800", "--no-first-run", "--disable-extensions", `--user-data-dir=${profile}`, url], { stdio: "ignore" });
	try {
		let up = false;
		for (let i = 0; i < 60 && !up; i++) {
			await new Promise((r) => setTimeout(r, 200));
			try { up = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch { /* wait */ }
		}
		if (!up) throw new Error("CDP not ready");
		const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
		const target = list.find((x) => x.type === "page");
		const ws = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((res, rej) => {
			ws.addEventListener("open", res, { once: true });
			ws.addEventListener("error", rej, { once: true });
		});
		let id = 0;
		const send = (m, p = {}) =>
			new Promise((resolve) => {
				const mid = ++id;
				const on = (ev) => {
					const msg = JSON.parse(ev.data);
					if (msg.id !== mid) return;
					ws.removeEventListener("message", on);
					resolve(msg.result);
				};
				ws.addEventListener("message", on);
				ws.send(JSON.stringify({ id: mid, method: m, params: p }));
			});
		await send("Runtime.enable");
		const expr = `(async () => {
			const dl = Date.now() + 10000;
			while (typeof window.__probe !== "function" && Date.now() < dl) await new Promise(r => setTimeout(r, 100));
			if (typeof window.__probe !== "function") return JSON.stringify({ fatal: "not ready" });
			return JSON.stringify(await window.__probe());
		})()`;
		const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
		ws.close();
		if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
		if (!r.result.value) throw new Error("probe returned nothing");
		const res = JSON.parse(r.result.value);
		const near = (a, b, tol) => Math.abs(a - b) <= tol;
		const checks = [
			[`↑/↓ 的滚动距离 ≈ 3 行（${Math.round(res.expectedStep)}px）`, near(res.downDelta, res.expectedStep, 4) && near(res.upDelta, res.expectedStep, 4)],
			["↓ 与 ↑ 方向相反且对称", res.downDelta > 0 && res.upDelta > 0],
			["滚动模式下 isPagedMode() === false（键盘才能路由到 scrollStep）", res.pagedReported === false],
			["按修复后的路由调用 scrollStep，实际滚动约 3 行", near(res.routedDelta, res.expectedStep, 4)],
			["分页模式下 isPagedMode() === true（↑/↓ 应走翻页）", res.pagedWhenPaged === true],
			["引擎处理 iframe 按键时不会在父文档重复处理（无双触发）", res.parentKeydownsDuringEnginePress === 0]
		];
		const report = { checks: checks.map(([n, p]) => ({ name: n, pass: p })), pass: checks.every(([, p]) => p), numbers: res };
		writeFileSync(join(OUT, "arrow-key.json"), JSON.stringify(report, null, 2), "utf8");
		console.log(JSON.stringify(report, null, 2));
		process.exitCode = report.pass ? 0 : 1;
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("arrow-key probe failed:", e.message);
	process.exitCode = 2;
});
