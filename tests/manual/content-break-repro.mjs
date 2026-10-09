/**
 * 内容断裂最小复现（真实引擎 + headless Edge）。
 *
 * 复现用户主诉：「中途切换页面/切模式后书断在中间，原本 6k 页变 2k 页（内容变短）」。
 *
 * 做法：把**真实 HtmlDocEngine**（esbuild 打包 src/**）放进 Edge 的 iframe 里跑：
 *   mount → 记快照 → notifyContentAppended → 记快照 → switchMode(滚动/分页) 往返 → 记快照
 * 每个快照都测三件事（互相独立，避免只看引擎自报的页数）：
 *   - `p`    : 文档里正文块个数（真实 DOM 数出来）
 *   - `text` : 正文可见文本总长度
 *   - `pages`: 引擎自报总页数（getTotalPages）
 *   - `cols` : 多栏容器里的子节点数
 * 不变量：内容只增不减 —— 任何一次快照的 p / text / cols 都不得小于上一次。
 * 另外检查：追加后 locationChanged 是否仍正常发出（外面进度条靠它驱动）。
 *
 * 用法：node tests/manual/content-break-repro.mjs
 * 退出码：0 = 不变量全部成立；1 = 复现到断裂（打印首个违约点）。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = process.env.NYAR_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BUNDLE = join(ROOT, "tests", "manual", ".engine-bundle.js");
const PORT = 9700 + Math.floor(Math.random() * 200);

async function bundleEngine() {
	mkdirSync(join(ROOT, "tests", "manual"), { recursive: true });
	const esbuild = await import("esbuild");
	await esbuild.build({
		entryPoints: [join(ROOT, "src/services/books/formats/mobi/HtmlDocEngine.ts")],
		bundle: true,
		format: "iife",
		globalName: "NyarEngine",
		platform: "browser",
		outfile: BUNDLE,
		logLevel: "error",
		external: ["obsidian"],
	});
}

function harnessHtml() {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#fff}#host{position:relative;width:100vw;height:100vh}
</style></head>
<body><div id="host"></div>
<script>window.__errors=[];window.addEventListener("error",function(e){window.__errors.push(String(e.message||e));});</script>
<script src="./engine-bundle.js"></script>
<script>
window.__loaded = typeof NyarEngine !== "undefined" && !!NyarEngine.HtmlDocEngine;
function decorate(el) {
	el.createEl = function (tag, o) {
		const c = document.createElement(tag);
		if (o && o.cls) c.className = o.cls;
		if (o && o.text != null) c.textContent = o.text;
		if (o && o.attr) for (const k in o.attr) c.setAttribute(k, o.attr[k]);
		this.appendChild(c);
		return c;
	};
	el.createDiv = function (o) { return this.createEl("div", o); };
	el.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
	if (!el.addClass) el.addClass = function (c) { this.classList.add(c); };
	if (!el.toggleClass) el.toggleClass = function (c, on) { this.classList.toggle(c, on === undefined ? undefined : !!on); };
	return el;
}
function blocks(prefix, from, count, heightPx) {
	let s = "";
	for (let i = from; i < from + count; i++) {
		s += '<p data-txt="' + prefix + i + '" class="blk" style="height:' + (heightPx || 0) + 'px">' + prefix + " " + i + "</p>";
	}
	return s;
}
window.__run = async function (s) {
	const host = decorate(document.getElementById("host"));
	host.style.width = "100vw";
	host.style.height = "100vh";
	host.style.position = "relative";
	if (s.containerWidth) host.style.width = s.containerWidth + "px";
	const settings = { fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24, theme: "light",
		layout: s.layout === "double" ? "double" : "single", scrollMode: false, pageWidth: s.pageWidth || 640 };
	const engine = new NyarEngine.HtmlDocEngine({
		book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" },
		html: s.html, formatLabel: "epub",
	});
	let progressEvents = 0;
	engine.on("locationChanged", () => { progressEvents++; });
	await engine.mount(host);
	engine.applySettings(settings);
	await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	const doc = host.querySelector("iframe").contentDocument;
	const snap = (label) => {
		const cols = doc.querySelector(".nyareader-columns");
		// 分页模式下"内容节点数"要排除零宽测量标记（它自己不是正文）
		const markers = cols ? cols.querySelectorAll("#nyareader-end-marker").length : 0;
		return {
			label,
			mode: engine.getTotalPages() === 0 ? "scroll" : "paged",
			p: doc.querySelectorAll("p.blk").length,
			text: (doc.body.textContent || "").length,
			cols: cols ? cols.children.length : 0,
			markers,
			pages: engine.getTotalPages(),
			loc: engine.currentLocation(),
			progressEvents,
		};
	};
	const out = { scenario: s.name, snaps: [snap("mount")] };
	const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	if (s.interleave) {
		// 追加与切模式交错：模拟"补章进行中用户切走/切模式"
		let n = 0;
		for (let round = 0; round < s.rounds; round++) {
			engine.notifyContentAppended(blocks("A", n, s.chunk, s.blockHeight));
			n += s.chunk;
			await frame();
			out.snaps.push(snap("append#" + round));
			engine.switchMode(true);
			await frame();
			out.snaps.push(snap("scroll#" + round));
			engine.notifyContentAppended(blocks("A", n, s.chunk, s.blockHeight));
			n += s.chunk;
			await frame();
			out.snaps.push(snap("append-in-scroll#" + round));
			engine.switchMode(false);
			await frame();
			out.snaps.push(snap("paged#" + round));
		}
	} else if (s.rapid) {
		// 极端：不等待帧，连续切模式 + 追加（模拟补章回调与用户操作同帧竞争）
		let n = 0;
		for (let round = 0; round < s.rounds; round++) {
			engine.switchMode(true);
			engine.notifyContentAppended(blocks("A", n, s.chunk, s.blockHeight));
			n += s.chunk;
			engine.switchMode(false);
			engine.notifyContentAppended(blocks("A", n, s.chunk, s.blockHeight));
			n += s.chunk;
			engine.switchMode(true);
			engine.switchMode(false);
			await frame();
			out.snaps.push(snap("rapid#" + round));
		}
	} else {
		const total = s.appendTotal != null ? s.appendTotal : s.chunk * s.rounds;
		let n = 0;
		while (n < total) {
			engine.notifyContentAppended(blocks("A", n, Math.min(s.chunk, total - n), s.blockHeight));
			n += s.chunk;
			await frame();
			out.snaps.push(snap("append@" + n));
		}
		for (let round = 0; round < s.roundTrips; round++) {
			engine.switchMode(true);
			await frame();
			out.snaps.push(snap("scroll#" + round));
			engine.switchMode(false);
			await frame();
			out.snaps.push(snap("paged#" + round));
		}
		if (s.trailingAppend) {
			engine.notifyContentAppended(blocks("A", n, s.chunk, s.blockHeight));
			n += s.chunk;
			await frame();
			out.snaps.push(snap("append-final"));
		}
	}
	// 末页可达性 + 实际内容占用列数（独立于引擎自报页数）
	const cols = doc.querySelector(".nyareader-columns");
	await engine.goTo("10000");
	await frame();
	out.endLoc = engine.currentLocation();
	const stride = (parseFloat(doc.documentElement.style.getPropertyValue("--nyar-page-w")) || 0) +
		(parseFloat(doc.documentElement.style.getPropertyValue("--nyar-gutter")) || 0);
	const colsLeft = cols ? cols.getBoundingClientRect().left : 0;
	const lastBlock = doc.querySelector("p.blk:last-of-type");
	const last = lastBlock ? lastBlock.getBoundingClientRect() : null;
	out.stride = Math.round(stride);
	// "断在中间"的独立判据：最后一个正文块所在列（真实几何）必须落在引擎自报页数之内
	out.lastBlockColumn = last && stride > 0 ? Math.round((last.left - colsLeft) / stride) + 1 : null;
	// 高块会跨列（分片）：用元素的版式高度（offsetHeight，不被分片裁剪）算它跨了几列
	const pageH = parseFloat(doc.documentElement.style.getPropertyValue("--nyar-page-h")) || 0;
	const blockH = lastBlock ? lastBlock.offsetHeight || (last ? last.height : 0) : 0;
	out.lastBlockSpanColumns = pageH > 0 && blockH > 0 ? Math.max(1, Math.ceil(blockH / pageH)) : 1;
	out.lastBlockVisible = !!(last && last.width > 0);
	out.lastBlockLeftRel = last ? Math.round(last.left - colsLeft) : null;
	out.reportedPages = engine.getTotalPages();
	out.expectedColumns = last && stride > 0 ? Math.round((last.left - colsLeft) / stride) + 1 : null;
	out.markerCount = doc.querySelectorAll("#nyareader-end-marker").length;
	out.markerIsLastChild = cols ? cols.lastElementChild && cols.lastElementChild.id === "nyareader-end-marker" : null;
	engine.destroy();
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

function allScenariosExpression(scenarios) {
	return `(async () => {
		const deadline = Date.now() + 20000;
		while (typeof window.__run !== "function" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		if (typeof window.__run !== "function") return JSON.stringify({ fatal: "window.__run 未定义" });
		const out = [];
		for (const s of ${JSON.stringify(scenarios)}) out.push(await window.__run(s));
		return JSON.stringify({ results: out });
	})()`;
}

/** 合成首屏 HTML：n 个块（可选固定高度，用来快速堆页数）。 */
function initialHtml(n, heightPx) {
	let s = "<!DOCTYPE html><html><head><meta charset='utf-8'></head><body>";
	for (let i = 0; i < n; i++) s += `<p class="blk" style="height:${heightPx || 0}px">B ${i}</p>`;
	return s + "</body></html>";
}

