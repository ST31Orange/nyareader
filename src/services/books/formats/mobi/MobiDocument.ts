/**
 * MOBI / AZW3 渲染数据源（v0.5 大文件重构，与 EpubDocument + EpubLazyLoader 同构）。
 *
 * 旧实现（根因，已修）：`extractMobiContent` 一次性把整本正文解压成一个大 Uint8Array，
 * 再全量字节扫描 filepos、全量插入锚点（**又复制一份**）、整串解码、多趟整串正则
 * （去 pagebreak / 合并多文档 / 改写链接 / 两趟目录提取），最后拼成整本 HTML 丢给 iframe。
 * 首屏成本随整本体积线性增长，且同一本书"解析一次 + 渲染再一次"要跑两遍。
 *
 * 现在：
 * 1) 结构解析一次，按 ArrayBuffer 身份缓存（WeakMap）：解析期 `MobiParser` 与渲染期
 *    `MobiContentSource` 共用同一次解压 + 同一次扫描。
 * 2) **单趟扫描**（旧实现正文有 5 趟整串 pass）：一次字节循环同时收集切章候选
 *    （`<mbp:pagebreak>` / `<html>` / `<h1..h3>`）、filepos 目标、标题与内联目录链接，
 *    并跳过 `<style>/<script>/<!--` 等不可切分区域。
 * 3) 切章：真边界优先 —— `<mbp:pagebreak>`（MOBI6 分页/分章）→ `<html>` 骨架文档
 *    （KF8/AZW3，语义等价于 EPUB 的 spine item）→ `<h1..h3>` 标题；三级都不可用时才
 *    退化为"近似块"（按标签边界 ≤ MAX_CHAPTER_BYTES 切块）。超长章节同样按标签边界细切，
 *    保证「首屏只建前 N 章」在单 flow 的 MOBI 上也成立。
 * 4) 正文按需重建：结构只保留每条正文记录的 (全局起始偏移, 解压长度)，读第 k 章时才
 *    重新解压涉及的记录（小 FIFO 缓存），不常驻整本解压结果。
 * 5) 锚点在**字节层按章插入**：filepos 目标只落在本章；id 仍是绝对偏移 `nyareader-fp-N`
 *    （跨章链接语义不变），标题锚点 `nyareader-toc-N` 让目录能落到标题而不是章首。
 * 6) 图片：`recindex` / `kindle:embed:XXXX`(base32) → 资源记录 → blob URL，由引擎的
 *    `resolveAsset` 按需回填（`data-nyar-asset`）；无法解析的登记为占位，
 *    引擎加 `nyareader-img-missing` 可见占位 —— 不再隐藏或清空 src。
 */
import type { TocItem } from "../../../../types";
import { decompressPalmDoc } from "./palmdoc";

// ---------- 常量 ----------

/** 章节锚点 id 前缀（目录/进度跳转用；追加前后不变）。 */
export const MOBI_ANCHOR_PREFIX = "nyareader-mobi-";
/** 标题锚点 id 前缀（标题目录落到标题本身，而不是所在块首）。 */
export const MOBI_TOC_ANCHOR_PREFIX = "nyareader-toc-";
/** 图片登记属性：值形如 mobi-rec-<记录号>；引擎据此按需解析为 blob: URL。 */
export const MOBI_ASSET_ATTR = "data-nyar-asset";
/** 原始引用（诊断/回退信息；已移除 src，浏览器不会去请求它）。 */
export const MOBI_ASSET_FALLBACK_ATTR = "data-nyar-src";
/** 可解析资源 key 前缀。 */
export const MOBI_ASSET_KEY_PREFIX = "mobi-rec-";
/** 不可解析资源 key 前缀（引擎解析返回 null -> 可见占位）。 */
export const MOBI_ASSET_MISSING_PREFIX = "mobi-missing:";
/** 首屏默认构建块数（其余后台补块）。 */
export const DEFAULT_MOBI_INITIAL_CHAPTERS = 2;
/** 单块上限：超过就按标签边界细切（保证首屏只建前 N 块）。 */
export const MAX_CHAPTER_BYTES = 128 * 1024;
/** 相邻切分点最小间距：过滤过密候选（例如每段都有小标题）。 */
export const MIN_CHAPTER_BYTES = 512;
/** 解压记录缓存条数（每条 ≤ recordSize，默认 4KB；FIFO 淘汰）。 */
const RECORD_CACHE_LIMIT = 64;

const PALMDOC_HEADER_SIZE = 16;
const DEFAULT_RECORD_SIZE = 4096;

// ---------- 错误 ----------

export type MobiParseFailure = "encrypted" | "unsupported-compression" | "truncated" | "no-text" | "internal";

export class MobiParseError extends Error {
	constructor(readonly reason: MobiParseFailure, message: string) {
		super(message);
		this.name = "MobiParseError";
	}
}

// ---------- 正文记录解压 ----------

export interface TextRecordSpec {
	compression: number;
	textLength: number;
	textRecordCount: number;
	recordSize: number;
}

export interface TextRecordIndex {
	/** 拼接后的完整解压正文。 */
	text: Uint8Array;
	/** starts[r-1]：第 r 条正文记录（r 从 1 起）解压内容在 text 中的全局起始偏移。 */
	starts: number[];
	/** lengths[r-1]：该记录实际产出的长度（0 = 记录为空/被跳过）。 */
	lengths: number[];
}

/**
 * 按"记录 1 .. textRecordCount"逐条解压正文，同时记录每条记录的全局偏移/长度，
 * 供后续"按章按需重解压"使用（旧实现只返回拼好的大数组，无法定位到记录）。
 * 每条记录解压后按 recordSize 截断，以丢弃记录尾部的检索用附加数据。
 */
export function readTextRecordsIndexed(
	bytes: Uint8Array,
	recordOffset: (index: number) => number,
	spec: TextRecordSpec
): TextRecordIndex {
	const chunks: Uint8Array[] = [];
	const count = Math.max(0, spec.textRecordCount);
	const starts = new Array<number>(count).fill(0);
	const lengths = new Array<number>(count).fill(0);
	let remaining = spec.textLength;
	let cursor = 0;
	let last = 0;
	for (let r = 1; r <= count && remaining > 0; r++) {
		starts[r - 1] = cursor;
		last = r;
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
		lengths[r - 1] = chunk.length;
		remaining -= chunk.length;
		cursor += chunk.length;
	}
	// 循环因 remaining<=0 提前结束时，剩余记录的起点都等于正文末尾
	for (let r = last + 1; r <= count; r++) starts[r - 1] = cursor;
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(Math.min(total, spec.textLength));
	let off = 0;
	for (const chunk of chunks) {
		if (off >= out.length) break;
		const slice = chunk.subarray(0, Math.min(chunk.length, out.length - off));
		out.set(slice, off);
		off += slice.length;
	}
	return { text: out, starts, lengths };
}

/**
 * 按"记录 1 .. textRecordCount"逐条解压正文（保留旧签名与旧行为）。
 * 每条记录解压后按 recordSize 截断，以丢弃记录尾部的检索用附加数据。
 */
