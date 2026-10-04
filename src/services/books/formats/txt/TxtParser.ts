/**
 * TXT 解析器：编码检测（jschardet）+ 解码（iconv-lite）+ 章节识别。
 * 章节识别为"尽力而为"，不命中也能整本阅读。
 */
import jschardet from "jschardet";
import iconv from "iconv-lite";
import type { BookModel, TocItem } from "../../../../types";
import type { IBookParser, ParseContext } from "../../Parser";

/** 常见中文章节标题正则：第x章 / 第x节 / 第x回 / 数字标题等 */
const CHAPTER_RE = /^\s*(?:第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章回节卷部篇集]|[0-9]+\s*[.、．]|卷\s*[0-9零一二三四五六七八九十百千万两]+).*$/;

export interface TxtContent {
	title: string;
	/** 按段落切分的文本数组 */
	paragraphs: string[];
	/** 每个段落对应的章节（若命中） */
	chapters: Array<{ title: string; startParagraph: number }>;
}

export class TxtParser implements IBookParser {
	readonly format = "txt" as const;

	async parse(ctx: ParseContext): Promise<BookModel> {
		const { content, encoding } = decodeBuffer(ctx.buffer);
		const title = guessTitle(ctx.path, content);
		const { paragraphs, chapters } = splitParagraphs(content);
		const toc: TocItem[] = chapters.map((c, i) => ({
			id: `txt-ch-${i}`,
			label: c.title,
			location: String(c.startParagraph),
		}));
		return {
			fingerprint: ctx.fingerprint,
			path: ctx.path,
			format: "txt",
			title,
			author: undefined,
			toc,
			spine: paragraphs.map((_, i) => ({ id: `p${i}`, href: String(i), title: undefined })),
			estimatedChars: content.length,
		};
	}
}

/** 检测编码并解码为 UTF-16 JS 字符串。 */
export function decodeBuffer(buffer: ArrayBuffer): { content: string; encoding: string } {
	const bytes = new Uint8Array(buffer);
	// 先看 BOM
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		return { content: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
	}
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
		return { content: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
	}
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		return { content: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
	}
	// 先尝试严格 UTF-8（合法则直接用）
	try {
		const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (isMostlyText(utf8)) return { content: utf8, encoding: "utf-8" };
	} catch {
		/* 不是合法 UTF-8 */
	}
	// jschardet 检测
	let encoding = "gb18030";
	try {
		const det = jschardet.detect(bytes as unknown as Buffer);
		if (det?.encoding) encoding = normalizeEncoding(det.encoding);
	} catch {
		/* 检测失败回退 GB18030 */
	}
	const content = iconv.decode(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), encoding);
	return { content, encoding };
}

function normalizeEncoding(enc: string): string {
	const e = enc.toLowerCase().replace(/[_-]/g, "");
	if (e.includes("utf8") || e.includes("utf")) return "utf-8";
	if (e.includes("big5")) return "big5";
	if (e.includes("shiftjis") || e.includes("sjis") || e.includes("eucjp")) return "shift_jis";
	return "gb18030";
}

function isMostlyText(s: string): boolean {
	if (!s) return false;
	let control = 0;
	for (const ch of s) {
		const code = ch.charCodeAt(0);
		if (code < 32 && code !== 9 && code !== 10 && code !== 13) control++;
	}
	return control / s.length < 0.05;
}

function guessTitle(path: string, content: string): string {
	const base = path.split("/").pop()?.replace(/\.txt$/i, "") || "未命名 TXT";
	const firstLine = content.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
	if (firstLine.length > 0 && firstLine.length <= 40 && CHAPTER_RE.test(firstLine) === false) return firstLine;
	return base;
}

/** 按空行/换行切段，并识别章节标题。 */
export function splitParagraphs(content: string): { paragraphs: string[]; chapters: Array<{ title: string; startParagraph: number }> } {
	const raw = content.replace(/\r\n/g, "\n");
	const blocks = raw.split(/\n{2,}/).map((b) => b.trim());
	const paragraphs = blocks.filter((b) => b.length > 0);
	const chapters: Array<{ title: string; startParagraph: number }> = [];
	paragraphs.forEach((p, i) => {
		const first = p.split("\n")[0].trim();
		if (CHAPTER_RE.test(first)) chapters.push({ title: first.slice(0, 60), startParagraph: i });
	});
	return { paragraphs, chapters };
}

