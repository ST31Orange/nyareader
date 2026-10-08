/**
 * MOBI / AZW3 解析器：尽力而为的纯 JS 解析。
 * 路径：解析 PalmDB 头 -> 读记录偏移表 -> 定位 PalmDOC 头 -> 按记录解压文本 ->
 *       提取 HTML（KF8/AZW3 与多数 MOBI 均含 HTML）-> 作为单一文档渲染。
 * 失败时抛出可读错误，由 Controller 提示用户改用 Calibre 转换。
 *
 * 关键实现要点（踩坑记录，勿轻易改动）：
 * 1. PalmDB 头固定 78 字节，其后紧跟记录偏移表（每条 8 字节：u32 偏移 + 1 属性 + 3 uid）。
 *    因此“记录 0 的偏移”= u32@78，而不是 `78 + recordCount * 8` 之类的推算值。
 * 2. PalmDOC 头在记录 0 内：compression/textLength/textRecordCount/recordSize/encryption。
 *    正文记录是记录 1 .. textRecordCount（含），共 textRecordCount 条。
 * 3. 每条正文记录解压后长度等于 recordSize（默认 4096），但记录尾部可能追加
 *    检索用的“尾随数据”，必须按 recordSize 截断，否则尾部会被解压成乱码并污染正文。
 * 4. 每条记录的 LZ77 窗口互相独立（字典在记录开始时重置）。
 */
import type { BookModel, TocItem } from "../../../../types";
import type { IBookParser, ParseContext } from "../../Parser";
import { decompressPalmDoc } from "./palmdoc";

const EXTH_TYPE_TITLE = 503;
const EXTH_TYPE_AUTHOR = 100;
const PALMDOC_HEADER_SIZE = 16;
const DEFAULT_RECORD_SIZE = 4096;

/** 解析失败的分类原因，便于给用户可执行的提示。 */
export type MobiParseFailure = "encrypted" | "unsupported-compression" | "truncated" | "no-text" | "internal";

export class MobiParseError extends Error {
	constructor(readonly reason: MobiParseFailure, message: string) {
		super(message);
		this.name = "MobiParseError";
	}
}

export class MobiParser implements IBookParser {
	readonly format = "mobi" as const;

	async parse(ctx: ParseContext): Promise<BookModel> {
		let result: MobiExtractResult | null;
		try {
			result = extractMobiContent(new Uint8Array(ctx.buffer));
		} catch (e) {
			const reason = e instanceof MobiParseError ? e.message : e instanceof Error ? e.message : String(e);
			throw new Error(
				`无法解析该 MOBI/AZW3 文件：${reason}。` +
					(e instanceof MobiParseError && e.reason === "encrypted"
						? "该文件带 DRM 加密，请先用 Calibre 去 DRM 并转换为 EPUB 后导入。"
						: "可尝试用 Calibre 转换为 EPUB 后导入。")
			);
		}
		if (!result) {
			throw new Error("无法解析该 MOBI/AZW3 文件（未找到正文文本记录）。请用 Calibre 转换为 EPUB 后导入。");
		}
		const { html, title, author } = result;
		// 目录：优先 h1-h3；MOBI6 多为“内联目录 + filepos 锚点”，退回锚点提取
		let toc = extractTocFromHtml(html);
		if (toc.length === 0) toc = extractAnchorToc(html);
		return {
			fingerprint: ctx.fingerprint,
			path: ctx.path,
			format: ctx.format === "azw3" ? "azw3" : "mobi",
			title: title || ctx.path.split("/").pop()?.replace(/\.(mobi|azw3|azw)$/i, "") || "未命名电子书",
			author: author || undefined,
			toc,
			spine: [{ id: "mobi-doc", href: "0", title }],
			estimatedChars: html.length,
		};
	}
}

export interface MobiExtractResult {
	html: string;
	title?: string;
	author?: string;
}