export function readTextRecords(
	bytes: Uint8Array,
	recordOffset: (index: number) => number,
	spec: TextRecordSpec
): Uint8Array {
	return readTextRecordsIndexed(bytes, recordOffset, spec).text;
}

// ---------- 单趟扫描：切章候选 + filepos + 标题 + 内联目录 ----------

export interface MobiHeading {
	level: number;
	/** 绝对字节偏移（指向 `<hN` 的 `<`）。 */
	offset: number;
	label: string;
}

export interface MobiAnchorLink {
	label: string;
	/** 目标 filepos 绝对字节偏移。 */
	target: number;
}

export interface MobiScan {
	pagebreaks: number[];
	htmlStarts: number[];
	headingOffsets: number[];
	headings: MobiHeading[];
	fileposTargets: number[];
	anchorLinks: MobiAnchorLink[];
	/** 不可切分区域（style/script/注释）的 [start, end) 区间，已排序。 */
	excludedRanges: Array<[number, number]>;
}

/**
 * 单趟扫描解压后的正文（旧实现在正文上跑了 5 趟整串 pass）。
 *
 * 同一趟里完成：
 * - 切章候选：`<mbp:pagebreak>`、`<html>` 骨架文档、`<h1..h3>`；
 * - filepos 目标（`filepos=NNN`，含 `<a>` 内的）；
 * - 标题条目（用于目录）+ 内联目录链接（`<a filepos=...>label</a>`，MOBI6 常见）；
 * - 排除 `<style>/<script>/<!--` 区域，避免把块切在 CSS/脚本里。
 */
export function scanMobiText(text: Uint8Array): MobiScan {
	const scan: MobiScan = {
		pagebreaks: [],
		htmlStarts: [],
		headingOffsets: [],
		headings: [],
		fileposTargets: [],
		anchorLinks: [],
		excludedRanges: [],
	};
	const n = text.length;
	const seenTargets = new Set<number>();
	const pushTarget = (value: number): void => {
		if (value <= 0 || seenTargets.has(value)) return;
		seenTargets.add(value);
		scan.fileposTargets.push(value);
	};
	let i = 0;
	while (i < n) {
		const c = text[i];
		if (c === 0x3c /* < */) {
			const skip = opaqueRegionEnd(text, i);
			if (skip > i) {
				scan.excludedRanges.push([i, skip]);
				i = skip;
				continue;
			}
			if (matchTagName(text, i, "mbp:pagebreak")) {
				scan.pagebreaks.push(i);
				i = tagEnd(text, i);
				continue;
			}
			if (matchTagName(text, i, "html")) {
				scan.htmlStarts.push(i);
				i++;
				continue;
			}
			const level = headingLevel(text, i);
			if (level > 0) {
				const open = tagEnd(text, i);
				const close = findCloseTag(text, open, `</h${level}`);
				const labelEnd = close >= 0 ? Math.min(close, open + 512) : Math.min(n, open + 512);
				const label = cleanLabel(decodeBytes(text, open, labelEnd)).slice(0, 60);
				if (label) {
					scan.headingOffsets.push(i);
					scan.headings.push({ level, offset: i, label });
				}
				i = Math.max(close >= 0 ? close + 5 : open, i + 1);
				continue;
			}
			if (matchTagName(text, i, "a")) {
				const open = tagEnd(text, i);
				const target = readFileposAttr(text, i, open);
				const close = findCloseTag(text, open, "</a");
				if (target !== null) {
					pushTarget(target);
					if (close >= 0 && scan.anchorLinks.length < 400) {
						const raw = cleanLabel(decodeBytes(text, open, Math.min(close, open + 512)));
						const label = raw.replace(/&nbsp;/gi, " ").trim();
						if (label) scan.anchorLinks.push({ label: label.slice(0, 80), target });
					}
				}
				i = close >= 0 ? close + 4 : Math.max(open, i + 1);
				continue;
			}
			i++;
			continue;
		}
		if (c === 0x66 /* f */ && matchAsciiAt(text, i, "filepos=")) {
			const digits = readDigits(text, i + 8);
			if (digits.value !== null) pushTarget(digits.value);
			i = Math.max(digits.end, i + 1);
			continue;
		}
		i++;
	}
	scan.fileposTargets.sort((a, b) => a - b);
	return scan;
}

/** 判断 `<style>/<script>/<!--` 区域并返回其结束位置（无则返回起点，表示不跳过）。 */
function opaqueRegionEnd(text: Uint8Array, i: number): number {
	if (text[i] !== 0x3c) return i;
	if (text[i + 1] === 0x21 && text[i + 2] === 0x2d && text[i + 3] === 0x2d) {
		const end = findAsciiAt(text, i + 4, "-->");
		return end >= 0 ? end + 3 : i;
	}
	for (const name of ["style", "script"]) {
		if (!matchTagName(text, i, name)) continue;
		const open = tagEnd(text, i);
		const close = findCloseTag(text, open, `</${name}`);
		if (close < 0) return i;
		const closeEnd = tagEnd(text, close);
		return closeEnd > close ? closeEnd : close + name.length + 3;
	}
	return i;
}

/** `<name` 且后面是空白/`>`/`/`（大小写不敏感）。 */
function matchTagName(text: Uint8Array, i: number, name: string): boolean {
	if (text[i] !== 0x3c) return false;
	const n = name.length;
	if (i + 1 + n > text.length) return false;
	for (let k = 0; k < n; k++) {
		if (lowerByte(text[i + 1 + k]) !== name.charCodeAt(k)) return false;
	}
	const after = text[i + 1 + n];
	return after === undefined || after === 0x20 || after === 0x3e || after === 0x2f || after === 0x09 || after === 0x0a || after === 0x0d;
}

/** `<h1`/`<h2`/`<h3`（后面是空白或 `>`），返回级别，否则 0。 */
function headingLevel(text: Uint8Array, i: number): number {
	if (text[i] !== 0x3c) return 0;
	const h = lowerByte(text[i + 1]);
	if (h !== 0x68 /* h */) return 0;
	const d = text[i + 2];
	if (d < 0x31 || d > 0x33) return 0;
	const after = text[i + 3];
	if (after === undefined || after === 0x20 || after === 0x3e || after === 0x09 || after === 0x0a || after === 0x0d) return d - 0x30;
	return 0;
}

/** 从 from 起找 `</hN` / `</a`（大小写不敏感），返回匹配起点，找不到返回 -1。 */
function findCloseTag(text: Uint8Array, from: number, needle: string): number {
	return findAsciiAt(text, from, needle);
}

function findAsciiAt(text: Uint8Array, from: number, needle: string): number {
	const first = needle.charCodeAt(0);
	const n = needle.length;
	for (let i = Math.max(0, from); i + n <= text.length; i++) {
		if (lowerByte(text[i]) !== first) continue;
		let k = 1;
		while (k < n && lowerByte(text[i + k]) === needle.charCodeAt(k)) k++;
		if (k === n) return i;
	}
	return -1;
}

