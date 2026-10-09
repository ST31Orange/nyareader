/**
 * 宿主层排版契约（styles.css）回归测试。
 *
 * 对应 task-3：
 * - .nyareader-reading 用 CSS 变量控制内边距（默认 8px/6px，窄窗 <720px 收紧），不再叠加固定 padding；
 * - iframe 铺满阅读区（宽度不受宿主限制：分页引擎要靠真实宽度决定能否双页对开）；
 * - 阅读区 overflow:hidden / min-height:0（宿主层不产生横向滚动条、不裁切图片），
 *   但 PDF（宿主容器滚动）与 TXT（引擎自建滚动容器）的既有滚动语义必须保留；
 * - 加载遮罩可交互（打开期间吞掉阅读区点击）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** 取某个选择器第一次出现的声明块（足够用于单层规则断言）。 */
function block(selector: string): string {
	const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "s");
	return re.exec(css)?.[1] ?? "";
}

describe("阅读区宿主层排版（styles.css）", () => {
	const reading = block(".nyareader-reading");

	it("内边距由 CSS 变量控制，默认收紧到 8px/6px", () => {
		expect(reading).toContain("--nyar-reading-pad-x: 8px");
		expect(reading).toContain("--nyar-reading-pad-y: 6px");
		expect(reading).toContain("padding: var(--nyar-reading-pad-y) var(--nyar-reading-pad-x)");
		// 旧的固定 20px 28px 必须消失（与引擎留白叠加导致左右 ~66px）
		expect(reading).not.toContain("20px 28px");
	});

	it("窄窗口（<720px）进一步收紧内边距", () => {
		expect(css).toMatch(/@media \(max-width: 719px\)[\s\S]*?--nyar-reading-pad-x: 4px/);
		// 侧栏分屏把 pane 拉窄、窗口未必窄，因此同时用容器查询
		expect(css).toMatch(/@container \(max-width: 719px\)[\s\S]*?--nyar-reading-pad-x: 4px/);
	});

	it("阅读区不滚动、可收缩，宿主层无横向溢出", () => {
		expect(reading).toContain("overflow: hidden");
		expect(reading).toContain("min-height: 0");
		expect(reading).toContain("min-width: 0");
		expect(reading).toContain("position: relative"); // 加载遮罩 / PDF 覆盖层定位基准
	});

	it("行宽上限变量保留在宿主层备用（不作用于 iframe）", () => {
		expect(reading).toContain("--nyar-measure: min(74ch, 720px)");
	});

	it("iframe 铺满阅读区，宽度不受宿主限制（否则宽窗也无法双页对开）", () => {
		const iframe = block(".nyareader-html-iframe");
		expect(iframe).toContain("display: block");
		expect(iframe).toContain("width: 100%");
		expect(iframe).toContain("height: 100%");
		expect(iframe).toContain("min-height: 0");
		expect(iframe).toContain("border: 0");
		// 回归：曾用 max-width: var(--nyar-measure) 限制 iframe，
		// 导致 2200px 窗口下可用宽 629px < MIN_SPREAD_WIDTH(640) → 双页永远退回单页
		expect(iframe).not.toContain("max-width");
		expect(iframe).not.toContain("margin-inline");
	});

	it("PDF / TXT 的滚动语义不被 overflow:hidden 破坏", () => {
		expect(block(".nyareader-reading.nyareader-pdf-root")).toContain("overflow: auto");
		expect(block(".nyareader-reading:has(> .nyareader-txt-scroll)")).toContain("overflow: hidden");
	});

	it("加载遮罩可显示阶段/百分比且拦截误点击", () => {
		const loading = block(".nyareader-engine-loading");
		expect(loading).toContain("position: absolute");
		expect(loading).toContain("pointer-events: auto");
		expect(block(".nyareader-engine-loading-text")).toContain("max-width");
		expect(block(".nyareader-control-disabled")).toContain("pointer-events: none");
	});
});
