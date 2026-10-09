/**
 * 冷区高亮恢复 + 目录跳转激活 探针（独立于 stream-i 的旧 harness）。
 *
 * 验证两条真实用户路径（按章独立分页引入的新行为）：
 * 1. **目录跳到远处章节**（`goTo("#锚点")`）必须真的激活那一章并定位过去 ——
 *    如果只因为它在冷区（display:none、几何为 0）就跳过，目录会**静默失效**；
 * 2. 给"还没读到"的章节加的高亮，跳到该章后必须自动恢复。
 *
 * 用法：node tests/manual/highlight-cold-zone-probe.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = join(ROOT, "tests", "manual");
const PORT = 9600 + Math.floor(Math.random() * 90);

async function bundle() {
	const esbuild = await import("esbuild");
	await esbuild.build({
		entryPoints: [join(ROOT, "src/services/books/formats/mobi/HtmlDocEngine.ts")],
		bundle: true,
		format: "iife",
		globalName: "NyarEngine",
		platform: "browser",
		outfile: join(OUT, ".cold-engine.js"),
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
<script src="./cold-engine.js"><\/script>
<script>
window.__errors = [];
window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
function decorate(el){
	el.createEl=function(tag,o){const c=document.createElement(tag);if(o&&o.cls)c.className=o.cls;if(o&&o.text!=null)c.textContent=o.text;if(o&&o.attr)for(const k in o.attr)c.setAttribute(k,o.attr[k]);this.appendChild(c);return c;};
	el.createDiv=function(o){return this.createEl("div",o);};
	el.empty=function(){while(this.firstChild)this.removeChild(this.firstChild);};
	if(!el.addClass)el.addClass=function(c){this.classList.add(c);};
	if(!el.toggleClass)el.toggleClass=function(c,on){this.classList.toggle(c,on===undefined?undefined:!!on);};
	return el;
}
// 三章：锚点必须是顶层节点（引擎按顶层节点是否带章节锚点 id 切章），
// 真实 EPUB 构建出来的 span#nyareader-epub-N 也是顶层同级节点。
const PARA = "<p>这是用于验证冷区高亮恢复的中文段落文本，重复足够多次以产生若干页内容。</p>";
function chapter(id, marker) {
	return '<span id="nyareader-epub-' + id + '"></span><h1>第' + id + '章</h1>' +
		'<p>' + marker + '</p>' + PARA.repeat(30);
}
window.__probe = async function () {
	window.__errors = [];
	const host = decorate(document.getElementById("reading"));
	host.empty();
	const engine = new NyarEngine.HtmlDocEngine({
		book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
		html: "<!DOCTYPE html><html><head></head><body>" +
			chapter(0, "第一章标记句") + chapter(1, "第二章标记句") + chapter(2, "第三章标记句") +
			"</body></html>",
		formatLabel: "epub",
		chapterAnchorPrefix: "nyareader-epub-",
		chapterPagedPagination: true
	});
	await engine.mount(host);
	engine.applySettings({
		fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24,
		theme: "light", layout: "single", scrollMode: false, pageWidth: 640
	});
	await new Promise((r) => setTimeout(r, 300));
	const docOf = () => host.querySelector("iframe").contentDocument;
	const count = () => {
		const doc = docOf();
		const api = doc.defaultView.CSS && doc.defaultView.CSS.highlights ? doc.defaultView.CSS.highlights.size : 0;
		const spans = doc.querySelectorAll(".nyar-hl").length;
		return { api, spans, total: api + spans };
	};
	const info = () => (engine.getTotalPagesInfo ? engine.getTotalPagesInfo() : null);
	const diag = () => (engine.getLayoutDiagnostics ? engine.getLayoutDiagnostics() : null);
	const farInWindow = () =>
		(docOf().querySelector(".nyareader-columns")?.textContent ?? "").includes("第三章标记句");

	const mountErrors = [...window.__errors];
	const infoAtMount = info();

	// 给"第 3 章"（远端/冷区）加高亮：此时按设计不渲染
	engine.setHighlights([
		{
			id: "h-far", color: "green", hasNote: false, text: "第三章标记句",
			anchor: { kind: "chapter", primary: "nyareader-epub-2", quote: { exact: "第三章标记句" }, progression: 0.9, v: 1 }
		}
	]);
	await new Promise((r) => setTimeout(r, 200));
	const beforeJump = { ...count(), farInWindow: farInWindow() };

	// 假设：挂起的 settings 重排会在跳转之后触发，把窗口按 activeChapterIdx=0 重置。
	// 用一个显式翻页把挂起任务落地（goTo 自身第一步就是 runPendingSettingsRelayout）。
	engine.showPage(1);
	await new Promise((r) => setTimeout(r, 60));
	const afterFlush = { ...count(), farInWindow: farInWindow(), info: info() };

	// 跳到第 3 章（真实目录用的是 "#锚点"）→ 该章应被激活 → 高亮自动恢复
	await engine.goTo("#nyareader-epub-2");
	await new Promise((r) => setTimeout(r, 400));
	const afterJump = {
		...count(),
		farInWindow: farInWindow(),
		info: info(),
		diag: diag(),
		placements: engine.getHighlightPlacements ? engine.getHighlightPlacements() : null,
		location: engine.currentLocation ? engine.currentLocation() : null
	};

	// 跳回第 1 章：第 3 章回到冷区
	await engine.goTo("#nyareader-epub-0");
	await new Promise((r) => setTimeout(r, 300));
	const afterBack = { ...count(), farInWindow: farInWindow(), info: info() };

	// 再跳回第 3 章：应再次恢复（可反复）
	await engine.goTo("#nyareader-epub-2");
	await new Promise((r) => setTimeout(r, 400));
	const afterReJump = { ...count(), farInWindow: farInWindow(), info: info() };

	const cold = docOf().querySelector(".nyareader-cold");
	const result = {
		mountErrors,
		infoAtMount,
		beforeJump,
		afterFlush,
		afterJump,
		afterBack,
		afterReJump,
		hasColumnsEl: Boolean(docOf().querySelector(".nyareader-columns")),
		hasColdEl: Boolean(cold),
		coldDisplay: cold ? docOf().defaultView.getComputedStyle(cold).display : null,
		errors: [...window.__errors]
	};
	engine.destroy();
	return result;
};
<\/script></body></html>`;

async function main() {
	mkdirSync(OUT, { recursive: true });
	await bundle();
	const dir = mkdtempSync(join(tmpdir(), "nyar-cold-"));
	writeFileSync(join(dir, "p.html"), PAGE, "utf8");
	writeFileSync(join(dir, "cold-engine.js"), readFileSync(join(OUT, ".cold-engine.js"), "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-cold-prof-"));
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
		const resolveDiag = res.afterJump?.diag?.lastAnchorResolve ?? null;
		const checks = [
			["mount 未抛异常", res.mountErrors.length === 0],
			["按章分页生效（存在 .nyareader-columns 与 .nyareader-cold）", res.hasColumnsEl && res.hasColdEl],
			["冷区确实是 display:none", res.coldDisplay === "none"],
			["三章被正确识别（chapters === 3）", res.infoAtMount?.chapters === 3],
			["远端章节高亮在跳过去之前不渲染（设计降级）", res.beforeJump.total === 0],
			["远端章节在跳转前不在活动窗口", res.beforeJump.farInWindow === false],
			["goTo('#锚点') 激活了目标章（第 3 章进入活动窗口）", res.afterJump.farInWindow === true],
			["激活后高亮自动恢复", res.afterJump.total === 1],
			["锚点解析诊断：解析到第 2 章并激活窗口", resolveDiag?.chapter === 2 && resolveDiag?.after?.from === 1],
			["跳回后第 3 章回到冷区（高亮随之不渲染）", res.afterBack.total === 0 && res.afterBack.farInWindow === false],
			["再次跳回仍能恢复（可反复）", res.afterReJump.total === 1 && res.afterReJump.farInWindow === true],
			["全程无未捕获异常", res.errors.length === 0]
		];
		const report = { checks: checks.map(([n, p]) => ({ name: n, pass: p })), pass: checks.every(([, p]) => p), numbers: res };
		writeFileSync(join(OUT, "highlight-cold-zone.json"), JSON.stringify(report, null, 2), "utf8");
		console.log(JSON.stringify(report, null, 2));
		process.exitCode = report.pass ? 0 : 1;
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("cold-zone probe failed:", e.message);
	process.exitCode = 2;
});
