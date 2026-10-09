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
	BROWSER_COLUMN_LIMIT,
	GUTTER_DOUBLE,
	GUTTER_SINGLE,
	MAX_COLUMNS,
	MIN_SPREAD_WIDTH,
	MIN_SPREAD_PAGE_WIDTH,
	PAGE_MARGIN_X_DOUBLE,
	PAGE_MARGIN_X_SINGLE,
	SAFETY,
	alignSpreadPage,
	clampPage,
	columnGridCount,
	columnGridWidth,
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

	it("末页必须是 100%（回归：进度条永远到不了尽头）", () => {
		expect(percentFromPage(10, 10)).toBe(10000);
		expect(percentageFromPage(10, 10)).toBe(1);
		// 倒数第二页仍按页中心，不提前报 100%
		expect(percentFromPage(9, 10)).toBe(8500);
		// 超过总页数也夹到 100%
		expect(percentFromPage(99, 10)).toBe(10000);
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

describe("columnGridWidth（回归：固定 2e6 宽度的列距漂移 + column-width 不能丢）", () => {
	/**
	 * 复刻浏览器的多栏分配（**显式给出 column-width 时**）：
	 *   n = min(column-count, floor((U+g)/stride))，实际栏宽 = (U − (n−1)g) / n。
	 * 断言实际步长精确等于 pageWidth+gutter：
	 * - 旧实现宽度写死 2e6：2200px 窗口下每列多 0.951px，到末页累积 219.69px 被裁；
	 * - 若 `column-width: auto`（曾漏写导致回归）：浏览器按列数均分容器
	 *   （2_000_000 / 10000 ≈ 200px），实际步长与 pageWidth 完全无关。
	 */
	const simulate = (layout: { pageWidth: number; columnStride: number; gutter: number }, opts: { columnWidthAuto?: boolean } = {}) => {
		const width = columnGridWidth(layout);
		const count = columnGridCount(layout);
		const stride = layout.columnStride;
		const g = layout.gutter;
		if (opts.columnWidthAuto) {
			// column-width:auto → 忽略 pageWidth，浏览器按**生效列数上限**均分容器宽度。
			// Blink 实际生效上限 10000，这正是 stream-d 实测 2_000_000/10000 ≈ 200px 的来源
			// （无论 column-count 写多大都按这个上限均分）。
			const U = 2_000_000;
			const n = BROWSER_COLUMN_LIMIT;
			const actualColumnWidth = (U - (n - 1) * g) / n;
			return { n, actualColumnWidth, actualStride: actualColumnWidth + g };
		}
		const n = Math.min(count, Math.floor((width + g) / stride));
		const actualColumnWidth = (width - (n - 1) * g) / n;
		return { n, actualColumnWidth, actualStride: actualColumnWidth + g };
	};

	/** 旧实现：宽度写死 2_000_000px（与 pageWidth 是否整除无关）。 */
	const legacySimulate = (layout: { pageWidth: number; columnStride: number; gutter: number }) => {
		const U = 2_000_000;
		const g = layout.gutter;
		const n = Math.floor((U + g) / layout.columnStride);
		return { n, actualStride: (U + g) / n };
	};

	it("四种典型窗口下实际栏宽==页宽、实际步长==pageWidth+gutter", () => {
		for (const [viewW, viewH, double] of [
			[900, 700, false],
			[2200, 900, false],
			[360, 700, false],
			[1400, 800, true],
		] as const) {
			const layout = computePageLayout({ viewWidth: viewW, viewHeight: viewH, double });
			const sim = simulate(layout);
			expect(sim.actualColumnWidth).toBeCloseTo(layout.pageWidth, 6);
			expect(sim.actualStride).toBeCloseTo(layout.columnStride, 6);
		}
	});

	it("旧实现（宽度写死 2e6）在同一版式下会漂移，新实现为 0", () => {
		const layout = computePageLayout({ viewWidth: 2200, viewHeight: 900, double: false });
		const legacy = legacySimulate(layout);
		// 旧：每列多约 0.951px（与独立验证实测一致）
		expect(legacy.actualStride - layout.columnStride).toBeGreaterThan(0.5);
		// 新：误差为 0
		expect(simulate(layout).actualStride - layout.columnStride).toBeCloseTo(0, 9);
	});

	it("漏写 column-width（auto）会导致按列数均分：每栏只有 ~200px（回归）", () => {
		const layout = computePageLayout({ viewWidth: 900, viewHeight: 700, double: false });
		const broken = simulate(layout, { columnWidthAuto: true });
		// stream-d 实测：2_000_000 / 10000 ≈ 200px，与页宽 800 完全无关
		expect(broken.actualColumnWidth).toBeLessThan(250);
		expect(broken.actualStride).toBeLessThan(layout.columnStride / 2);
		// 正确实现严格等于页宽
		expect(simulate(layout).actualColumnWidth).toBeCloseTo(layout.pageWidth, 6);
	});

	it("列数不超过浏览器实际上限（Blink 10000）", () => {
		for (const viewW of [360, 900, 2200]) {
			const layout = computePageLayout({ viewWidth: viewW, viewHeight: 700, double: false });
			expect(columnGridCount(layout)).toBeLessThanOrEqual(BROWSER_COLUMN_LIMIT);
		}
	});

	it("宽度可以远大于内容，但必须满足「整数倍减一个槽宽」", () => {
		const layout = computePageLayout({ viewWidth: 900, viewHeight: 700, double: false });
		const width = columnGridWidth(layout);
		const n = Math.floor((width + layout.gutter) / layout.columnStride);
		expect(width).toBe(n * layout.columnStride - layout.gutter);
		expect(width).toBeLessThanOrEqual(2_000_000);
	});
});

describe("后台补章时保持当前页（回归：补章导致阅读位置漂移）", () => {
	/**
	 * 复刻 HtmlDocEngine.relayoutPages 的两种定位策略：
	 * - 默认：按「旧百分比 × 新页数」重算（窗口缩放/字号变化时正确）；
	 * - 内容末尾追加（keepPage）：必须保持页码，否则每补一批章节读者就被往后推。
	 */
	const repositionByPercent = (page: number, oldTotal: number, newTotal: number): number =>
		clampPage(Math.round(((page - 0.5) / oldTotal) * newTotal) || 1, newTotal);
	const repositionKeepPage = (page: number, newTotal: number): number => clampPage(page, newTotal);

	it("按百分比重算会在补章后把读者往后推（正文追加时这是错误行为）", () => {
		// 已加载 10 页时读到第 3 页；后台补章后总页数变成 100
		expect(repositionByPercent(3, 10, 100)).toBe(25);
	});

	it("保持页码策略在补章后仍停在第 3 页", () => {
		expect(repositionKeepPage(3, 100)).toBe(3);
	});

	it("保持页码策略在新的总页数变小时会被夹回有效范围", () => {
		expect(repositionKeepPage(90, 40)).toBe(40);
	});
});