async function main() {
	if (!existsSync(EDGE)) throw new Error(`未找到 Edge：${EDGE}`);
	await bundleEngine();
	const dir = mkdtempSync(join(tmpdir(), "nyar-break-"));
	const file = join(dir, "harness.html");
	writeFileSync(file, harnessHtml(), "utf8");
	writeFileSync(join(dir, "engine-bundle.js"), readFileSync(BUNDLE, "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-break-profile-"));
	const url = `file:///${file.replace(/\\/g, "/")}`;

	const scenarios = [
		// 1) 最痛的一条：分页模式 + 后台补章 + 切模式往返，内容只增不减
		{ name: "append-then-mode-roundtrip", html: initialHtml(400, 24), chunk: 200, rounds: 3, roundTrips: 2, trailingAppend: true, blockHeight: 24 },
		// 2) 追加与切模式交错（补章进行中用户切走/切模式）
		{ name: "interleaved-append-and-mode", html: initialHtml(300, 24), chunk: 150, rounds: 4, interleave: true, blockHeight: 24 },
		// 3) 窄窗（手机）下的同一路径
		{ name: "narrow-append-roundtrip", html: initialHtml(300, 24), chunk: 150, rounds: 3, roundTrips: 2, containerWidth: 380, blockHeight: 24 },
		// 4) 极端同帧竞争：连续切模式 + 追加，不等待帧
		{ name: "rapid-mode-switch-with-append", html: initialHtml(300, 24), chunk: 150, rounds: 5, rapid: true, blockHeight: 24 },
		// 5) 页数量级复现：内容足以产生 9000 页（固定高度块，每块约 2-3 页）
		{ name: "many-pages-scale", html: initialHtml(1500, 1600), chunk: 1500, rounds: 1, roundTrips: 0, blockHeight: 1600, pageWidth: 640 },
		// 6) 末尾测量标记不得泄漏：连续 5 次「滚动 ↔ 分页」往返后仍只能有 1 个标记
		{ name: "end-marker-5-roundtrips", html: initialHtml(400, 24), chunk: 100, rounds: 0, roundTrips: 5, blockHeight: 24 },
	];

	let payload = null;
	const child = spawn(
		EDGE,
		["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1200,800", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, url],
		{ stdio: "ignore" }
	);
	try {
		for (let i = 0; i < 40 && !payload; i++) {
			try {
				await new Promise((r) => setTimeout(r, 300));
				const raw = await cdpEval(url, allScenariosExpression(scenarios));
				const parsed = JSON.parse(raw);
				if (parsed.fatal) throw new Error(`页面内 fatal：${raw}`);
				payload = parsed.results;
			} catch (e) {
				if (i === 39) throw e;
			}
		}
		if (!payload) throw new Error("harness 未就绪");
		const checks = [];
		for (const r of payload) {
			// 内容只增不减（p / text 为与模式无关的观测量；cols 只在分页快照之间比较）
			for (let i = 1; i < r.snaps.length; i++) {
				const a = r.snaps[i - 1], b = r.snaps[i];
				checks.push([`${r.scenario}: 块数不减少 (${a.label}→${b.label})`, b.p >= a.p]);
				checks.push([`${r.scenario}: 文本不缩短 (${a.label}→${b.label})`, b.text >= a.text]);
				if (a.mode === "paged" && b.mode === "paged") {
					checks.push([`${r.scenario}: 分页栏内内容节点不减少 (${a.label}→${b.label})`, b.cols - b.markers >= a.cols - a.markers]);
				}
			}
			// 分页快照内部一致性：正文块必须都在多栏容器里（没有块被落在 body 上）
			for (const s of r.snaps) {
				if (s.mode === "paged") checks.push([`${r.scenario}: 分页时正文全在栏容器内 (${s.label})`, s.cols - s.markers === s.p]);
			}
			// 补章必须让引擎进度事件继续发出（外面进度条靠它驱动）
			checks.push([`${r.scenario}: locationChanged 有发出`, r.snaps[r.snaps.length - 1].progressEvents > 0]);
			// 末尾测量标记唯一且在最后
			checks.push([`${r.scenario}: 末尾标记唯一`, r.markerCount === 1]);
			checks.push([`${r.scenario}: 末尾标记在最后一列`, r.markerIsLastChild === true]);
			// 末页可达：自报页数必须覆盖最后一个正文块的起始列（不能被截断），
			// 且不能比它多出很多列（后者 = 末尾空白页）。容差 3 列 = 超高块跨列的几何余量
			// （分片元素的 offsetHeight/getBoundingClientRect 只反映单个分片，无法精确算跨度）。
			checks.push([
				`${r.scenario}: 末页可达(最后一个块在自报页数内,容差3列)`,
				r.lastBlockColumn == null || (r.reportedPages >= r.lastBlockColumn && r.reportedPages - r.lastBlockColumn <= 3),
			]);
			checks.push([`${r.scenario}: 自报页数≥实际列数`, r.expectedColumns == null || r.reportedPages >= r.expectedColumns - 1]);
		}
		const report = { results: payload, checks: checks.map(([n, ok]) => ({ name: n, pass: !!ok })), pass: checks.every(([, ok]) => !!ok) };
		const outFile = process.env.NYAR_BREAK_REPORT || join(tmpdir(), "nyar-content-break.json");
		writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
		console.log(`report: ${outFile}`);
		console.log(
			JSON.stringify(
				{
					pass: report.pass,
					failed: report.checks.filter((c) => !c.pass).map((c) => c.name),
					summary: payload.map((r) => ({
						scenario: r.scenario,
						pages: r.reportedPages,
						expectedColumns: r.expectedColumns,
						lastBlockVisible: r.lastBlockVisible,
						snaps: r.snaps.map((s) => `${s.label}: p=${s.p} text=${s.text} cols=${s.cols} pages=${s.pages}`),
					})),
				},
				null,
				2
			)
		);
		process.exitCode = report.pass ? 0 : 1;
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("content-break repro failed:", e && e.message);
	process.exitCode = 2;
});
