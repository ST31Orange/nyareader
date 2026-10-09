/**
 * PDF 文档交接缓存单测。
 *
 * 这些断言保护的是「打开大 PDF 不重复解析」这条优化的正确性边界：
 * - 只有同一份 buffer 才允许复用（避免张冠李戴拿到别的书的文档）；
 * - 一次性取走（避免两个引擎共用同一个文档后被其中一个销毁）；
 * - 取走/替换/放弃时，旧的文档必须被释放（否则 pdf.js worker 常驻内存）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { dropPdfHandoff, putPdfHandoff, takePdfHandoff } from "../src/services/books/formats/pdf/pdfHandoff";

/** 只关心 destroy 的假文档对象。 */
function fakeDoc(): PDFDocumentProxy & { destroy: ReturnType<typeof vi.fn> } {
	return { destroy: vi.fn().mockResolvedValue(undefined) } as unknown as PDFDocumentProxy & {
		destroy: ReturnType<typeof vi.fn>;
	};
}

describe("pdfHandoff", () => {
	beforeEach(() => {
		dropPdfHandoff();
		vi.restoreAllMocks();
	});

	it("同一 buffer 可以取回刚交接的文档，且只能取一次", () => {
		const buffer = new ArrayBuffer(8);
		const doc = fakeDoc();
		putPdfHandoff(buffer, doc);
		expect(takePdfHandoff(buffer)).toBe(doc);
		expect(takePdfHandoff(buffer)).toBeNull();
	});

	it("buffer 身份不匹配时不复用，并释放旧文档", () => {
		const doc = fakeDoc();
		putPdfHandoff(new ArrayBuffer(8), doc);
		expect(takePdfHandoff(new ArrayBuffer(8))).toBeNull();
		expect(doc.destroy).toHaveBeenCalledTimes(1);
	});

	it("放入新文档时释放上一份未取走的文档", () => {
		const first = fakeDoc();
		const second = fakeDoc();
		putPdfHandoff(new ArrayBuffer(8), first);
		putPdfHandoff(new ArrayBuffer(8), second);
		expect(first.destroy).toHaveBeenCalledTimes(1);
		expect(second.destroy).not.toHaveBeenCalled();
	});

	it("重复放入同一个文档不会自毁", () => {
		const buffer = new ArrayBuffer(8);
		const doc = fakeDoc();
		putPdfHandoff(buffer, doc);
		putPdfHandoff(buffer, doc);
		expect(doc.destroy).not.toHaveBeenCalled();
		expect(takePdfHandoff(buffer)).toBe(doc);
	});

	it("dropPdfHandoff 释放待取走的文档且幂等", () => {
		const doc = fakeDoc();
		putPdfHandoff(new ArrayBuffer(8), doc);
		dropPdfHandoff();
		dropPdfHandoff();
		expect(doc.destroy).toHaveBeenCalledTimes(1);
	});

	it("超过 TTL 的条目不再复用，并被释放", () => {
		const buffer = new ArrayBuffer(8);
		const doc = fakeDoc();
		putPdfHandoff(buffer, doc);
		const realNow = Date.now;
		Date.now = () => realNow() + 61_000;
		try {
			expect(takePdfHandoff(buffer)).toBeNull();
		} finally {
			Date.now = realNow;
		}
		expect(doc.destroy).toHaveBeenCalledTimes(1);
	});
});
