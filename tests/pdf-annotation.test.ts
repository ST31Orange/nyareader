/** PDF 批注写入单测：生成测试 PDF -> 写注释 -> 用 pdf-lib 回读校验。 */
import { describe, it, expect, beforeAll } from "vitest";
import { PDFDocument, PDFDict, PDFArray, PDFName } from "pdf-lib";
import { writePdfAnnotation, expectedSubtype } from "../src/services/annotations/PdfAnnotationWriter";
import type { PdfPoint } from "../src/utils/pdf-coords";

let pdfBytes: Uint8Array;

beforeAll(async () => {
	const doc = await PDFDocument.create();
	const page = doc.addPage([612, 792]);
	page.drawText("Hello NyaReader", { x: 100, y: 700, size: 18 });
	pdfBytes = await doc.save();
});

describe("writePdfAnnotation", () => {
	it("写入高亮注释（含 QuadPoints）并可通过 pdf-lib 回读", async () => {
		const quad: PdfPoint[] = [
			{ x: 100, y: 690 },
			{ x: 250, y: 690 },
			{ x: 100, y: 710 },
			{ x: 250, y: 710 },
		];
		const out = await writePdfAnnotation(pdfBytes.slice().buffer as ArrayBuffer, {
			pageIndex: 0,
			kind: "highlight",
			quad,
			pageWidth: 612,
			pageHeight: 792,
			text: "Hello NyaReader",
			color: "yellow",
			author: "NyaReader-test",
		});

		const doc = await PDFDocument.load(out.slice().buffer as ArrayBuffer);
		const page = doc.getPage(0);
		const annotsRef = page.node.Annots();
		expect(annotsRef).toBeTruthy();
		const annots = (await doc.context.lookup(annotsRef!)) as PDFArray;
		expect(annots.size()).toBeGreaterThan(0);

		const dict = doc.context.lookup(annots.get(0)) as PDFDict;
		expect(dict.get(PDFName.of("Subtype"))?.toString()).toBe(`/${expectedSubtype("highlight")}`);
		expect(dict.get(PDFName.of("QuadPoints"))).toBeTruthy();
		expect(dict.get(PDFName.of("T"))?.toString()).toContain("NyaReader");
	});

	it("写入笔记（Text）注释无需 QuadPoints", async () => {
		const out = await writePdfAnnotation(pdfBytes.slice().buffer as ArrayBuffer, {
			pageIndex: 0,
			kind: "note",
			quad: [
				{ x: 100, y: 690 },
				{ x: 120, y: 690 },
				{ x: 100, y: 700 },
				{ x: 120, y: 700 },
			],
			pageWidth: 612,
			pageHeight: 792,
			text: "note",
			note: "这是一条笔记",
			color: "pink",
			author: "NyaReader-test",
		});
		const doc = await PDFDocument.load(out.slice().buffer as ArrayBuffer);
		const page = doc.getPage(0);
		const annots = (await doc.context.lookup(page.node.Annots()!)) as PDFArray;
		const dict = doc.context.lookup(annots.get(0)) as PDFDict;
		expect(dict.get(PDFName.of("Subtype"))?.toString()).toBe(`/${expectedSubtype("note")}`);
		expect(dict.get(PDFName.of("QuadPoints"))).toBeUndefined();
	});

	it("多次写入累积到同一页面 Annots", async () => {
		const quad: PdfPoint[] = [
			{ x: 100, y: 690 },
			{ x: 250, y: 690 },
			{ x: 100, y: 710 },
			{ x: 250, y: 710 },
		];
		let bytes: Uint8Array = pdfBytes;
		bytes = await writePdfAnnotation(bytes.slice().buffer as ArrayBuffer, { pageIndex: 0, kind: "highlight", quad, pageWidth: 612, pageHeight: 792, text: "a", color: "yellow" });
		bytes = await writePdfAnnotation(bytes.slice().buffer as ArrayBuffer, { pageIndex: 0, kind: "underline", quad, pageWidth: 612, pageHeight: 792, text: "b", color: "green" });
		const doc = await PDFDocument.load(bytes);
		const page = doc.getPage(0);
		const annots = (await doc.context.lookup(page.node.Annots()!)) as PDFArray;
		expect(annots.size()).toBe(2);
	});
});

