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
	dest?: string | unknown[] | null;
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

/**
 * 从 outline 目标解析页码；失败回退为 1。
 *
 * pdf.js 的 outline 节点 dest 有两种形态：
 * - 字符串：命名目标，需要 getDestination(id) 解析；
 * - 数组：内联目标（explicit dest），首元素可能是对象引用或页码索引。
 * 旧实现只处理字符串且把数组强转成 string，导致大量目录项回退到第 1 页。
 */
async function resolvePageNumber(node: PdfOutlineNode, doc: PDFDocumentProxy): Promise<number> {
	try {
		let dest: unknown = node.dest ?? null;
		if (typeof dest === "string") dest = await doc.getDestination(dest);
		if (!Array.isArray(dest) || dest.length === 0) return 1;
		const target = dest[0];
		// 对象引用 { num, gen } -> 页索引
		if (target && typeof target === "object" && "num" in (target as Record<string, unknown>)) {
			const ref = target as { num: number; gen: number };
			const pageIndex = await doc.getPageIndex(ref).catch(() => -1);
			if (pageIndex >= 0) return pageIndex + 1;
		}
		// 直接是 0-based 页索引
		if (typeof target === "number" && Number.isFinite(target)) return Math.max(1, Math.floor(target) + 1);
	} catch {
		/* 忽略单个节点失败 */
	}
	return 1;
}

