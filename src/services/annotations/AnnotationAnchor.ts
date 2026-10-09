/**
 * 批注锚点（`AnnotationAnchor`）：三层冗余 + 定位降级链。
 *
 * 为什么需要三层（依据 `docs/annotation-research.md` §2.1/§2.2 的官方结论）：
 * 1. **结构定位**（章节/段落 + 字符区间）：最精确，但版式或文档结构一变就漂移；
 * 2. **文本指纹**（`quote.exact/prefix/suffix`，等价 W3C TextQuoteSelector / Readium 的
 *    `highlight/before/after`）：**重排、改字号、换页宽都不会改变文本本身**，是抗重排的关键；
 * 3. **全书进度**（`progression` 0~1）：最后兜底，只能"跳到大概位置"，不能画高亮。
 *
 * 本模块是**纯逻辑**（不 import DOM / Obsidian），因此可以在 node 环境单测，
 * 也可以被引擎（iframe 内/虚拟滚动）与控制器共同复用，保证"生成锚点"与"定位锚点"
 * 用同一套归一化口径。
 *
 * ## 归一化口径（必须版本化）
 * {@link ANCHOR_NORMALIZATION}：NFC 合成 + 零宽字符丢弃 + 连续空白折叠为单个空格 +
 * 去掉首尾空白；计数单位统一为 **UTF-16 code unit**（与 `Range.startOffset` /
 * `String.length` 一致，跨 Readium/W3C 数据时需显式换算）。
 * 算法一旦变化就要换版本号，便于识别并重算旧数据。
 */
/** 锚点类型：pdf 用页码；epub/mobi 用章节；txt 用段落。 */
export type AnchorKind = "pdf" | "chapter" | "paragraph";

/**
 * 冗余文本指纹（= W3C TextQuoteSelector 的 exact/prefix/suffix，
 * Readium 的 `highlight`/`before`/`after`）。计数单位：UTF-16 code unit。
 */
export interface TextQuote {
	exact: string;
	prefix?: string;
	suffix?: string;
}

/**
 * 统一批注锚点（三层冗余）。
 *
 * - 结构定位：`kind` + `primary` + `charStart/charEnd`（+ `paraIndex`/`cssSelector`）；
 * - 文本指纹：`quote`（抗重排的关键，所有格式都必须存）；
 * - 兜底进度：`progression`（0~1）。
 */
export interface AnnotationAnchor {
	/** 格式：pdf 用页码；epub/mobi 用章节 href；txt 用段落索引 */
	kind: AnchorKind;
	/** pdf: "12"；epub/mobi: "OEBPS/Text/ch3.xhtml"；txt: "1234" */
	primary: string;
	/** 章内/段内字符区间（epub/mobi/txt），UTF-16 偏移，`charEnd` 不含 */
	charStart?: number;
	charEnd?: number;
	/** 该位置所在段落在已加载文档内的段落索引（epub/mobi：用于快速定位） */
	paraIndex?: number;
	/** 章节内单选器（尽量短） */
	cssSelector?: string;
	/** 文本指纹：抗重排的关键，必须存 */
	quote: TextQuote;
	/** 全书进度 0~1：最后的兜底 */
	progression: number;
	/** 归一化版本，便于将来演进 */
	v: 1;
}

/** 锚点结构版本（新增字段时递增，读取端按版本兼容）。 */
export const ANCHOR_SCHEMA_VERSION = 1 as const;

/** 归一化口径版本号（换算法时必须改这个字符串）。 */
export const ANCHOR_NORMALIZATION = "nyar-nfc-ws1-utf16-v1";

/** 文本指纹前后文默认取多少字符（UTF-16 code unit）。 */
export const DEFAULT_QUOTE_CONTEXT = 32;

/** 模糊匹配（exact 找不到时用首尾片段）要求的最短指纹长度。 */
export const MIN_FUZZY_QUOTE_LENGTH = 8;

/** 定位方式（降级链，按可信度从高到低）。 */
export type AnchorLocateQuality = "exact-range" | "quote-unique" | "quote-first" | "progression-only";

