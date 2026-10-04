/**
 * PDF 坐标换算工具（纯函数，可单测）。
 * pdf.js 视口坐标系（CSS px，原点左上）与 PDF 用户空间（原点左下，单位 pt）
 * 之间的双向换算，供文本层选区 -> PDF 批注 QuadPoints 使用。
 */

export interface PdfPoint {
	x: number;
	y: number;
}

export interface PdfRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * 由 pdf.js viewport 构造变换。
 * viewport.convertToViewportPoint(pdfX, pdfY) 将 PDF 点（左下原点）转 CSS px（左上原点）。
 * 我们直接基于该 API 封装，避免手工解析矩阵，兼容 pdf.js 内部变化。
 */
export interface ViewportLike {
	convertToViewportPoint(x: number, y: number): [number, number];
	convertToPdfPoint(x: number, y: number): [number, number];
}

/**
 * 将文本层中的 DOM 矩形（CSS px，容器内坐标）换算为 PDF 页用户空间坐标。
 * 需要提供文本层容器相对于页面画布的偏移（通常为 0，因为文本层覆盖在 canvas 上）。
 */
export function domRectToPdfRect(rect: PdfRect, viewport: ViewportLike, containerOffsetX = 0, containerOffsetY = 0): { quad: PdfPoint[]; rect: PdfRect } {
	// DOM 矩形在容器内：先转绝对视口坐标
	const absLeft = rect.left + containerOffsetX;
	const absTop = rect.top + containerOffsetY;
	const corners: PdfRect[] = [
		{ left: absLeft, top: absTop, width: 0, height: 0 },
		{ left: absLeft + rect.width, top: absTop, width: 0, height: 0 },
		{ left: absLeft + rect.width, top: absTop + rect.height, width: 0, height: 0 },
		{ left: absLeft, top: absTop + rect.height, width: 0, height: 0 },
	];
	const pdfCorners = corners.map((c) => {
		const [x, y] = viewport.convertToPdfPoint(c.left, c.top);
		return { x, y };
	});
	// QuadPoints 顺序：左下、右下、左上、右上（PDF 规范对高亮批注的要求）
	const quad = [pdfCorners[3], pdfCorners[2], pdfCorners[0], pdfCorners[1]];
	const xs = pdfCorners.map((p) => p.x);
	const ys = pdfCorners.map((p) => p.y);
	const pdfRect: PdfRect = {
		left: Math.min(...xs),
		top: Math.min(...ys),
		width: Math.max(...xs) - Math.min(...xs),
		height: Math.max(...ys) - Math.min(...ys),
	};
	return { quad, rect: pdfRect };
}

/**
 * 合并同一行内的多个 DOM 矩形（多列选中会返回多个 rect）为单个 PDF 矩形。
 */
export function mergeDomRects(rects: PdfRect[]): PdfRect {
	if (rects.length === 0) return { left: 0, top: 0, width: 0, height: 0 };
	const left = Math.min(...rects.map((r) => r.left));
	const top = Math.min(...rects.map((r) => r.top));
	const right = Math.max(...rects.map((r) => r.left + r.width));
	const bottom = Math.max(...rects.map((r) => r.top + r.height));
	return { left, top, width: right - left, height: bottom - top };
}

/** 判断 PDF 矩形是否完全在页内（用于批注写入前的合法性检查）。 */
export function isWithinPage(rect: PdfRect, pageWidthPt: number, pageHeightPt: number, tolerance = 1): boolean {
	return rect.left >= -tolerance && rect.top >= -tolerance && rect.left + rect.width <= pageWidthPt + tolerance && rect.top + rect.height <= pageHeightPt + tolerance;
}

