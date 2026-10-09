/**
 * 真机 MOBI6 / AZW3 的页码与进度端到端检查（只读用户文件）。
 *
 * 覆盖用户主诉：
 *   3) "mobi 的页码数有误"            → 分页模式 getTotalPages() 是否等于真实列数、滚动模式是否返回 0
 *   4) "mobi 关掉再开回不去、外面进度条不动"
 *      → 补块过程中页码是否单调/不漂移；locationChanged 是否持续发出（进度条靠它驱动）；
 *        整书百分比 → 已加载文档百分比 → goToFraction 的往返误差有多大
 *
 * 用**真实产品代码**：Node 侧用 MobiDocument/MobiParser/EpubLazyLoader 生成首屏与块片段，
 * 浏览器侧用真实 HtmlDocEngine（esbuild 打包当前工作区）在 headless Edge 里跑。
 *
 * 用法：node tests/manual/real-mobi-progress-e2e.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const ROOT = process.cwd();
const EDGE = process.env.NYAR_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const LIB = process.env.NYAR_LIBRARY || "C:\\Users\\ST31ORANGEJUICE\\OneDrive - buaa.edu.cn\\ST31___NOTES\\NyaNotes\\nyareader\\library";
const BOOKS = [
	{ name: "mobi", file: join(LIB, "我的书库", "未分类", "Pride and Prejudice.mobi") },
	{ name: "azw3", file: join(LIB, "我的书库", "未分类", "Pride and Prejudice (Standard Ebooks).azw3") },
];
const PORT = 9950 + Math.floor(Math.random() * 40);
const require = createRequire(import.meta.url);

async function bundleEngine(outfile) {
	const esbuild = await import("esbuild");
	await esbuild.build({
		entryPoints: [join(ROOT, "src/services/books/formats/mobi/HtmlDocEngine.ts")],
		bundle: true,
		format: "iife",
		globalName: "EngineWorktree",
		platform: "browser",
		outfile,
		logLevel: "error",
		external: ["obsidian"],
	});
}

async function bundleApi(outfile) {
	const esbuild = await import("esbuild");
	await esbuild.build({
		stdin: {
			contents:
				`import * as mobi from "./src/services/books/formats/mobi/MobiDocument.ts";\n` +
				`import * as lazy from "./src/services/books/formats/epub/EpubLazyLoader.ts";\n` +
				`export const api = { mobi, lazy };`,
			resolveDir: ROOT,
			loader: "ts",
			sourcefile: "mobi-e2e-entry.ts",
		},
		bundle: true,
		platform: "node",
		format: "cjs",
		outfile,
		logLevel: "error",
		external: ["obsidian"],
	});
}

function pageHtml(scenarios) {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#host{position:relative;width:100vw;height:100vh}</style></head>
<body><div id="host"></div>
<script>window.__SCENARIOS=${JSON.stringify(scenarios)};window.__errors=[];window.addEventListener("error",e=>window.__errors.push(String(e.message||e)));</script>
<script src="./engine.js"></script>
<script>
function decorate(el){
  el.createEl=function(tag,o){const c=document.createElement(tag);if(o&&o.cls)c.className=o.cls;if(o&&o.text!=null)c.textContent=o.text;if(o&&o.attr)for(const k in o.attr)c.setAttribute(k,o.attr[k]);this.appendChild(c);return c;};
  el.createDiv=function(o){return this.createEl("div",o);};
  el.empty=function(){while(this.firstChild)this.removeChild(this.firstChild);};
  return el;
}
function settings(scroll){return {fontFamily:"system-ui",fontSize:18,lineHeight:1.8,margin:24,theme:"light",layout:"single",scrollMode:!!scroll,pageWidth:640};}
const frame = () => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
window.__runOne = async function(s){
  const host = decorate(document.getElementById("host"));
  host.style.width="100vw"; host.style.height="100vh";
  const book = {format:s.format,title:s.title,toc:[],spine:[],fingerprint:"x",path:"x"};
  const out = {name:s.name, chapterCount:s.chunkCount, initialHtmlKB:Math.round(s.initialHtml.length/1024)};
  let progressEvents = 0;
  const engine = new EngineWorktree.HtmlDocEngine({book, html:s.initialHtml, formatLabel:s.format});
  engine.on("locationChanged", ()=>{progressEvents++;});
  await engine.mount(host);
  engine.applySettings(settings(false));
  await frame();
  const doc = host.querySelector("iframe").contentDocument;
  const cols = () => doc.querySelector(".nyareader-columns");
  // 首屏必须真的渲染出内容（不是空白）
  out.firstScreenPages = engine.getTotalPages();
  out.firstScreenTextLen = (doc.body.textContent||"").length;
  out.pagedTotalPagesPositive = out.firstScreenPages > 0;
  const pagesSeq = [];
  let currentBefore = null, currentAfter = null;
  // 逐批补块（每批 8 块，与 EpubLazyLoader 的批大小同量级）
  for (let from = 1; from < s.chunks.length + 1; from += 8) {
    const batch = s.chunks.slice(from - 1, from - 1 + 8).join("");
    if (from === 1) {
      await engine.goTo("4000");
      await frame();
      currentBefore = engine.currentLocation();
    }
    engine.notifyContentAppended(batch);
    await frame();
    pagesSeq.push(engine.getTotalPages());
    if (from === 1) { currentAfter = engine.currentLocation(); }
  }
  out.pagesSeq = pagesSeq;
  out.pagesMonotonic = pagesSeq.every((p, i) => i === 0 || p >= pagesSeq[i-1]);
  out.pagesGrew = pagesSeq.length > 1 && pagesSeq[pagesSeq.length-1] > pagesSeq[0];
  out.pagesAfterAll = engine.getTotalPages();
  out.currentPageKeptOnAppend = currentBefore === currentAfter;
  out.locationBeforeAppend = currentBefore;
  out.locationAfterAppend = currentAfter;
  out.progressEventsAfterAppends = progressEvents;
  // 分页/滚动两模式的 getTotalPages 契约
  engine.switchMode(true);
  await frame();
  out.scrollTotalPages = engine.getTotalPages();
  out.scrollTextLen = (doc.body.textContent||"").length;
  engine.switchMode(false);
  await frame();
  out.pagedTotalPagesAfterRoundTrip = engine.getTotalPages();
  out.markerCount = doc.querySelectorAll("#nyareader-end-marker").length;
  out.contentBlocksInColumns = cols() ? cols().children.length - out.markerCount : 0;
  // 整书百分比 -> 已加载文档 -> goToFraction 往返（全部块已加载时两者应一致）
  const fracs = [0.1, 0.25, 0.5, 0.75, 0.9];
  out.goToFraction = [];
  for (const f of fracs) {
    engine.goToFraction(f);
    await frame();
    const loc = parseInt(engine.currentLocation(), 10) / 10000;
    out.goToFraction.push({ target: f, got: +loc.toFixed(4), deltaPages: Math.round((loc - f) * engine.getTotalPages()) });
    progressEvents++;
  }
  out.progressEventsTotal = progressEvents;
  engine.destroy();
  host.empty();
  return out;
};
window.__run = async function(){
  const out = [];
  for (const s of window.__SCENARIOS) out.push(await window.__runOne(s));
  return { results: out, errors: window.__errors };
};
</script></body></html>`;
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
	const missing = BOOKS.filter((b) => !existsSync(b.file));
	if (missing.length === BOOKS.length) {
		console.log(JSON.stringify({ skipped: true, reason: "未找到真机 MOBI/AZW3 样本", missing }, null, 2));
		return;
	}
	const dir = mkdtempSync(join(tmpdir(), "nyar-mobi-e2e-"));
	await bundleEngine(join(dir, "engine.js"));
	const apiOut = join(dir, "api.cjs");
	await bundleApi(apiOut);
	const { api } = require(apiOut);

	const scenarios = [];
	const nodeFacts = [];
	for (const b of BOOKS) {
		if (!existsSync(b.file)) continue;
		const raw = readFileSync(b.file);
		const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
		const source = await api.mobi.openMobiSource(buffer, b.name);
		const initialHtml = await source.buildInitialHtml(api.mobi.DEFAULT_MOBI_INITIAL_CHAPTERS);
		const chunks = [];
		for (let i = api.mobi.DEFAULT_MOBI_INITIAL_CHAPTERS; i < source.chapterCount; i++) chunks.push(await source.buildChapterChunk(i));
		const weights = source.chapterWeights();
		// 懒加载进度换算（Node 侧真实 EpubLazyLoader，与 ReaderController 用法一致）
		const loadedAll = new api.lazy.EpubLazyLoader(source, { initialChapters: source.chapterCount, append: () => undefined });
		const loadedFew = new api.lazy.EpubLazyLoader(source, { initialChapters: 2, append: () => undefined });
		const inverseErrors = [0.1, 0.4, 0.9].map((p) => Math.abs(loadedFew.loadedDocPercent(loadedFew.wholeBookPercent(p)) - p));
		nodeFacts.push({
			name: b.name,
			fileMB: +(raw.length / 1048576).toFixed(2),
			chapterCount: source.chapterCount,
			textMB: +(source.totalTextLength / 1048576).toFixed(2),
			weightsLen: weights.length,
			hasImageRecords: source.hasImageRecords,
			initialHtmlKB: Math.round(initialHtml.length / 1024),
			allChunksKB: Math.round(chunks.reduce((a, c) => a + c.length, 0) / 1024),
			wholeBookPercentAtFullLoad: loadedAll.wholeBookPercent(0.4),
			progressInverseMaxError: Math.max(...inverseErrors),
		});
		scenarios.push({
			name: b.name,
			format: b.name === "azw3" ? "azw3" : "mobi",
			title: source.title,
			chunkCount: source.chapterCount,
			initialHtml,
			chunks,
		});
		source.dispose();
	}

	writeFileSync(join(dir, "harness.html"), pageHtml(scenarios), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-mobi-e2e-profile-"));
	const url = `file:///${join(dir, "harness.html").replace(/\\/g, "/")}`;
	const child = spawn(
		EDGE,
		["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1200,800", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, url],
		{ stdio: "ignore" }
	);
	try {
		let payload = null;
		for (let i = 0; i < 60 && !payload; i++) {
			try {
				await new Promise((r) => setTimeout(r, 300));
				const text = await cdpEval(
					url,
					`(async()=>{const d=Date.now()+30000;while(typeof window.__run!=="function"&&Date.now()<d)await new Promise(r=>setTimeout(r,100));if(typeof window.__run!=="function")return JSON.stringify({fatal:"__run 未定义"});return JSON.stringify(await window.__run());})()`
				);
				payload = JSON.parse(text);
				if (payload.fatal) throw new Error(String(payload.fatal));
			} catch (e) {
				if (i === 59) throw e;
				payload = null;
			}
		}
		const report = { nodeFacts, browser: payload.results, pageErrors: payload.errors };
		const outFile = process.env.NYAR_MOBI_E2E_REPORT || join(tmpdir(), "nyar-mobi-progress-e2e.json");
		writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
		console.log(`report: ${outFile}`);
		console.log(JSON.stringify(report, null, 2));
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("mobi e2e failed:", e && e.message);
	process.exitCode = 2;
});
