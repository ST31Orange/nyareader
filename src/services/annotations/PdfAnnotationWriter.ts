/**
 * PDF 批注写入器：使用 pdf-lib 将高亮/下划线/笔记作为标准 PDF 注释写入文件。
 * 关键决策：
 * - 写入前由 PdfBackupService 保证已备份；
 * - 批注位置使用 PDF 用户空间 QuadPoints（左下原点，单位 pt）；
 * - 使用 pdf-lib 的 Annotation 构造，尽量贴近标准 /Subtype。
 * - 写回后调用方应回读校验（PdfInlineAnnotationStore 负责）。
 */
import { PDFDocument, PDFName, PDFNumber, PDFString, PDFArray, PDFDict } from "pdf-lib";
import type { Annotation, AnnotationKind } from "./AnnotationModel";
import type { PdfPoint } from "../../utils/pdf-coords";

export interface WriteAnnotationInput {
	/** 页索引（0-based） */
	pageIndex: number;
	kind: AnnotationKind;
	/** QuadPoints：左下、右下、左上、右上 */
	quad: PdfPoint[];
	/** 页尺寸（pt），用于合法性检查 */
	pageWidth: number;
	pageHeight: number;
	text: string;
	note?: string;
	color: string;
	author?: string;
}

const KIND_SUBTYPE: Record<AnnotationKind, string> = {
	highlight: "Highlight",
	underline: "Underline",
	note: "Text",
};

const COLOR_RGB: Record<string, [number, number, number]> = {
	yellow: [1, 1, 0],
	green: [0, 1, 0.4],
	blue: [0.4, 0.6, 1],
	pink: [1, 0.4, 0.6],
	orange: [1, 0.7, 0.2],
};

/**
 * 向 PDF 二进制写入一条批注。
 * 返回新二进制。此函数为纯操作（传入 pdfBytes），便于单测。
 */
export async function writePdfAnnotation(pdfBytes: ArrayBuffer, input: WriteAnnotationInput): Promise<Uint8Array> {
	const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
	const page = doc.getPage(input.pageIndex);
	const color = COLOR_RGB[input.color] ?? COLOR_RGB.yellow;

	const pageRef = page.ref;

	// 构造批注字典
	const dict = doc.context.obj({
		Type: "Annot",
		Subtype: KIND_SUBTYPE[input.kind],
		Rect: [0, 0, 0, 0],
		// 页面引用
		P: pageRef,
		C: color,
		M: PDFString.of(new Date().toISOString()),
		Contents: input.note ? PDFString.of(input.note) : PDFString.of(input.text),
		T: input.author ? PDFString.of(input.author) : undefined,
	});
	// 高亮/下划线需要 QuadPoints
	if (input.kind === "highlight" || input.kind === "underline") {
		const quadArray = doc.context.obj([]) as PDFArray;
		for (const p of input.quad) {
			quadArray.push(PDFNumber.of(p.x));
			quadArray.push(PDFNumber.of(p.y));
		}
		dict.set(PDFName.of("QuadPoints"), quadArray);
	}
	// 计算包围矩形
	const xs = input.quad.map((p) => p.x);
	const ys = input.quad.map((p) => p.y);
	dict.set(PDFName.of("Rect"), doc.context.obj([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]));

	// 追加到页面注释数组
	const annotsRef = page.node.Annots();
	if (annotsRef instanceof PDFArray) {
		annotsRef.push(dict);
	} else if (annotsRef) {
		// 对象引用形式
		const arr = await doc.context.lookup(annotsRef);
		if (arr instanceof PDFArray) arr.push(dict);
		else {
			const newArr = doc.context.obj([dict]) as PDFArray;
			page.node.set(PDFName.of("Annots"), newArr);
		}
	} else {
		const newArr = doc.context.obj([dict]) as PDFArray;
		page.node.set(PDFName.of("Annots"), newArr);
	}

	return doc.save({ useObjectStreams: true });
}

/** 根据 Annotation 类型决定 PDF 子类型与是否含 QuadPoints（供回读校验）。 */
export function expectedSubtype(kind: AnnotationKind): string {
	return KIND_SUBTYPE[kind];
}


