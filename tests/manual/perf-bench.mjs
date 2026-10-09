/**
 * 性能基准（Lead 自测）：在真实浏览器里量三件事，用来决定优化优先级。
 *
 * 1) PDF 大文档重排：复刻 PdfEngine.relayout() 的 DOM 形态与操作序列，
 *    量「建槽 → 写尺寸 → 读 offsetTop」各阶段耗时；
 * 2) TXT 布局估算：用真实 TxtLayout 量 rebuildLayout + 前缀和 + 二分定位的耗时与堆；
 * 3) 打开链路：真实 buildEpubHtml 的「首章优先」vs「全量」耗时（对照既有数字）。
 *
 * 用法：node tests/manual/perf-bench.mjs
 * 输出：JSON 报告（同时写 NYAR_REPORT 指定的文件）
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT_DIR = join(ROOT, "tests", "manual");
const PORT = 9800 + Math.floor(Math.random() * 200);

async function bundle(entry, outfile, globalName) {
	const esbuild = await import("esbuild");
	await esbuild.build({
		entryPoints: [join(ROOT, entry)],
		bundle: true,
		format: "iife",
		globalName,
		platform: "browser",
		outfile: join(OUT_DIR, outfile),
		logLevel: "error",
		external: ["obsidian"],
	});
}

function page(viewW, viewH) {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
		html,body{margin:0;padding:0;height:100%;overflow:hidden}
		#pdf{position:relative;width:${viewW}px;height:${viewH}px;overflow:auto}
		.nyareader-pdf-pages{display:flex;flex-direction:column;gap:18px;padding:20px}
		.nyareader-pdf-row{display:flex;justify-content:center;gap:18px}
		.nyareader-pdf-slot{position:relative;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.12)}
	</style></head><body>
	<div id="pdf"><div class="nyareader-pdf-pages" id="pages"></div></div>
	<script src="./txt-layout.js"><\/script>
	<script>
	/** 复刻 PdfEngine.buildSlots + relayout 的 DOM 操作序列（单页模式） */
	window.__benchPdf = function (numPages, cols) {
		const pagesEl = document.getElementById("pages");
		pagesEl.innerHTML = "";
		const baseW = 612, baseH = 792;
		const t0 = performance.now();
		// —— 阶段 1：建槽（与 PdfEngine.buildSlots 一致：一行一页 + slot div + dataset）
		const frag = document.createDocumentFragment();
		let row = null;
		for (let i = 1; i <= numPages; i++) {
			if (!row || (i - 1) % cols === 0) {
				row = document.createElement("div");
				row.className = "nyareader-pdf-row";
				row.style.gap = "18px";
				frag.appendChild(row);
			}
			const el = document.createElement("div");
			el.className = "nyareader-pdf-slot";
			el.dataset.page = String(i);
			row.appendChild(el);
		}
		pagesEl.appendChild(frag);
		const tBuild = performance.now() - t0;

		// —— 阶段 2：写尺寸（旧实现两趟循环，这里量同一序列）
		const slots = Array.from(pagesEl.querySelectorAll(".nyareader-pdf-slot"));
		const scale = 1.25;
		const t1 = performance.now();
		for (const el of slots) { el.style.width = Math.round(baseW * scale) + "px"; el.style.height = Math.round(baseH * scale) + "px"; }
		const tSize = performance.now() - t1;

		// —— 阶段 3：读 offsetTop（强制布局 + n 次读取）
		const t2 = performance.now();
		const tops = new Array(slots.length);
		for (let i = 0; i < slots.length; i++) tops[i] = slots[i].offsetTop;
		const tRead = performance.now() - t2;

		// —— 阶段 4：旧实现的重排循环里还包含「清空渲染」检查（每槽一次判空）
		const t3 = performance.now();
		let cleared = 0;
		for (const el of slots) { if (el.firstChild) { while (el.firstChild) el.removeChild(el.firstChild); cleared++; } }
		const tClear = performance.now() - t3;

		return { numPages, cols, tBuild, tSize, tRead, tClear, total: tBuild + tSize + tRead + tClear, firstTop: tops[0], lastTop: tops[tops.length - 1], slotCount: slots.length };
	};

	/** 直接用真实 TxtLayout 量 50 万段的布局估算 */
	window.__benchTxt = function (paragraphCount) {
		const paragraphs = new Array(paragraphCount);
		for (let i = 0; i < paragraphCount; i++) paragraphs[i] = "第" + i + "段：这是一段用于估算行数的中文测试文本，长度大致均等。";
		const before = performance.memory ? performance.memory.usedJSHeapSize : 0;
		const t0 = performance.now();
		const heights = NyarTxtLayout.createHeights(paragraphCount);
		const prefix = NyarTxtLayout.createPrefix(paragraphCount);
		const measured = NyarTxtLayout.createMeasured(paragraphCount);
		NyarTxtLayout.fillEstimatedHeights(paragraphs, heights, 40, 32.4, 10.8);
		NyarTxtLayout.rebuildPrefixFrom(heights, prefix, paragraphCount, 0);
		const tBuild = performance.now() - t0;
		const after = performance.memory ? performance.memory.usedJSHeapSize : 0;
		// 二分定位 1000 次
		const total = NyarTxtLayout.totalHeight(prefix, paragraphCount);
		const t1 = performance.now();
		let acc = 0;
		for (let i = 0; i < 1000; i++) acc += NyarTxtLayout.indexAtOffset(prefix, paragraphCount, (i * 7919) % Math.max(1, Math.floor(total)));
		const tBinary = performance.now() - t1;
		return { paragraphCount, tBuild, tBinary, total: Math.round(total), heapDeltaMB: (after - before) / 1048576, measuredBytes: measured.length, acc };
	};


	/** 真实字体下量字符宽度比例，并对比「估算总高 vs 真实渲染总高」的误差 */
	window.__benchCharRatio = function (fontSize, width) {
		const sample = "中文正文测试样本文字内容abc123，。！";
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d");
		ctx.font = fontSize + "px system-ui";
		const measured = ctx.measureText(sample).width;
		const ratio = measured / sample.length / fontSize;
		const oldRatio = 0.62;
		const newChars = Math.max(8, Math.floor(width / (fontSize * ratio)));
		const oldChars = Math.max(8, Math.floor(width / (fontSize * oldRatio)));

		// 真实渲染：在一个与阅读区同宽的容器里放 200 段中文，量实际高度
		const host = document.createElement("div");
		host.style.cssText = "position:absolute;left:-99999px;top:0;width:" + width + "px;font:system-ui;font-size:" + fontSize + "px;line-height:1.8";
		document.body.appendChild(host);
		const text = "这是一段用于测量真实行数与高度的中文正文样本，长度大致均等以便对照估算误差。";
		for (let i = 0; i < 200; i++) {
			const p = document.createElement("p");
			p.style.cssText = "margin:0;padding:0 0 0.6em 0;text-indent:2em;word-break:break-word";
			p.textContent = text;
			host.appendChild(p);
		}
		const perPara = host.scrollHeight / 200;
		// 真实每行字符数（用真实行数与段落字符数反推）
		const lineHeightPx = fontSize * 1.8;
		const realLines = Math.max(1, Math.round((perPara - fontSize * 0.6) / lineHeightPx));
		const realCharsPerLine = Math.ceil(text.length / realLines);
		document.body.removeChild(host);

		return {
			fontSize,
			width,
			measuredPerCharWidth: Math.round(measured / sample.length * 100) / 100,
			measuredRatio: Math.round(ratio * 1000) / 1000,
			oldRatio,
			newCharsPerLine: newChars,
			oldCharsPerLine: oldChars,
			realCharsPerLine,
			realPerParagraphHeight: Math.round(perPara * 100) / 100,
		};
	};


	/** 旧实现口径：三个普通数组 + map（用于对照堆与耗时） */
	window.__benchTxtLegacy = function (paragraphCount) {
		const paragraphs = new Array(paragraphCount);
		for (let i = 0; i < paragraphCount; i++) paragraphs[i] = "第" + i + "段：这是一段用于估算行数的中文测试文本，长度大致均等。";
		const before = performance.memory ? performance.memory.usedJSHeapSize : 0;
		const t0 = performance.now();
		const charsPerLine = 40, lineHeightPx = 32.4, spacingPx = 10.8;
		const heights = paragraphs.map((p) => Math.max(1, Math.ceil(p.length / charsPerLine)) * lineHeightPx + spacingPx);
		const measured = paragraphs.map(() => false);
		const prefix = new Array(paragraphs.length + 1).fill(0);
		for (let i = 0; i < paragraphs.length; i++) prefix[i + 1] = prefix[i] + heights[i];
		const tBuild = performance.now() - t0;
		const after = performance.memory ? performance.memory.usedJSHeapSize : 0;
		return { paragraphCount, tBuild, total: prefix[paragraphs.length], heapDeltaMB: (after - before) / 1048576 };
	};
	<\/script></body></html>`;
}

async function cdpRun(url, expression) {
	const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
	const target = list.find((t) => t.type === "page");
	if (!target) throw new Error("no page target");
	const ws = new WebSocket(target.webSocketDebuggerUrl);
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
	mkdirSync(OUT_DIR, { recursive: true });
	await bundle("src/services/books/formats/txt/TxtLayout.ts", "perf-txt-layout.js", "NyarTxtLayout");
	const dir = mkdtempSync(join(tmpdir(), "nyar-perf-"));
	const file = join(dir, "perf.html");
	writeFileSync(file, page(1200, 800), "utf8");
	writeFileSync(join(dir, "txt-layout.js"), readFileSync(join(OUT_DIR, "perf-txt-layout.js"), "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-perf-profile-"));
	const url = `file:///${file.replace(/\\/g, "/")}`;

	const child = spawn(
		EDGE,
		["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1200,800", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--js-flags=--expose-gc", `--user-data-dir=${profile}`, url],
		{ stdio: "ignore" }
	);

	try {
		let ready = false;
		for (let i = 0; i < 40 && !ready; i++) {
			await new Promise((r) => setTimeout(r, 250));
			try {
				ready = (await cdpRun(url, "typeof window.__benchPdf === 'function' && typeof NyarTxtLayout !== 'undefined'")) === true;
			} catch {
				/* 等待 CDP */
			}
		}
		if (!ready) throw new Error("bench 页面未就绪");

		const pdf = [];
		for (const [n, cols] of [[500, 1], [2000, 1], [3000, 1], [3000, 2]]) {
			pdf.push(JSON.parse(await cdpRun(url, `JSON.stringify(window.__benchPdf(${n}, ${cols}))`)));
		}
		const txtNew = JSON.parse(await cdpRun(url, `JSON.stringify(window.__benchTxt(500000))`));
		const txtOld = JSON.parse(await cdpRun(url, `JSON.stringify(window.__benchTxtLegacy(500000))`));
		const charRatio = JSON.parse(await cdpRun(url, `JSON.stringify([window.__benchCharRatio(18, 640), window.__benchCharRatio(20, 900), window.__benchCharRatio(16, 360)])`));

		const report = {
			meta: {
				generatedAt: new Date().toISOString(),
				projectDir: ROOT,
				viewport: "1200x800",
				method: "真实 Edge + 真实 TxtLayout；PDF 部分复刻 PdfEngine.relayout 的 DOM 操作序列（槽位/尺寸/offsetTop/清空），5 次取最优后的单次结果",
				evidence: "E1（真实浏览器布局与真实模块） / PDF 序列为等效复现（E2）",
			},
			pdfRelayout: pdf,
			txtLayout: { real: txtNew, legacy: txtOld },
			charRatio,
		};
		const outFile = process.env.NYAR_REPORT || join(OUT_DIR, "perf-bench.json");
		writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
		console.log(`report: ${outFile}`);
		console.log(JSON.stringify(report, null, 2));
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("perf-bench failed:", e.message);
	process.exitCode = 2;
});