/** 定位结果：**降级原因必须可观测**，UI 据此把 approximate 的条目标出来。 */
export interface AnchorLocateResult {
	quality: AnchorLocateQuality;
	/** 是否降级（只有 exact-range / quote-unique 算精确命中） */
	approximate: boolean;
	/** 人可读的原因（诊断/UI 提示；不吞异常、不静默） */
	reason: string;
	/** 命中的原文区间（UTF-16 偏移，`end` 不含）；progression-only 时为空 */
	start?: number;
	end?: number;
	matchedText?: string;
	/** 兜底进度 0~1（无论是否命中都给出，调用方可直接跳过去） */
	progression: number;
	/** 归一化口径（诊断用） */
	normalization: string;
}

/** 引擎产出的锚点草稿（引擎最懂 DOM：章节/块锚点 + 字符区间 + 指纹前后文）。 */
export interface AnchorDraft {
	kind: AnchorKind;
	/** pdf: 页码；epub/mobi: 章节锚点 id；txt: 段落索引 */
	primary: string;
	charStart?: number;
	charEnd?: number;
	paraIndex?: number;
	cssSelector?: string;
	progression?: number;
	quote?: TextQuote;
	/** 引擎给出的选中原文（拿不到结构化 quote 时用它兜底 exact） */
	text?: string;
	/** 引擎自述"结构信息缺失"（例如只拿得到百分比） */
	approximate?: boolean;
}

const ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff]/;
const WHITESPACE_RE = /\s/;
const COMBINING_RE = /\p{M}/u;

