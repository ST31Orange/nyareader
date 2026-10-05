/**
 * PDF 解析器：使用 pdf.js 读取文档元数据、目录（outline）与页数，
 * 构建 BookModel。不渲染，纯解析，可在 Node/测试环境验证。
 * 目录页码通过异步 getDestination 解析，保证跳转准确。
 */
import type { BookModel, TocItem } from "../../../../types";
import type { IBookParser, ParseContext } from "../../Parser";
import { pdfjs } from "./pdfWorker";
import type { PDFDocumentProxy } from "pdfjs-dist";

interface PdfOutlineNode {
	title: string;
	dest?: unknown;
	items?: PdfOutlineNode[];
}

export class PdfParser implements IBookParser {
	readonly format = "pdf" as const;

	async parse(ctx: ParseContext): Promise<BookModel> {
		const loadingTask = pdfjs.getDocument({
			data: ctx.buffer,
			isEvalSupported: false,
			useSystemFonts: true,
		});
		const doc = await loadingTask.promise;
		try {
			const meta = await doc.getMetadata();
			const outline = await doc.getOutline();
			const numPages = doc.numPages;
			const info = meta.info as { Title?: string; Author?: string };
			return {
				fingerprint: ctx.fingerprint,
				path: ctx.path,
				format: "pdf",
				title: info.Title?.trim() || ctx.path.split("/").pop()?.replace(/\.pdf$/i, "") || "未命名 PDF",
				author: info.Author?.trim() || undefined,
				toc: await buildToc(outline, doc),
				spine: Array.from({ length: numPages }, (_, i) => ({
					id: `p${i + 1}`,
					href: String(i + 1),
					title: `第 ${i + 1} 页`,
				})),
			};
		} finally {
			await doc.destroy();
		}
	}
}

async function buildToc(outline: PdfOutlineNode[] | null, doc: PDFDocumentProxy): Promise<TocItem[]> {
	if (!outline) return [];
	let counter = 0;
	const walk = async (nodes: PdfOutlineNode[], depth: number): Promise<TocItem[]> => {
		const items: TocItem[] = [];
		for (const node of nodes) {
			counter++;
			const page = await resolvePageNumber(node, doc);
			const item: TocItem = {
				id: `toc-${counter}`,
				label: node.title,
				location: String(page),
			};
			if (node.items?.length) item.children = await walk(node.items, depth + 1);
			items.push(item);
		}
		return items;
	};
	return walk(outline, 0);
}

/** 从 outline 目标解析页码；失败回退为 1。 */
async function resolvePageNumber(node: PdfOutlineNode, doc: PDFDocumentProxy): Promise<number> {
	try {
		if (node.dest) {
			const dest = await doc.getDestination(node.dest as string);
			if (Array.isArray(dest) && dest[0] !== undefined) {
				const ref = dest[0] as { num?: number; gen?: number; toString(): string };
				// ref 是 PDF 对象引用，转成 pageIndex 需要 getPageIndex
				const pageIndex = await doc.getPageIndex({ num: ref.num ?? 0, gen: ref.gen ?? 0 } as never).catch(() => -1);
				if (pageIndex >= 0) return pageIndex + 1;
			}
		}
	} catch {
		/* 忽略单个节点失败 */
	}
	return 1;
}