/** 解析 MOBI 二进制，返回提取的 HTML 与元数据；结构性失败抛 MobiParseError。 */
export function extractMobiContent(bytes: Uint8Array): MobiExtractResult | null {
	try {
		// PalmDB 头 78 字节
		if (bytes.length < 86) throw new MobiParseError("truncated", "文件过小，不是有效的 PalmDB 文件");
		if (readAscii(bytes, 60, 8) !== "BOOKMOBI") {
			// 少数文件 type/creator 字段写法不同，这里只警告不作为硬失败条件
		}
		const recordCount = readU16(bytes, 76);
		if (recordCount < 2) throw new MobiParseError("truncated", "记录表为空或过小");
		const recordOffset = (index: number): number =>
			index < recordCount ? readU32(bytes, 78 + index * 8) : bytes.length;

		// PalmDOC 头位于记录 0
		const record0 = recordOffset(0);
		if (record0 <= 0 || record0 + PALMDOC_HEADER_SIZE > bytes.length) {
			throw new MobiParseError("truncated", "PalmDOC 头越界");
		}
		const compression = readU16(bytes, record0); // 1=无压缩 2=PalmDOC LZ77
		const textLength = readU32(bytes, record0 + 4);
		const textRecordCount = readU16(bytes, record0 + 8);
		const recordSize = readU16(bytes, record0 + 10) || DEFAULT_RECORD_SIZE;
		const encryptionType = readU16(bytes, record0 + 12);
		if (encryptionType !== 0) {
			throw new MobiParseError("encrypted", `文件已加密（encryption=${encryptionType}）`);
		}
		if (compression !== 1 && compression !== 2) {
			throw new MobiParseError(
				"unsupported-compression",
				`不支持的压缩类型 ${compression}（可能是 HUFF/CDIC 或已加密）`
			);
		}
		if (textLength === 0 || textRecordCount === 0) {
			throw new MobiParseError("no-text", "正文长度为 0");
		}

		const text = readTextRecords(bytes, recordOffset, {
			compression,
			textLength,
			textRecordCount,
			recordSize,
		});
		if (text.length === 0) throw new MobiParseError("no-text", "正文记录解压为空");

		// EXTH 元数据：紧跟 MOBI 头（长度由 MOBI 头自述）
		const mobiHeaderOffset = record0 + PALMDOC_HEADER_SIZE;
		const mobiHeaderLen = readAscii(bytes, mobiHeaderOffset, 4) === "MOBI" ? readU32(bytes, mobiHeaderOffset + 4) : 0;
		const exthOffset = mobiHeaderOffset + mobiHeaderLen;
		let title: string | undefined;
		let author: string | undefined;
		if (readAscii(bytes, exthOffset, 4) === "EXTH" && exthOffset + 12 <= bytes.length) {
			const exthLen = readU32(bytes, exthOffset + 4);
			const exthStart = exthOffset + 12;
			title = readExthString(bytes, exthStart, exthStart + exthLen, EXTH_TYPE_TITLE);
			author = readExthString(bytes, exthStart, exthStart + exthLen, EXTH_TYPE_AUTHOR);
		}
		if (!title) {
			// 退回 PalmDB 名称字段
			const nameEnd = findNull(bytes, 0, 32);
			const name = new TextDecoder("utf-8").decode(bytes.slice(0, nameEnd >= 0 ? nameEnd : 32)).trim();
			if (name) title = name;
		}

		// MOBI6 的内部跳转使用 filepos=<解压后字节偏移>；插入锚点后转成普通 # 链接，
		// 这样目录/脚注链接可以在渲染出的单页文档里真正跳转。
		const anchored = applyFileposAnchors(text);
		const html = textToHtml(anchored);
		return { html, title, author };
	} catch (e) {
		if (e instanceof MobiParseError) throw e;
		throw new MobiParseError("internal", e instanceof Error ? e.message : String(e));
	}
}

interface TextRecordSpec {
	compression: number;
	textLength: number;
	textRecordCount: number;
	recordSize: number;
}

/**
 * 按“记录 1 .. textRecordCount”逐条解压正文。
 * 每条记录解压后按 recordSize 截断，以丢弃记录尾部的检索用附加数据。
 */
export function readTextRecords(
	bytes: Uint8Array,
	recordOffset: (index: number) => number,
	spec: TextRecordSpec
): Uint8Array {
	const chunks: Uint8Array[] = [];
	let remaining = spec.textLength;
	for (let r = 1; r <= spec.textRecordCount && remaining > 0; r++) {
		const start = recordOffset(r);
		const end = Math.min(recordOffset(r + 1), bytes.length);
		if (start < 0 || start >= end) continue;
		const budget = Math.min(spec.recordSize, remaining);
		const chunk =
			spec.compression === 1
				? bytes.slice(start, Math.min(end, start + budget))
				: decompressPalmDoc(bytes, start, end, budget);
		if (chunk.length === 0) continue;
		chunks.push(chunk);
		remaining -= chunk.length;
	}
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(Math.min(total, spec.textLength));
	let off = 0;
	for (const chunk of chunks) {
		if (off >= out.length) break;
		const slice = chunk.subarray(0, Math.min(chunk.length, out.length - off));
		out.set(slice, off);
		off += slice.length;
	}
	return out;
}