function matchAsciiAt(text: Uint8Array, i: number, needle: string): boolean {
	if (i + needle.length > text.length) return false;
	for (let k = 0; k < needle.length; k++) if (text[i + k] !== needle.charCodeAt(k)) return false;
	return true;
}

function lowerByte(c: number): number {
	return c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
}

/** 返回 `<` 之后第一个 `>` 的下一个位置（找不到则返回起点 +1，避免死循环）。 */
function tagEnd(text: Uint8Array, i: number): number {
	for (let p = i + 1; p < text.length; p++) if (text[p] === 0x3e) return p + 1;
	return Math.min(text.length, i + 1);
}

/** 读 `<a ...>` 起始标签内的 `filepos=NNN`；没有则返回 null。 */
function readFileposAttr(text: Uint8Array, from: number, to: number): number | null {
	for (let i = from; i + 8 <= to; i++) {
		if (!matchAsciiAt(text, i, "filepos=")) continue;
		let p = i + 8;
		if (text[p] === 0x22 || text[p] === 0x27) p++;
		const digits = readDigits(text, p);
		if (digits.value !== null) return digits.value;
	}
	return null;
}

/** 从 from 起读连续十进制数字。 */
function readDigits(text: Uint8Array, from: number): { value: number | null; end: number } {
	let p = from;
	let acc = 0;
	while (p < text.length && text[p] >= 0x30 && text[p] <= 0x39) {
		acc = acc * 10 + (text[p] - 0x30);
		p++;
		if (acc > Number.MAX_SAFE_INTEGER / 16) break;
	}
	return p > from && Number.isFinite(acc) ? { value: acc, end: p } : { value: null, end: from };
}

function decodeBytes(text: Uint8Array, from: number, to: number): string {
	const end = Math.max(from, Math.min(to, text.length));
	return new TextDecoder("utf-8", { fatal: false }).decode(text.subarray(from, end));
}

