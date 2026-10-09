/**
 * 分页版式的纯函数内核（无 DOM、无 obsidian 依赖，可单测）。
 *
 * 背景：HtmlDocEngine 用「CSS 多栏容器（一栏 = 一页）+ transform 水平位移」实现翻页。
 * 这套算法的所有"算术"（页宽/页高、单双页回退、槽宽、页边距、列位移、页码换算）
 * 都集中在这里，引擎只负责把结果写进 DOM。
 *
 * 为什么抽出纯函数（重构要点）：
 * - 旧版这些常量散落在引擎里并与测量逻辑耦合，改一个边距要在三处对齐；
 * - 「双页回退单页」「列位移」「百分比↔页码」是本功能最容易出错的部分，
 *   抽出来才能用单测锁死（tests/paging-layout.test.ts）。
 */

/** 单页模式的栏间距（px） */
export const GUTTER_SINGLE = 40;
/** 双页对开的栏间距（px）：更窄，缩小中间留白 */
export const GUTTER_DOUBLE = 30;
/** 单页模式的页内左右内边距（px） */
export const PAGE_MARGIN_X_SINGLE = 28;
/** 双页模式的页内左右内边距（px）：更窄，避免两页正文挤在一起 */
export const PAGE_MARGIN_X_DOUBLE = 18;
/**
 * 页面与阅读区边缘的留白（px）。
 * 注意：宿主（Obsidian 视图壳）另有自己的 padding（--nyar-reading-pad-x），
 * 两边都要保持"收敛"的小值，避免旧版 20+28+32+38≈118px 的叠加留白。
 */
export const BOOK_MARGIN = 10;
/** 计算页宽时预留的安全余量（px/每侧）：杜绝取整误差让右页贴边被裁 */
export const SAFETY = 4;
/** 低于该可用宽度时，即使选择「双页」也自动退回单页（对应 epub.js 的 spread:"auto"） */
export const MIN_SPREAD_WIDTH = 640;
/** 双页模式下每页的最小可读宽度（px），低于此值退回单页 */
export const MIN_SPREAD_PAGE_WIDTH = 300;
/** 页宽下限 / 上限（px） */
export const MIN_PAGE_WIDTH = 120;
export const MAX_PAGE_WIDTH = 1400;
/** 页高下限（px） */
export const MIN_PAGE_HEIGHT = 120;
/** 图片在页内允许占用的高度预算：页高减去上下页内边距与一点呼吸空间 */
export const IMAGE_HEIGHT_RESERVE = 8;

export interface PageLayoutInput {
	/** iframe 实测内容宽度（px，= 宿主阅读区宽度） */
	viewWidth: number;
	/** iframe 实测内容高度（px） */
	viewHeight: number;
	/** 是否用户选择了双页对开 */
	double: boolean;
}

export interface PageLayout {
	/** 单页宽（px，不含页边距与槽宽） */
	pageWidth: number;
	/** 页高（px，含上下页边距） */
	pageHeight: number;
	/** 栏间距 / 页间槽宽（px） */
	gutter: number;
	/** 每页左右内边距（px） */
	pageMarginX: number;
	/** 书窗（可见页容器）宽度（px） */
	bookWidth: number;
	/** 书窗高度（px）＝ pageHeight */
	bookHeight: number;
	/** 实际生效的双页对开（窗口太窄时为 false） */
	double: boolean;
	/** 一页对应的水平步长（px）＝ pageWidth + gutter */
	columnStride: number;
}

/**
 * 计算分页版式。
 *
 * 规则（与旧实现等价，但边界更明确）：
 * - 可用空间 = iframe 尺寸 - BOOK_MARGIN*2 - SAFETY*2；
 * - 双页对开需同时满足：用户选择双页、可用宽 ≥ MIN_SPREAD_WIDTH、每页宽 ≥ MIN_SPREAD_PAGE_WIDTH，
 *   否则自动退回单页（窄窗下强行双页会把右页挤出阅读区）；
 * - 页宽/页高永不超过可用空间，并有下限。
 */