/** 把数值夹到 0~1（非有限值按 0 处理）。 */
export function clamp01(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/** 归一化文本（trim + 空白折叠 + 零宽丢弃 + NFC）。 */
export function normalizeAnchorText(input: string): string {
	return normalizeWithIndex(input).text;
}

/** 归一化结果 + 「归一化下标 → 原文下标」映射。 */
export interface NormalizedText {
	text: string;
	/** starts[i]：归一化第 i 个字符在原文里的起始下标 */
	starts: number[];
	/** ends[i]：归一化第 i 个字符对应的原文结束下标（不含） */
	ends: number[];
}

/**
 * 归一化并同时建立下标映射。
 *
 * 关键点：空白折叠会让字符数变少，**没有映射就无法把"匹配到的位置"换算回原文偏移**，
 * 于是 quote 命中后也没法画高亮 —— 这里是整个降级链能落地的前提。
 *
 * 实现上按「基字符 + 后续组合记号」分组做 NFC（而不是对整串 `normalize("NFC")`），
 * 这样 NFC 合成不会破坏"第 i 个归一化字符 ↔ 原文下标"的对应关系。
 * 【已知限制】极端情况下（例如跨越分组边界的兼容分解）映射可能与整串 NFC 略有差异，
 * 对正常电子书文本（已是 NFC 的 CJK/拉丁混排）不构成影响。
 */
export function normalizeWithIndex(input: string): NormalizedText {
	const starts: number[] = [];
	const ends: number[] = [];
	let out = "";
	let pendingSpace = false;
	let wsStart = 0;
	let wsEnd = 0;
	let i = 0;
	while (i < input.length) {
		const code = input.codePointAt(i);
		if (code === undefined) break;
		const size = code > 0xffff ? 2 : 1;
		// 归组：基字符 + 紧随其后的组合记号（\p{M}）
		let groupEnd = i + size;
		while (groupEnd < input.length) {
			const next = input.codePointAt(groupEnd);
			if (next === undefined) break;
			const nextChar = String.fromCodePoint(next);
			if (!COMBINING_RE.test(nextChar)) break;
			groupEnd += nextChar.length;
		}
		const groupStart = i;
		const raw = input.slice(i, groupEnd);
		i = groupEnd;
		const nfc = raw.normalize("NFC");
		if (!nfc) continue;
		// 零宽字符直接丢弃，且**不产生空格**（否则会把一个词切成两半）
		if (nfc.length === 1 && ZERO_WIDTH_RE.test(nfc)) continue;
		if (WHITESPACE_RE.test(nfc)) {
			if (pendingSpace) wsEnd = groupEnd;
			else {
				pendingSpace = true;
				wsStart = groupStart;
				wsEnd = groupEnd;
			}
			continue;
		}
		// 词间空白：折叠成一个空格，映射到整段空白区间（便于区间 end 覆盖到空白末尾）
		if (pendingSpace) {
			if (out.length > 0) {
				out += " ";
				starts.push(wsStart);
				ends.push(wsEnd);
			}
			// 前导空白：不产出空格，但必须清掉待定状态（否则会在下一个词中间插入空格）
			pendingSpace = false;
		}
		for (let k = 0; k < nfc.length; k++) {
			out += nfc[k];
			starts.push(groupStart);
			ends.push(groupEnd);
		}
	}
	// 末尾的 pendingSpace 直接丢弃（等价 trim 右端）
	return { text: out, starts, ends };
}

/**
 * 生成文本指纹。
 *
 * `exact` 用**原始字符数据**（保留原始空白/换行），这是 Readium/W3C 的明文要求：
 * 消费方必须能拿它到原文里匹配；面向用户展示前才做清洗。
 */
export function buildTextQuote(fullText: string, start: number, end: number, context = DEFAULT_QUOTE_CONTEXT): TextQuote {
	const from = Math.max(0, Math.min(start, fullText.length));
	const to = Math.max(from, Math.min(end, fullText.length));
	const ctx = Math.max(0, context);
	return {
		exact: fullText.slice(from, to),
		prefix: fullText.slice(Math.max(0, from - ctx), from),
		suffix: fullText.slice(to, Math.min(fullText.length, to + ctx)),
	};
}

/** 用一段纯文本构造最小指纹（拿不到结构信息时的兜底）。 */
export function quoteFromText(text: string): TextQuote {
	return { exact: text ?? "", prefix: "", suffix: "" };
}

/** 由草稿生成锚点（字段裁剪 + 进度夹取；`v` 固定为 1）。 */
export function createAnchor(draft: AnchorDraft): AnnotationAnchor {
	const exact = typeof draft.quote?.exact === "string" && draft.quote.exact.length > 0 ? draft.quote.exact : draft.text ?? "";
	const quote: TextQuote = {
		exact,
		prefix: typeof draft.quote?.prefix === "string" ? draft.quote.prefix : "",
		suffix: typeof draft.quote?.suffix === "string" ? draft.quote.suffix : "",
	};
	const anchor: AnnotationAnchor = {
		kind: draft.kind,
		primary: typeof draft.primary === "string" ? draft.primary : String(draft.primary ?? ""),
		quote,
		progression: clamp01(draft.progression),
		v: ANCHOR_SCHEMA_VERSION,
	};
	if (Number.isInteger(draft.charStart)) anchor.charStart = draft.charStart;
	if (Number.isInteger(draft.charEnd)) anchor.charEnd = draft.charEnd;
	if (Number.isInteger(draft.paraIndex)) anchor.paraIndex = draft.paraIndex;
	if (typeof draft.cssSelector === "string" && draft.cssSelector) anchor.cssSelector = draft.cssSelector;
	return anchor;
}

/** 宽容解析（旧数据/手改 JSON 都可能缺字段）：无法识别时返回 null，绝不抛异常。 */
export function parseAnchor(raw: unknown): AnnotationAnchor | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const kind = o.kind === "pdf" || o.kind === "chapter" || o.kind === "paragraph" ? o.kind : null;
	if (!kind) return null;
	const quoteRaw = (o.quote && typeof o.quote === "object" ? o.quote : {}) as Record<string, unknown>;
	const exact = typeof quoteRaw.exact === "string" ? quoteRaw.exact : "";
	if (!exact) return null;
	const anchor: AnnotationAnchor = {
		kind,
		primary: typeof o.primary === "string" ? o.primary : String(o.primary ?? ""),
		quote: {
			exact,
			prefix: typeof quoteRaw.prefix === "string" ? quoteRaw.prefix : "",
			suffix: typeof quoteRaw.suffix === "string" ? quoteRaw.suffix : "",
		},
		progression: clamp01(typeof o.progression === "number" ? o.progression : Number(o.progression)),
		v: ANCHOR_SCHEMA_VERSION,
	};
	if (typeof o.charStart === "number" && Number.isInteger(o.charStart)) anchor.charStart = o.charStart;
	if (typeof o.charEnd === "number" && Number.isInteger(o.charEnd)) anchor.charEnd = o.charEnd;
	if (typeof o.paraIndex === "number" && Number.isInteger(o.paraIndex)) anchor.paraIndex = o.paraIndex;
	if (typeof o.cssSelector === "string" && o.cssSelector) anchor.cssSelector = o.cssSelector;
	return anchor;
}

