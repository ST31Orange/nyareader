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
