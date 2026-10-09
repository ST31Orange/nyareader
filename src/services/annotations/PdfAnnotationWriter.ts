/**
 * PDF 批注写入器：使用 pdf-lib 将高亮/下划线/笔记作为标准 PDF 注释写入文件。
 * 关键决策：
 * - 写入前由 PdfBackupService 保证已备份；
 * - 批注位置使用 PDF 用户空间 QuadPoints（左下原点，单位 pt）；
 * - 使用 pdf-lib 的 Annotation 构造，尽量贴近标准 /Subtype。
 * - 写回后调用方应回读校验（PdfInlineAnnotationStore 负责）。
 */
import { PDFDocument, PDFName, PDFNumber, PDFString, PDFArray, PDFDict, PDFObject } from "pdf-lib";
import type { Annotation, AnnotationKind } from "./AnnotationModel";
import type { PdfPoint } from "../../utils/pdf-coords";

export interface WriteAnnotationInput {
	/** NyaReader 批注 id：写入 PDF 自定义键 /NyaReader，用于后续精确删除 */
	id: string;
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
	// 六色模型的紫色：缺了它 PDF 的 /C 会静默回退成黄色（ReaderController 现在会传 purple）
	purple: [0.6, 0.4, 1],
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
	const id = input.id?.replace(/[^A-Za-z0-9._-]/g, "_") || "nyareader";
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
	// 自定义键：让“删除批注”能精确识别并移除我们写入的注释，而不误伤其他工具的批注
	dict.set(PDFName.of("NyaReader"), PDFString.of(id));
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

/**
 * 从 PDF 中删除一条由 NyaReader 写入的批注（按 /NyaReader 自定义键匹配）。
 * 返回新二进制；若未找到匹配注释则抛出错误。
 */
export async function removePdfAnnotation(pdfBytes: ArrayBuffer, pageIndex: number, id: string): Promise<Uint8Array> {
	const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
	const page = doc.getPage(pageIndex);
	const annotsRef = page.node.Annots();
	if (!annotsRef) return doc.save({ useObjectStreams: true });
	const arr = annotsRef instanceof PDFArray ? annotsRef : ((await doc.context.lookup(annotsRef)) as PDFArray | null);
	if (!(arr instanceof PDFArray)) return doc.save({ useObjectStreams: true });

	const keep: PDFObject[] = [];
	let removed = 0;
	for (const ref of arr.asArray()) {
		const dict = doc.context.lookup(ref);
		const marker = dict instanceof PDFDict ? dict.get(PDFName.of("NyaReader")) : undefined;
		const markerText = marker instanceof PDFString ? marker.asString() : "";
		if (marker && markerText === id) {
			removed++;
			continue;
		}
		keep.push(ref);
	}
	if (removed === 0) throw new Error(`未找到 NyaReader 批注（id=${id}），已停止删除以避免误删其他批注`);
	// 重建注释数组：pdf-lib 的 PDFArray 元素不可直接移除，用新数组替换
	const newArr = doc.context.obj([]) as PDFArray;
	for (const ref of keep) newArr.push(ref);
	page.node.set(PDFName.of("Annots"), newArr);
	return doc.save({ useObjectStreams: true });
}

/** 根据 Annotation 类型决定 PDF 子类型与是否含 QuadPoints（供回读校验）。 */
export function expectedSubtype(kind: AnnotationKind): string {
	return KIND_SUBTYPE[kind];
}

/**
 * 是否是"PDF 已加密"这类**能力性失败**（pdf-lib 官方限制：不支持加密文档，
 * `PDFDocument.load` 抛 `EncryptedPDFError`；`ignoreEncryption: true` 也不会解密）。
 *
 * 为什么单独抽成纯函数：调用方要靠它区分"该降级到侧车存储"与"真的写坏了"，
 * 而且它必须能被单测覆盖（构造真实的 `EncryptedPDFError` 实例即可）。
 */
export function isEncryptedPdfError(error: unknown): boolean {
	if (!error) return false;
	const name = (error as { name?: string }).name ?? "";
	const message = error instanceof Error ? error.message : String(error);
	return name === "EncryptedPDFError" || /encrypt/i.test(message);
}


