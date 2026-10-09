/**
 * 高亮位置正确性探针：模拟真实划词 → 生成锚点 → 重新定位并绘制，
 * 检查**实际高亮覆盖的文本**是否就是**当初选中的文本**。
 *
 * 也是回归：改字号 / 切模式 / 切章之后高亮不能漂移。
 *
 * 用法：node tests/manual/highlight-accuracy-probe.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = join(ROOT, "tests", "manual");
const PORT = 9800 + Math.floor(Math.random() * 90);

async function bundle() {
	const esbuild = await import("esbuild");
	await esbuild.build({
		entryPoints: [join(ROOT, "src/services/books/formats/mobi/HtmlDocEngine.ts")],
		bundle: true,
		format: "iife",
		globalName: "NyarEngine",
		platform: "browser",
		outfile: join(OUT, ".acc-engine.js"),
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
<script src="./acc-engine.js"><\/script>
<script>
function decorate(el){
	el.createEl=function(tag,o){const c=document.createElement(tag);if(o&&o.cls)c.className=o.cls;if(o&&o.text!=null)c.textContent=o.text;if(o&&o.attr)for(const k in o.attr)c.setAttribute(k,o.attr[k]);this.appendChild(c);return c;};
	el.createDiv=function(o){return this.createEl("div",o);};
	el.empty=function(){while(this.firstChild)this.removeChild(this.firstChild);};
	if(!el.addClass)el.addClass=function(c){this.classList.add(c);};
	if(!el.toggleClass)el.toggleClass=function(c,on){this.classList.toggle(c,on===undefined?undefined:!!on);};
	return el;
}
// 多段中文，段落里放"目标句"（含前后文，便于检查偏移是否漂移）
const TARGET = "高亮定位必须精确命中这一句";
const FILLER = "这是一段用于制造偏移的填充文字，重复出现以拉开字符距离。";
const SENT_A = "第一段开头。" + FILLER.repeat(3) + TARGET + "第一段结尾。";
const SENT_B = "第二段开头。" + FILLER.repeat(5) + TARGET + "第二段结尾。";
window.__probe = async function () {
	const host = decorate(document.getElementById("reading"));
	host.empty();
	const engine = new NyarEngine.HtmlDocEngine({
		book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
		html: "<!DOCTYPE html><html><head></head><body><span id='nyareader-epub-0'></span>" +
			"<h1>标题</h1><p>" + SENT_A + "</p><p>" + SENT_B + "</p>" +
			"<p>" + FILLER.repeat(6) + "</p></body></html>",
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

	// —— 模拟真实划词：在第二段的"目标句"上建立选区 ——
	const paras = [...doc.querySelectorAll("p")];
	const paraB = paras[1];
	const textNode = [...paraB.childNodes].find((n) => n.nodeType === 3 && n.data.includes(TARGET));
	if (!textNode) return { fatal: "找不到目标文本节点" };
	const at = textNode.data.indexOf(TARGET);
	const range = doc.createRange();
	range.setStart(textNode, at);
	range.setEnd(textNode, at + TARGET.length);
	const sel = win.getSelection();
	sel.removeAllRanges();
	sel.addRange(range);
	const selectedText = sel.toString();

	// —— 引擎生成锚点（真实链路）——
	const draft = engine.getSelectionAnchor();
	if (!draft) return { fatal: "getSelectionAnchor 返回 null" };

	// 诊断：选区容器 / 区域节点 / 偏移，逐层确认 offsetInNodes 为何可能返回 null
	const selStart = range.startContainer;
	const selStartParent = selStart.nodeType === 3 ? selStart.parentElement : selStart;
	const diag2 = {
		startContainerType: selStart.nodeType,
		startContainerParentTag: selStartParent ? selStartParent.tagName : null,
		startContainerParentIsParagraph: selStartParent ? selStartParent.tagName === "P" : false,
		startOffset: range.startOffset,
		endOffset: range.endOffset,
		startInDoc: doc.body.contains(selStart),
		paragraphIndexInQueried: paras.indexOf(selStartParent),
		paragraphCount: paras.length,
		firstParaTextLen: paras[0] ? paras[0].textContent.length : null,
		secondParaHasTarget: paras[1] ? paras[1].textContent.includes(TARGET) : null
	};

	// 诊断：锚点坐标系 vs 高亮层坐标系是否一致
	// 引擎生成 charStart/charEnd 用的"区域文本"必须与高亮层 rangeWithinRegion 用的是同一串
	const regions = engine.highlightRegions ? engine.highlightRegions() : null;
	let regionDiagnostic = null;
	if (regions) {
		const r = regions.find((x) => x.key === draft.primary) ?? regions[0];
		if (r) {
			const regionText = r.nodes.map((n) => n.textContent ?? "").join("");
			regionDiagnostic = {
				regionCount: regions.length,
				regionKeys: regions.map((x) => x.key).slice(0, 5),
				nodeCount: r.nodes.length,
				regionTextLen: regionText.length,
				sliceAtCharRange:
					typeof draft.charStart === "number" && typeof draft.charEnd === "number"
						? regionText.slice(draft.charStart, draft.charEnd)
						: null
			};
		}
	}

	// 序列化往返（模拟"存盘后重开书"）：锚点必须能原样还原
	const roundTripped = JSON.parse(JSON.stringify(draft));

	// 用锚点重新设置高亮（等价于"存盘后重开书"）
	engine.setHighlights([{ id: "h1", anchor: draft, color: "yellow", hasNote: false, text: selectedText }]);
	await new Promise((r) => setTimeout(r, 250));

	// 读回实际绘制的文本：用 CSS Highlight 的 Range 直接取
	const paintRanges = () => {
		const out = [];
		const reg = win.CSS && win.CSS.highlights;
		if (!reg) return out;
		for (const [name, hl] of reg) {
			for (const r of hl) out.push({ name, text: r.toString() });
		}
		return out;
	};
	const painted = paintRanges();
	const placement = engine.getHighlightPlacements ? engine.getHighlightPlacements()[0] : null;

	// 改字号后是否漂移
	engine.applySettings({
		fontFamily: "system-ui", fontSize: 26, lineHeight: 1.8, margin: 24,
		theme: "light", layout: "single", scrollMode: true, pageWidth: 640
	});
	await new Promise((r) => setTimeout(r, 400));
	const paintedAfterFont = paintRanges();

	// 切分页再切回滚动
	engine.switchMode && engine.switchMode(false);
	await new Promise((r) => setTimeout(r, 400));
	engine.switchMode && engine.switchMode(true);
	await new Promise((r) => setTimeout(r, 400));
	const paintedAfterMode = paintRanges();

	const result = {
		selectedText,
		target: TARGET,
		draftCharStart: draft.charStart,
		draftCharEnd: draft.charEnd,
		draftPrimary: draft.primary,
		quoteExact: draft.quote ? draft.quote.exact : null,
		regionDiagnostic,
		diag2,
		engineDiag: engine.getLayoutDiagnostics ? engine.getLayoutDiagnostics().lastSelectionDiag : null,
		roundTripCharStart: roundTripped.charStart,
		roundTripCharEnd: roundTripped.charEnd,
		painted,
		paintedAfterFont,
		paintedAfterMode,
		placement
	};
	engine.destroy();
	return result;
};
<\/script></body></html>`;

async function main() {
	mkdirSync(OUT, { recursive: true });
	await bundle();
	const dir = mkdtempSync(join(tmpdir(), "nyar-acc-"));
	writeFileSync(join(dir, "p.html"), PAGE, "utf8");
	writeFileSync(join(dir, "acc-engine.js"), readFileSync(join(OUT, ".acc-engine.js"), "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-acc-prof-"));
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
		const res = JSON.parse(r.result.value);
		if (res.fatal) {
			console.log(JSON.stringify({ fatal: res.fatal }, null, 2));
			process.exitCode = 2;
			return;
		}
		const exact = (arr) => arr.length === 1 && arr[0].text === res.selectedText;
		const checks = [
			["划词生成了结构锚点（charStart/charEnd 存在）", typeof res.draftCharStart === "number" && typeof res.draftCharEnd === "number"],
			["锚点指纹 exact == 选中文本", res.quoteExact === res.selectedText],
			["首次绘制覆盖的文本 == 选中文本", exact(res.painted)],
			["改字号后仍覆盖同一句", exact(res.paintedAfterFont)],
			["切分页/滚动往返后仍覆盖同一句", exact(res.paintedAfterMode)],
			["placement 为精确命中（非 approximate）", res.placement && res.placement.approximate === false]
		];
		const report = { checks: checks.map(([n, p]) => ({ name: n, pass: p })), pass: checks.every(([, p]) => p), numbers: res };
		writeFileSync(join(OUT, "highlight-accuracy.json"), JSON.stringify(report, null, 2), "utf8");
		console.log(JSON.stringify(report, null, 2));
		process.exitCode = report.pass ? 0 : 1;
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("highlight-accuracy probe failed:", e.message);
	process.exitCode = 2;
});
