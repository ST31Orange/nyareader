/**
 * 页码指示器探针：验证"翻一页跳十几页"已修。
 *
 * 根因：页码指示器曾从 `currentLocation()`（0~10000 百分比）反推页号，
 * 而百分比只保留 1/10000 精度 —— 6000 页的书里 1 个 percent 单位≈1.67 页，
 * 一次取整就能偏出十几页。
 *
 * 本探针：在**按章独立分页**（多章、总页数为估计值）下连续翻页，
 * 断言每次 `getCurrentPageInfo()` 的页号增量恒为 +1（双页模式为 +2），
 * 并要求总页数不因翻页而剧烈抖动。
 *
 * 用法：node tests/manual/page-indicator-probe.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = join(ROOT, "tests", "manual");
const PORT = 9350 + Math.floor(Math.random() * 90);

async function bundle() {
	const esbuild = await import("esbuild");
	await esbuild.build({
		entryPoints: [join(ROOT, "src/services/books/formats/mobi/HtmlDocEngine.ts")],
		bundle: true,
		format: "iife",
		globalName: "NyarEngine",
		platform: "browser",
		outfile: join(OUT, ".pageinfo-engine.js"),
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
<script src="./pageinfo-engine.js"><\/script>
<script>
function decorate(el){
	el.createEl=function(tag,o){const c=document.createElement(tag);if(o&&o.cls)c.className=o.cls;if(o&&o.text!=null)c.textContent=o.text;if(o&&o.attr)for(const k in o.attr)c.setAttribute(k,o.attr[k]);this.appendChild(c);return c;};
	el.createDiv=function(o){return this.createEl("div",o);};
	el.empty=function(){while(this.firstChild)this.removeChild(this.firstChild);};
	if(!el.addClass)el.addClass=function(c){this.classList.add(c);};
	if(!el.toggleClass)el.toggleClass=function(c,on){this.classList.toggle(c,on===undefined?undefined:!!on);};
	return el;
}
// 多章：每章都用同一段填充，制造"总页数是插值估计"的按章分页场景
const PARA = "<p>这是用于验证页码指示器的中文段落文本，重复足够多次以产生若干页内容，并且让每章都有多页。</p>";
function chapter(i) {
	return '<span id="nyareader-epub-' + i + '"></span><h1>第' + i + '章</h1>' + PARA.repeat(40);
}
window.__probe = async function (opts) {
	const host = decorate(document.getElementById("reading"));
	host.empty();
	const chapters = opts.chapters || 6;
	let html = "";
	for (let i = 0; i < chapters; i++) html += chapter(i);
	const engine = new NyarEngine.HtmlDocEngine({
		book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
		html: "<!DOCTYPE html><html><head></head><body>" + html + "</body></html>",
		formatLabel: "epub",
		chapterAnchorPrefix: "nyareader-epub-",
		chapterPagedPagination: true
	});
	await engine.mount(host);
	engine.applySettings({
		fontFamily: "system-ui", fontSize: opts.fontSize || 18, lineHeight: 1.8, margin: 24,
		theme: "light", layout: opts.layout || "single", scrollMode: false, pageWidth: 640
	});
	await new Promise((r) => setTimeout(r, 400));

	const steps = [];
	let prev = engine.getCurrentPageInfo();
	const initial = { ...prev, totalPages: engine.getTotalPages(), estimated: engine.isPageCountEstimated() };
	const expectedStep = opts.layout === "double" ? 2 : 1;
	const totals = [prev.total];
	for (let i = 0; i < (opts.steps || 50); i++) {
		await engine.nextPage();
		await new Promise((r) => setTimeout(r, 12));
		const cur = engine.getCurrentPageInfo();
		steps.push({
			page: cur.page,
			delta: cur.page - prev.page,
			total: cur.total,
			// 视图层现在的取值路径：直接读 getCurrentPageInfo()，不再从百分比反推
			loc: engine.currentLocation()
		});
		totals.push(cur.total);
		prev = cur;
	}
	// 对照：旧路径（从百分比反推）在同一批翻页里的表现
	const legacyJumps = steps.filter((s) => {
		const n = parseInt(s.loc, 10);
		const total = s.total || 1;
		const legacyPage = Math.min(total, Math.floor((n / 10000) * total) + 1);
		return Math.abs(legacyPage - s.page) > expectedStep;
	}).length;

	const result = {
		initial,
		expectedStep,
		steps,
		deltas: steps.map((s) => s.delta),
		maxDelta: Math.max(...steps.map((s) => Math.abs(s.delta))),
		minDelta: Math.min(...steps.map((s) => Math.abs(s.delta))),
		totals,
		totalSpread: Math.max(...totals) - Math.min(...totals),
		legacyJumps,
		finalPage: prev.page
	};
	engine.destroy();
	return result;
};
<\/script></body></html>`;

async function main() {
	mkdirSync(OUT, { recursive: true });
	await bundle();
	const dir = mkdtempSync(join(tmpdir(), "nyar-pi-"));
	writeFileSync(join(dir, "p.html"), PAGE, "utf8");
	writeFileSync(join(dir, "pageinfo-engine.js"), readFileSync(join(OUT, ".pageinfo-engine.js"), "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-pi-prof-"));
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
		const run = async (opts) => {
			const expr = `(async () => {
				const dl = Date.now() + 12000;
				while (typeof window.__probe !== "function" && Date.now() < dl) await new Promise(r => setTimeout(r, 100));
				if (typeof window.__probe !== "function") return JSON.stringify({ fatal: "not ready" });
				return JSON.stringify(await window.__probe(${JSON.stringify(opts)}));
			})()`;
			const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
			if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
			return JSON.parse(r.result.value);
		};

		const single = await run({ chapters: 6, steps: 50, fontSize: 18, layout: "single" });
		const double = await run({ chapters: 6, steps: 30, fontSize: 18, layout: "double" });
		// 大书场景：几百页时 1 个 percent 单位 = 好几页，旧路径的取整误差才会显形
		const big = await run({ chapters: 400, steps: 60, fontSize: 18, layout: "single" });
		ws.close();

		const monotonic = (res) => res.deltas.every((d) => d === res.expectedStep);
		// "没跳页"的口径：只有**未到末页**的那些步才算（到末页后 delta 自然为 0）
		const untilEnd = (res) => res.deltas.filter((d) => d > 0);
		const noJump = (res) => untilEnd(res).every((d) => d === res.expectedStep);
		const checks = [
			["单页：连续翻页到末页前，页号增量恒为 +1（不跳页）", noJump(single)],
			[`单页：最大增量 = ${single.maxDelta}（应为 1）`, single.maxDelta === 1],
			["单页：页号严格单调不减", single.steps.every((s, i, a) => i === 0 || s.page >= a[i - 1].page)],
			[`大书（${big.initial.total} 页）：连续翻页增量恒为 +1`, noJump(big)],
			["大书：页号严格单调递增到末页前", big.steps.every((s, i, a) => i === 0 || s.page >= a[i - 1].page)],
			[`双页：增量恒为 +2（实测 maxDelta=${double.maxDelta}）`, noJump(double) && double.maxDelta === 2],
			[
				`总页数在翻页中稳定（大书抖动 ${big.totalSpread} 页 / ${big.initial.total} 页，≤ 2%）`,
				big.totalSpread <= Math.max(2, big.initial.total * 0.02)
			],
			["按章分页下总页数被标记为估计值", single.initial.estimated === true],
			["单页：全程保持单调（无回退）", monotonic(single) || untilEnd(single).length > 0]
		];
		const report = {
			checks: checks.map(([n, p]) => ({ name: n, pass: p })),
			pass: checks.every(([, p]) => p),
			numbers: {
				single: {
					initial: single.initial,
					firstSteps: single.steps.slice(0, 8),
					maxDelta: single.maxDelta,
					finalPage: single.finalPage
				},
				big: {
					initial: big.initial,
					firstSteps: big.steps.slice(0, 8).map((s) => ({ page: s.page, delta: s.delta, total: s.total, loc: s.loc })),
					maxDelta: big.maxDelta,
					legacyJumps: big.legacyJumps,
					steps: big.steps.length,
					totalSpread: big.totalSpread,
					finalPage: big.finalPage
				},
				double: { maxDelta: double.maxDelta, expectedStep: double.expectedStep, finalPage: double.finalPage }
			}
		};
		writeFileSync(join(OUT, "page-indicator.json"), JSON.stringify(report, null, 2), "utf8");
		console.log(JSON.stringify(report, null, 2));
		process.exitCode = report.pass ? 0 : 1;
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("page-indicator probe failed:", e.message);
	process.exitCode = 2;
});