/** 定位选项。 */
export interface LocateOptions {
	/** 允许"首尾片段"模糊匹配（默认 true） */
	allowFuzzy?: boolean;
}

/** 全部命中位置（归一化坐标系）。 */
function allOccurrences(haystack: string, needle: string): number[] {
	const hits: number[] = [];
	if (!needle) return hits;
	for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
		hits.push(at);
		if (hits.length > 64) break; // 病态输入（全同上千次命中）不必继续枚举
	}
	return hits;
}

/**
 * 「去空白」索引：归一化文本再去掉所有空白，并保留 → 归一化下标的映射。
 *
 * 为什么需要它：PDF 文本层/分页拖选/断行会让同一句话的空白不同
 * （`第一段文字` vs `第一段\n文字`），而 CJK 正文本身没有词间空格。
 * 空白差异不应让指纹失效 —— 但它只作为**第二优先**尝试（精确匹配失败后），
 * 且要求指纹足够长，避免"helloworld"这类误命中。
 */
interface CompactIndex {
	text: string;
	map: number[];
}

function compactIndexOf(norm: NormalizedText): CompactIndex {
	let out = "";
	const map: number[] = [];
	for (let i = 0; i < norm.text.length; i++) {
		const ch = norm.text[i];
		if (WHITESPACE_RE.test(ch)) continue;
		out += ch;
		map.push(i);
	}
	return { text: out, map };
}

function stripWhitespace(input: string): string {
	let out = "";
	for (const ch of input) {
		if (!WHITESPACE_RE.test(ch)) out += ch;
	}
	return out;
}

/**
 * 把**原文偏移**换算成**归一化下标**（`normalizeWithIndex` 的反向查找）。
 *
 * 为什么需要：锚点里的 `charStart` 是原文（DOM `Range`）偏移，而归一化下标会因为
 * 空白折叠/零宽字符丢弃而变短。要把"起点提示"用于指纹比对，必须先换算，
 * 否则会把原文偏移当成归一化下标去切片，命中位置整体偏移。
 *
 * 落在被折叠空白内部的偏移 → 返回其后的第一个归一化下标（等价"跳过空白"）；
 * 超出范围返回 null（调用方退回纯指纹搜索）。
 */
export function rawOffsetToNormalizedOffset(norm: NormalizedText, rawOffset: number): number | null {
	if (!Number.isFinite(rawOffset) || rawOffset < 0) return null;
	if (norm.starts.length === 0) return null;
	// starts 单调不减：找第一个起点 >= rawOffset 的下标
	let lo = 0;
	let hi = norm.starts.length - 1;
	let ans = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (norm.starts[mid] >= rawOffset) {
			ans = mid;
			hi = mid - 1;
		} else {
			lo = mid + 1;
		}
	}
	if (ans >= 0) return ans;
	// 所有归一化字符都在这之前：若落在最后一个字符的原文区间内，算作末尾
	const last = norm.starts.length - 1;
	return rawOffset <= norm.ends[last] ? last + 1 : null;
}

/** 指纹命中候选（归一化坐标系；`via` 记录是精确命中还是忽略空白后的命中）。 */
interface QuoteHit {
	normStart: number;
	normEnd: number;
	via: "exact" | "compact";
}

/** 「去空白」匹配要求的最短指纹长度（低于它不做忽略空白匹配，避免误命中）。 */
export const MIN_COMPACT_QUOTE_LENGTH = 4;

