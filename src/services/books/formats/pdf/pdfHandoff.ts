/**
 * 已打开 PDF 文档的一次性交接缓存。
 *
 * 背景（打开大 PDF 慢的根因之一）：
 * PdfParser 为了拿元数据/目录/页数会先 `pdfjs.getDocument(buffer)` 解析一次，
 * 解析完立刻 `doc.destroy()`；随后 PdfEngine 又对同一份 buffer 再
 * `getDocument()` 解析一次。PDF 的解析（xref/对象流/字体）是打开耗时的大头，
 * 大文件上等于白做一遍。
 *
 * 做法：解析阶段把文档对象放进这个「一次性交接」槽位，渲染引擎 mount 时
 * 优先取用。用「身份（buffer 引用）+ 一次性取走」而不是 LRU：
 * - 身份比较避免误用别的书的文档；
 * - 取走即清空，保证同一时刻只有一个打开任务持有它，不会泄漏；
 * - 带 TTL 兜底：若引擎始终没取走（切书/关窗），过期条目会被释放。
 */
import type { PDFDocumentProxy } from "pdfjs-dist";

interface HandoffEntry {
	buffer: ArrayBuffer;
	doc: PDFDocumentProxy;
	createdAt: number;
}

/**
 * 交接条目的最长存活时间（ms）。
 * 解析完成后若引擎始终没有挂载（用户切书/关窗/后续步骤失败），
 * 过期条目会在下次存取时被释放，避免 pdf.js worker 长期持有文档。
 */
const HANDOFF_TTL_MS = 60_000;

let entry: HandoffEntry | null = null;

/** 释放并清空当前条目。 */
function releaseEntry(): void {
	if (!entry) return;
	const doc = entry.doc;
	entry = null;
	void doc.destroy().catch(() => undefined);
}

/** 存放刚解析完成的文档，供渲染引擎复用（旧的、不同的文档会被释放）。 */
export function putPdfHandoff(buffer: ArrayBuffer, doc: PDFDocumentProxy): void {
	if (entry && entry.doc !== doc) releaseEntry();
	entry = { buffer, doc, createdAt: Date.now() };
}

/** 取走与给定 buffer 匹配的已解析文档（一次性）；未命中或已过期返回 null。 */
export function takePdfHandoff(buffer: ArrayBuffer): PDFDocumentProxy | null {
	if (!entry) return null;
	if (entry.buffer !== buffer || Date.now() - entry.createdAt > HANDOFF_TTL_MS) {
		releaseEntry();
		return null;
	}
	const doc = entry.doc;
	entry = null;
	return doc;
}

/** 放弃当前交接的文档（打开流程失败/切书时调用，避免 pdf.js worker 常驻）。 */
export function dropPdfHandoff(): void {
	releaseEntry();
}
