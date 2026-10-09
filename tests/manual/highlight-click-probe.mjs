/**
 * 高亮点击链路探针：验证"点击高亮"能否拿到**父文档视口坐标**。
 *
 * 为什么单独验这个：引擎渲染在 iframe 里，而就地小菜单在父文档里。
 * 若不换算坐标，菜单会画到错误的屏幕位置（`clientX` 是 iframe 坐标系）。
 * 本探针把 iframe 放到**已知偏移**处，再模拟点击高亮，检查回调收到的坐标。
 *
 * 用法：node tests/manual/highlight-click-probe.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = join(ROOT, "tests", "manual");
const PORT = 9400 + Math.floor(Math.random() * 90);

async function bundle() {
	const esbuild = await import("esbuild");
	await esbuild.build({
		entryPoints: [join(ROOT, "src/services/books/formats/mobi/HtmlDocEngine.ts")],
		bundle: true,
		format: "iife",
		globalName: "NyarEngine",
		platform: "browser",
		outfile: join(OUT, ".click-engine.js"),
		logLevel: "error",
		external: ["obsidian"],
	});
}

/** 目标句（同时注入页面与断言，避免两处漂移） */
const TARGET = "点击这一句应当弹出就地菜单";

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
	html,body{margin:0;height:100%;overflow:hidden}
	/* 故意把阅读容器放在偏移 (140, 90) 处，才能验证坐标换算 */
	#host{position:absolute;left:140px;top:90px;width:900px;height:600px}
	.nyareader-reading{position:absolute;inset:0;overflow:hidden}
