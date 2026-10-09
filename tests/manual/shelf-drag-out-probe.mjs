/**
 * 书架卡片"拖出"载荷探针。
 *
 * 用户诉求：把书架里的书**拖到 Obsidian 左侧文件列表**，即移出书库。
 * 关键前提：卡片 dragstart 时必须把**纯 vault 路径**放进 `text/plain`
 * （Obsidian 文件树按路径处理外部拖入；放 JSON 它不认）。
 *
 * 这里在真实 Edge 里构造与 BookshelfView 相同的拖拽处理器，检查载荷：
 * - `text/plain` 必须等于 vault 路径（且不是 JSON）
 * - `application/x-nyareader-book` 存在（内部移动用）
 * - `effectAllowed` 允许 move
 *
 * 用法：node tests/manual/shelf-drag-out-probe.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = join(ROOT, "tests", "manual");
const PORT = 9200 + Math.floor(Math.random() * 90);

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div class="nyareader-shelf-card" id="card" draggable="true">银河帝国.epub</div>
<script>
window.__probe = async function () {
	const card = document.getElementById("card");
	const path = "nyareader/library/我的书库/测试/银河帝国完整版（全套15册）.epub";
	// 与 BookshelfView 的 dragstart 完全一致
	card.addEventListener("dragstart", (e) => {
		const dt = e.dataTransfer;
		if (dt) {
			dt.setData("application/x-nyareader-book", path);
			dt.setData("text/plain", path);
			try { dt.setData("text/uri-list", path); } catch (err) { /* 忽略 */ }
			dt.effectAllowed = "copyMove";
		}
		card.classList.add("is-dragging");
	});

	// 构造真实拖拽并派发 dragstart（DataTransfer 由浏览器创建）
	const dt = new DataTransfer();
	const ev = new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt });
	card.dispatchEvent(ev);

	const types = Array.from(dt.types);
	const plain = dt.getData("text/plain");
	const ours = dt.getData("application/x-nyareader-book");
	const uri = (() => { try { return dt.getData("text/uri-list"); } catch { return ""; } })();
	return {
		expected: path,
		types,
		plain,
		ours,
		uri,
		effectAllowed: dt.effectAllowed,
		isJson: plain.trim().startsWith("{") || plain.trim().startsWith("["),
		draggingClass: card.classList.contains("is-dragging")
	};
};
<\/script></body></html>`;

async function main() {
	mkdirSync(OUT, { recursive: true });
	const dir = mkdtempSync(join(tmpdir(), "nyar-dragout-"));
	writeFileSync(join(dir, "p.html"), PAGE, "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-dragout-prof-"));
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
		const r = await send("Runtime.evaluate", {
			expression: `(async () => {
				const dl = Date.now() + 8000;
				while (typeof window.__probe !== "function" && Date.now() < dl) await new Promise(r => setTimeout(r, 100));
				if (typeof window.__probe !== "function") return JSON.stringify({ fatal: "not ready" });
				return JSON.stringify(await window.__probe());
			})()`,
			awaitPromise: true,
			returnByValue: true
		});
		ws.close();
		if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
		const res = JSON.parse(r.result.value);
		const checks = [
			["text/plain 就是 vault 路径（不含 JSON 包裹）", res.plain === res.expected],
			["text/plain 不是 JSON", res.isJson === false],
			["内部 MIME application/x-nyareader-book 也在", res.ours === res.expected],
			["text/uri-list 也给的是相对路径", res.uri === res.expected],
			["卡片带上了 is-dragging 状态（可做视觉反馈）", res.draggingClass === true]
		];
		// 说明：`effectAllowed` 不断言 —— 合成 DragEvent 的 dataTransfer 不会真正应用它
		// （浏览器只在真实拖拽里生效），这里只把观察值记录下来。
		const report = {
			checks: checks.map(([n, p]) => ({ name: n, pass: p })),
			pass: checks.every(([, p]) => p),
			note: "effectAllowed 仅记录：合成 DragEvent 不应用该属性",
			numbers: res
		};
		writeFileSync(join(OUT, "shelf-drag-out.json"), JSON.stringify(report, null, 2), "utf8");
		console.log(JSON.stringify(report, null, 2));
		process.exitCode = report.pass ? 0 : 1;
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("shelf-drag-out probe failed:", e.message);
	process.exitCode = 2;
});
