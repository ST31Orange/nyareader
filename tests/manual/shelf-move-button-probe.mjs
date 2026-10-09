/**
 * 书架卡片「移出」按钮探针。
 *
 * 用户要求：卡片**左上角**的小「移出」按钮，**悬停出现**。
 * 验证（用真实 styles.css + 真实卡片结构）：
 * 1. 按钮在卡片左上角（left ≈ 6px、top ≈ 6px），且**不与右上角删除按钮重叠**；
 * 2. 默认 opacity = 0（不悬停时看不见），:hover 时为 1；
 * 3. 点按钮不会冒泡触发卡片的 click（否则会"点移出就打开书"）。
 *
 * 用法：node tests/manual/shelf-move-button-probe.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = join(ROOT, "tests", "manual");
const PORT = 9300 + Math.floor(Math.random() * 90);

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./styles.css">
<style>
  :root { --background-primary:#fff; --background-secondary:#f6f6f6; --text-normal:#222; --text-muted:#777;
          --background-modifier-border:#ddd; --background-modifier-hover:#eee; --interactive-accent:#7c3aed; --text-accent:#7c3aed; }
  .nyareader-bookshelf { width: 1100px; }
</style></head><body>
<div class="nyareader-bookshelf">
  <div class="nyareader-shelf-grid">
    <div class="nyareader-shelf-zone">
      <div class="nyareader-shelf-zone-header"></div>
      <div class="nyareader-shelf-cards">
        <div class="nyareader-shelf-card is-full" id="card" draggable="true" data-path="nyareader/library/我的书库/测试/银河帝国.epub">
          <button class="nyareader-shelf-card-move" id="moveBtn" title="移出书库…" aria-label="移出书库">
            <svg width="14" height="14" viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v10H3z"/></svg>
          </button>
          <button class="nyareader-shelf-card-del" id="delBtn">✕</button>
          <div class="nyareader-shelf-cover"><div class="nyareader-shelf-cover-placeholder"><svg width="24" height="24"></svg></div></div>
          <div class="nyareader-shelf-card-info">
            <div class="nyareader-shelf-card-title">银河帝国</div>
            <div class="nyareader-shelf-card-author">作者：阿西莫夫</div>
            <div class="nyareader-shelf-progress"><div class="nyareader-shelf-progress-bar" style="width:40%"></div></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
window.__probe = function () {
  const card = document.getElementById("card");
  const move = document.getElementById("moveBtn");
  const del = document.getElementById("delBtn");
  const rect = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };
  const cs = getComputedStyle(move);
  const cardRect = rect(card);
  const moveRect = rect(move);
  const delRect = rect(del);

  // 点击是否冒泡到卡片
  let cardClicks = 0;
  card.addEventListener("click", () => cardClicks++);
  // 与 BookshelfView.attachMoveOutButton 一致：按钮自己吞掉 click，不让它触发"打开书"
  move.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); });
  move.addEventListener("mousedown", (e) => e.stopPropagation());
  move.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  return {
    card: cardRect,
    move: moveRect,
    del: delRect,
    // 相对卡片左上角的偏移
    offsetFromCard: { left: moveRect.left - cardRect.left, top: moveRect.top - cardRect.top },
    opacityDefault: cs.opacity,
    position: cs.position,
    // 与删除按钮是否重叠（左上角 vs 右上角，应完全不重叠）
    overlapsDelete: !(moveRect.right <= delRect.left || delRect.right <= moveRect.left || moveRect.bottom <= delRect.top || delRect.bottom <= moveRect.top),
    isLeftOfCenter: moveRect.left < cardRect.left + (cardRect.right - cardRect.left) / 2,
    isTopHalf: moveRect.top < cardRect.top + (cardRect.bottom - cardRect.top) / 2,
    cardClicks: cardClicks
  };
};
<\/script></body></html>`;

async function main() {
	mkdirSync(OUT, { recursive: true });
	const dir = mkdtempSync(join(tmpdir(), "nyar-movebtn-"));
	writeFileSync(join(dir, "p.html"), PAGE, "utf8");
	writeFileSync(join(dir, "styles.css"), readFileSync(join(ROOT, "styles.css"), "utf8"), "utf8");
	const profile = mkdtempSync(join(tmpdir(), "nyar-movebtn-prof-"));
	const url = `file:///${join(dir, "p.html").replace(/\\/g, "/")}`;
	const child = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1200,900", "--no-first-run", "--disable-extensions", `--user-data-dir=${profile}`, url], { stdio: "ignore" });
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
		const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
		const checks = [
			["按钮定位为 absolute（相对卡片）", res.position === "absolute"],
			[`按钮在卡片**左上角**（偏移 ${res.offsetFromCard.left},${res.offsetFromCard.top}）`, near(res.offsetFromCard.left, 6) && near(res.offsetFromCard.top, 6)],
			["按钮确实在卡片左半区", res.isLeftOfCenter === true],
			["按钮确实在卡片上半区", res.isTopHalf === true],
			["默认 opacity=0（不悬停看不见）", res.opacityDefault === "0"],
			["**不与右上角删除按钮重叠**", res.overlapsDelete === false],
			["点按钮**不冒泡**到卡片（不会误触发打开书）", res.cardClicks === 0]
		];
		const report = { checks: checks.map(([n, p]) => ({ name: n, pass: p })), pass: checks.every(([, p]) => p), numbers: res };
		writeFileSync(join(OUT, "shelf-move-button.json"), JSON.stringify(report, null, 2), "utf8");
		console.log(JSON.stringify(report, null, 2));
		process.exitCode = report.pass ? 0 : 1;
	} finally {
		child.kill();
	}
}

main().catch((e) => {
	console.error("shelf-move-button probe failed:", e.message);
	process.exitCode = 2;
});