function cleanLabel(text: string): string {
	return text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

// ---------- 锚点插入 ----------

export interface AnchorInsert {
	/** 绝对字节偏移（= 锚点 id 编号语义）；插入点 = offset - base。 */
	offset: number;
	id: string;
}

/**
 * 在字节层插入锚点（绝不在多字节字符中间插入 —— 只在 `<` 之前）。
 *
 * 允许 local === 0：切分候选本身就是标题时，"标题锚点"与"块起点"重合，
 * 这种情况必须照样插入（否则标题目录会跳到块首而不是标题）。
 */
function insertAnchors(text: Uint8Array, base: number, anchors: readonly AnchorInsert[]): Uint8Array {
	const sorted = anchors
		.map((a) => ({ local: a.offset - base, id: a.id }))
		.filter((a) => a.local >= 0 && a.local <= text.length)
		.sort((a, b) => a.local - b.local);
	if (sorted.length === 0) return text;
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];
	let cursor = 0;
	for (const a of sorted) {
		if (a.local < cursor) continue;
		parts.push(text.subarray(cursor, a.local), encoder.encode(`<span id="${a.id}"></span>`));
		cursor = a.local;
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

/**
 * 把 MOBI6 的 `filepos=<字节偏移>` 目标转成可在 DOM 中跳转的锚点。
 * 只在目标位置确实是标签起始（'<'）时插入，避免切断多字节字符或破坏正文。
 *
 * @param opts.base 切片起点（按章插入时用）；缺省 0 = 旧的全量行为。
 * @param opts.targets 已扫描出的 filepos 目标；缺省时在本段内重新扫描。
 */
export function applyFileposAnchors(
	text: Uint8Array,
	opts: { base?: number; targets?: readonly number[] } = {}
): Uint8Array {
	const base = opts.base ?? 0;
	const list = opts.targets ?? scanFileposOffsets(text);
	const anchors: AnchorInsert[] = [];
	for (const off of list) {
		const local = off - base;
		if (local > 0 && local < text.length && text[local] === 0x3c) {
			anchors.push({ offset: off, id: fileposAnchorId(off) });
		}
	}
	return insertAnchors(text, base, anchors);
}

/** 按字节扫描出所有 `filepos=<数字>` 指向的目标偏移。 */
export function scanFileposOffsets(text: Uint8Array): number[] {
	const found: number[] = [];
	for (let i = 0; i + 8 < text.length; i++) {
		if (text[i] !== 0x66) continue;
		if (!matchAsciiAt(text, i, "filepos=")) continue;
		let p = i + 8;
		if (text[p] === 0x22 || text[p] === 0x27) p++;
		const digits = readDigits(text, p);
		if (digits.value !== null) found.push(digits.value);
	}
	return found;
}

export function fileposAnchorId(offset: number): string {
	return `nyareader-fp-${offset}`;
}

/** filepos 锚点 id 前缀（跳转钩子识别用）。 */
export const FILEPOS_ANCHOR_PREFIX = "nyareader-fp-";

/** 把 `filepos=NNN` 属性改写为 `href="#nyareader-fp-NNN"`。 */
export function rewriteFileposLinks(html: string): string {
	return html.replace(
		/(\s)filepos=["']?(\d+)["']?/gi,
		(_all, space: string, raw: string) => `${space}href="#${fileposAnchorId(parseInt(raw, 10))}"`
	);
}

// ---------- 文档合并 / 解包 ----------

/**
 * KF8/AZW3 的正文是多个相互独立的 XHTML 文档拼接而成（Standard Ebooks 那本有 65 个）。
 * 观察真实 KF8 样本发现的关键结构（v0.3.3 重写合并策略）：
 * - 每个 `<html>…</html>` 块是"骨架"：<head> 里有样式引用，<body> 是空的（aid="0"）；
 * - 真实章节内容（<section>/<p>/<h1>…）位于骨架块之**间**；
 * - 旧实现只取每个骨架 body 的 innerHTML，等于只拿到 65 个空 body → 白屏。
 * 因此合并策略为：保留骨架之间（以及非空 body 内）的全部正文，丢弃空骨架；
 * <head> 中若确有内联 <style> 才保留，跨文档丢弃 kindle:flow: 样式链接。
 *
 * 现在按块调用（每块 = 一个章节），语义与整本调用一致：顺序拼接不变量不变。
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
		const between = stripXmlDecls(html.slice(last, m.index));
		if (between.trim()) bodyParts.push(between);
		const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(doc);
		if (head && /<style\b/i.test(head[1])) heads.push(head[1]);
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

/**
 * 把（可能仍带 <html>/<head>/<body> 外壳的）片段解包成可追加到正文容器的 HTML：
 * 内联 <style> 单独抽出交给调用方去重后注入，其余外壳标签剥掉。
 */
export function unwrapMobiDocument(html: string): { styles: string[]; body: string } {
	const styles: string[] = [];
	let out = html.replace(/<\?xml[^>]*\?>/gi, "").replace(/<!DOCTYPE[^>]*>/gi, "");
	out = out.replace(/<head\b[^>]*>([\s\S]*?)<\/head>/gi, (_all, inner: string) => {
		const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
		let m: RegExpExecArray | null;
		while ((m = re.exec(inner)) !== null) {
			const css = m[1].trim();
			if (css) styles.push(css);
		}
		return "";
	});
	out = out
		.replace(/<\/?html\b[^>]*>/gi, "")
		.replace(/<\/?body\b[^>]*>/gi, "")
		.trim();
	// 纯文本 MOBI（没有根标签）：保留段落结构（旧行为）
	if (!/<[a-z!/][\s\S]*?>/i.test(out)) out = plainTextToParagraphs(out);
	return { styles, body: out };
}

function plainTextToParagraphs(text: string): string {
	return text
		.split(/\r?\n{2,}/)
		.map((p) => `<p>${escapeHtml(p.trim())}</p>`)
		.join("");
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- 目录提取（保留旧纯函数，目录用结构版） ----------

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

// ---------- 章节切分 ----------

export interface MobiChapterRange {
	/** 起始绝对字节偏移（含）。 */
	start: number;
	/** 结束绝对字节偏移（不含）。 */
	end: number;
}

/** 选切分候选：真边界优先，三级都不可用时返回空（调用方退化为按大小切块）。 */
function pickCutCandidates(scan: MobiScan): number[] {
	if (scan.pagebreaks.length >= 2) return scan.pagebreaks;
	if (scan.htmlStarts.length >= 2) return scan.htmlStarts;
	if (scan.headingOffsets.length >= 2) return scan.headingOffsets;
	return [];
}

/**
 * 由扫描结果推导章节区间（纯函数，便于单测）。
 * 不变量：覆盖 [0, textLength) 无空洞、无重叠、严格递增、每块 ≥1 字节。
 */
export function buildMobiChapters(text: Uint8Array, scan: MobiScan): MobiChapterRange[] {
	const textLength = text.length;
	if (textLength <= 0) return [];
	const starts: number[] = [0];
	for (const c of pickCutCandidates(scan)) {
		if (c <= 0 || c >= textLength) continue;
		if (c - starts[starts.length - 1] < MIN_CHAPTER_BYTES) continue;
		starts.push(c);
	}
	const ranges: MobiChapterRange[] = [];
	for (let i = 0; i < starts.length; i++) {
		const from = starts[i];
		const to = i + 1 < starts.length ? starts[i + 1] : textLength;
		if (to - from <= MAX_CHAPTER_BYTES) {
			ranges.push({ start: from, end: to });
			continue;
		}
		// 超长块：按标签边界细切（首屏只建前 N 块这条保证依赖它）
		let cursor = from;
		while (to - cursor > MAX_CHAPTER_BYTES) {
			const cut = findSafeCut(text, cursor + MAX_CHAPTER_BYTES, to, scan.excludedRanges);
			if (cut <= cursor) break;
			ranges.push({ start: cursor, end: cut });
			cursor = cut;
		}
		ranges.push({ start: cursor, end: to });
	}
	return ranges;
}

/** 在 target 附近找一个安全的标签起点（不在 style/script/注释里）。 */
function findSafeCut(text: Uint8Array, target: number, limit: number, excluded: ReadonlyArray<[number, number]>): number {
	const window = 8192;
	const forwardEnd = Math.min(limit, target + window);
	for (let i = Math.max(1, target); i < forwardEnd; i++) {
		if (isSafeCutAt(text, i) && !inExcluded(excluded, i)) return i;
	}
	for (let i = Math.min(limit - 1, target - 1); i > Math.max(0, target - window); i--) {
		if (isSafeCutAt(text, i) && !inExcluded(excluded, i)) return i;
	}
	return -1;
}

function isSafeCutAt(text: Uint8Array, i: number): boolean {
	if (text[i] !== 0x3c) return false;
	const next = text[i + 1];
	if (next === undefined) return false;
	if (next === 0x2f /* / */ || next === 0x21 /* ! */) return true;
	return (next >= 0x41 && next <= 0x5a) || (next >= 0x61 && next <= 0x7a);
}

function inExcluded(excluded: ReadonlyArray<[number, number]>, pos: number): boolean {
	for (const [start, end] of excluded) {
		if (pos >= start && pos < end) return true;
	}
	return false;
}

/** 二分：包含该偏移的章节索引。 */
export function chapterIndexForOffset(ranges: readonly MobiChapterRange[], offset: number): number {
	if (ranges.length === 0) return 0;
	if (offset <= ranges[0].start) return 0;
	let lo = 0;
	let hi = ranges.length - 1;
	let ans = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (ranges[mid].start <= offset) {
			ans = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return Math.min(ranges.length - 1, Math.max(0, ans));
}

// ---------- 结构解析（一次） ----------

export interface MobiStructure {
	buffer: ArrayBuffer;
	bytes: Uint8Array;
	recordCount: number;
	textRecordCount: number;
	recordOffset: (index: number) => number;
	compression: number;
	recordSize: number;
	textLength: number;
	/** 每条正文记录解压内容的全局起始偏移/长度（按需重解压用）。 */
	recordStarts: number[];
	recordLengths: number[];
	chapters: MobiChapterRange[];
	fileposTargets: number[];
	headings: MobiHeading[];
	anchorLinks: MobiAnchorLink[];
	/** 第一条图片记录的记录号；-1 = 未识别（图片只能给占位）。 */
	firstImageRecord: number;
	title?: string;
	author?: string;
}

const EXTH_TYPE_TITLE = 503;
const EXTH_TYPE_AUTHOR = 100;

/**
 * 解析 MOBI 二进制为可复用结构：PalmDB 头 -> 记录偏移表 -> PalmDOC 头 -> 逐记录解压
 * -> 单趟扫描（切章/锚点/标题/目录）-> 丢弃大数组（只留记录级索引）。
 *
 * 失败抛 MobiParseError（原因分类见 MobiParseFailure），由调用方给出可执行提示。
 */
export function parseMobiStructure(bytes: Uint8Array): MobiStructure {
	return parseStructureInternal(bytes);
}

function parseStructureInternal(bytes: Uint8Array): MobiStructure {
	// PalmDB 头 78 字节
	if (bytes.length < 86) throw new MobiParseError("truncated", "文件过小，不是有效的 PalmDB 文件");
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

	const spec: TextRecordSpec = { compression, textLength, textRecordCount, recordSize };
	const indexed = readTextRecordsIndexed(bytes, recordOffset, spec);
	const text = indexed.text;
	if (text.length === 0) throw new MobiParseError("no-text", "正文记录解压为空");

	// 单趟扫描：切章候选 + filepos 目标 + 标题 + 内联目录
	const scan = scanMobiText(text);
	const chapters = buildMobiChapters(text, scan);

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

	return {
		buffer: bytes.buffer as ArrayBuffer,
		bytes,
		recordCount,
		textRecordCount,
		recordOffset,
		compression,
		recordSize,
		textLength,
		recordStarts: indexed.starts,
		recordLengths: indexed.lengths,
		chapters,
		fileposTargets: scan.fileposTargets,
		headings: scan.headings,
		anchorLinks: scan.anchorLinks,
		firstImageRecord: findFirstImageRecord(bytes, recordOffset, recordCount, textRecordCount, mobiHeaderOffset, mobiHeaderLen),
		title,
		author,
	};
}

/**
 * 找第一条图片记录。MOBI 头里"first image index"的偏移随版本漂移（0x60/0x6C 等），
 * 因此这里**逐个候选用图片魔数验证**，哪个先验证通过用哪个；都不通过就从正文记录之后
 * 顺序找一小段窗口。这样即使表头字段读错也不会把非图片记录当图片返回。
 */
function findFirstImageRecord(
	bytes: Uint8Array,
	recordOffset: (index: number) => number,
	recordCount: number,
	textRecordCount: number,
	mobiHeaderOffset: number,
	mobiHeaderLen: number
): number {
	const candidates: number[] = [];
	const headerEnd = mobiHeaderLen > 0 ? Math.min(bytes.length, mobiHeaderOffset + mobiHeaderLen) : 0;
	for (const rel of [0x6c, 0x60, 0x50, 0x40]) {
		const at = mobiHeaderOffset + rel;
		if (at + 4 > headerEnd) continue;
		candidates.push(readU32(bytes, at));
	}
	candidates.push(textRecordCount + 1);
	for (const c of candidates) {
		if (c > 0 && c < recordCount && isImageRecord(bytes, recordOffset, c)) return c;
	}
	for (let r = textRecordCount + 1; r < recordCount && r <= textRecordCount + 64; r++) {
		if (isImageRecord(bytes, recordOffset, r)) return r;
	}
	return -1;
}

function isImageRecord(bytes: Uint8Array, recordOffset: (index: number) => number, record: number): boolean {
	const start = recordOffset(record);
	const end = Math.min(recordOffset(record + 1), bytes.length);
	if (start < 0 || start + 4 > end) return false;
	return sniffImageMime(bytes.subarray(start, Math.min(end, start + 16))) !== undefined;
}

const IMAGE_MIME_BY_MAGIC: Array<{ bytes: number[]; mime: string }> = [
	{ bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
	{ bytes: [0x89, 0x50, 0x4e, 0x47], mime: "image/png" },
	{ bytes: [0x47, 0x49, 0x46, 0x38], mime: "image/gif" },
	{ bytes: [0x42, 0x4d], mime: "image/bmp" },
];

/** 按魔数识别图片类型；不是图片返回 undefined。 */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
	for (const sig of IMAGE_MIME_BY_MAGIC) {
		if (bytes.length < sig.bytes.length) continue;
		let ok = true;
		for (let i = 0; i < sig.bytes.length; i++) {
			if (bytes[i] !== sig.bytes[i]) {
				ok = false;
				break;
			}
		}
		if (ok) return sig.mime;
	}
	// RIFF....WEBP
	if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
		if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
	}
	// SVG（文本）
	if (bytes.length >= 4 && (bytes[0] === 0x3c || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf))) {
		const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 512)));
		if (/<svg\b/i.test(head)) return "image/svg+xml";
	}
	return undefined;
}

