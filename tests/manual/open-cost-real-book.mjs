/**
 * 真实 43MB EPUB 的「首屏打开成本」前后对比（只读用户文件）。
 *
 * 量的是用户主诉「大 EPUB 打开要几十秒」里的**首屏那一段**：
 *   旧链路（git 92a0daf 的 EpubDocument + HtmlDocEngine）
 *     = 整本 600 章拼成一份 HTML（含全量章节）→ iframe srcdoc 解析 → 全量页数测量
 *   新链路（当前工作区）
 *     = JSZip+OPF → 首屏只建前 N 章（图片走 data-nyar-asset 登记）→ iframe srcdoc 解析
 *
 * 两个引擎分别用 esbuild 打成 IIFE（globalName 不同），在同一个 headless Edge 页面里跑，
 * 因此 iframe 解析与页数测量都是真实 Chromium 行为（E1）。
 *
 * 用法：
 *   node tests/manual/open-cost-real-book.mjs ["<epub 路径>"]
 *   未找到文件时打印 skipped 并退出 0（保持 CI/无样本环境可用）。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const ROOT = process.cwd();
const EDGE = process.env.NYAR_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DEFAULT_BOOK =
	process.env.NYAR_EPUB ||
	"C:\\Users\\ST31ORANGEJUICE\\OneDrive - buaa.edu.cn\\ST31___NOTES\\NyaNotes\\nyareader\\library\\我的书库\\测试\\银河帝国完整版（全套15册）.epub";
const BOOK = process.argv[2] || DEFAULT_BOOK;
const PORT = 9900 + Math.floor(Math.random() * 90);
const require = createRequire(import.meta.url);

const BASELINE_ENGINE_ENTRY = join(ROOT, "verify", ".baseline", "src", "services", "books", "formats", "mobi", "HtmlDocEngine.ts");
const WORKTREE_ENGINE_ENTRY = join(ROOT, "src", "services", "books", "formats", "mobi", "HtmlDocEngine.ts");

async function bundle(entry, globalName, outfile) {
	const esbuild = await import("esbuild");
	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		format: "iife",
		globalName,
		platform: "browser",
		outfile,
		logLevel: "error",
		external: ["obsidian"],
	});
}

/** 当前工作区的 EPUB 构建入口（打成 CJS 供 Node 调用）。 */
async function bundleEpubApi(outfile) {
	const esbuild = await import("esbuild");
	await esbuild.build({
		stdin: {
			contents: `import * as epub from "./src/services/books/formats/epub/EpubDocument.ts";\nexport const api = { epub };`,
			resolveDir: ROOT,
			loader: "ts",
			sourcefile: "open-cost-entry.ts",
		},
		bundle: true,
		platform: "node",
		format: "cjs",
		outfile,
		logLevel: "error",
		external: ["obsidian"],
	});
}

