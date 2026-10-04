/**
 * MOBI / AZW3 解析器：尽力而为的纯 JS 解析。
 * 路径：解析 PalmDB 头 -> 定位 PalmDOC 头 -> 按压缩类型解压文本记录 ->
 *       提取 HTML（KF8/AZW3 与多数 MOBI 均含 HTML）-> 作为单一文档渲染。
 * 失败时抛出可读错误，由 Controller 提示用户改用 Calibre 转换。
 */
import type { BookModel, TocItem } from "../../../../types";
import type { IBookParser, ParseContext } from "../../Parser";
import { decompressPalmDoc } from "./palmdoc";

const EXTH_TYPE_TITLE = 503;
const EXTH_TYPE_AUTHOR = 100;

export class MobiParser implements IBookParser {
	readonly format = "mobi" as const;

	async parse(ctx: ParseContext): Promise<BookModel> {
		const result = extractMobiContent(new Uint8Array(ctx.buffer));
		if (!result) throw new Error("无法解析该 MOBI/AZW3 文件（可能加密或格式过旧）。请用 Calibre 转换为 EPUB 后导入。");
		const { html, title, author } = result;
		// 从 HTML 粗提取目录（h1-h3）
		const toc = extractTocFromHtml(html);
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

/** 解析 MOBI 二进制，返回提取的 HTML 与元数据；失败返回 null。 */
export function extractMobiContent(bytes: Uint8Array): MobiExtractResult | null {
	try {
		// PalmDB 头 78 字节
		if (bytes.length < 78) return null;
		const dbNameEnd = findNull(bytes, 0, 32);
		void dbNameEnd;
		const recordCount = readU16(bytes, 76);
		const recordInfoOffset = readU16(bytes, 78);
		if (recordCount === 0) return null;

		// 第一条记录起始位置
		const firstRecordDataOffset = recordInfoOffset + recordCount * 8;
		if (firstRecordDataOffset + 4 > bytes.length) return null;

		// PalmDOC 头（16 字节）
		const compression = readU16(bytes, firstRecordDataOffset); // 1=无压缩 2=LZ77
		const textLength = readU32(bytes, firstRecordDataOffset + 4);
		if (compression !== 1 && compression !== 2) return null;

		// 文本记录从第一条记录的数据区开始（PalmDOC 头之后 16 字节）
		const textStart = firstRecordDataOffset + 16;
		const textEnd = Math.min(bytes.length, textStart + textLength);
		let text: Uint8Array;
		if (compression === 1) {
			text = bytes.slice(textStart, textEnd);
		} else {
			text = decompressPalmDoc(bytes, textStart, textEnd);
		}

		// EXTH 元数据：PalmDOC 头后可能跟 MOBI 头（16 字节），再到 EXTH 头
		const mobiHeaderOffset = firstRecordDataOffset + 16;
		const exthPresent = readU32(bytes, mobiHeaderOffset + 0x0c) === 0x45585448; // "EXTH"
		let title: string | undefined;
		let author: string | undefined;
		if (exthPresent && mobiHeaderOffset + 0x10 + 12 <= bytes.length) {
			const exthLen = readU32(bytes, mobiHeaderOffset + 0x10);
			const exthStart = mobiHeaderOffset + 0x14;
			title = readExthString(bytes, exthStart, exthStart + exthLen, EXTH_TYPE_TITLE);
			author = readExthString(bytes, exthStart, exthStart + exthLen, EXTH_TYPE_AUTHOR);
		}

		// 文本转 HTML：PalmDOC 内是 HTML 或纯文本；统一包装
		const html = textToHtml(text);
		return { html, title, author };
	} catch {
		return null;
	}
}

function textToHtml(text: Uint8Array): string {
	let s = new TextDecoder("utf-8", { fatal: false }).decode(text);
	s = s.replace(/<mbp:pagebreak[^>]*>/gi, "");
	if (/<html[\s>]/i.test(s)) return s;
	// 纯文本（或没有根标签）：包装为 HTML，保留换行
	const paragraphs = s.split(/\r?\n{2,}/).map((p) => `<p>${escapeHtml(p.trim())}</p>`).join("");
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>mobi</title></head><body>${paragraphs}</body></html>`;
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