// ---------- 结构缓存 ----------

const structureCache = new WeakMap<ArrayBuffer, Promise<MobiStructure>>();

/** 打开并缓存 MOBI 结构（解析期与渲染期共用同一次解压 + 扫描）。 */
export function loadMobiStructure(buffer: ArrayBuffer): Promise<MobiStructure> {
	const cached = structureCache.get(buffer);
	if (cached) return cached;
	const task = Promise.resolve()
		.then(() => parseStructureInternal(new Uint8Array(buffer)))
		.catch((e: unknown) => {
			structureCache.delete(buffer);
			throw e;
		});
	structureCache.set(buffer, task);
	return task;
}

/** 释放结构缓存（关闭/切换书籍时调用；再打开会重新解压）。 */
export function releaseMobiStructure(buffer: ArrayBuffer): void {
	structureCache.delete(buffer);
}

// ---------- 纯字符串拼装 ----------

export function mobiChapterAnchorHtml(index: number): string {
	return `<span id="${MOBI_ANCHOR_PREFIX}${index}" class="nyareader-mobi-anchor"></span>`;
}

export function composeMobiDocument(title: string, headStyles: string[], bodies: string[]): string {
	const heads = headStyles.map((s) => `<style>${s}</style>`).join("\n");
	return (
		`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${heads}</head>` +
		`<body>${bodies.join("\n")}</body></html>`
	);
}

/**
 * 单块失败的可见占位正文（块锚点由 buildChapterChunk 追加，因此跳转/进度语义不变）。
 * 与 EpubDocument.failedChapterBody 同一套类名，便于样式与诊断统一识别。
 */
export function failedMobiChapterBody(index: number, error?: unknown): string {
	const detail = error instanceof Error && error.message ? `：${escapeHtml(error.message)}` : "";
	return `<p class="nyareader-chunk-failed" data-nyar-chunk-failed="${index}">（第 ${index + 1} 块内容读取失败，已跳过${detail}）</p>`;
}

// ---------- 图片登记 ----------

interface ParsedMobiImageRef {
	kind: "record" | "external" | "unresolvable";
	index?: number;
}

/** 解析 `<img src>` / `srcset` 里的 MOBI 图片引用。 */
export function parseMobiImageRef(src: string): ParsedMobiImageRef {
	const value = src.trim();
	if (!value) return { kind: "unresolvable" };
	if (/^(https?:|data:|blob:|file:|mailto:)/i.test(value)) return { kind: "external" };
	const lower = value.toLowerCase();
	if (lower.startsWith("kindle:embed:")) {
		const idx = parseBase32(value.slice("kindle:embed:".length));
		return idx === null ? { kind: "unresolvable" } : { kind: "record", index: idx };
	}
	if (lower.startsWith("kindle:")) return { kind: "unresolvable" };
	if (/^\d+$/.test(value)) {
		const n = parseInt(value, 10);
		return Number.isFinite(n) ? { kind: "record", index: n } : { kind: "unresolvable" };
	}
	return { kind: "unresolvable" };
}

/** KF8 的 `kindle:embed:XXXX` 用 base32（0-9A-V）编码 1-based 资源序号。 */
function parseBase32(raw: string): number | null {
	const s = raw.trim().split(/[^0-9a-vA-V]/)[0];
	if (!s) return null;
	let acc = 0;
	for (const ch of s) {
		const code = ch.charCodeAt(0);
		const digit = code >= 0x30 && code <= 0x39 ? code - 0x30 : code >= 0x41 && code <= 0x56 ? code - 0x41 + 10 : code >= 0x61 && code <= 0x76 ? code - 0x61 + 10 : -1;
		if (digit < 0) return null;
		acc = acc * 32 + digit;
	}
	return acc;
}