export function computePageLayout(input: PageLayoutInput): PageLayout {
	const gutter = input.double ? GUTTER_DOUBLE : GUTTER_SINGLE;
	const pageMarginX = input.double ? PAGE_MARGIN_X_DOUBLE : PAGE_MARGIN_X_SINGLE;
	const availW = Math.max(MIN_PAGE_WIDTH, Math.floor(input.viewWidth - (BOOK_MARGIN + SAFETY) * 2));
	const availH = Math.max(MIN_PAGE_HEIGHT, Math.floor(input.viewHeight - (BOOK_MARGIN + SAFETY) * 2));

	const widthForDouble = (availW - gutter) / 2 - pageMarginX * 2;
	const double = input.double && availW >= MIN_SPREAD_WIDTH && widthForDouble >= MIN_SPREAD_PAGE_WIDTH;

	// 单页：可用宽 - 左右页边距；双页：再减去槽宽后对半
	const rawWidth = double ? widthForDouble : availW - pageMarginX * 2;
	const pageWidth = clamp(Math.round(rawWidth), MIN_PAGE_WIDTH, Math.min(MAX_PAGE_WIDTH, availW));
	const pageHeight = clamp(Math.round(availH), MIN_PAGE_HEIGHT, availH);
	const bookWidth = double ? pageWidth * 2 + gutter : pageWidth;

	return {
		pageWidth,
		pageHeight,
		gutter,
		pageMarginX,
		bookWidth,
		bookHeight: pageHeight,
		double,
		columnStride: pageWidth + gutter,
	};
}

export function clamp(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min;
	return Math.min(max, Math.max(min, n));
}

/** 一页的列位移（px，负值；用于 transform: translateX） */
export function columnOffsetPx(page: number, layout: Pick<PageLayout, "columnStride">): number {
	return -(Math.max(1, page) - 1) * layout.columnStride;
}

/** 页宽 + 槽宽：翻一页的水平步长 */
export function pageStridePx(layout: Pick<PageLayout, "columnStride">): number {
	return layout.columnStride;
}

/** 双页对开时左页必须为奇数（1|2、3|4…）；单页模式原样返回 */
export function alignSpreadPage(page: number, double: boolean): number {
	const p = Math.max(1, Math.floor(page));
	if (!double) return p;
	return p % 2 === 0 ? p - 1 : p;
}

/**
 * 翻页步长：双页对开翻 2 页，否则 1 页。
 * @param double 实际生效的双页（注意传 layout.double，而不是用户设置）
 */
export function pageStep(double: boolean): number {
	return double ? 2 : 1;
}

/** 把页码限制在 [1, total]；total<=0 时返回 1 */
export function clampPage(page: number, total: number): number {
	if (!Number.isFinite(page)) return 1;
	if (total <= 0) return 1;
	return Math.min(total, Math.max(1, Math.round(page)));
}

/** 0~10000 的百分比定位符 → 页码 */
export function pageFromPercent(percent: number, total: number): number {
	if (!Number.isFinite(percent) || total <= 0) return 1;
	const raw = Math.round((percent / 10000) * total) || 1;
	return clampPage(raw, total);
}

/** 页码 → 0~10000 的百分比定位符（用页中心，避免边界抖动） */
export function percentFromPage(page: number, total: number): number {
	if (total <= 0) return 0;
	const p = clampPage(page, total);
	return Math.round(((p - 0.5) / total) * 10000);
}

/** 相对进度 0~1（页中心语义，与 percentFromPage 一致） */
export function percentageFromPage(page: number, total: number): number {
	if (total <= 0) return 0;
	const p = clampPage(page, total);
	return Math.min(1, Math.max(0, (p - 0.5) / total));
}

/**
 * 由「一页对应的水平步长」反推总页数。
 *
 * 用于 O(1) 测量：在栏容器末尾放一个零宽标记元素，
 * 取它相对容器左缘的偏移，除以步长即最后一列的序号（从 0 开始）。
 *
 * @param markerLeft 标记元素相对栏容器左缘的偏移（px，offsetLeft 语义）
 * @param layout 当前版式（只需 columnStride）
 */
export function pageCountFromMarker(markerLeft: number, layout: Pick<PageLayout, "columnStride">): number {
	if (!Number.isFinite(markerLeft) || layout.columnStride <= 0) return 1;
	return Math.max(1, Math.round(markerLeft / layout.columnStride) + 1);
}

/** 可见页在栏容器中的位移（px，正数，用于 translateX 的取负值） */
export function visibleOffsetPx(page: number, layout: Pick<PageLayout, "columnStride">): number {
	return (clamp(page, 1, Number.MAX_SAFE_INTEGER) - 1) * layout.columnStride;
}
