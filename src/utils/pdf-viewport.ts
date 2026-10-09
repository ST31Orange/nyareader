/**
 * PDF 连续滚动视图的纯计算工具（不依赖 DOM，可单测）。
 * 供 PdfEngine 计算可见页面范围、当前页与页面尺寸。
 */
/** 只需 viewport 的 PDF 坐标换算能力（pdf.js 的 PageViewport 结构上满足）。 */
export interface PdfPointConverter {
	convertToPdfPoint(x: number, y: number): number[];
}

/** 页面在滚动内容中的纵向位置与高度（CSS px）。 */
export interface PageMetrics {
	top: number;
	height: number;
}

/** 按行组织页面时的布局参数（PdfEngine 的行容器模型：行内水平排列，行间纵向堆叠）。 */
export interface PdfRowLayout {
	/** 每行几页（单页 1 / 双页对开 2） */
	cols: number;
	/** 行间距与页间距（px，两处同值） */
	gap: number;
	/** 滚动内容容器相对行容器的顶部偏移（.nyareader-pdf-pages 的 padding-top） */
	contentTop: number;
}

/**
 * 由各页高度纯计算每页在滚动内容中的 top（不读 DOM）。
 *
 * 为什么不用 `el.offsetTop` 逐个读：在 3000 页文档上，每渲染一页都要重算一次
 * 全部页偏移（`fixSlotSize` 里的 `for (const s of this.slots) s.top = s.el.offsetTop`），
 * 于是「滚动一屏（约 50 页）」变成 O(50 × 3000) 次强制布局 —— 这是大 PDF 滚动卡顿的根因。
 * 行高 = 该行内最高的页高，行与行之间叠加 gap，因此可以纯算术算出全部偏移。
 *
 * @param heights 各页高度（按页序，长度应与 cols 对应的分组数一致）
 * @param layout 行布局参数
 * @returns 每页的 top（与 heights 同序）
 */
export function computeRowTops(heights: readonly number[], layout: PdfRowLayout): number[] {
	const n = heights.length;
	const tops = new Array<number>(n);
	const cols = Math.max(1, Math.floor(layout.cols));
	const gap = Math.max(0, layout.gap);
	let y = Math.max(0, layout.contentTop);
	for (let i = 0; i < n; i += cols) {
		let rowHeight = 0;
		for (let k = i; k < Math.min(n, i + cols); k++) rowHeight = Math.max(rowHeight, heights[k] || 0);
		for (let k = i; k < Math.min(n, i + cols); k++) tops[k] = y;
		y += rowHeight + gap;
	}
	return tops;
}

/**
 * 只有第 `changed` 页的高度变化时，增量修正其后的 top。
 *
 * 单页高度变化只影响「它所在行及其后所有行」的纵向位置，前面的页不动，
 * 因此无需重算全表（O(n) → O(受影响页数)）。
 * 说明：PdfEngine 目前采用「批次结束统一纯算术重算」（computeRowTops 不读 DOM，
 * 3000 页也只有微秒级），本函数作为可选的增量口径保留并单测，供后续按需启用。
 *
 * @returns 实际被修正的页数（用于测试/统计）
 */
export function shiftTopsAfter(
	tops: number[],
	heights: readonly number[],
	changed: number,
	delta: number,
	layout: PdfRowLayout
): number {
	const n = tops.length;
	if (changed < 0 || changed >= n || delta === 0) return 0;
	const cols = Math.max(1, Math.floor(layout.cols));
	const rowStart = changed - (changed % cols);
	const rowEnd = Math.min(n, rowStart + cols);
	void heights;
	let affected = 0;
	for (let i = rowEnd; i < n; i++) {
		tops[i] += delta;
		affected++;
	}
	return affected;
}


/** 二分查找第一个 bottom >= y 的页面索引（pages 按 top 升序）。 */
export function lowerBound(pages: PageMetrics[], y: number): number {
	if (pages.length === 0) return 0;
	let lo = 0;
	let hi = pages.length - 1;
	// 若 y 越过最后一页（例如滚到文档末尾的空隙），回退到最后一页，
	// 否则"当前页"会错误地回到第 1 页。
	let ans = pages.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const page = pages[mid];
		if (page.top + page.height >= y) {
			ans = mid;
			hi = mid - 1;
		} else {
			lo = mid + 1;
		}
	}
	return ans;
}

/**
 * 返回与视口（上下各留 margin）相交的页面索引区间。
 * 无页面时返回 [0, -1]。
 */
export function findVisibleRange(pages: PageMetrics[], scrollTop: number, viewportHeight: number, margin: number): [number, number] {
	if (pages.length === 0) return [0, -1];
	const top = scrollTop - margin;
	const bottom = scrollTop + viewportHeight + margin;
	const from = lowerBound(pages, top);
	let to = from;
	while (to + 1 < pages.length && pages[to + 1].top <= bottom) to++;
	return [from, to];
}

/** 视口中线所在的页面索引（页面按 top 升序）。 */
export function pageIndexAtMidpoint(pages: PageMetrics[], scrollTop: number, viewportHeight: number): number {
	if (pages.length === 0) return 0;
	return lowerBound(pages, scrollTop + viewportHeight / 2);
}

/** 让某页居中（页面较矮时）或顶对齐（页面较高时）所需的 scrollTop。 */
export function scrollTopForPage(page: PageMetrics, viewportHeight: number): number {
	return Math.max(0, Math.round(page.top - Math.max(0, (viewportHeight - page.height) / 2)));
}

/**
 * 由 viewport 反推页面 PDF 用户空间尺寸（pt），兼容任意旋转。
 *
 * 注意：不要用 convertToPdfPoint(width, height) 直接当尺寸——rotation=0 时
 * 它返回 (pageWidth, 0)，会让"选中区域是否在页内"的校验永远失败。
 * 正确做法是对 (0,0) 与 (width,height) 两点分别换算后取绝对值差。
 */
export function pageSizeFromViewport(viewport: PdfPointConverter, viewWidth: number, viewHeight: number): { width: number; height: number } {
	const [x0, y0] = viewport.convertToPdfPoint(0, 0);
	const [x1, y1] = viewport.convertToPdfPoint(viewWidth, viewHeight);
	return { width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}