/**
 * 把 MOBI6 的 `filepos=<字节偏移>` 目标转成可在 DOM 中跳转的锚点。
 * 只在目标位置确实是标签起始（'<'）时插入，避免切断多字节字符或破坏正文。
 */
export function applyFileposAnchors(text: Uint8Array): Uint8Array {
	const targets = new Set<number>();
	for (const off of scanFileposOffsets(text)) {
		if (off > 0 && off < text.length && text[off] === 0x3c) targets.add(off);
	}
	if (targets.size === 0) return text;
	const encoder = new TextEncoder();
	const sorted = [...targets].sort((a, b) => a - b);
	const parts: Uint8Array[] = [];
	let cursor = 0;
	for (const off of sorted) {
		if (off <= cursor) continue;
		parts.push(text.subarray(cursor, off), encoder.encode(`<span id="${fileposAnchorId(off)}"></span>`));
		cursor = off;
	}
	parts.push(text.subarray(cursor));
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/** 按字节扫描出所有 `filepos=<数字>` 指向的目标偏移。 */
function scanFileposOffsets(text: Uint8Array): number[] {
	const needle = [0x66, 0x69, 0x6c, 0x65, 0x70, 0x6f, 0x73, 0x3d]; // "filepos="
	const found: number[] = [];
	for (let i = 0; i + needle.length < text.length; i++) {
		if (text[i] !== needle[0]) continue;
		let j = 1;
		while (j < needle.length && text[i + j] === needle[j]) j++;
		if (j !== needle.length) continue;
		let p = i + needle.length;
		if (text[p] === 0x22 || text[p] === 0x27) p++;
		const digitsStart = p;
		let acc = 0;
		while (p < text.length && text[p] >= 0x30 && text[p] <= 0x39) {
			acc = acc * 10 + (text[p] - 0x30);
			p++;
		}
		if (p > digitsStart && Number.isFinite(acc)) found.push(acc);
	}
	return found;
}

export function fileposAnchorId(offset: number): string {
	return `nyareader-fp-${offset}`;
}

/** 把 `filepos=NNN` 属性改写为 `href="#nyareader-fp-NNN"`。 */
export function rewriteFileposLinks(html: string): string {
	return html.replace(
		/(\s)filepos=["']?(\d+)["']?/gi,
		(_all, space: string, raw: string) => `${space}href="#${fileposAnchorId(parseInt(raw, 10))}"`
	);
}

function textToHtml(text: Uint8Array): string {
	let s = new TextDecoder("utf-8", { fatal: false }).decode(text);
	s = s.replace(/<mbp:pagebreak[^>]*>/gi, "");
	if (/<html[\s>]/i.test(s)) return rewriteFileposLinks(mergeHtmlDocuments(s));
	// 纯文本（或没有根标签）：包装为 HTML，保留换行
	const paragraphs = s.split(/\r?\n{2,}/).map((p) => `<p>${escapeHtml(p.trim())}</p>`).join("");
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>mobi</title></head><body>${paragraphs}</body></html>`;
}

/**
 * KF8/AZW3 的正文是多个相互独立的 XHTML 文档拼接而成（Standard Ebooks 那本有 65 个）。
 * 观察真实 KF8 样本发现的关键结构（v0.3.3 重写合并策略）：
 * - 每个 `<html>…</html>` 块是"骨架"：<head> 里有样式引用，<body> 是空的（aid="0"）；
 * - 真实章节内容（<section>/<p>/<h1>…）位于骨架块之**间**；
 * - 旧实现只取每个骨架 body 的 innerHTML，等于只拿到 65 个空 body → 白屏。
 * 因此合并策略为：保留骨架之间（以及非空 body 内）的全部正文，丢弃空骨架；
 * <head> 中若确有内联 <style> 才保留，跨文档丢弃 kindle:flow: 样式链接。
 */
export function mergeHtmlDocuments(html: string): string {
	const re = /<html\b[\s\S]*?<\/html>/gi;
	const heads: string[] = [];
	const bodyParts: string[] = [];
	let m: RegExpExecArray | null;
	let last = 0;
	let docCount = 0;
	while ((m = re.exec(html)) !== null) {
		docCount++;
		const doc = m[0];
		// 骨架块之间/之前的内容（KF8 章节正文所在）
		const between = stripXmlDecls(html.slice(last, m.index));
		if (between.trim()) bodyParts.push(between);
		// 仅保留含内联样式的 head
		const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(doc);
		if (head && /<style\b/i.test(head[1])) heads.push(head[1]);
		// 单文档（MOBI6）时正文在 body 内，需要保留
		const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(doc);
		const inner = body ? body[1] : "";
		if (inner.trim()) bodyParts.push(inner);
		last = m.index + doc.length;
	}
	if (docCount === 0) return html;
	bodyParts.push(stripXmlDecls(html.slice(last)));
	const bodyJoined = bodyParts
		.join("\n")
		.replace(/\r\n/g, "\n")
		.replace(/\n{4,}/g, "\n\n")
		.trim();
	const title = extractTitle(html);
	return (
		`<!DOCTYPE html><html><head><meta charset="utf-8">` +
		(title ? `<title>${title}</title>` : "") +
		heads.join("\n") +
		`</head><body>${bodyJoined}</body></html>`
	);
}

/** 去掉 XML 声明（允许在任意位置出现）。 */
function stripXmlDecls(s: string): string {
	return s.replace(/<\?xml[^>]*\?>/gi, "").replace(/^\s*\n/, "");
}

function extractTitle(html: string): string | null {
	const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	return m ? m[1].trim() : null;
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function findNull(bytes: Uint8Array, from: number, to: number): number {
	for (let i = from; i < to && i < bytes.length; i++) if (bytes[i] === 0) return i;
	return -1;
}

function readU16(bytes: Uint8Array, offset: number): number {
	if (offset + 2 > bytes.length) return 0;
	return (bytes[offset] << 8) | bytes[offset + 1];
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
	if (offset < 0 || offset + length > bytes.length) return "";
	let s = "";
	for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i]);
	return s;
}

function readU32(bytes: Uint8Array, offset: number): number {
	if (offset + 4 > bytes.length) return 0;
	return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/** 读取 EXTH 中指定类型的字符串值。 */
function readExthString(bytes: Uint8Array, from: number, to: number, wantedType: number): string | undefined {
	let p = from;
	while (p + 8 <= to) {
		const type = readU32(bytes, p);
		const len = readU32(bytes, p + 4);
		if (len < 8) break;
		if (type === wantedType) {
			const valBytes = bytes.slice(p + 8, Math.min(p + len, to));
			return new TextDecoder("utf-8").decode(valBytes).replace(/\0.*$/, "").trim() || undefined;
		}
		p += len;
	}
	return undefined;
}

/** 从 HTML 提取 h1-h3 作为目录（尽力而为）。 */
export function extractTocFromHtml(html: string): TocItem[] {
	const toc: TocItem[] = [];
	const re = /<h([123])[^>]*>(.*?)<\/h\1>/gi;
	let m: RegExpExecArray | null;
	let i = 0;
	while ((m = re.exec(html)) !== null && i < 200) {
		const label = m[2].replace(/<[^>]+>/g, "").trim();
		if (!label) continue;
		toc.push({ id: `mobi-toc-${i}`, label: label.slice(0, 60), location: String(i) });
		i++;
	}
	return toc;
}

/**
 * 从内部锚点链接提取目录（MOBI6 常见形态：内联目录页只有 `<a filepos=...>` 列表）。
 * 链接在 textToHtml 阶段已统一改写为 `href="#nyareader-fp-NNN"`。
 */
export function extractAnchorToc(html: string): TocItem[] {
	const toc: TocItem[] = [];
	const seen = new Set<string>();
	const re = /<a\b[^>]*href=["']#(nyareader-fp-\d+)["'][^>]*>([\s\S]*?)<\/a>/gi;
	let m: RegExpExecArray | null;
	let i = 0;
	while ((m = re.exec(html)) !== null && toc.length < 400) {
		const label = m[2].replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim();
		if (!label || seen.has(m[1])) continue;
		seen.add(m[1]);
		toc.push({ id: `mobi-anchor-${i++}`, label: label.slice(0, 80), location: `#${m[1]}` });
	}
	return toc;
}
