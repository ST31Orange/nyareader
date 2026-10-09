/**
 * PDF 分页偏移重算的性能对照（真实浏览器布局）。
 *
 * 复刻 PdfEngine 的两种口径：
 * - 旧：每渲染一页都 `for (const s of this.slots) s.top = s.el.offsetTop`
 *   （O(页数) 次强制布局 × 本次滚动渲染的页数）；
 * - 新：写 CSS + 批次结束调用一次 computeRowTops()（纯算术，不读 DOM）。
 *
 * 用法：node tests/manual/perf-pdf-offsets.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT_DIR = join(ROOT, "tests", "manual");
const PORT = 9700 + Math.floor(Math.random() * 200);

async function bundle() {
	const esbuild = await import("esbuild");
	await esbuild.build({
		entryPoints: [join(ROOT, "src/utils/pdf-viewport.ts")],
		bundle: true,
		format: "iife",
		globalName: "NyarPdfViewport",
		platform: "browser",
		outfile: join(OUT_DIR, ".perf-pdf-viewport.js"),
		logLevel: "error",
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
	<script src="./pdf-viewport.js"><\/script>
	<script>
	window.__build = function (numPages, cols) {
		const pagesEl = document.getElementById("pages");
		pagesEl.innerHTML = "";
		const frag = document.createDocumentFragment();
		let row = null;
		for (let i = 1; i <= numPages; i++) {
			if (!row || (i - 1) % cols === 0) {
				row = document.createElement("div"); row.className = "nyareader-pdf-row"; row.style.gap = "18px"; frag.appendChild(row);
			}
			const el = document.createElement("div"); el.className = "nyareader-pdf-slot"; el.dataset.page = String(i);
			row.appendChild(el);
		}
		pagesEl.appendChild(frag);
		const slots = Array.from(pagesEl.querySelectorAll(".nyareader-pdf-slot"));
		for (const el of slots) { el.style.width = "765px"; el.style.height = "990px"; }
		return slots.length;
	};

	/** 旧口径：渲染 window 页，每页修正尺寸后都全表读 offsetTop */
	window.__benchLegacy = function (numPages, cols, windowPages) {
		window.__build(numPages, cols);
		const slots = Array.from(document.querySelectorAll(".nyareader-pdf-slot"));
		const t0 = performance.now();
		let reads = 0;
		for (let w = 0; w < windowPages; w++) {
			// 模拟"这一页的真实尺寸与占位不同"，触发 fixSlotSize 的全表重算
			slots[w].style.height = (990 + (w % 7)) + "px";
			for (const s of slots) { s.top = s.el ? s.el.offsetTop : s.offsetTop; reads++; }
		}
		return { numPages, cols, windowPages, ms: performance.now() - t0, domReads: reads };
	};

	/** 新口径：写 CSS + 批次结束一次纯算术重算 */
	window.__benchNew = function (numPages, cols, windowPages) {
		window.__build(numPages, cols);
		const slots = Array.from(document.querySelectorAll(".nyareader-pdf-slot"));
		const t0 = performance.now();
		for (let w = 0; w < windowPages; w++) slots[w].style.height = (990 + (w % 7)) + "px";
		const heights = slots.map((el) => parseFloat(el.style.height));
		const tops = NyarPdfViewport.computeRowTops(heights, { cols, gap: 18, contentTop: 20 });
		const ms = performance.now() - t0;
		return { numPages, cols, windowPages, ms, domReads: 0, topCount: tops.length, lastTop: Math.round(tops[tops.length - 1]) };
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
	await bundle();
	const dir = mkdtempSync(join(tmpdir(), "nyar-pdfperf-"));
	const file = join(dir, "perf.html");
	writeFileSync(file, page(1200, 800), "utf8");
	writeFileSync(join(dir, "pdf-viewport.js"), readFileSync(join(OUT_DIR, ".perf-pdf-viewport.js"), "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-pdfperf-profile-"));
	const url = `file:///${file.replace(/\\/g, "/")}`;
	const child = spawn(
		EDGE,
		["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1200,800", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, url],
		{ stdio: "ignore" }
	);
	try {
		// 等 CDP 端口就绪（首连可能早于 Edge 绑定端口，直接 fetch 会 "fetch failed"）
		let cdpUp = false;
		for (let i = 0; i < 60 && !cdpUp; i++) {
			await new Promise((r) => setTimeout(r, 250));
			try {
				const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
				cdpUp = res.ok;
			} catch {
				/* 还没起来 */
			}
		}
		if (!cdpUp) throw new Error("CDP 端口未就绪");
		// 注意：headless 下「先探测就绪、再另开连接取值」会偶发读到不同 document 状态，
		// 因此把「等待就绪 + 跑完全部用例」放进同一次 Runtime.evaluate。
		const expr = `(async () => {
			const deadline = Date.now() + 10000;
			while ((typeof window.__benchLegacy !== "function" || typeof window.__benchNew !== "function" || typeof NyarPdfViewport === "undefined") && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 100));
			}
			if (typeof window.__benchLegacy !== "function" || typeof window.__benchNew !== "function" || typeof NyarPdfViewport === "undefined") {
				return JSON.stringify({ fatal: "页面未就绪" });
			}
			const out = [];
			for (const [pages, cols, win] of [[1000, 1, 50], [3000, 1, 50], [3000, 2, 50]]) {
				let legacy = null, modern = null;
				for (let i = 0; i < 3; i++) {
					const l = window.__benchLegacy(pages, cols, win);
					const m = window.__benchNew(pages, cols, win);
					if (!legacy || l.ms < legacy.ms) legacy = l;
					if (!modern || m.ms < modern.ms) modern = m;
				}
				out.push({ pages, cols, windowPages: win, legacy, modern, speedup: Number((legacy.ms / Math.max(0.01, modern.ms)).toFixed(1)), domReadsSaved: legacy.domReads - modern.domReads });
			}
			return JSON.stringify({ cases: out });
		})()`;
		const raw = await cdpRun(url, expr);
		const parsed = JSON.parse(raw);
		if (parsed.fatal) throw new Error(parsed.fatal);
		const cases = parsed.cases;
		const report = {
			meta: {
				generatedAt: new Date().toISOString(),
				method: "真实 Edge：①旧口径=每页修正后全表读 offsetTop；②新口径=写 CSS+一次 computeRowTops 纯算术。各 3 次取最优。",
				evidence: "E2（复刻 DOM 操作序列与真实布局引擎）",
			},
			cases,
		};
		const out = process.env.NYAR_REPORT || join(OUT_DIR, "perf-pdf-offsets.json");
		writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
		console.log(`report: ${out}`);
		console.log(JSON.stringify(report, null, 2));
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("perf-pdf-offsets failed:", e.message);
	process.exitCode = 2;
});