/** 资源序号（recindex / embed 编号，1-based）-> 记录号；两种常见约定都试，均无效返回 -1。 */
export function imageRecordForIndex(structure: MobiStructure, index: number): number {
	const first = structure.firstImageRecord;
	if (first <= 0 || !Number.isFinite(index) || index < 0) return -1;
	const a = first + index - 1;
	const b = first + index;
	if (isImageRecord(structure.bytes, structure.recordOffset, a)) return a;
	if (isImageRecord(structure.bytes, structure.recordOffset, b)) return b;
	return -1;
}

export function assetKeyForRecord(record: number): string {
	return `${MOBI_ASSET_KEY_PREFIX}${record}`;
}

function missingAssetKey(original: string): string {
	return `${MOBI_ASSET_MISSING_PREFIX}${original}`;
}

/**
 * 把正文里的 `<img>` 登记为可解析资源：
 * - `recindex` / `kindle:embed:` 指向真实图片记录 -> `data-nyar-asset="mobi-rec-<n>"`；
 * - 指向不存在的记录 / `kindle:flow:` / 相对路径 -> `data-nyar-asset="mobi-missing:..."`，
 *   引擎解析返回 null 后加 `nyareader-img-missing` 可见占位（不再隐藏/清空 src）；
 * - http(s)/data:/blob: 保持原样。
 * 原引用保存在 `data-nyar-src`（诊断用），src/srcset 被移除（srcdoc 下必然 404）。
 * 纯字符串函数，不做 I/O，便于单测。
 */
export function registerMobiImages(body: string, structure: MobiStructure): string {
	const re = /<img\b[^>]*>/gi;
	const tags: Array<{ tag: string; index: number; length: number }> = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(body)) !== null) tags.push({ tag: m[0], index: m.index, length: m[0].length });
	let out = body;
	for (const t of tags.reverse()) {
		const resolved = resolveMobiImageAsset(parseAttrs(t.tag), structure);
		if (!resolved) continue;
		let replacement = t.tag
			.replace(/\ssrcset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "")
			.replace(/\ssrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "")
			.replace(/\sxlink:href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "");
		replacement = injectAttr(replacement, MOBI_ASSET_FALLBACK_ATTR, resolved.original);
		replacement = injectAttr(replacement, MOBI_ASSET_ATTR, resolved.key);
		out = out.slice(0, t.index) + replacement + out.slice(t.index + t.length);
	}
	return registerMobiSvgImages(out, structure);
}

/** 图片属性 -> 资源 key（external/无 src 返回 null）。`<img>` 与 `<svg><image>` 共用。 */
function resolveMobiImageAsset(
	attrs: Record<string, string>,
	structure: MobiStructure
): { key: string; original: string } | null {
	const recindex = attrs.recindex?.trim();
	const src = attrs.src ?? attrs["xlink:href"] ?? firstSrcsetUrl(attrs.srcset);
	let original = src ?? "";
	if (recindex !== undefined && /^\d+$/.test(recindex)) {
		original = original || `recindex:${recindex}`;
		const rec = imageRecordForIndex(structure, parseInt(recindex, 10));
		return { key: rec > 0 ? assetKeyForRecord(rec) : missingAssetKey(original), original };
	}
	if (!src) return null;
	const parsed = parseMobiImageRef(src);
	if (parsed.kind === "external") return null;
	if (parsed.kind === "record" && parsed.index !== undefined) {
		const rec = imageRecordForIndex(structure, parsed.index);
		return { key: rec > 0 ? assetKeyForRecord(rec) : missingAssetKey(src), original: src };
	}
	return { key: missingAssetKey(src), original: src };
}

/**
 * 把「只包含一张 `<image>` 的 `<svg>` 包装」改写成 `<img data-nyar-asset>`（EPUB 侧同构修复）。
 *
 * KF8/AZW3 的封面页与漫画页常见写法：
 * `<svg viewBox="0 0 1200 1600"><image xlink:href="kindle:embed:0001" width="1200" height="1600"/></svg>`。
 * 引擎的资源回填只认 `<img data-nyar-asset>`，`<image xlink:href>` 在 srcdoc 里必然解析失败
 * → **封面页/整页插图是空白的**。这里在不改变"单图整页"语义的前提下改写成 `<img>`；
 * 含其它矢量元素的复杂 SVG 原样保留（浏览器能自己渲染，且其中外链本就是已知限制）。
 */
export function registerMobiSvgImages(body: string, structure: MobiStructure): string {
	if (!/<svg\b/i.test(body)) return body;
	const svgRe = /<svg\b[^>]*>[\s\S]*?<\/svg>/gi;
	const blocks: Array<{ block: string; index: number; length: number }> = [];
	let m: RegExpExecArray | null;
	while ((m = svgRe.exec(body)) !== null) blocks.push({ block: m[0], index: m.index, length: m[0].length });
	if (!blocks.length) return body;
	let out = body;
	for (const b of blocks.reverse()) {
		const replacement = mobiSingleImageSvgToImg(b.block, structure);
		if (!replacement) continue;
		out = out.slice(0, b.index) + replacement + out.slice(b.index + b.length);
	}
	return out;
}

function mobiSingleImageSvgToImg(svg: string, structure: MobiStructure): string | null {
	const inner = svg.replace(/^<svg\b[^>]*>/i, "").replace(/<\/svg\s*>$/i, "");
	if (/<\s*\/?\s*(?!(?:svg|image|title|desc|metadata|g)\b)[a-z]/i.test(inner)) return null;
	const images = inner.match(/<image\b[^>]*>/gi) ?? [];
	if (images.length !== 1) return null;
	const resolved = resolveMobiImageAsset(parseAttrs(images[0]), structure);
	if (!resolved) return null;
	const width = parseAttrs(images[0]).width;
	const numericWidth = width && /^\d+(?:\.\d+)?$/.test(width) ? width : "";
	const tag = numericWidth ? `<img width="${escapeAttr(numericWidth)}"` : `<img`;
	return `${tag} alt="" style="max-width:100%;height:auto" ${MOBI_ASSET_FALLBACK_ATTR}="${escapeAttr(
		resolved.original
	)}" ${MOBI_ASSET_ATTR}="${escapeAttr(resolved.key)}"/>`;
}

function firstSrcsetUrl(srcset: string | undefined): string | undefined {
	if (!srcset) return undefined;
	const first = srcset.split(",")[0]?.trim();
	if (!first) return undefined;
	const url = first.split(/\s+/)[0]?.trim();
	return url || undefined;
}

function injectAttr(tag: string, name: string, value: string): string {
	const selfClose = /\/\s*>$/.test(tag);
	const trimmed = tag.replace(/\s*\/?>$/, "");
	return `${trimmed} ${name}="${escapeAttr(value)}"${selfClose ? "/>" : ">"}`;
}

function escapeAttr(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function parseAttrs(tag: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(tag)) !== null) attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
	return attrs;
}

// ---------- MobiContentSource ----------

export interface MobiChapterDoc {
	body: string;
	styles: string[];
}

interface MobiAsset {
	bytes: Uint8Array;
	mime: string;
}

