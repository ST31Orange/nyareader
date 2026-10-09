/**
 * 分页版式纯函数单测。
 *
 * 这些断言锁死的是阅读页最容易回归的三件事：
 * 1. 页宽/页高永不超过可用空间（排版溢出与右页被裁的根因）；
 * 2. 窄窗下双页对开必须自动退回单页；
 * 3. 页码 ↔ 百分比 ↔ 列位移三者互逆且双页左页恒为奇数。
 */
import { describe, expect, it } from "vitest";
import {
	BOOK_MARGIN,
	GUTTER_DOUBLE,
	GUTTER_SINGLE,
	MIN_SPREAD_WIDTH,
	MIN_SPREAD_PAGE_WIDTH,
	PAGE_MARGIN_X_DOUBLE,
	PAGE_MARGIN_X_SINGLE,
	SAFETY,
	alignSpreadPage,
	clampPage,
	columnOffsetPx,
	computePageLayout,
	pageCountFromMarker,
	pageFromPercent,
	pageStep,
	percentFromPage,
	percentageFromPage,
	visibleOffsetPx,
} from "../src/services/books/formats/html/paging-layout";

describe("computePageLayout", () => {
	it("单页：页宽 = 可用宽 - 左右页边距，且不超出可用空间", () => {
		const layout = computePageLayout({ viewWidth: 900, viewHeight: 700, double: false });
		const availW = 900 - (BOOK_MARGIN + SAFETY) * 2;
		expect(layout.double).toBe(false);
		expect(layout.pageWidth).toBe(availW - PAGE_MARGIN_X_SINGLE * 2);
		expect(layout.gutter).toBe(GUTTER_SINGLE);
		expect(layout.bookWidth).toBe(layout.pageWidth);
		expect(layout.columnStride).toBe(layout.pageWidth + GUTTER_SINGLE);
		// 页面 + 两侧外框不得超出窗口
		expect(layout.bookWidth + PAGE_MARGIN_X_SINGLE * 2).toBeLessThanOrEqual(availW);
	});

	it("双页：每页宽 = (可用宽 - 槽宽)/2 - 页边距，两页加槽宽正好铺满", () => {
		const layout = computePageLayout({ viewWidth: 1200, viewHeight: 800, double: true });
		const availW = 1200 - (BOOK_MARGIN + SAFETY) * 2;
		expect(layout.double).toBe(true);
		expect(layout.gutter).toBe(GUTTER_DOUBLE);
		expect(layout.bookWidth).toBe(layout.pageWidth * 2 + GUTTER_DOUBLE);
		expect(layout.bookWidth + PAGE_MARGIN_X_DOUBLE * 2).toBeLessThanOrEqual(availW);
		expect(layout.pageWidth).toBeGreaterThanOrEqual(MIN_SPREAD_PAGE_WIDTH);
	});

	it("窄窗下即使选择双页也自动退回单页（epub.js spread:auto 语义）", () => {
		const layout = computePageLayout({ viewWidth: MIN_SPREAD_WIDTH - 60, viewHeight: 700, double: true });
		expect(layout.double).toBe(false);
		expect(layout.gutter).toBe(GUTTER_SINGLE);
	});

	it("页高按可用高度取值，且不小于下限、不超出可用高度", () => {
		const tall = computePageLayout({ viewWidth: 900, viewHeight: 1000, double: false });
		expect(tall.pageHeight).toBe(1000 - (BOOK_MARGIN + SAFETY) * 2);
		const tiny = computePageLayout({ viewWidth: 900, viewHeight: 60, double: false });
		expect(tiny.pageHeight).toBeGreaterThanOrEqual(120);
	});

	it("极端窄窗不产生非法尺寸（不出现 0/负数页宽）", () => {
		const layout = computePageLayout({ viewWidth: 50, viewHeight: 50, double: true });
		expect(layout.pageWidth).toBeGreaterThanOrEqual(120);
		expect(Number.isFinite(layout.bookWidth)).toBe(true);
	});
});

describe("页码换算", () => {
	it("clampPage 把页码限制在有效区间", () => {
		expect(clampPage(0, 10)).toBe(1);
		expect(clampPage(99, 10)).toBe(10);
		expect(clampPage(Number.NaN, 10)).toBe(1);
		expect(clampPage(5, 0)).toBe(1);
	});

	it("百分比 → 页码 → 百分比 往返稳定", () => {
		const total = 200;
		for (const pct of [0, 1, 2500, 5000, 9999, 10000]) {
			const page = pageFromPercent(pct, total);
			expect(page).toBeGreaterThanOrEqual(1);
			expect(page).toBeLessThanOrEqual(total);
			const back = percentFromPage(page, total);
			expect(pageFromPercent(back, total)).toBe(page);
		}
	});

	it("percentageFromPage 用页中心语义，与 percentFromPage 一致", () => {
		expect(percentageFromPage(1, 10)).toBeCloseTo(0.05, 6);
		expect(percentFromPage(1, 10)).toBe(500);
		expect(percentageFromPage(0, 0)).toBe(0);
	});

	it("总页数未知时退化为第 1 页 / 0 进度，不抛异常", () => {
		expect(pageFromPercent(5000, 0)).toBe(1);
		expect(percentFromPage(3, 0)).toBe(0);
	});
});

describe("列位移与双页对齐", () => {
	it("columnOffsetPx = -(页 - 1) * 步长", () => {
		const layout = computePageLayout({ viewWidth: 1000, viewHeight: 700, double: false });
		expect(columnOffsetPx(1, layout)).toBe(-0);
		expect(columnOffsetPx(2, layout)).toBe(-layout.columnStride);
		expect(columnOffsetPx(5, layout)).toBe(-4 * layout.columnStride);
		expect(visibleOffsetPx(5, layout)).toBe(4 * layout.columnStride);
	});

	it("双页对开左页恒为奇数（1|2、3|4…）", () => {
		expect(alignSpreadPage(1, true)).toBe(1);
		expect(alignSpreadPage(2, true)).toBe(1);
		expect(alignSpreadPage(3, true)).toBe(3);
		expect(alignSpreadPage(4, true)).toBe(3);
		// 单页模式原样返回
		expect(alignSpreadPage(2, false)).toBe(2);
	});

	it("翻页步长：双页 2、单页 1", () => {
		expect(pageStep(true)).toBe(2);
		expect(pageStep(false)).toBe(1);
	});

	it("双页从第 1 页起连续下一页仍为奇数，且不会越过末页之后", () => {
		let page = 1;
		for (let i = 0; i < 5; i++) {
			page = clampPage(page + pageStep(true), 21);
			expect(page % 2).toBe(1);
		}
		expect(page).toBe(11);
	});
});

describe("pageCountFromMarker（O(1) 测页数的算术）", () => {
	const layout = { columnStride: 500 };

	it("标记在容器左缘 → 只有 1 页", () => {
		expect(pageCountFromMarker(0, layout)).toBe(1);
	});

	it("标记落在第 N 列列首 → 内容占 N 页", () => {
		expect(pageCountFromMarker(500, layout)).toBe(2);
		expect(pageCountFromMarker(1500, layout)).toBe(4);
		expect(pageCountFromMarker(499, layout)).toBe(2);
	});

	it("非有限输入退化为 1 页（不抛异常）", () => {
		expect(pageCountFromMarker(Number.NaN, layout)).toBe(1);
		expect(pageCountFromMarker(100, { columnStride: 0 })).toBe(1);
	});
});
