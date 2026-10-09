/**
 * TXT 解析器：编码检测（jschardet）+ 解码（iconv-lite）+ 章节识别。
 * 章节识别为"尽力而为"，不命中也能整本阅读。
 *
 * v0.5 大文件重构（40MB / 50 万段 TXT 打开慢的三处根因）：
 * 1) 解析器与阅读引擎各自 `decodeBuffer` + `splitParagraphs` 一次：整本书在内存里
 *    同时存在两份解码字符串与两份段落数组。现在共用 loadTxtContent（按 buffer 身份缓存），
 *    全流程只解码/切段一次，切完即释放大字符串；
 * 2) splitParagraphs 改为单遍扫描：不再 `replace` 整串 + `split` 大数组 + `map` + `filter`
 *    四趟全量拷贝，也不再为每段 `split("\n")` 造临时数组；
 * 3) BookModel.spine 惰性构建：50 万段 = 50 万个对象（数十 MB），而 TXT 渲染与视图
 *    都不读它；改成首次访问时才生成（对外内容与旧实现完全一致）。
 */
import jschardet from "jschardet";
import iconv from "iconv-lite";
import type { BookModel, SpineItem, TocItem } from "../../../../types";
import type { IBookParser, ParseContext } from "../../Parser";

/** 常见中文章节标题正则：第x章 / 第x节 / 第x回 / 数字标题等 */
const CHAPTER_RE = /^\s*(?:第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章回节卷部篇集]|[0-9]+\s*[.、．]|卷\s*[0-9零一二三四五六七八九十百千万两]+).*$/;

export interface TxtContent {
	title: string;
	/** 按段落切分的文本数组 */
	paragraphs: string[];
	/** 每个段落对应的章节（若命中） */
	chapters: Array<{ title: string; startParagraph: number }>;
	/** 检测到的编码（诊断用，可缺省） */
	encoding?: string;
	/** 全书字符数（进度展示/索引） */
	estimatedChars?: number;
}

export class TxtParser implements IBookParser {
	readonly format = "txt" as const;

	async parse(ctx: ParseContext): Promise<BookModel> {
		const { title, paragraphs, chapters, estimatedChars } = loadTxtContent(ctx.buffer, ctx.path);
		const toc: TocItem[] = chapters.map((c, i) => ({
			id: `txt-ch-${i}`,
			label: c.title,
			location: String(c.startParagraph),
		}));
		// spine 惰性构建：大 TXT 的 spine 只是段索引镜像，无人读取时不必付 50 万对象的代价。
		let spine: SpineItem[] | null = null;
		return {
			fingerprint: ctx.fingerprint,
			path: ctx.path,
			format: "txt",
			title,
			author: undefined,
			toc,
			get spine(): SpineItem[] {
				if (!spine) spine = buildTxtSpine(paragraphs.length);
				return spine;
			},
			estimatedChars,
		};
	}
}

/** 按段落数生成 spine（与旧实现逐项一致）。 */
export function buildTxtSpine(count: number): SpineItem[] {
	const spine: SpineItem[] = new Array(Math.max(0, count));
	for (let i = 0; i < count; i++) spine[i] = { id: `p${i}`, href: String(i), title: undefined };
	return spine;
}

/** 已解码 + 已切段的全书内容（不保留原始大字符串）。 */
export interface TxtLoadedContent extends TxtContent {
	encoding: string;
	estimatedChars: number;
}

const contentCache = new WeakMap<ArrayBuffer, TxtLoadedContent>();

/**
 * 单次解码 + 切段（按 buffer 身份缓存）：解析器与阅读引擎共用同一份结果，
 * 避免 40MB 级 TXT 被解码两遍、段落数组存在两份。
 */
export function loadTxtContent(buffer: ArrayBuffer, path = ""): TxtLoadedContent {
	const cached = contentCache.get(buffer);
	if (cached) return cached;
	const { content, encoding } = decodeBuffer(buffer);
	const loaded = buildTxtContent(content, path, encoding);
	contentCache.set(buffer, loaded);
	return loaded;
}

/** 释放缓存（关闭书籍时调用，让段落数组可被回收）。 */
export function releaseTxtContent(buffer: ArrayBuffer): void {
	contentCache.delete(buffer);
}

function buildTxtContent(content: string, path: string, encoding: string): TxtLoadedContent {
	const title = guessTitle(path, content);
	const { paragraphs, chapters } = splitParagraphs(content);
	// 注意：这里只保留切段结果，content 大字符串在本函数返回后即可被 GC 回收。
	return { title, paragraphs, chapters, encoding, estimatedChars: content.length };
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
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code < 32 && code !== 9 && code !== 10 && code !== 13) control++;
	}
	return control / s.length < 0.05;
}

function guessTitle(path: string, content: string): string {
	const base = path.split("/").pop()?.replace(/\.txt$/i, "") || "未命名 TXT";
	const firstLine = firstNonEmptyLine(content);
	if (firstLine.length > 0 && firstLine.length <= 40 && CHAPTER_RE.test(firstLine) === false) return firstLine;
	return base;
}

/** 第一行非空文本（不复制整表行数组）。 */
function firstNonEmptyLine(content: string): string {
	let start = 0;
	while (start <= content.length) {
		const nl = content.indexOf("\n", start);
		const end = nl < 0 ? content.length : nl;
		const line = content.slice(start, end).trim();
		if (line.length > 0) return line;
		if (nl < 0) break;
		start = nl + 1;
	}
	return "";
}

/**
 * 按空行切段，并识别章节标题。
 *
 * 单遍扫描实现；与旧实现
 * `content.replace(/\r\n/g, "\n").split(/\n{2,}/).map(trim).filter(非空)`
 * 的分段边界等价（分段符 = 连续的 CRLF/LF 空行）。
 */
export function splitParagraphs(content: string): { paragraphs: string[]; chapters: Array<{ title: string; startParagraph: number }> } {
	const paragraphs: string[] = [];
	const chapters: Array<{ title: string; startParagraph: number }> = [];
	const separator = /\r?\n(?:\r?\n)+/g;
	// 与旧实现一致：块内 CRLF 归一为 LF（裸 CR 保持原样，行为不变）
	const pushBlock = (raw: string): void => {
		const text = (raw.indexOf("\r") >= 0 ? raw.replace(/\r\n/g, "\n") : raw).trim();
		if (!text) return;
		const index = paragraphs.length;
		paragraphs.push(text);
		const first = firstLineOf(text);
		if (CHAPTER_RE.test(first)) chapters.push({ title: first.slice(0, 60), startParagraph: index });
	};
	let cursor = 0;
	let m: RegExpExecArray | null;
	while ((m = separator.exec(content)) !== null) {
		pushBlock(content.slice(cursor, m.index));
		cursor = m.index + m[0].length;
	}
	pushBlock(content.slice(cursor));
	return { paragraphs, chapters };
}

function firstLineOf(text: string): string {
	const nl = text.indexOf("\n");
	return (nl < 0 ? text : text.slice(0, nl)).trim();
}