/** 样式稳定键（FNV-1a + djb2 + 长度）：只存键，不保留整串 CSS。 */
export function stableMobiStyleKey(style: string): string {
	let fnv = 2166136261;
	let djb = 5381;
	for (let i = 0; i < style.length; i++) {
		const c = style.charCodeAt(i);
		fnv = Math.imul(fnv ^ c, 16777619) >>> 0;
		djb = (Math.imul(djb, 33) ^ c) >>> 0;
	}
	return `${style.length}:${fnv.toString(16)}:${djb.toString(16)}`;
}

/**
 * 一本书的渲染数据源：按块构建 HTML（首屏优先）、按需重解压正文记录、按需解析内嵌图片。
 * 满足 `EpubChapterSource`（chapterCount / buildChapterChunk / chapterWeights）形状，
 * 可直接交给 EpubLazyLoader 复用同一套"首屏优先 + 后台补块 + 跳转前补块"契约。
 */
export class MobiContentSource {
	private readonly recordCache = new Map<number, Uint8Array>();
	private readonly styleKeys = new Set<string>();
	private readonly assetUrls = new Map<string, string | null>();
	private readonly assetInflight = new Map<string, Promise<string | null>>();

	constructor(private readonly structure: MobiStructure, readonly title: string) {}

	get chapterCount(): number {
		return this.structure.chapters.length;
	}

	/** 已登记的样式条数（去重后）。 */
	get styleCount(): number {
		return this.styleKeys.size;
	}

	/** 是否识别出了图片记录（false 时所有内嵌图片只能是占位）。 */
	get hasImageRecords(): boolean {
		return this.structure.firstImageRecord > 0;
	}

	get totalTextLength(): number {
		return this.structure.textLength;
	}

	/**
	 * 各块内容量权重 = 该块的字节长度。
	 * 用于把进度从"按块数"换成"按内容量"，避免长块在补块过程中让进度回退。
	 */
	chapterWeights(): number[] {
		return this.structure.chapters.map((c) => Math.max(1, c.end - c.start));
	}

	/** 含该字节偏移的块索引。 */
	chapterIndexForOffset(offset: number): number {
		return chapterIndexForOffset(this.structure.chapters, offset);
	}

	/**
	 * 锚点/目录定位符 -> 需要先补到的块索引；不是本源的定位符返回 null
	 * （调用方回退到通用的"百分比 -> 块"换算）。
	 */
	chapterIndexForAnchor(location: string): number | null {
		if (typeof location !== "string" || !location.startsWith("#")) return null;
		const id = location.slice(1);
		if (id.startsWith(MOBI_ANCHOR_PREFIX)) {
			const n = parseInt(id.slice(MOBI_ANCHOR_PREFIX.length), 10);
			return Number.isFinite(n) ? Math.max(0, Math.min(this.chapterCount - 1, n)) : null;
		}
		if (id.startsWith(MOBI_TOC_ANCHOR_PREFIX)) {
			const n = parseInt(id.slice(MOBI_TOC_ANCHOR_PREFIX.length), 10);
			const heading = Number.isFinite(n) ? this.structure.headings[n] : undefined;
			return heading ? this.chapterIndexForOffset(heading.offset) : null;
		}
		if (id.startsWith(FILEPOS_ANCHOR_PREFIX)) {
			const n = parseInt(id.slice(FILEPOS_ANCHOR_PREFIX.length), 10);
			return Number.isFinite(n) ? this.chapterIndexForOffset(n) : null;
		}
		return null;
	}

	/** 构建某一块的正文（同步；纯 CPU 无 I/O）。**永不抛异常**：单块失败降级为可见占位。 */
	buildChapterDoc(index: number): MobiChapterDoc {
		const range = this.structure.chapters[index];
		if (!range) return { body: failedMobiChapterBody(index), styles: [] };
		try {
			return this.buildChapterDocUnsafe(index, range);
		} catch (e) {
			// 损坏记录 / 解压异常：旧实现会抛到 EpubLazyLoader，使后台补块永久停在这一块
			// （用户可见症状＝"书断在中间、页数变少"）。这里降级为占位，块序继续推进。
			try {
				// eslint-disable-next-line no-console
				console.debug(`[NyaReader] mobi 第 ${index + 1} 块读取失败（已降级为占位）：${e instanceof Error ? e.message : String(e)}`);
			} catch {
				/* 诊断日志本身失败不影响阅读 */
			}
			return { body: failedMobiChapterBody(index, e), styles: [] };
		}
	}

	private buildChapterDocUnsafe(index: number, range: MobiChapterRange): MobiChapterDoc {
		const raw = this.readRange(range.start, range.end);
		const anchors: AnchorInsert[] = [];
		for (const target of this.structure.fileposTargets) {
			if (target < range.start) continue;
			if (target >= range.end) break;
			const local = target - range.start;
			if (local > 0 && local < raw.length && raw[local] === 0x3c) anchors.push({ offset: target, id: fileposAnchorId(target) });
		}
		for (let h = 0; h < this.structure.headings.length; h++) {
			const heading = this.structure.headings[h];
			if (heading.offset < range.start) continue;
			if (heading.offset >= range.end) break;
			anchors.push({ offset: heading.offset, id: `${MOBI_TOC_ANCHOR_PREFIX}${h}` });
		}
		const anchored = insertAnchors(raw, range.start, anchors);
		let s = new TextDecoder("utf-8", { fatal: false }).decode(anchored);
		s = s.replace(/<mbp:pagebreak[^>]*>/gi, "");
		// KF8/AZW3 的多文档骨架按块等价合并（顺序语义与整本合并一致）
		if (/<html[\s>]/i.test(s)) s = mergeHtmlDocuments(s);
		s = rewriteFileposLinks(s);
		const unwrapped = unwrapMobiDocument(s);
		const styles: string[] = [];
		for (const style of unwrapped.styles) {
			const key = stableMobiStyleKey(style);
			if (this.styleKeys.has(key)) continue;
			this.styleKeys.add(key);
			styles.push(style);
		}
		return { body: registerMobiImages(unwrapped.body, this.structure), styles };
	}

	/** 可直接追加到引擎文档末尾的块片段（增量样式 + 章锚点 + 正文）。永不抛异常。 */
	async buildChapterChunk(index: number): Promise<string> {
		const doc = this.buildChapterDoc(index);
		const styles = doc.styles.map((s) => `<style>${s}</style>`).join("\n");
		return `${styles}${mobiChapterAnchorHtml(index)}${doc.body}`;
	}

	/** 首屏文档：只构建前 initialChapters 块。 */
	async buildInitialHtml(initialChapters: number = DEFAULT_MOBI_INITIAL_CHAPTERS): Promise<string> {
		const total = this.chapterCount;
		const n = Math.max(1, Math.min(total || 1, Math.floor(initialChapters) > 0 ? Math.floor(initialChapters) : 1));
		const headStyles: string[] = [];
		const bodies: string[] = [];
		for (let i = 0; i < n && i < total; i++) {
			const doc = this.buildChapterDoc(i);
			for (const style of doc.styles) headStyles.push(style);
			bodies.push(`${mobiChapterAnchorHtml(i)}${doc.body}`);
		}
		return composeMobiDocument(this.title, headStyles, bodies);
	}

