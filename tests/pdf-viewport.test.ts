/** pdf-viewport 工具单测：连续滚动的可见范围、当前页、跳转与页面尺寸推导。 */
import { describe, it, expect } from "vitest";
import { findVisibleRange, lowerBound, pageIndexAtMidpoint, pageSizeFromViewport, scrollTopForPage } from "../src/utils/pdf-viewport";
import type { PageMetrics } from "../src/utils/pdf-viewport";
import type { ViewportLike } from "../src/utils/pdf-coords";

/** 模拟 pdf.js PageViewport 的坐标换算（pageW × pageH pt，缩放 scale）。 */
function stubViewport(pageW: number, pageH: number, scale = 1): ViewportLike {
	return {
		convertToPdfPoint(x: number, y: number): [number, number] {
			return [x / scale, pageH - y / scale];
		},
		convertToViewportPoint(x: number, y: number): [number, number] {
			return [x * scale, (pageH - y) * scale];
		},
	};
}

/** 3 页，各高 100，页间距 18（与引擎 PAGE_GAP 一致）。 */
const THREE: PageMetrics[] = [
	{ top: 0, height: 100 },
	{ top: 118, height: 100 },
	{ top: 236, height: 100 },
];

describe("lowerBound", () => {
	it("返回第一个 bottom >= y 的索引", () => {
		expect(lowerBound(THREE, 0)).toBe(0);
		expect(lowerBound(THREE, 100)).toBe(0); // 第 1 页 bottom 恰为 100
		expect(lowerBound(THREE, 101)).toBe(1);
		expect(lowerBound(THREE, 218)).toBe(1);
		expect(lowerBound(THREE, 100000)).toBe(2); // 超出末尾时回退到最后一页
	});
});

describe("findVisibleRange", () => {
	it("只返回与视口相交的页面（含上下 margin）", () => {
		expect(findVisibleRange(THREE, 0, 200, 0)).toEqual([0, 1]);
		expect(findVisibleRange(THREE, 150, 100, 0)).toEqual([1, 2]);
		expect(findVisibleRange(THREE, 0, 50, 200)).toEqual([0, 2]);
	});

	it("空列表返回 [0, -1]", () => {
		expect(findVisibleRange([], 0, 100, 0)).toEqual([0, -1]);
	});

	it("大文档只命中视口附近一小段（懒渲染关键约束）", () => {
		// 真实页面高度量级（fit-width 下约数百 px），远大于视口高度的页面不会整篇渲染
		const many: PageMetrics[] = Array.from({ length: 1000 }, (_, i) => ({ top: i * 768, height: 750 }));
		const [from, to] = findVisibleRange(many, 300_000, 800, 1400);
		expect(from).toBeGreaterThan(300);
		expect(to).toBeLessThan(420);
		expect(to - from + 1).toBeLessThanOrEqual(8);
		expect(to - from + 1).toBeLessThan(many.length / 50);
	});
});

describe("pageIndexAtMidpoint", () => {
	it("取视口中线所在页", () => {
		expect(pageIndexAtMidpoint(THREE, 0, 200)).toBe(0);
		expect(pageIndexAtMidpoint(THREE, 130, 100)).toBe(1);
	});

	it("滚过文档末尾时落在最后一页", () => {
		expect(pageIndexAtMidpoint(THREE, 300, 100)).toBe(2);
	});
});

describe("scrollTopForPage", () => {
	it("矮页面居中", () => {
		expect(scrollTopForPage({ top: 500, height: 100 }, 300)).toBe(400);
	});
	it("高页面顶对齐", () => {
		expect(scrollTopForPage({ top: 500, height: 300 }, 200)).toBe(500);
	});
	it("不会滚到负值", () => {
		expect(scrollTopForPage({ top: 10, height: 50 }, 300)).toBe(0);
	});
});

describe("pageSizeFromViewport", () => {
	it("按 PDF 用户空间返回页面尺寸（含缩放）", () => {
		const vp = stubViewport(612, 792, 1.5);
		const size = pageSizeFromViewport(vp, 612 * 1.5, 792 * 1.5);
		expect(size.width).toBeCloseTo(612);
		expect(size.height).toBeCloseTo(792);
	});

	it("回归：直接用右下角换算会得到 height=0，必须用两点差", () => {
		const vp = stubViewport(612, 792, 1.5);
		// 旧实现的错误结果（rotation=0 时右下角 -> (pageWidth, 0)）
		expect(vp.convertToPdfPoint(612 * 1.5, 792 * 1.5)).toEqual([612, 0]);
		// 正确结果
		expect(pageSizeFromViewport(vp, 612 * 1.5, 792 * 1.5)).toEqual({ width: 612, height: 792 });
	});
});
