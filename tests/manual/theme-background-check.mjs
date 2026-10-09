/**
 * 验证 HtmlDocEngine 滚动模式的背景是否跟随宿主主题（EPUB 灰底/白底对不上的问题）。
 *
 * 做法：在页面里造一个仿 Obsidian 的宿主容器（带 --background-primary / --text-normal），
 * 把这两个变量设成与引擎 THEME_CSS（light 默认 #f2f2f2）**明显不同**的值，
 * 然后在滚动/分页两种模式下分别读 iframe 文档的 computed 背景色。
 *
 * 期望：
 * - 滚动模式 + 默认主题(light) → 背景 == 宿主 --background-primary（不是 #f2f2f2）
 * - 分页模式 + 默认主题(light) → 背景仍是书页白（#ffffff），不受宿主影响
 * - 滚动模式 + 显式 dark/sepia → 保持主题色
 *
 * 用法：node tests/manual/theme-background-check.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = join(ROOT, "tests", "manual");
const PORT = 9900 + Math.floor(Math.random() * 90);

async function bundle() {
	const esbuild = await import("esbuild");
	await esbuild.build({
		entryPoints: [join(ROOT, "src/services/books/formats/mobi/HtmlDocEngine.ts")],
		bundle: true,
		format: "iife",
		globalName: "NyarEngine",
		platform: "browser",
		outfile: join(OUT, ".theme-engine.js"),
		logLevel: "error",
		external: ["obsidian"],
	});
}

function page(bundleName) {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
		html,body{margin:0;height:100%;overflow:hidden}
		/* 仿 Obsidian 宿主：变量必须定义在 :root，否则 <html> 读不到（继承不上自定义属性） */
		:root{
			--background-primary: rgb(13, 37, 61);
			--text-normal: rgb(240, 244, 250);
		}
		#host{
			position:relative;width:100vw;height:100vh;
			background: var(--background-primary);
		}
		.nyareader-reading{position:absolute;inset:0;overflow:hidden}
	</style></head><body>
	<div id="host" class="nyareader-root"><div class="nyareader-reading" id="reading"></div></div>
	<script src="./${bundleName}"><\/script>
	<script>
	function decorate(el){
		el.createEl=function(tag,o){const c=document.createElement(tag);if(o&&o.cls)c.className=o.cls;if(o&&o.text!=null)c.textContent=o.text;if(o&&o.attr)for(const k in o.attr)c.setAttribute(k,o.attr[k]);this.appendChild(c);return c;};
		el.createDiv=function(o){return this.createEl("div",o);};
		el.empty=function(){while(this.firstChild)this.removeChild(this.firstChild);};
		if(!el.addClass)el.addClass=function(c){this.classList.add(c);};
		if(!el.toggleClass)el.toggleClass=function(c,on){this.classList.toggle(c,on===undefined?undefined:!!on);};
		return el;
	}
	const BODY = new Array(400).fill("<p>用于验证背景的中文段落文字，重复足够多次以产生多栏与滚动高度。</p>").join("");

	window.__probe = async function (opts) {
		const host = decorate(document.getElementById("reading"));
		host.empty();
		const settings = {
			fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24,
			theme: opts.theme || "light", layout: "single",
			scrollMode: opts.scrollMode === true, pageWidth: 640
		};
		const engine = new NyarEngine.HtmlDocEngine({
			book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
			html: "<!DOCTYPE html><html><head></head><body>" + BODY + "</body></html>",
			formatLabel: "epub"
		});
		await engine.mount(host);
		engine.applySettings(settings);
		await new Promise((r) => setTimeout(r, 200));
		const iframe = host.querySelector("iframe");
		const doc = iframe.contentDocument;
		const win = iframe.contentWindow;
		const htmlBg = win.getComputedStyle(doc.documentElement).backgroundColor;
		const bodyBg = win.getComputedStyle(doc.body).backgroundColor;
		const bodyColor = win.getComputedStyle(doc.body).color;
		// 分页模式：真正呈现"书页"的是 .nyareader-book（白/深色由主题决定），不是 html 画布
		const bookEl = doc.querySelector(".nyareader-book");
		const bookBg = bookEl ? win.getComputedStyle(bookEl).backgroundColor : null;
		const scrolled = opts.scrollMode === true;
		engine.destroy();
		return { label: opts.label, theme: settings.theme, scrollMode: scrolled, htmlBg, bodyBg, bodyColor, bookBg };
	};
	<\/script></body></html>`;
}

async function cdp(url, expr) {
	const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
	const t = list.find((x) => x.type === "page");
	const ws = new WebSocket(t.webSocketDebuggerUrl);
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
	const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
	ws.close();
	if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
	return r.result.value;
}

async function main() {
	mkdirSync(OUT, { recursive: true });
	await bundle();
	const dir = mkdtempSync(join(tmpdir(), "nyar-theme-"));
	const file = join(dir, "p.html");
	writeFileSync(file, page("engine.js"), "utf8");
	writeFileSync(join(dir, "engine.js"), readFileSync(join(OUT, ".theme-engine.js"), "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-theme-prof-"));
	const url = `file:///${file.replace(/\\/g, "/")}`;
	const child = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1200,800", "--no-first-run", "--disable-extensions", `--user-data-dir=${profile}`, url], { stdio: "ignore" });
	try {
		let up = false;
		for (let i = 0; i < 60 && !up; i++) {
			await new Promise((r) => setTimeout(r, 200));
			try { up = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch { /* wait */ }
		}
		if (!up) throw new Error("CDP 未就绪");
		const expr = `(async () => {
			const dl = Date.now() + 8000;
			while (typeof window.__probe !== "function" && Date.now() < dl) await new Promise(r => setTimeout(r, 100));
			if (typeof window.__probe !== "function") return JSON.stringify({ fatal: "未就绪" });
			const out = [];
			out.push(await window.__probe({ label: "滚动+默认主题", scrollMode: true, theme: "light" }));
			out.push(await window.__probe({ label: "分页+默认主题", scrollMode: false, theme: "light" }));
			out.push(await window.__probe({ label: "滚动+dark", scrollMode: true, theme: "dark" }));
			out.push(await window.__probe({ label: "滚动+sepia", scrollMode: true, theme: "sepia" }));
			return JSON.stringify(out);
		})()`;
		const rows = JSON.parse(await cdp(url, expr));
		const HOST_BG = "rgb(13, 37, 61)";
		const checks = [];
		const find = (l) => rows.find((r) => r.label === l);
		const scrollDefault = find("滚动+默认主题");
		const pagedDefault = find("分页+默认主题");
		const scrollDark = find("滚动+dark");
		const scrollSepia = find("滚动+sepia");
		checks.push(["滚动+默认主题：背景 == 宿主 --background-primary（不再是 #f2f2f2）",
			scrollDefault.htmlBg === HOST_BG || scrollDefault.bodyBg === HOST_BG]);
		checks.push(["滚动+默认主题：正文颜色跟随宿主（不再是写死的 #1f1f1f）",
			scrollDefault.bodyColor !== "rgb(31, 31, 31)"]);
		checks.push(["分页+默认主题：书页本体仍是白（呈现书页的是 .nyareader-book）",
			pagedDefault.bookBg === "rgb(255, 255, 255)"]);
		checks.push(["分页+默认主题：书页不跟随宿主深色（保持纸的观感）",
			pagedDefault.bookBg !== HOST_BG]);
		checks.push(["滚动+dark：保留暗色主题背景",
			scrollDark.htmlBg === "rgb(20, 20, 22)" || scrollDark.bodyBg === "rgb(20, 20, 22)"]);
		checks.push(["滚动+sepia：保留羊皮纸主题背景",
			scrollSepia.htmlBg === "rgb(233, 224, 205)" || scrollSepia.bodyBg === "rgb(233, 224, 205)"]);
		const report = { hostVar: HOST_BG, rows, checks: checks.map(([name, pass]) => ({ name, pass })), pass: checks.every(([, p]) => p) };
		writeFileSync(join(OUT, "theme-background.json"), JSON.stringify(report, null, 2), "utf8");
		console.log(JSON.stringify(report, null, 2));
		process.exitCode = report.pass ? 0 : 1;
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("theme-background-check failed:", e.message);
	process.exitCode = 2;
});
