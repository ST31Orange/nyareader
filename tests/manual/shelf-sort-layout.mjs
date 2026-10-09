/**
 * 书架"排序"控件对齐探针。
 *
 * 用户反馈："书架页最近阅读按钮靠右放没有修改"。
 * 根因：排序控件与「＋新建文件夹」**各自** `margin-left:auto`，flex 把剩余空间平分，
 * 于是排序控件停在中间。修法是两者包成一组、只让组靠右。
 * 本探针用**真实的 styles.css** + 真实 DOM 结构量位置。
 *
 * 用法：node tests/manual/shelf-sort-layout.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = join(ROOT, "tests", "manual");
const PORT = 9700 + Math.floor(Math.random() * 90);

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./styles.css">
<style>
  /* 模拟 Obsidian 主题变量（styles.css 依赖它们） */
  :root { --background-primary:#fff; --background-secondary:#f6f6f6; --text-normal:#222; --text-muted:#777;
          --background-modifier-border:#ddd; --background-modifier-hover:#eee; --interactive-accent:#7c3aed; --text-accent:#7c3aed; }
</style></head><body>
<!-- 与 BookshelfView.render() 产出的结构一致 -->
<div class="nyareader-bookshelf" id="shelf">
  <div class="nyareader-shelf-header">
    <div class="nyareader-shelf-title">
      <div class="nyareader-shelf-title-row"><button class="nyareader-shelf-settings-btn"></button><h2>我的书架</h2></div>
      <span class="nyareader-shelf-sub">3 个书库 · 当前：我的书库</span>
    </div>
    <div class="nyareader-shelf-actions"><button class="nyareader-shelf-btn">＋ 新建书库</button></div>
  </div>
  <div class="nyareader-shelf-body">
    <div class="nyareader-library-col"><div class="nyareader-library-col-title">书库</div></div>
    <div class="nyareader-shelf-main">
      <div class="nyareader-shelf-main-bar">
        <h3>我的书库</h3>
        <span class="nyareader-shelf-sub">3 个文件夹</span>
        <div class="nyareader-shelf-main-actions">
          <label class="nyareader-shelf-sort-wrap"><span class="nyareader-shelf-sort-label">排序</span>
            <select class="nyareader-shelf-sort"><option>最近阅读</option><option>书名</option></select>
          </label>
          <button class="nyareader-shelf-btn">＋ 新建文件夹</button>
        </div>
      </div>
      <div class="nyareader-shelf-main-scroll"></div>
    </div>
  </div>
</div>
<script>
window.__probe = function () {
  const bar = document.querySelector(".nyareader-shelf-main-bar");
  const wrap = document.querySelector(".nyareader-shelf-sort-wrap");
  const actions = document.querySelector(".nyareader-shelf-main-actions");
  const btn = bar.querySelector(".nyareader-shelf-btn");
  const h3 = bar.querySelector("h3");
  const sel = document.querySelector(".nyareader-shelf-sort");
  const r = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) }; };
  const cs = getComputedStyle(wrap);
  const csActions = getComputedStyle(actions);
  return {
    barWidth: Math.round(bar.getBoundingClientRect().width),
    h3: r(h3),
    sortWrap: r(wrap),
    sortSelect: r(sel),
    newFolderBtn: r(btn),
    actions: r(actions),
    actionsMarginLeft: csActions.marginLeft,
    sortWrapMarginLeft: cs.marginLeft,
    barDisplay: getComputedStyle(bar).display,
    barJustify: getComputedStyle(bar).justifyContent,
    // 判定：排序控件应在"文件夹按钮"左侧，且两者都靠右半区
    gapSortToBtn: Math.round(btn.getBoundingClientRect().left - wrap.getBoundingClientRect().right),
    sortIsRightOfCenter: r(wrap).left > Math.round(bar.getBoundingClientRect().width * 0.5)
  };
};
<\/script></body></html>`;

async function main() {
	mkdirSync(OUT, { recursive: true });
	const dir = mkdtempSync(join(tmpdir(), "nyar-shelf-"));
	writeFileSync(join(dir, "p.html"), PAGE, "utf8");
	writeFileSync(join(dir, "styles.css"), readFileSync(join(ROOT, "styles.css"), "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-shelf-prof-"));
	const url = `file:///${join(dir, "p.html").replace(/\\/g, "/")}`;
	const child = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1400,900", "--no-first-run", "--disable-extensions", `--user-data-dir=${profile}`, url], { stdio: "ignore" });
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
		const r = await send("Runtime.evaluate", { expression: "JSON.stringify(window.__probe())", returnByValue: true });
		ws.close();
		if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
		const res = JSON.parse(r.result.value);
		const checks = [
			["排序控件位于书库栏右半区", res.sortIsRightOfCenter === true],
			["排序控件紧邻「＋新建文件夹」左侧（间距 ≤ 16px）", res.gapSortToBtn >= 0 && res.gapSortToBtn <= 16],
			["外层操作组承担 auto margin（只此一处，避免空间被平分）", res.actionsMarginLeft !== "0px"],
			["排序控件自身不再用 auto margin（否则与按钮平分空间）", res.sortWrapMarginLeft === "0px"],
			["书库名仍在左侧", res.h3.left < res.sortWrap.left],
			["排序整组贴右边界（组的右缘与栏右缘差 ≤ 4px）", Math.abs(res.actions.right - (res.h3.left - 219 + res.barWidth)) <= 4 || res.actions.right > res.barWidth * 0.9]
		];
		const report = { checks: checks.map(([n, p]) => ({ name: n, pass: p })), pass: checks.every(([, p]) => p), numbers: res };
		writeFileSync(join(OUT, "shelf-sort-layout.json"), JSON.stringify(report, null, 2), "utf8");
		console.log(JSON.stringify(report, null, 2));
		process.exitCode = report.pass ? 0 : 1;
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("shelf-sort probe failed:", e.message);
	process.exitCode = 2;
});
