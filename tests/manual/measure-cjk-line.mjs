/**
 * 直接量「真实每行字符数」：把一段固定中文放进指定宽度的容器，
 * 用 client rects 数出实际行数，反推真实每行字符数，并与两种估算口径对比。
 *
 * 用法：node tests/manual/measure-cjk-line.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9600 + Math.floor(Math.random() * 200);

function page() {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script>
window.__probe = function (fontSize, width, charCount) {
	const host = document.createElement("div");
	host.style.cssText = "position:absolute;left:0;top:0;width:" + width + "px;font-family:system-ui;font-size:" + fontSize + "px;line-height:1.8;text-indent:0";
	document.body.appendChild(host);
	const p = document.createElement("p");
	p.style.cssText = "margin:0;padding:0;word-break:break-word";
	p.textContent = "汉".repeat(charCount);
	host.appendChild(p);

	// 真实行数：用 Range 逐字符量 client rects 的 top 去重
	const range = document.createRange();
	range.selectNodeContents(p);
	const rects = Array.from(range.getClientRects());
	const lineTops = Array.from(new Set(rects.map((r) => Math.round(r.top))));
	const lines = lineTops.length;

	// canvas 实测
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");
	ctx.font = fontSize + "px system-ui";
	const w1 = ctx.measureText("汉").width;
	const sample = "中文正文测试样本文字内容abc123，。！";
	const wSample = ctx.measureText(sample).width / sample.length;

	const result = {
		fontSize, width, charCount,
		realLines: lines,
		realCharsPerLine: Math.ceil(charCount / Math.max(1, lines)),
		realLineHeight: lines > 1 ? Math.round((rects[rects.length - 1].top - rects[0].top) / (lines - 1) * 100) / 100 : null,
		canvasHanWidth: Math.round(w1 * 1000) / 1000,
		canvasSamplePerChar: Math.round(wSample * 1000) / 1000,
		ratioFromHan: Math.round((w1 / fontSize) * 1000) / 1000,
		ratioFromSample: Math.round((wSample / fontSize) * 1000) / 1000,
		estNewCharsPerLine: Math.floor(width / (fontSize * (wSample / fontSize))),
		estOldCharsPerLine: Math.floor(width / (fontSize * 0.62)),
		hostWidth: host.clientWidth,
	};
	document.body.removeChild(host);
	return result;
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
	const dir = mkdtempSync(join(tmpdir(), "nyar-cjk-"));
	const f = join(dir, "p.html");
	writeFileSync(f, page(), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-cjk-prof-"));
	const url = `file:///${f.replace(/\\/g, "/")}`;
	const child = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1200,800", "--no-first-run", "--disable-extensions", `--user-data-dir=${profile}`, url], { stdio: "ignore" });
	try {
		let up = false;
		for (let i = 0; i < 60 && !up; i++) {
			await new Promise((r) => setTimeout(r, 250));
			try { up = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch { /* wait */ }
		}
		if (!up) throw new Error("CDP 未就绪");
		const expr = `(async () => {
			const dl = Date.now() + 8000;
			while (typeof window.__probe !== "function" && Date.now() < dl) await new Promise(r => setTimeout(r, 100));
			if (typeof window.__probe !== "function") return JSON.stringify({ fatal: "未就绪" });
			return JSON.stringify([
				window.__probe(18, 640, 500),
				window.__probe(18, 900, 500),
				window.__probe(16, 360, 500),
				window.__probe(20, 900, 500)
			]);
		})()`;
		const rows = JSON.parse(await cdp(url, expr));
		console.log("font  width  realLines 真实字/行  估算(新)  估算(旧0.62)  canvas汉宽  ratioFromHan  ratioFromSample");
		for (const r of rows) {
			console.log(String(r.fontSize).padEnd(5), String(r.width).padEnd(6), String(r.realLines).padEnd(9), String(r.realCharsPerLine).padEnd(10), String(r.estNewCharsPerLine).padEnd(9), String(r.estOldCharsPerLine).padEnd(13), String(r.canvasHanWidth).padEnd(10), String(r.ratioFromHan).padEnd(12), r.ratioFromSample);
		}
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("measure failed:", e.message);
	process.exitCode = 2;
});
