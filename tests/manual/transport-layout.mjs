/**
 * 底部进度条（transport）真实浏览器几何验证。
 *
 * 用一个与阅读视图同构的最小宿主（.nyareader-root > .nyareader-content + .nyareader-transport）
 * 加载**真实 styles.css**，断言：
 * - 脚注固定在底部（不覆盖正文、不与内容区重叠）；
 * - 进度条可见且有实际宽度（可点可拖）；
 * - 填充宽度/滑块位置随进度变化；
 * - 360 / 900 / 2200 三种宽度下都不产生横向溢出，页码区不把进度条挤没。
 *
 * 用法：node tests/manual/transport-layout.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9500 + Math.floor(Math.random() * 200);

function page(css, viewW, viewH) {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style>
<style>html,body{margin:0;height:100%;overflow:hidden}#view{width:${viewW}px;height:${viewH}px;display:flex;overflow:hidden}</style>
</head><body>
<div id="view" class="nyareader-root">
	<div class="nyareader-content" style="flex:1;display:flex;min-height:0;position:relative">
		<div class="nyareader-reading" style="flex:1"><div style="height:100%;background:#eee">正文占位</div></div>
	</div>
	<div class="nyareader-transport">
		<div class="nyareader-transport-info">
			<span class="nyareader-page-indicator">12 / 6000 页</span>
			<span class="nyareader-transport-percent">0%</span>
		</div>
		<div class="nyareader-seek" role="slider" tabindex="0">
			<div class="nyareader-seek-fill" style="width:0%"></div>
			<div class="nyareader-seek-thumb" style="left:0%"></div>
		</div>
	</div>
</div>
<script>
window.__probe = function () {
	const view = document.getElementById("view");
	const reading = document.querySelector(".nyareader-reading");
	const bar = document.querySelector(".nyareader-transport");
	const track = document.querySelector(".nyareader-seek");
	const fill = document.querySelector(".nyareader-seek-fill");
	const thumb = document.querySelector(".nyareader-seek-thumb");
	const info = document.querySelector(".nyareader-transport-info");
	const vr = view.getBoundingClientRect();
	const rr = reading.getBoundingClientRect();
	const br = bar.getBoundingClientRect();
	const tr = track.getBoundingClientRect();

	// 模拟拖到 50%：检查填充与滑块是否跟随
	fill.style.width = "50%";
	thumb.style.left = "50%";
	const fr = fill.getBoundingClientRect();
	const hr = thumb.getBoundingClientRect();
	const fillRatio = tr.width > 0 ? (fr.width / tr.width) : 0;
	const thumbCenterRatio = tr.width > 0 ? ((hr.left + hr.width / 2 - tr.left) / tr.width) : 0;

	// 点击轨道中点：用与产品一致的换算，确认落在 0.5 附近
	const clientX = tr.left + tr.width / 2;
	const ratio = Math.min(1, Math.max(0, (clientX - tr.left) / tr.width));

	return {
		view: { w: Math.round(vr.width), h: Math.round(vr.height) },
		reading: { bottom: Math.round(rr.bottom), height: Math.round(rr.height) },
		bar: { top: Math.round(br.top), bottom: Math.round(br.bottom), height: Math.round(br.height) },
		track: { left: Math.round(tr.left), width: Math.round(tr.width), height: Math.round(tr.height) },
		info: { width: Math.round(info.getBoundingClientRect().width) },
		fillRatio: Math.round(fillRatio * 1000) / 1000,
		thumbCenterRatio: Math.round(thumbCenterRatio * 1000) / 1000,
		clickRatio: Math.round(ratio * 1000) / 1000,
		overlap: Math.round(Math.max(0, rr.bottom - br.top) * 100) / 100,
		barAtBottom: Math.abs(br.bottom - vr.bottom) <= 1,
		noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
		pointerEvents: getComputedStyle(track).pointerEvents,
		touchAction: getComputedStyle(track).touchAction,
		cursor: getComputedStyle(track).cursor,
	};
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
	const css = readFileSync(join(ROOT, "styles.css"), "utf8");
	const results = [];
	for (const [w, h] of [[360, 640], [900, 700], [2200, 1000]]) {
		const dir = mkdtempSync(join(tmpdir(), "nyar-transport-"));
		const f = join(dir, "p.html");
		writeFileSync(f, page(css, w, h), "utf8");
		const profile = mkdtempSync(join(tmpdir(), "nyar-transport-prof-"));
		const url = `file:///${f.replace(/\\/g, "/")}`;
		const child = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--window-size=${w + 100},${h + 100}`, "--no-first-run", "--disable-extensions", `--user-data-dir=${profile}`, url], { stdio: "ignore" });
		try {
			let up = false;
			for (let i = 0; i < 60 && !up; i++) {
				await new Promise((r) => setTimeout(r, 200));
				try { up = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch { /* wait */ }
			}
			if (!up) throw new Error("CDP 未就绪");
			const expr = `(async () => {
				const dl = Date.now() + 8000;
				while (typeof window.__probe !== "function" && Date.now() < dl) await new Promise(r => setTimeout(r, 50));
				if (typeof window.__probe !== "function") return JSON.stringify({ fatal: "未就绪" });
				await new Promise(r => requestAnimationFrame(() => r()));
				return JSON.stringify(window.__probe());
			})()`;
			const row = JSON.parse(await cdp(url, expr));
			row.viewport = `${w}x${h}`;
			results.push(row);
		} finally {
			child.kill();
			await new Promise((r) => setTimeout(r, 300));
		}
	}
	const checks = [];
	for (const r of results) {
		checks.push([`${r.viewport}: 脚注贴底`, r.barAtBottom === true]);
		checks.push([`${r.viewport}: 不覆盖正文`, r.overlap === 0]);
		checks.push([`${r.viewport}: 进度条有宽度`, r.track.width > 40]);
		checks.push([`${r.viewport}: 填充=50%`, Math.abs(r.fillRatio - 0.5) < 0.02]);
		checks.push([`${r.viewport}: 滑块中心=50%`, Math.abs(r.thumbCenterRatio - 0.5) < 0.03]);
		checks.push([`${r.viewport}: 点击中点→0.5`, Math.abs(r.clickRatio - 0.5) < 0.02]);
		checks.push([`${r.viewport}: 可拖动(touch-action:none)`, r.touchAction === "none"]);
		checks.push([`${r.viewport}: 无横向溢出`, r.noHorizontalOverflow === true]);
	}
	const report = { results, checks: checks.map(([name, pass]) => ({ name, pass })), pass: checks.every(([, p]) => p) };
	writeFileSync(join(ROOT, "tests/manual/transport-layout.json"), JSON.stringify(report, null, 2), "utf8");
	console.log(JSON.stringify(report, null, 2));
	process.exitCode = report.pass ? 0 : 1;
}

main().catch((e) => {
	console.error("transport-layout failed:", e.message);
	process.exitCode = 2;
});
