/**
 * 真实 HtmlDocEngine 的无头浏览器端到端验证（Lead 自测，不依赖 Obsidian 运行时）。
 *
 * 与 verify/headless-pagination.mjs 的区别：
 * - 那个测的是「复刻的最小 DOM 结构」（验证算法假设）；
 * - 本脚本把**真实引擎代码**用 esbuild 打成 IIFE，在 Edge 里用真实 iframe 跑一遍
 *   mount / 翻页 / 单双页 / 追加章节 / 图片资源回填，验证端到端行为。
 *
 * 用法：node tests/manual/real-engine-check.mjs
 * 输出：一行 JSON（每个场景 PASS/FAIL + 关键数值）
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BUNDLE = join(ROOT, "tests", "manual", ".engine-bundle.js");
const PORT = 9400 + Math.floor(Math.random() * 400);

/**
 * 用 esbuild 的 JS API 打包引擎（避免在 Windows 上 spawn npx.cmd 的 EINVAL）。
 * esbuild 是 devDependency，直接 import 即可。
 */
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

/** 生成 2000+ 块 + 大图 + 超页高长图的合成书。 */
function syntheticHtml() {
	const blocks = Array.from({ length: 2000 }, (_, i) => `<p>段落 ${i + 1}：用于产生足够多的分栏内容，验证分页测量与翻页位移。</p>`).join("\n");
	// 1x1 PNG 的 data URI 作为"大图"的替代：真实尺寸由 width/height 属性给出
	const png =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
	return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
${blocks}
<p><img id="big" src="${png}" width="2400" height="1800" alt="big"></p>
<p><img id="tall" src="${png}" width="600" height="3000" alt="tall"></p>
<p><img id="lazy" data-nyar-asset="OEBPS/images/registered.png" alt="lazy"></p>
</body></html>`;
}

function harnessHtml(bundleFileName) {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#host{position:relative;width:100vw;height:100vh}</style></head>
<body><div id="host"></div>
<script>window.__errors=[];window.addEventListener("error",function(e){window.__errors.push(String(e.message||e));});<\/script>
<script src="./${bundleFileName}"><\/script>
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
window.__run = async function (scenario) {
	const host = decorate(document.getElementById("host"));
	// 用容器宽度模拟不同面板宽度（引擎按 iframe.clientWidth 计算版式）
	if (scenario.containerWidth) host.style.width = scenario.containerWidth + "px";
	else host.style.width = "100vw";
	host.style.height = "100vh";
	host.style.position = "relative";
	const double = scenario.layout === "double";
	const html = scenario.html || ${JSON.stringify("__INJECT__")};
	const settings = { fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24, theme: "light",
		layout: double ? "double" : "single", scrollMode: scenario.scrollMode === true, pageWidth: scenario.pageWidth || 640 };
	let resolved = 0;
	const opts = { book: { format: "epub", title: "T", toc: [], spine: [], fingerprint: "x", path: "x" }, html, formatLabel: "epub" };
	if (scenario.withResolver) opts.resolveAsset = async () => {
		resolved++;
		const blob = new Blob([new Uint8Array([137,80,78,71])], { type: "image/png" });
		return URL.createObjectURL(blob);
	};
	const engine = new NyarEngine.HtmlDocEngine(opts);
	await engine.mount(host);
	engine.applySettings(settings);
	await new Promise((r) => setTimeout(r, 150));
	const doc = host.querySelector("iframe").contentDocument;
	const out = { scenario: scenario.name, resolvedCalls: resolved };
	out.pages = engine.getTotalPages();
	out.paged = engine.capabilities.pageNav === true;
	const cols = doc.querySelector(".nyareader-columns");
	const marker = doc.getElementById("nyareader-end-marker");
	out.hasMarker = !!marker;
	out.markerInLastColumn = marker && cols ? (marker.offsetParent === cols ? marker.offsetLeft : -1) : -1;
	const pageW = parseFloat(doc.documentElement.style.getPropertyValue("--nyar-page-w")) || 0;
	const gutter = parseFloat(doc.documentElement.style.getPropertyValue("--nyar-gutter")) || 0;
	out.pageW = pageW; out.gutter = gutter; out.stride = pageW + gutter;
	const bookEl = doc.querySelector(".nyareader-book");
	out.hasBookWindow = !!bookEl;
	out.doubleActive = bookEl ? bookEl.getBoundingClientRect().width > pageW * 1.5 : false;
	if (cols) {
		// 探针 1（stream-d 建议）：computed column-width 必须是页宽，不能是 auto。
		// 只写 column-count 而漏掉 column-width 时浏览器按列数均分容器（~200px），
		// 与页宽无关，一页里会塞进多个窄栏 —— 这是曾经漏掉的一条。
		const colsStyle = getComputedStyle(cols);
		out.computedColumnWidth = colsStyle.columnWidth;
		out.computedColumnCount = colsStyle.columnCount;
		out.columnWidthIsPageWidth = Math.abs(parseFloat(colsStyle.columnWidth) - pageW) <= 0.5;

		// 探针 2（stream-d 建议）：相邻列左缘间距必须等于 pageW+gutter（不是均分宽度）
		const colsLeft0 = cols.getBoundingClientRect().left;
		const lefts = Array.from(new Set(Array.from(cols.children)
			.filter((el) => el.getBoundingClientRect().height > 0)
			.map((el) => Math.round((el.getBoundingClientRect().left - colsLeft0) * 100) / 100)))
			.sort((a, b) => a - b);
		let minGap = Infinity;
		for (let i = 1; i < lefts.length; i++) {
			const d = lefts[i] - lefts[i - 1];
			if (d > 1) minGap = Math.min(minGap, d);
		}
		out.observedAdjacentStep = Number.isFinite(minGap) ? Math.round(minGap * 100) / 100 : null;
		out.observedStepMatchesStride = out.observedAdjacentStep === null || Math.abs(out.observedAdjacentStep - out.stride) <= 0.5;

		// 真实多栏栅格：容器宽 + 实际列数 → 实际步长必须精确等于 pageW+gutter
		const colsW = parseFloat(doc.documentElement.style.getPropertyValue("--nyar-cols-width")) || cols.getBoundingClientRect().width;
		const columnCountStyle = parseInt(colsStyle.columnCount, 10) || 20000;
		const n = Math.min(columnCountStyle, Math.floor((colsW + gutter) / out.stride));
		out.colsWidth = Math.round(colsW);
		out.effectiveColumns = n;
		out.effectiveStride = n > 0 ? Math.round(((colsW + gutter) / n) * 1000) / 1000 : 0;
		out.strideDriftPx = Math.round((out.effectiveStride - out.stride) * 1000) / 1000;
		// 可见页裁切检查：只针对「当前可见那一页」里的正文块
		// （其它列的块本来就排在书窗之外，不属于裁切）
		const colsLeft = cols.getBoundingClientRect().left;
		const visibleIndex = Math.max(0, Math.round(Math.abs(parseFloat((/translateX\((-?[\d.]+)px\)/.exec(cols.style.transform || "") || [0, "0"])[1])) / out.stride));
		const visibleBlocks = Array.from(cols.children).filter((el) => {
			if (el.getBoundingClientRect().height <= 0) return false;
			const k = Math.round((el.getBoundingClientRect().left - colsLeft) / out.stride);
			return k === visibleIndex;
		});
		const lastVisible = visibleBlocks[visibleBlocks.length - 1];
		if (bookEl && lastVisible) {
			const br = bookEl.getBoundingClientRect();
			const lr = lastVisible.getBoundingClientRect();
			out.visibleBlocks = visibleBlocks.length;
			out.lastVisibleRight = Math.round((lr.right - br.left) * 100) / 100;
			out.bookInnerRight = Math.round((br.width - 1) * 100) / 100;
			out.lastBlockOverflowRight = Math.round(Math.max(0, lr.right - br.right) * 100) / 100;
		} else {
			out.visibleBlocks = 0;
			out.lastBlockOverflowRight = 0;
		}
	}
	if (scenario.scrollMode !== true && cols) {
		// 单页/双页翻页位移
		const tx = () => { const m = /translateX\\((-?[\\d.]+)px\\)/.exec(cols.style.transform || "translateX(0px)"); return m ? parseFloat(m[1]) : 0; };
		const pageNo = () => { const m = /translateX\\((-?[\\d.]+)px\\)/.exec(cols.style.transform || "translateX(0px)"); const off = m ? Math.abs(parseFloat(m[1])) : 0; return Math.round(off / out.stride) + 1; };
		const before = tx();
		const pageBefore1 = pageNo();
		await engine.nextPage();
		const after1 = tx();
		const pageAfter1 = pageNo();
		await engine.nextPage();
		const after2 = tx();
		const pageAfter2 = pageNo();
		out.pageDelta1 = pageAfter1 - pageBefore1;
		out.pageDelta2 = pageAfter2 - pageAfter1;
		// 位移步长应与「翻过的页数 × 步长」一致（单页 1 步、双页 2 步）
		out.stepMatchesStride = Math.abs(Math.abs(after1 - before) - out.pageDelta1 * out.stride) <= 1.5 &&
			Math.abs(Math.abs(after2 - after1) - out.pageDelta2 * out.stride) <= 1.5 &&
			out.pageDelta1 >= 1 && out.pageDelta2 >= 1;
		out.leftPageAlwaysOdd = pageBefore1 % 2 === 1 && pageAfter1 % 2 === 1 && pageAfter2 % 2 === 1;
		out.currentLocation = engine.currentLocation();
		// 末页可达
		await engine.goTo("10000");
		out.afterEndLocation = engine.currentLocation();
		out.endReachable = parseInt(out.afterEndLocation, 10) >= 9000;
		// 补章不漂移：记录真实页码后再追加
		const pageAtEnd = pageNo();
		const totalBefore = engine.getTotalPages();
		const extra = new Array(300).fill("<p>追加章节内容，用于验证补章不改变当前页码。</p>").join("");
		engine.notifyContentAppended(extra);
		await new Promise((r) => setTimeout(r, 120));
		out.totalAfterAppend = engine.getTotalPages();
		out.pageAtEndBefore = pageAtEnd;
		out.pageAtEndAfter = pageNo();
		out.pageKeptAfterAppend = out.pageAtEndAfter === out.pageAtEndBefore;
		out.totalGrew = out.totalAfterAppend > totalBefore;
		out.locationAfterAppend = engine.currentLocation();
		out.locationBeforeAppend = out.afterEndLocation;
	}
	// 图片
	const imgs = Array.from(doc.querySelectorAll("img"));
	out.imgCount = imgs.length;
	out.lazyHasBlobSrc = imgs.some((i) => (i.getAttribute("src") || "").startsWith("blob:"));
	out.lazyMissingPlaceholder = imgs.some((i) => i.classList.contains("nyareader-img-missing"));
	out.imgOverflow = imgs.filter((i) => {
		const r = i.getBoundingClientRect();
		return r.width > pageW + 2 || (pageW > 0 && r.height > 0 && r.height > parseFloat(doc.documentElement.style.getPropertyValue("--nyar-page-h")) + 64);
	}).length;
	out.noHorizontalOverflow = doc.documentElement.scrollWidth <= doc.documentElement.clientWidth + 1;
	const big = doc.getElementById("big");
	out.bigImgNaturalWidth = big ? big.naturalWidth : null;
	engine.destroy();
	return out;
};
<\/script></body></html>`;
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

/** 在页面内一次跑完所有场景（单次连接，避免跨连接读到不同 document 状态）。 */
function allScenariosExpression(scenarios) {
	return `(async () => {
		const deadline = Date.now() + 10000;
		while (typeof window.__run !== "function" && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 100));
		}
		if (typeof window.__run !== "function") {
			return JSON.stringify({ fatal: "windows.__run 未定义", loaded: window.__loaded, errors: window.__errors });
		}
		const out = [];
		const list = ${JSON.stringify(scenarios)};
		for (const s of list) out.push(await window.__run(s));
		return JSON.stringify({ results: out });
	})()`;
}

async function main() {
	if (!existsSync(EDGE)) throw new Error("未找到 Edge");
	await bundleEngine();
	const html = syntheticHtml();
	const bundleName = "engine-bundle.js";
	const page = harnessHtml(bundleName).replace(JSON.stringify("__INJECT__"), JSON.stringify(html));
	const dir = mkdtempSync(join(tmpdir(), "nyar-real-"));
	const file = join(dir, "harness.html");
	writeFileSync(file, page, "utf8");
	writeFileSync(join(dir, bundleName), readFileSync(BUNDLE, "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-real-profile-"));
	const url = `file:///${file.replace(/\\/g, "/")}`;

	const child = spawn(
		EDGE,
		["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1200,800", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, url],
		{ stdio: "ignore" }
	);

	const scenarios = [
		{ name: "single-page", layout: "single" },
		{ name: "double-page", layout: "double" },
		{ name: "single-with-resolver", layout: "single", withResolver: true },
		{ name: "scroll-mode", layout: "single", scrollMode: true },
		// 独立验证在 2200px 抓到的「列距累积漂移 / 末页被裁」回归位：必须覆盖两个非整除宽度
		{ name: "wide-2200-single", layout: "single", containerWidth: 2200 },
		{ name: "narrow-360-single", layout: "single", containerWidth: 360 },
		{ name: "wide-2200-double", layout: "double", containerWidth: 2200 },
	];
	try {
		let payload = null;
		for (let i = 0; i < 40 && !payload; i++) {
			try {
				await new Promise((r) => setTimeout(r, 300));
				const raw = await cdpEval(url, allScenariosExpression(scenarios));
				const parsed = JSON.parse(raw);
				if (parsed.fatal) throw new Error(`页面内 fatal：${JSON.stringify(parsed)}`);
				payload = parsed.results;
			} catch (e) {
				if (i === 39) throw e;
			}
		}
		if (!payload) throw new Error("harness 未就绪");
		const results = payload;
		const checks = [];
		for (const r of results) {
			if (r.scenario !== "scroll-mode") {
				checks.push([`${r.scenario}: pages>1`, r.pages > 1]);
				checks.push([`${r.scenario}: 翻页位移==翻过页数×步长`, r.stepMatchesStride === true]);
				// 单页模式页码本就单双交替，「左页恒为奇数」只适用于双页对开
				if (r.doubleActive) checks.push([`${r.scenario}: 双页左页恒为奇数`, r.leftPageAlwaysOdd === true]);
				checks.push([`${r.scenario}: 末页可达`, r.endReachable === true]);
				checks.push([`${r.scenario}: 补章后页码保持`, r.pageKeptAfterAppend === true && r.totalGrew === true]);
			}
			checks.push([`${r.scenario}: 无横向溢出`, r.noHorizontalOverflow === true]);
			checks.push([`${r.scenario}: 图片不超页宽`, r.imgOverflow === 0]);
			if (r.scenario !== "scroll-mode") {
				checks.push([`${r.scenario}: computed column-width==页宽(非 auto)`, r.columnWidthIsPageWidth === true]);
				checks.push([`${r.scenario}: 相邻列左缘间距==页宽+槽宽`, r.observedStepMatchesStride === true]);
				checks.push([`${r.scenario}: 实际列距==页宽+槽宽(漂移=0)`, Math.abs(r.strideDriftPx) <= 0.05]);
				checks.push([`${r.scenario}: 可见页正文不被裁切`, (r.lastBlockOverflowRight ?? 0) <= 1 && (r.visibleBlocks ?? 0) > 0]);
			}
		}
		const withResolver = results.find((r) => r.scenario === "single-with-resolver");
		checks.push(["resolveAsset 回填 blob URL", withResolver.lazyHasBlobSrc === true]);
		const single = results.find((r) => r.scenario === "single-page");
		checks.push(["未注入 resolver 时显示可见占位", single.lazyMissingPlaceholder === true]);
		const dbl = results.find((r) => r.scenario === "double-page");
		checks.push(["双页对开生效", dbl.doubleActive === true]);

		const report = { results, checks: checks.map(([n, ok]) => ({ name: n, pass: !!ok })), pass: checks.every(([, ok]) => !!ok) };
		// 结果同时写文件（便于解析）：通道与 PowerShell 的 stderr 混流会污染 stdout
		const outFile = process.env.NYAR_REPORT || join(tmpdir(), "nyar-real-engine-report.json");
		writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
		console.log(`report: ${outFile}`);
		console.log(JSON.stringify({ pass: report.pass, failed: report.checks.filter((c) => !c.pass).map((c) => c.name) }, null, 2));
		process.exitCode = report.pass ? 0 : 1;
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("real-engine-check failed:", e.message);
	process.exitCode = 2;
});
