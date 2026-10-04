/** pdf-coords 工具单测：DOM 矩形 <-> PDF 用户坐标。 */
import { describe, it, expect } from "vitest";
import { domRectToPdfRect, mergeDomRects, isWithinPage } from "../src/utils/pdf-coords";
import type { ViewportLike, PdfRect } from "../src/utils/pdf-coords";

/** 构造一个简单的视口桩：PDF 页面 612x792pt，缩放 1，原点左下。 */
function stubViewport(width = 612, height = 792): ViewportLike {
	return {
		// CSS px（左上原点） -> PDF pt（左下原点）
		convertToPdfPoint(x: number, y: number): [number, number] {
			return [x, height - y];
		},
		convertToViewportPoint(x: number, y: number): [number, number] {
			return [x, height - y];
		},
	};
}

describe("domRectToPdfRect", () => {
	it("把左上原点 DOM 矩形转换为左下原点 PDF 矩形", () => {
		const vp = stubViewport(612, 792);
		const dom: PdfRect = { left: 100, top: 100, width: 200, height: 40 };
		const { quad, rect } = domRectToPdfRect(dom, vp);
		// PDF y 翻转：top=100 -> 792-100-40=652 为底边
		expect(rect.left).toBeCloseTo(100);
		expect(rect.top).toBeCloseTo(652); // 792 - (100+40)
		expect(rect.width).toBeCloseTo(200);
		expect(rect.height).toBeCloseTo(40);
		// QuadPoints 顺序：左下、右下、左上、右上
		expect(quad[0]).toEqual({ x: 100, y: 652 });
		expect(quad[1]).toEqual({ x: 300, y: 652 });
		expect(quad[2]).toEqual({ x: 100, y: 692 });
		expect(quad[3]).toEqual({ x: 300, y: 692 });
	});

	it("支持容器偏移", () => {
		const vp = stubViewport();
		const dom: PdfRect = { left: 10, top: 20, width: 30, height: 10 };
		const { rect } = domRectToPdfRect(dom, vp, 5, 8);
		expect(rect.left).toBeCloseTo(15);
		expect(rect.top).toBeCloseTo(792 - 38);
	});
});

describe("mergeDomRects", () => {
	it("合并多个矩形为包围盒", () => {
		const merged = mergeDomRects([
			{ left: 10, top: 10, width: 50, height: 20 },
			{ left: 80, top: 30, width: 20, height: 10 },
		]);
		expect(merged.left).toBe(10);
		expect(merged.top).toBe(10);
		expect(merged.width).toBe(90);
		expect(merged.height).toBe(30);
	});

	it("空数组返回零矩形", () => {
		const merged = mergeDomRects([]);
		expect(merged.width).toBe(0);
	});
});

describe("isWithinPage", () => {
	it("页内矩形通过", () => {
		expect(isWithinPage({ left: 10, top: 10, width: 100, height: 50 }, 612, 792)).toBe(true);
	});
	it("越界矩形不通过", () => {
		expect(isWithinPage({ left: -5, top: 10, width: 100, height: 50 }, 612, 792)).toBe(false);
		expect(isWithinPage({ left: 0, top: 700, width: 100, height: 100 }, 612, 792)).toBe(false);
	});
});