function pageHtml(baselineHtml, worktreeHtml, nextChaptersHtml) {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#host{position:relative;width:100vw;height:100vh}</style></head>
<body><div id="host"></div>
<script>window.__BASELINE_HTML=${JSON.stringify(baselineHtml)};window.__WORKTREE_HTML=${JSON.stringify(worktreeHtml)};window.__NEXT_CHUNKS=${JSON.stringify(nextChaptersHtml)};window.__errors=[];window.addEventListener("error",e=>window.__errors.push(String(e.message||e)));</script>
<script src="./engine-baseline.js"></script>
<script src="./engine-worktree.js"></script>
<script>
function decorate(el){
  el.createEl=function(tag,o){const c=document.createElement(tag);if(o&&o.cls)c.className=o.cls;if(o&&o.text!=null)c.textContent=o.text;if(o&&o.attr)for(const k in o.attr)c.setAttribute(k,o.attr[k]);this.appendChild(c);return c;};
  el.createDiv=function(o){return this.createEl("div",o);};
  el.empty=function(){while(this.firstChild)this.removeChild(this.firstChild);};
  return el;
}
function settings(){return {fontFamily:"system-ui",fontSize:18,lineHeight:1.8,margin:24,theme:"light",layout:"single",scrollMode:false,pageWidth:640};}
window.__run = async function(){
  const host = decorate(document.getElementById("host"));
  const book = {format:"epub",title:"T",toc:[],spine:[],fingerprint:"x",path:"x"};
  const out = {errors: window.__errors, baselineHtmlMB: +(window.__BASELINE_HTML.length/1048576).toFixed(2), worktreeHtmlKB: Math.round(window.__WORKTREE_HTML.length/1024)};
  // ---- 旧链路：整本 HTML -> iframe ----
  {
    const t0 = performance.now();
    const engine = new EngineBaseline.HtmlDocEngine({book, html: window.__BASELINE_HTML, formatLabel:"epub"});
    await engine.mount(host);
    const tMount = performance.now();
    engine.applySettings(settings());
    await new Promise(r=>setTimeout(r,1200)); // 旧引擎的兜底测量窗口（800ms）+ 余量
    out.baseline = { mountMs: Math.round(tMount-t0), mountAndPagesMs: Math.round(performance.now()-t0), pages: engine.getTotalPages(), location: engine.currentLocation() };
    engine.destroy();
    host.empty();
    await new Promise(r=>requestAnimationFrame(r));
  }
  // ---- 新链路：首屏 N 章 -> iframe，再逐批补章 ----
  {
    const t0 = performance.now();
    const engine = new EngineWorktree.HtmlDocEngine({book, html: window.__WORKTREE_HTML, formatLabel:"epub"});
    let progressEvents = 0;
    engine.on("locationChanged", ()=>{progressEvents++;});
    await engine.mount(host);
    const tMount = performance.now();
    engine.applySettings(settings());
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const tReady = performance.now();
    const pages0 = engine.getTotalPages();
    // 补一批章（模拟 EpubLazyLoader 的一批 append）
    const tAppend0 = performance.now();
    engine.notifyContentAppended(window.__NEXT_CHUNKS);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const tAppend1 = performance.now();
    out.worktree = {
      mountMs: Math.round(tMount-t0),
      firstScreenReadyMs: Math.round(tReady-t0),
      pagesFirstScreen: pages0,
      pagesAfterAppend: engine.getTotalPages(),
      appendOneBatchMs: Math.round(tAppend1-tAppend0),
      locationChangedEvents: progressEvents,
      htmlKB: Math.round(window.__WORKTREE_HTML.length/1024),
    };
    engine.destroy();
    host.empty();
  }
  return out;
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
	if (!existsSync(BOOK)) {
		console.log(JSON.stringify({ skipped: true, reason: `未找到样本书：${BOOK}` }, null, 2));
		return;
	}
	if (!existsSync(BASELINE_ENGINE_ENTRY)) throw new Error(`缺少 baseline 引擎源码：${BASELINE_ENGINE_ENTRY}（先跑 node verify/build-engines.mjs）`);
	const dir = mkdtempSync(join(tmpdir(), "nyar-opencost-"));
	await bundle(BASELINE_ENGINE_ENTRY, "EngineBaseline", join(dir, "engine-baseline.js"));
	await bundle(WORKTREE_ENGINE_ENTRY, "EngineWorktree", join(dir, "engine-worktree.js"));
	const apiOut = join(dir, "epub-api.cjs");
	await bundleEpubApi(apiOut);

	const raw = readFileSync(BOOK);
	const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
	const fileMB = +(statSync(BOOK).size / 1048576).toFixed(2);

	// 旧链路：整本 HTML（92a0daf 的构建函数）
	const baseline = require(join(ROOT, "verify", "build", "epubdoc-baseline.cjs"));
	const t0 = performance.now();
	const baselineHtml = await baseline.buildEpubHtml(buffer, "银河帝国");
	const baselineBuildMs = Math.round(performance.now() - t0);

	// 新链路：首屏 2 章 + 下一批 8 章的追加片段
	const { api } = require(apiOut);
	const source = await api.epub.openEpubSource(buffer, "银河帝国");
	const t1 = performance.now();
	const worktreeHtml = await source.buildInitialHtml(2);
	const firstScreenBuildMs = Math.round(performance.now() - t1);
	const t2 = performance.now();
	let next = "";
	for (let i = 2; i < 10; i++) next += await source.buildChapterChunk(i);
	const nextChunksBuildMs = Math.round(performance.now() - t2);

	writeFileSync(join(dir, "harness.html"), pageHtml(baselineHtml, worktreeHtml, next), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-opencost-profile-"));
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
				const raw2 = await cdpEval(
					url,
					`(async()=>{const d=Date.now()+20000;while(typeof window.__run!=="function"&&Date.now()<d)await new Promise(r=>setTimeout(r,100));if(typeof window.__run!=="function")return JSON.stringify({fatal:"__run 未定义"});return JSON.stringify(await window.__run());})()`
				);
				payload = JSON.parse(raw2);
				if (payload.fatal) throw new Error(String(payload.fatal));
			} catch (e) {
				if (i === 59) throw e;
				payload = null;
			}
		}
		const report = { book: BOOK, fileMB, chapterCount: source.chapterCount, baselineBuildMs, firstScreenBuildMs, nextChunksBuildMs, ...payload };
		const outFile = process.env.NYAR_OPENCOST_REPORT || join(tmpdir(), "nyar-open-cost.json");
		writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
		console.log(`report: ${outFile}`);
		console.log(JSON.stringify(report, null, 2));
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("open-cost check failed:", e && e.message);
	process.exitCode = 2;
});