	/** 全量文档（旧 extractMobiContent 的等价路径；大书慎用）。 */
	buildFullHtml(): string {
		const headStyles: string[] = [];
		const bodies: string[] = [];
		for (let i = 0; i < this.chapterCount; i++) {
			const doc = this.buildChapterDoc(i);
			for (const style of doc.styles) headStyles.push(style);
			bodies.push(`${mobiChapterAnchorHtml(i)}${doc.body}`);
		}
		return composeMobiDocument(this.title, headStyles, bodies);
	}

	/** 目录：标题优先（落到标题锚点），退回内联锚点目录（filepos）。 */
	buildToc(): TocItem[] {
		const toc: TocItem[] = [];
		for (let i = 0; i < this.structure.headings.length && toc.length < 200; i++) {
			const h = this.structure.headings[i];
			toc.push({ id: `mobi-toc-${i}`, label: h.label.slice(0, 60), location: `#${MOBI_TOC_ANCHOR_PREFIX}${i}` });
		}
		if (toc.length > 0) return toc;
		for (let i = 0; i < this.structure.anchorLinks.length && toc.length < 400; i++) {
			const a = this.structure.anchorLinks[i];
			toc.push({ id: `mobi-anchor-${i}`, label: a.label.slice(0, 80), location: `#${fileposAnchorId(a.target)}` });
		}
		return toc;
	}

	/** 读取某条正文记录（按需解压 + FIFO 缓存）。 */
	private readRecord(record: number): Uint8Array {
		const cached = this.recordCache.get(record);
		if (cached) return cached;
		const bytes = this.decompressRecord(record);
		if (this.recordCache.size >= RECORD_CACHE_LIMIT) {
			const oldest = this.recordCache.keys().next().value;
			if (oldest !== undefined) this.recordCache.delete(oldest);
		}
		this.recordCache.set(record, bytes);
		return bytes;
	}

	/** 与 readTextRecordsIndexed 完全一致地重解压第 record 条（预算 = 首次解压的剩余长度）。 */
	private decompressRecord(record: number): Uint8Array {
		const s = this.structure;
		const start = s.recordOffset(record);
		const end = Math.min(s.recordOffset(record + 1), s.bytes.length);
		if (start < 0 || start >= end) return new Uint8Array(0);
		const budget = Math.min(s.recordSize, s.textLength - s.recordStarts[record - 1]);
		if (!(budget > 0)) return new Uint8Array(0);
		return s.compression === 1
			? s.bytes.slice(start, Math.min(end, start + budget))
			: decompressPalmDoc(s.bytes, start, end, budget);
	}

	/** 物化 [start, end) 的正文字节（跨记录拼接）。 */
	private readRange(start: number, end: number): Uint8Array {
		const s = this.structure;
		const out = new Uint8Array(Math.max(0, end - start));
		let pos = start;
		let o = 0;
		for (let r = this.recordIndexForOffset(start); r <= s.recordStarts.length && pos < end; r++) {
			const recStart = s.recordStarts[r - 1];
			const chunk = this.readRecord(r);
			if (chunk.length === 0) continue;
			const from = Math.max(0, pos - recStart);
			const take = Math.min(chunk.length - from, end - pos);
			if (take <= 0) continue;
			out.set(chunk.subarray(from, from + take), o);
			o += take;
			pos += take;
		}
		return o === out.length ? out : out.subarray(0, o);
	}

	/** 含 offset 的正文记录号（1-based；跳过长度为 0 的记录）。 */
	private recordIndexForOffset(offset: number): number {
		const starts = this.structure.recordStarts;
		if (starts.length === 0) return 1;
		let lo = 0;
		let hi = starts.length - 1;
		let ans = 0;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (starts[mid] <= offset) {
				ans = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		while (ans < starts.length && this.structure.recordLengths[ans] <= 0) ans++;
		return ans + 1;
	}

	// ---------- 资源（内嵌图片）按需解析 ----------

	/** 读取资源记录的字节 + MIME；key 非本格式或不是图片时返回 null。 */
	readAsset(key: string): MobiAsset | null {
		if (!key.startsWith(MOBI_ASSET_KEY_PREFIX)) return null;
		const record = parseInt(key.slice(MOBI_ASSET_KEY_PREFIX.length), 10);
		if (!Number.isFinite(record) || record <= 0 || record >= this.structure.recordCount) return null;
		const start = this.structure.recordOffset(record);
		const end = Math.min(this.structure.recordOffset(record + 1), this.structure.bytes.length);
		if (start < 0 || start >= end) return null;
		const bytes = this.structure.bytes.subarray(start, end);
		const mime = sniffImageMime(bytes.subarray(0, Math.min(bytes.length, 512)));
		return mime ? { bytes, mime } : null;
	}

	/**
	 * 解析登记的图片为可显示 URL（blob:）；结果按 key 缓存，同一资源只创建一个 URL。
	 * 失败返回 null（引擎据此保留 `nyareader-img-missing` 可见占位）。
	 */
	async resolveAssetUrl(key: string): Promise<string | null> {
		if (this.assetUrls.has(key)) return this.assetUrls.get(key) ?? null;
		const running = this.assetInflight.get(key);
		if (running) return running;
		const task = (async (): Promise<string | null> => {
			const asset = this.readAsset(key);
			let url: string | null = null;
			if (asset) {
				try {
					url =
						typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
							? URL.createObjectURL(new Blob([asset.bytes as BlobPart], { type: asset.mime }))
							: null;
				} catch {
					url = null;
				}
			}
			this.assetUrls.set(key, url);
			return url;
		})();
		this.assetInflight.set(key, task);
		try {
			return await task;
		} finally {
			this.assetInflight.delete(key);
		}
	}

	/** 释放已创建的 blob: URL（与 EpubSource 对称）。 */
	releaseAssetUrls(): void {
		for (const url of this.assetUrls.values()) {
			if (!url) continue;
			try {
				URL.revokeObjectURL(url);
			} catch {
				/* 忽略：URL 已被回收 */
			}
		}
		this.assetUrls.clear();
		this.assetInflight.clear();
	}

	/** 关闭这本书：释放 blob URL、解压记录缓存与结构缓存。 */
	dispose(): void {
		this.releaseAssetUrls();
		this.recordCache.clear();
		releaseMobiStructure(this.structure.buffer);
	}
}

/** 打开 MobikContentSource（解析与渲染共用结构的便捷入口）。 */
export function openMobiSource(buffer: ArrayBuffer, fallbackTitle = "MOBI"): Promise<MobiContentSource> {
	return loadMobiStructure(buffer).then((structure) => new MobiContentSource(structure, structure.title || fallbackTitle));
}

// ---------- 小工具 ----------

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