</style></head><body>
<div id="host" class="nyareader-root"><div class="nyareader-reading" id="reading"></div></div>
<script src="./click-engine.js"><\/script>
<script>
function decorate(el){
	el.createEl=function(tag,o){const c=document.createElement(tag);if(o&&o.cls)c.className=o.cls;if(o&&o.text!=null)c.textContent=o.text;if(o&&o.attr)for(const k in o.attr)c.setAttribute(k,o.attr[k]);this.appendChild(c);return c;};
	el.createDiv=function(o){return this.createEl("div",o);};
	el.empty=function(){while(this.firstChild)this.removeChild(this.firstChild);};
	if(!el.addClass)el.addClass=function(c){this.classList.add(c);};
	if(!el.toggleClass)el.toggleClass=function(c,on){this.classList.toggle(c,on===undefined?undefined:!!on);};
	return el;
}
const TARGET_TEXT = ${JSON.stringify(TARGET)};
const FILLER = "填充文字用于撑开内容并制造坐标距离，重复出现。";
window.__probe = async function () {	const host = decorate(document.getElementById("reading"));
	host.empty();
	const engine = new NyarEngine.HtmlDocEngine({
		book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
		html: "<!DOCTYPE html><html><head></head><body><span id='nyareader-epub-0'></span>" +
			"<p>" + FILLER.repeat(4) + TARGET_TEXT + FILLER.repeat(4) + "</p></body></html>",
		formatLabel: "epub",
		chapterAnchorPrefix: "nyareader-epub-",
		chapterPagedPagination: true
	});
	await engine.mount(host);
	engine.applySettings({
		fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24,
		theme: "light", layout: "single", scrollMode: true, pageWidth: 640
	});
	await new Promise((r) => setTimeout(r, 300));

	const iframe = host.querySelector("iframe");
	const doc = iframe.contentDocument;
	const win = iframe.contentWindow;

	// 用真实选区生成锚点（与产品链路一致）
	const p = doc.querySelector("p");
	const textNode = [...p.childNodes].find((n) => n.nodeType === 3 && n.data.includes(TARGET_TEXT));
	const at = textNode.data.indexOf(TARGET_TEXT);
	const range = doc.createRange();
	range.setStart(textNode, at);
	range.setEnd(textNode, at + TARGET_TEXT.length);
	const sel = win.getSelection();
	sel.removeAllRanges();
	sel.addRange(range);
	const draft = engine.getSelectionAnchor();
	engine.setHighlights([{ id: "h1", anchor: draft, color: "yellow", hasNote: false, text: TARGET_TEXT }]);
	await new Promise((r) => setTimeout(r, 250));

	// 注册点击回调
	const clicks = [];
	engine.setHighlightClickHandler((id, click) => clicks.push({ id, click: click ?? null }));

	// 高亮文字的真实屏幕位置（父文档坐标）—— 作为期望值
	const r = range.getBoundingClientRect();
	const iframeRect = iframe.getBoundingClientRect();
	const expected = {
		x: Math.round(iframeRect.left + r.left + r.width / 2),
		y: Math.round(iframeRect.top + r.top + r.height / 2)
	};

	// 在高亮文字中心派发真实点击（iframe 内坐标系）
	const ev = new win.MouseEvent("click", {
		bubbles: true,
		cancelable: true,
		clientX: Math.round(r.left + r.width / 2),
		clientY: Math.round(r.top + r.height / 2)
	});
	(textNode.parentElement ?? textNode).dispatchEvent(ev);
	await new Promise((r2) => setTimeout(r2, 120));

	// 引擎给出的高亮矩形（父文档坐标）
	const rect = engine.getHighlightRect ? engine.getHighlightRect("h1") : null;

	const result = {
		iframeOffset: { x: Math.round(iframeRect.left), y: Math.round(iframeRect.top) },
		expectedClick: expected,
		clicks,
		firstClick: clicks[0] ?? null,
		highlightRect: rect,
		rangeText: range.toString()
	};
	engine.destroy();
	return result;
};
<\/script></body></html>`;

async function main() {
	mkdirSync(OUT, { recursive: true });
	await bundle();
	const dir = mkdtempSync(join(tmpdir(), "nyar-click-"));
	writeFileSync(join(dir, "p.html"), PAGE, "utf8");
	writeFileSync(join(dir, "click-engine.js"), readFileSync(join(OUT, ".click-engine.js"), "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-click-prof-"));
	const url = `file:///${join(dir, "p.html").replace(/\\/g, "/")}`;
	const child = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1400,900", "--no-first-run", "--disable-extensions", `--user-data-dir=${profile}`, url], { stdio: "ignore" });
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
		const res = JSON.parse(r.result.value);
		const near = (a, b, tol) => Math.abs(a - b) <= tol;
		const got = res.firstClick?.click ?? null;
		const checks = [
			["点击高亮触发了回调，且 id 正确", res.firstClick?.id === "h1"],
			["回调带回了点击坐标", Boolean(got)],
			[
				`点击 x 是父文档坐标（含 iframe 偏移 ${res.iframeOffset.x}px）`,
				got ? near(got.x, res.expectedClick.x, 3) : false
			],
			[
				`点击 y 是父文档坐标（含 iframe 偏移 ${res.iframeOffset.y}px）`,
				got ? near(got.y, res.expectedClick.y, 3) : false
			],
			["点击坐标**不是** iframe 内坐标（证明确实做了换算）", got ? got.x > res.iframeOffset.x : false],
			["getHighlightRect() 返回矩形", Boolean(res.highlightRect)],
			[
				"getHighlightRect() 的 left/top 也是父文档坐标（含偏移）",
				res.highlightRect ? res.highlightRect.left >= res.iframeOffset.x - 2 : false
			],
			["高亮覆盖的文本就是目标句", res.rangeText === TARGET]
		];
		const report = { checks: checks.map(([n, p]) => ({ name: n, pass: p })), pass: checks.every(([, p]) => p), numbers: res };
		writeFileSync(join(OUT, "highlight-click.json"), JSON.stringify(report, null, 2), "utf8");
		console.log(JSON.stringify(report, null, 2));
		process.exitCode = report.pass ? 0 : 1;
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("highlight-click probe failed:", e.message);
	process.exitCode = 2;
});
