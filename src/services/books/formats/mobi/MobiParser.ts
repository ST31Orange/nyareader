/**
 * MOBI / AZW3 解析器入口。
 *
 * 职责边界（v0.5 大文件重构后）：
 * - 底层结构解析（PalmDB 记录表 / PalmDOC 头 / EXTH / 逐记录解压 / 单趟扫描切章 / 图片记录）
 *   与渲染数据源全部在 `MobiDocument.ts`，本文件只做"结构 -> BookModel"的映射；
 * - 结构与渲染共用同一次解压 + 扫描（`loadMobiStructure` 按 ArrayBuffer 身份缓存），
 *   不再出现"解析整本一次 + 挂载时再整本一次"的重复成本；
 * - 目录用结构扫描结果：标题优先（定位到 `#nyareader-toc-N` 标题锚点，旧实现只写
 *   `String(i)` 会跳到 0%），退回 MOBI6 内联 `filepos` 锚点目录；
 * - `extractMobiContent` 与一批纯函数保持原签名/原行为（既有单测与调用方不受影响）。
 *
 * 关键实现要点（踩坑记录，勿轻易改动，详见 MobiDocument.ts）：
 * 1. PalmDB 头固定 78 字节，其后紧跟记录偏移表（每条 8 字节），“记录 0 的偏移”= u32@78。
 * 2. PalmDOC 头在记录 0 内；正文记录是记录 1 .. textRecordCount（含）。
 * 3. 每条正文记录解压后按 recordSize 截断，丢弃尾部检索数据。
 * 4. 每条记录的 LZ77 窗口互相独立。
 */
import type { BookModel } from "../../../../types";
import type { IBookParser, ParseContext } from "../../Parser";
import {
	MobiContentSource,
	MobiParseError,
	loadMobiStructure,
	parseMobiStructure,
} from "./MobiDocument";

export interface MobiExtractResult {
	html: string;
	title?: string;
	author?: string;
}

export class MobiParser implements IBookParser {
	readonly format = "mobi" as const;

	async parse(ctx: ParseContext): Promise<BookModel> {
		let structure: Awaited<ReturnType<typeof loadMobiStructure>>;
		try {
			structure = await loadMobiStructure(ctx.buffer);
		} catch (e) {
			const reason = e instanceof MobiParseError ? e.message : e instanceof Error ? e.message : String(e);
			throw new Error(
				`无法解析该 MOBI/AZW3 文件：${reason}。` +
					(e instanceof MobiParseError && e.reason === "encrypted"
						? "该文件带 DRM 加密，请先用 Calibre 去 DRM 并转换为 EPUB 后导入。"
						: "可尝试用 Calibre 转换为 EPUB 后导入。")
			);
		}
		const source = new MobiContentSource(structure, structure.title || "mobi");
		const rawTitle = structure.title;
		const toc = source.buildToc();
		return {
			fingerprint: ctx.fingerprint,
			path: ctx.path,
			format: ctx.format === "azw3" ? "azw3" : "mobi",
			title: rawTitle || ctx.path.split("/").pop()?.replace(/\.(mobi|azw3|azw)$/i, "") || "未命名电子书",
			author: structure.author || undefined,
			toc,
			spine: [{ id: "mobi-doc", href: "0", title: rawTitle }],
			estimatedChars: structure.textLength,
		};
	}
}

/**
 * 解析 MOBI 二进制，返回提取的整本 HTML 与元数据；结构性失败抛 MobiParseError。
 *
 * 注意：这是**全量构建**入口（大书请走 `loadMobiStructure` + `MobiContentSource` 的分块懒加载）。
 * 保留它是为了向后兼容既有的同步调用方与单测。
 */
export function extractMobiContent(bytes: Uint8Array): MobiExtractResult | null {
	try {
		const structure = parseMobiStructure(bytes);
		const source = new MobiContentSource(structure, structure.title || "mobi");
		return { html: source.buildFullHtml(), title: structure.title, author: structure.author };
	} catch (e) {
		if (e instanceof MobiParseError) throw e;
		throw new MobiParseError("internal", e instanceof Error ? e.message : String(e));
	}
}

// ---------- 向后兼容 re-export（旧调用方与既有单测从本文件导入这些符号） ----------

export { MobiParseError, MobiContentSource, loadMobiStructure, releaseMobiStructure, openMobiSource, parseMobiStructure, buildMobiChapters, scanMobiText, chapterIndexForOffset, registerMobiImages, sniffImageMime, parseMobiImageRef, applyFileposAnchors, scanFileposOffsets, fileposAnchorId, rewriteFileposLinks, mergeHtmlDocuments, readTextRecords, readTextRecordsIndexed, extractTocFromHtml, extractAnchorToc, unwrapMobiDocument, composeMobiDocument, mobiChapterAnchorHtml, DEFAULT_MOBI_INITIAL_CHAPTERS, MAX_CHAPTER_BYTES, MIN_CHAPTER_BYTES, MOBI_ANCHOR_PREFIX, MOBI_TOC_ANCHOR_PREFIX, MOBI_ASSET_ATTR, MOBI_ASSET_FALLBACK_ATTR, MOBI_ASSET_KEY_PREFIX, MOBI_ASSET_MISSING_PREFIX, FILEPOS_ANCHOR_PREFIX, assetKeyForRecord, imageRecordForIndex, stableMobiStyleKey } from "./MobiDocument";
export type {
	MobiParseFailure,
	MobiStructure,
	MobiChapterRange,
	MobiChapterDoc,
	MobiHeading,
	MobiAnchorLink,
	MobiScan,
	TextRecordIndex,
	TextRecordSpec,
} from "./MobiDocument";
