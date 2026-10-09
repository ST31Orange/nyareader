/**
 * 底部进度条（transport）契约测试。
 *
 * 覆盖三件事：
 * 1. 拖动/点击的像素→进度换算（边界夹取、零宽轨道不产生 NaN）；
 * 2. 键盘步进（2% / Shift 10% / Home·End），并保证越界被夹住；
 * 3. 页码文字在大文件懒加载期间**不把"已加载页数"当总页数**（用户实测反馈的"6k 页变 2k 页"）。
 * 另含 product CSS 契约：脚注存在、进度条可点可拖（touch-action:none、cursor:pointer）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatPageIndicator, formatSeekPercent, ratioFromClientX, stepSeekPercent } from "../src/utils/transport";

describe("ratioFromClientX：像素 → 进度", () => {
	it("左缘=0、右缘=1、中点=0.5", () => {
		expect(ratioFromClientX(100, 100, 200)).toBe(0);
		expect(ratioFromClientX(200, 100, 200)).toBe(0.5);
		expect(ratioFromClientX(300, 100, 200)).toBe(1);
	});

	it("越界被夹到 [0,1]（拖出轨道外不产生负值/超过 1）", () => {
		expect(ratioFromClientX(-500, 100, 200)).toBe(0);
		expect(ratioFromClientX(99999, 100, 200)).toBe(1);
	});

	it("轨道宽度为 0 或非有限值 → 返回 null（调用方忽略本次手势，不跳转）", () => {
		expect(ratioFromClientX(100, 0, 0)).toBeNull();
		expect(ratioFromClientX(100, 0, -10)).toBeNull();
		expect(ratioFromClientX(Number.NaN, 0, 100)).toBeNull();
		expect(ratioFromClientX(100, Number.NaN, 100)).toBeNull();
		expect(ratioFromClientX(100, 0, Number.NaN)).toBeNull();
	});
});

describe("stepSeekPercent：键盘步进", () => {
	it("方向键默认 2%", () => {
		expect(stepSeekPercent(0.5, "ArrowRight")).toBeCloseTo(0.52, 9);
		expect(stepSeekPercent(0.5, "ArrowLeft")).toBeCloseTo(0.48, 9);
		expect(stepSeekPercent(0.5, "ArrowUp")).toBeCloseTo(0.52, 9);
		expect(stepSeekPercent(0.5, "ArrowDown")).toBeCloseTo(0.48, 9);
	});

	it("Shift 加速到 10%", () => {
		expect(stepSeekPercent(0.5, "ArrowRight", true)).toBeCloseTo(0.6, 9);
	});

	it("Home/End 到首末，PageUp/PageDown 每次 10%", () => {
		expect(stepSeekPercent(0.5, "Home")).toBe(0);
		expect(stepSeekPercent(0.5, "End")).toBe(1);
		expect(stepSeekPercent(0.5, "PageDown")).toBeCloseTo(0.6, 9);
		expect(stepSeekPercent(0.5, "PageUp")).toBeCloseTo(0.4, 9);
	});

	it("越界夹取：在 0 处按左仍在 0，在 1 处按右仍在 1", () => {
		expect(stepSeekPercent(0, "ArrowLeft")).toBe(0);
		expect(stepSeekPercent(1, "ArrowRight")).toBe(1);
	});

	it("无关按键返回 null（调用方不 preventDefault）", () => {
		expect(stepSeekPercent(0.5, "a")).toBeNull();
		expect(stepSeekPercent(0.5, "Enter")).toBeNull();
		expect(stepSeekPercent(Number.NaN, "ArrowRight")).toBeNull();
	});
});

describe("formatSeekPercent", () => {
	it("整数百分比不留小数，非整数保留 1 位", () => {
		expect(formatSeekPercent(0)).toBe("0%");
		expect(formatSeekPercent(0.5)).toBe("50%");
		expect(formatSeekPercent(1)).toBe("100%");
		expect(formatSeekPercent(0.1234)).toBe("12.3%");
	});

	it("非法输入退化为 0%，不产生 NaN%", () => {
		expect(formatSeekPercent(Number.NaN)).toBe("0%");
		expect(formatSeekPercent(-5)).toBe("0%");
		expect(formatSeekPercent(9)).toBe("100%");
	});
});

describe("formatPageIndicator（回归：大文件懒加载不得把已加载页数当总页数）", () => {
	it("全部排完时显示 当前/总页数", () => {
		expect(formatPageIndicator(12, 6000, true)).toBe("12 / 6000 页");
	});

	it("懒加载未排完时总页数显示为 —，而不是已加载部分的页数", () => {
		// 用户实测场景：6k 页的书在加载到 2k 页时不能显示 "12 / 2000 页"
		expect(formatPageIndicator(12, 2000, false)).toBe("12 / — 页");
		expect(formatPageIndicator(12, 2000, false)).not.toContain("2000");
	});

	it("总页数未知（<=0）时只显示当前页", () => {
		expect(formatPageIndicator(7, 0, true)).toBe("7 页");
		expect(formatPageIndicator(7, -1, false)).toBe("7 页");
	});

	it("页码非法时显示占位，不抛异常", () => {
		expect(formatPageIndicator(Number.NaN, 100, true)).toBe("— / —");
	});
});

describe("product CSS 契约（styles.css）", () => {
	const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

	it("存在底部进度条样式，且进度条可点可拖", () => {
		expect(css).toContain(".nyareader-transport");
		expect(css).toContain(".nyareader-seek");
		expect(css).toContain(".nyareader-seek-fill");
		expect(css).toContain(".nyareader-seek-thumb");
		// 拖动需要 touch-action:none（否则触屏会被浏览器手势抢走）
		expect(css).toMatch(/\.nyareader-seek\s*\{[^}]*touch-action:\s*none/);
	});

	it("底部条位于内容区之外（flex 列布局的固定高度条），不占正文宽度", () => {
		expect(css).toMatch(/\.nyareader-transport\s*\{[^}]*flex:\s*0 0 auto/);
	});
});