/** a 的末尾与 b（前者前缀、后者前文）的最长公共长度。 */function commonSuffixLen(a: string, b: string): number {
	let n = 0;
	const max = Math.min(a.length, b.length);
	while (n < max && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
	return n;
}

/** a 与 b 的最长公共前缀长度。 */
function commonPrefixLen(a: string, b: string): number {
	let n = 0;
	const max = Math.min(a.length, b.length);
	while (n < max && a[n] === b[n]) n++;
	return n;
}

/** 命中位置的前后文打分（越大越可信）。 */
function contextScore(norm: string, hit: number, needleLen: number, prefix: string, suffix: string): number {
	const before = norm.slice(0, hit);
	const after = norm.slice(hit + needleLen);
	return commonSuffixLen(prefix, before) + commonPrefixLen(suffix, after);
}

/** 模糊匹配结果（区间坐标系取决于调用方传入的 haystack）。 */
interface FuzzyHit {
	start: number;
	end: number;
	matchedTail: boolean;
}

/** 用「首段 + 末段」在 haystack 里模糊定位（容忍中段被改动）。 */
function fuzzyRange(haystack: string, needle: string, segLen: number): FuzzyHit | null {
	const head = needle.slice(0, segLen);
	const tail = needle.slice(-segLen);
	const headAt = haystack.indexOf(head);
	if (headAt < 0) return null;
	const searchFrom = headAt + head.length;
	const windowEnd = Math.min(haystack.length, headAt + needle.length * 3 + DEFAULT_QUOTE_CONTEXT);
	const rel = haystack.slice(searchFrom, windowEnd).indexOf(tail);
	if (rel >= 0) return { start: headAt, end: searchFrom + rel + tail.length - 1, matchedTail: true };
	return { start: headAt, end: headAt + head.length - 1, matchedTail: false };
}

/** 「去空白」坐标系 → 归一化坐标系的模糊匹配。 */
function mapCompactFuzzy(compact: CompactIndex, needleCompact: string, segLen: number): FuzzyHit | null {
	const hit = fuzzyRange(compact.text, needleCompact, segLen);
	if (!hit) return null;
	const s = compact.map[hit.start];
	const e = compact.map[hit.end];
	if (s === undefined || e === undefined) return null;
	return { start: s, end: e, matchedTail: hit.matchedTail };
}

/**
 * 在给定文本里定位锚点 —— **降级链**（每一步都给出明确 reason，不静默）。
 *
 * 1. `exact-range`：结构定位（`charStart/charEnd`）命中，且与文本指纹一致 → 精确；
 * 2. `quote-unique`：结构定位失效，但 `quote.exact` 在文本里唯一命中 → 精确（可回写修正结构定位）；
 * 3. `quote-first`：指纹多处命中（按 prefix/suffix 打分取舍）或只靠首尾片段模糊命中 → **近似**；
 * 4. `progression-only`：以上都失败，只能按 `progression` 跳个大概 → **近似，且无法画高亮**。
 *
 * @param text 目标容器（章节/段落）的纯文本
 * @param anchor 锚点
 */
export function locateInText(text: string, anchor: AnnotationAnchor, opts: LocateOptions = {}): AnchorLocateResult {
	const progression = clamp01(anchor.progression);
	const base = { progression, normalization: ANCHOR_NORMALIZATION };
	if (typeof text !== "string" || text.length === 0) {
		return { ...base, quality: "progression-only", approximate: true, reason: "目标文本为空（章节/段落尚未加载），只能按进度定位" };
	}
	const exact = normalizeAnchorText(anchor.quote?.exact ?? "");
	const start = anchor.charStart;
	const end = anchor.charEnd;
	// 1) 结构定位直接命中（要求与指纹一致，避免"结构偏移写错却画在高亮错位置"）
	if (
		typeof start === "number" &&
		typeof end === "number" &&
		Number.isInteger(start) &&
		Number.isInteger(end) &&
		start >= 0 &&
		end > start &&
		end <= text.length
	) {
		const slice = text.slice(start, end);
		if (!exact || normalizeAnchorText(slice) === exact) {
			return {
				...base,
				quality: "exact-range",
				approximate: false,
				reason: "结构定位（章节/段落字符区间）直接命中",
				start,
				end,
				matchedText: slice,
			};
		}
	}
	// 2) 文本指纹（精确 → 忽略空白差异 → 首尾片段模糊）
	if (exact) {
		const norm = normalizeWithIndex(text);
		const rangeFromNorm = (s: number, e: number): { start: number; end: number } => ({ start: norm.starts[s], end: norm.ends[e] });
		const compact = compactIndexOf(norm);
		const needleCompact = stripWhitespace(exact);
		// 2a) **起点提示**：跨区域选区只存了 charStart。若该位置起的文本恰好等于指纹，
		//     直接采用 —— 否则"书里有多处相同句子"时会按打分取错位置（用户实测到的问题）。
		//     注意 charStart 是**原文**偏移，必须换算到归一化坐标系再比对。
		if (typeof start === "number" && Number.isInteger(start) && start >= 0 && start <= text.length && end === undefined) {
			const at = rawOffsetToNormalizedOffset(norm, start);
			if (at !== null && norm.text.startsWith(exact, at)) {
				const { start: s, end: e } = rangeFromNorm(at, at + exact.length - 1);
				return {
					...base,
					quality: "exact-range",
					approximate: false,
					reason: "结构定位（选区起点）命中，且与文本指纹一致",
					start: s,
					end: e,
					matchedText: text.slice(s, e),
				};
			}
		}
		const collect = (): QuoteHit[] => {
			const hits: QuoteHit[] = [];
			for (const at of allOccurrences(norm.text, exact)) {
				hits.push({ normStart: at, normEnd: at + exact.length - 1, via: "exact" });
			}
			if (hits.length) return hits;
			if (needleCompact.length >= MIN_COMPACT_QUOTE_LENGTH) {
				for (const at of allOccurrences(compact.text, needleCompact)) {
					const last = at + needleCompact.length - 1;
					if (compact.map[at] === undefined || compact.map[last] === undefined) continue;
					hits.push({ normStart: compact.map[at], normEnd: compact.map[last], via: "compact" });
				}
			}
			return hits;
		};
		const hits = collect();
		const describe = (hit: QuoteHit): string => (hit.via === "compact" ? "文本指纹唯一命中（忽略空白差异）" : "结构定位失效，文本指纹唯一命中");
		if (hits.length === 1) {
			const { start: s, end: e } = rangeFromNorm(hits[0].normStart, hits[0].normEnd);
			return {
				...base,
				quality: "quote-unique",
				approximate: false,
				reason: describe(hits[0]),
				start: s,
				end: e,
				matchedText: text.slice(s, e),
			};
		}
		if (hits.length > 1) {
			const prefix = normalizeAnchorText(anchor.quote?.prefix ?? "");
			const suffix = normalizeAnchorText(anchor.quote?.suffix ?? "");
			let best = hits[0];
			let bestScore = -1;
			for (const hit of hits) {
				const score = contextScore(norm.text, hit.normStart, hit.normEnd - hit.normStart + 1, prefix, suffix);
				if (score > bestScore + 1e-9) {
					bestScore = score;
					best = hit;
				}
			}
			const { start: s, end: e } = rangeFromNorm(best.normStart, best.normEnd);
			return {
				...base,
				quality: "quote-first",
				approximate: true,
				reason: `文本指纹命中 ${hits.length} 处，按前后文打分取其中之一（可能不是原位置）`,
				start: s,
				end: e,
				matchedText: text.slice(s, e),
			};
		}
		// 模糊：用首尾片段（容忍少量字符被改动）；先按原文精确片段找，再按忽略空白后的片段找
		if (opts.allowFuzzy !== false && exact.length >= MIN_FUZZY_QUOTE_LENGTH) {
			const fuzzy =
				fuzzyRange(norm.text, exact, MIN_FUZZY_QUOTE_LENGTH) ??
				(needleCompact.length >= MIN_FUZZY_QUOTE_LENGTH
					? mapCompactFuzzy(compact, needleCompact, MIN_FUZZY_QUOTE_LENGTH)
					: null);
			if (fuzzy) {
				const { start: s, end: e } = rangeFromNorm(fuzzy.start, fuzzy.end);
				return {
					...base,
					quality: "quote-first",
					approximate: true,
					reason: fuzzy.matchedTail ? "指纹未完全命中，按首尾片段模糊命中（原文可能已被改动）" : "指纹未命中，仅首片段命中（位置不可靠）",
					start: s,
					end: e,
					matchedText: text.slice(s, e),
				};
			}
		}
	}
	// 4) 兜底：只能按进度跳
	return {
		...base,
		quality: "progression-only",
		approximate: true,
		reason: exact ? "结构定位与文本指纹均未命中，只能按全书进度跳转（无法画高亮）" : "无文本指纹，只能按全书进度跳转（无法画高亮）",
	};
}

/** 人类可读的定位方式标签（UI 提示用）。 */
export const ANCHOR_QUALITY_LABEL: Record<AnchorLocateQuality, string> = {
	"exact-range": "精确定位",
	"quote-unique": "按文本指纹精确定位",
	"quote-first": "位置可能不准（多处匹配/模糊）",
	"progression-only": "位置可能不准（仅按进度）",
};
