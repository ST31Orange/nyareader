/**
 * EPUB 渲染文档构建（v0.5 大文件重构）。
 *
 * 旧实现（根因，已修）：
 * - 一次性 await 全部 spine 章节拼成单份 HTML：3000 章 / 40MB 的书要在首屏前把整本书读完；
 * - 图片一律 base64 内联，且 >1.5MB 直接 `src=""`（图片消失）；
 * - 章节样式按整串字符串去重，大书 O(n²) 且长期保留整串 CSS。
 *
 * 现在：
 * 1) 首章优先：buildInitialHtml(n) 只构建前 n 章（默认 2），其余交给 EpubLazyLoader
 *    逐批追加；每个章节片段自带 `nyareader-epub-N` 锚点，目录跳转语义不变。
 * 2) 资源登记而非内联：`<img src>` 重写为 `data-nyar-asset="zip 绝对路径"`（原相对 href
 *    保留在 `data-nyar-src`），由渲染引擎按需解析成 blob: URL；缺失资源保留可见占位，
 *    不再清空成 `src=""`。
 * 3) 样式去重：每章样式做稳定哈希键去重（只存键、不保留整串 CSS），外链 CSS 同一路径只读一次。
 */
import type JSZip from "jszip";
import { parseOpf } from "./EpubParser";
import type { OpfData } from "./EpubParser";
import { EPUB_ANCHOR_PREFIX, openEpubZip, releaseEpubZip } from "./EpubZipCache";

/** 章节渲染结果；`styles` 只包含"本章新增、此前未登记过"的样式。 */
export interface EpubChapterDoc {
	body: string;
	styles: string[];
}

/** 首屏默认构建章节数（其余后台补章）。 */
export const DEFAULT_INITIAL_CHAPTERS = 2;
/** 图片登记属性：值为 zip 内绝对路径，渲染引擎据此按需解析。 */
export const EPUB_ASSET_ATTR = "data-nyar-asset";
/** 原始相对 href（回退/诊断信息；已移除 src，浏览器不会去请求它）。 */
export const EPUB_ASSET_FALLBACK_ATTR = "data-nyar-src";

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
};

const MAX_INLINE_CSS = 512 * 1024;

// ---------- 样式去重（稳定哈希键） ----------

/**
 * 样式稳定键：长度 + FNV-1a + djb2，十六进制拼接。
 * 两个独立 32 位哈希 + 长度 ≈ 64 位区分度：不保留整串 CSS 也能安全去重（大书省内存）。
 */
export function stableStyleKey(style: string): string {
	let fnv = 2166136261;
	let djb = 5381;
	for (let i = 0; i < style.length; i++) {
		const c = style.charCodeAt(i);
		fnv = Math.imul(fnv ^ c, 16777619) >>> 0;
		djb = (Math.imul(djb, 33) ^ c) >>> 0;
	}
	return `${style.length}:${fnv.toString(16)}:${djb.toString(16)}`;
}

/** 章节样式增量去重器：只保存哈希键，不保存样式原文。 */
export class StyleRegistry {
	private seen = new Set<string>();

	/** 登记一条样式；返回 true 表示这是首次出现（调用方应写入文档）。 */
	add(style: string): boolean {
		const key = stableStyleKey(style);
		if (this.seen.has(key)) return false;
		this.seen.add(key);
		return true;
	}

	has(style: string): boolean {
		return this.seen.has(stableStyleKey(style));
	}

	get size(): number {
		return this.seen.size;
	}
}

// ---------- 图片登记 ----------

/**
 * 把章节正文里的 `<img src="相对路径">`（或仅有 `srcset` 的图片）登记为可解析资源：
 * 移除 src/srcset（srcdoc iframe 下相对路径必然 404），写入
 * `data-nyar-asset="zip 绝对路径"` 与 `data-nyar-src="原 href"`。
 * 纯字符串函数，不做任何 I/O，便于单测。
 *
 * 同时处理两种"真实书里图片不是 `<img>`"的写法（否则图片/封面页在阅读器里是空白）：
 * - `<svg><image xlink:href="…"/></svg>` 单图包装 → 改写成 `<img>`（见 registerSvgImages）；
 * - 正文为空、只有 `background-image:url(…)` 的整页插图 → 注入 `<img>`
 *   （见 registerBodyBackgroundImage，由 transformChapter 调用）。
 */
export function registerChapterImages(body: string, dir: string): string {
	const imgRe = /<img\b[^>]*>/gi;
	const tags: Array<{ tag: string; index: number; length: number }> = [];
	let m: RegExpExecArray | null;
	while ((m = imgRe.exec(body)) !== null) tags.push({ tag: m[0], index: m.index, length: m[0].length });
	let out = body;
	for (const t of tags.reverse()) {
		const attrs = parseAttrs(t.tag);
		// 只有 srcset 的图片同样要登记，否则懒加载书里的图片会一直空着
		const src = attrCaseInsensitive(attrs, "src") ?? firstSrcsetUrl(attrCaseInsensitive(attrs, "srcset"));
		if (!src) continue;
		const zipPath = resolveHref(dir, src);
		let replacement = t.tag
			.replace(/\ssrcset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "")
			.replace(/\ssrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "");
		replacement = injectAttr(replacement, EPUB_ASSET_FALLBACK_ATTR, src);
		replacement = injectAttr(replacement, EPUB_ASSET_ATTR, zipPath);
		out = out.slice(0, t.index) + replacement + out.slice(t.index + t.length);
	}
	return registerSvgImages(out, dir);
}

/**
 * 把「只包含一张 `<image>` 的 `<svg>` 包装」改写成 `<img data-nyar-asset>`。
 *
 * 为什么必须做（真实样本：《银河帝国完整版》`OEBPS/Text/cover.xhtml`）：
 * 封面页写法是
 * `<div><svg viewBox="0 0 960 1280"><image xlink:href="../Images/cover.jpg"/></svg></div>`，
 * 而引擎的资源回填只认 `<img data-nyar-asset>`，`<image xlink:href>` 里的相对路径在
 * srcdoc iframe 里必然 404 → **封面页是空白的**（用户报的"封面渲染失败"）。
 * 只在这种"纯单图"结构上改写；含其它矢量元素的复杂 SVG 原样保留（浏览器能自己渲染）。
 */
export function registerSvgImages(body: string, dir: string): string {
	if (!/<svg\b/i.test(body)) return body;
	const svgRe = /<svg\b[^>]*>[\s\S]*?<\/svg>/gi;
	const blocks: Array<{ block: string; index: number; length: number }> = [];
	let m: RegExpExecArray | null;
	while ((m = svgRe.exec(body)) !== null) blocks.push({ block: m[0], index: m.index, length: m[0].length });
	if (!blocks.length) return body;
	let out = body;
	for (const b of blocks.reverse()) {
		const replacement = svgSingleImageToImg(b.block, dir);
		if (!replacement) continue;
		out = out.slice(0, b.index) + replacement + out.slice(b.index + b.length);
	}
	return out;
}

/** 单图 `<svg>` -> `<img>`；含其它标签/多于一张图时返回 null（保持原样）。 */
function svgSingleImageToImg(svg: string, dir: string): string | null {
	const inner = svg.replace(/^<svg\b[^>]*>/i, "").replace(/<\/svg\s*>$/i, "");
	// 只允许 svg/image/title/desc/metadata/g 这几种标签（复杂矢量图不动）
	if (/<\s*\/?\s*(?!(?:svg|image|title|desc|metadata|g)\b)[a-z]/i.test(inner)) return null;
	const images = inner.match(/<image\b[^>]*>/gi) ?? [];
	if (images.length !== 1) return null;
	const attrs = parseAttrs(images[0]);
	const href = attrCaseInsensitive(attrs, "xlink:href") ?? attrCaseInsensitive(attrs, "href");
	if (!href || /^(?:data:|https?:|blob:)/i.test(href)) return null;
	const width = attrCaseInsensitive(attrs, "width");
	const numericWidth = width && /^\d+(?:\.\d+)?$/.test(width) ? width : "";
	const tag = numericWidth ? `<img width="${escapeAttr(numericWidth)}"` : `<img`;
	return (
		`${tag} alt="" style="max-width:100%;height:auto" ` +
		`${EPUB_ASSET_FALLBACK_ATTR}="${escapeAttr(href)}" ${EPUB_ASSET_ATTR}="${escapeAttr(resolveHref(dir, href))}"/>`
	);
}

/**
 * "整页只有背景图"的章节（真实样本：分卷封面页 `<body style="background-image:url('../Images/z1.png')">`
 * 且 body 内**没有任何可见内容**）→ 在阅读器里是空白页。
 * 正文没有可见内容时，把该背景图注入成 `<img data-nyar-asset>` 交给引擎回填。
 *
 * @param bodyHtml 章节 `<body>` 的内部 HTML（已做图片登记）
 * @param bodyAttrs `<body ...>` 的属性串（背景图常写在这里）
 */
export function registerBodyBackgroundImage(bodyHtml: string, bodyAttrs: string, dir: string): string {
	if (hasVisibleContent(bodyHtml)) return bodyHtml;
	const url = firstBackgroundImageUrl(bodyAttrs) ?? firstBackgroundImageUrl(bodyHtml);
	if (!url || /^(?:data:|https?:|blob:)/i.test(url)) return bodyHtml;
	return (
		bodyHtml +
		`<img alt="" style="max-width:100%;height:auto" ` +
		`${EPUB_ASSET_FALLBACK_ATTR}="${escapeAttr(url)}" ${EPUB_ASSET_ATTR}="${escapeAttr(resolveHref(dir, url))}"/>`
	);
}

/** 正文里是否已有可见内容（文字 / 位图 / 内联 SVG / 表格等）。 */
function hasVisibleContent(html: string): boolean {
	const stripped = html
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/gi, " ")
		.trim();
	if (stripped) return true;
	return /<(?:img|svg|video|audio|table|iframe|object|embed|canvas|math)\b/i.test(html);
}

/** 取第一处 `background-image:url(...)` 的地址（含 `url("…")` 与 HTML 实体引号写法）。 */
function firstBackgroundImageUrl(source: string): string | null {
	// XHTML 里 style 属性内的引号常被转义成 &quot;/&#39;：先还原再做匹配，避免把实体当路径
	const decoded = source.replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'");
	const m = /background(?:-image)?\s*:\s*[^;"']*?url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"]+))\s*\)/i.exec(decoded);
	return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim() || null;
}

/** 取 srcset 第一候选的 URL（`a.png 1x, b.png 2x` -> `a.png`）。 */
function firstSrcsetUrl(srcset: string | undefined): string | undefined {
	if (!srcset) return undefined;
	const first = srcset.split(",")[0]?.trim();
	if (!first) return undefined;
	const url = first.split(/\s+/)[0]?.trim();
	return url || undefined;
}

function attrCaseInsensitive(attrs: Record<string, string>, name: string): string | undefined {
	if (attrs[name] !== undefined) return attrs[name];
	const lower = name.toLowerCase();
	for (const [k, v] of Object.entries(attrs)) {
		if (k.toLowerCase() === lower) return v;
	}
	return undefined;
}

/** 往标签里追加一个属性（保留自闭合写法）。 */
function injectAttr(tag: string, name: string, value: string): string {
	const selfClose = /\/\s*>$/.test(tag);
	const trimmed = tag.replace(/\s*\/?>$/, "");
	return `${trimmed} ${name}="${escapeAttr(value)}"${selfClose ? "/>" : ">"}`;
}

function escapeAttr(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// ---------- 章节转换 ----------

export interface TransformContext {
	/** 跨章节共享的样式去重器；缺省时本章内去重。 */
	registry?: StyleRegistry;
	/** 外链 CSS 路径 -> 文本缓存（同一 CSS 被上千章引用时只读一次）。 */
	cssCache?: Map<string, string>;
}

/**
 * 转换单个 XHTML 章节：去 xml/script，抽取样式（经 registry 去重），登记图片，保留正文。
 */
export async function transformChapter(xhtml: string, zip: JSZip, dir: string, ctx: TransformContext = {}): Promise<EpubChapterDoc> {
	const registry = ctx.registry ?? new StyleRegistry();
	const cssCache = ctx.cssCache ?? new Map<string, string>();
	let s = xhtml
		.replace(/<\?xml[^>]*\?>/gi, "")
		.replace(/<!DOCTYPE[^>]*>/gi, "")
		.replace(/<script\b[\s\S]*?<\/script>/gi, "");

	const styles: string[] = [];
	const pushStyle = (text: string): void => {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (registry.add(trimmed)) styles.push(trimmed);
	};

	const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(s);
	if (head) {
		const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
		let m: RegExpExecArray | null;
		while ((m = styleRe.exec(head[1])) !== null) pushStyle(m[1]);

		// 外链样式表：存在且不超限则内联（同路径只解压/解码一次）
		const linkRe = /<link\b[^>]*>/gi;
		while ((m = linkRe.exec(head[1])) !== null) {
			const attrs = parseAttrs(m[0]);
			if (!/stylesheet/i.test(attrs.rel ?? "") || !attrs.href) continue;
			const cssPath = resolveHref(dir, attrs.href);
			let css = cssCache.get(cssPath);
			if (css === undefined) {
				css = "";
				const cssFile = zip.file(cssPath);
				if (cssFile) {
					const raw = await cssFile.async("uint8array");
					if (raw.length <= MAX_INLINE_CSS) css = new TextDecoder("utf-8").decode(raw).trim();
				}
				cssCache.set(cssPath, css);
			}
			pushStyle(css);
		}
		// 移除外链样式表标签（内联后避免双重加载/破链接）
		s = s.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, "");
	}

	const bodyMatch = /<body\b([^>]*)>([\s\S]*?)<\/body>/i.exec(s);
	const bodyAttrs = bodyMatch ? bodyMatch[1] : "";
	const bodyHtml = bodyMatch ? bodyMatch[2] : stripHead(s);
	const registered = registerChapterImages(bodyHtml, dir);
	// 整页只有背景图的章节（分卷封面页）：注入 <img>，否则阅读器里是空白页
	return { body: registerBodyBackgroundImage(registered, bodyAttrs, dir), styles };
}

// ---------- 结构加载（解析与渲染共用一次 OPF 解析） ----------

export interface EpubStructure {
	buffer: ArrayBuffer;
	zip: JSZip;
	opfPath: string;
	opfDir: string;
	opf: OpfData;
}

const structureCache = new WeakMap<ArrayBuffer, Promise<EpubStructure>>();

/** 打开并缓存 EPUB 结构（container.xml + content.opf）；解析器与渲染层共用同一次结果。 */
export function loadEpubStructure(buffer: ArrayBuffer): Promise<EpubStructure> {
	const cached = structureCache.get(buffer);
	if (cached) return cached;
	const task = openStructure(buffer).catch((e: unknown) => {
		structureCache.delete(buffer);
		throw e;
	});
	structureCache.set(buffer, task);
	return task;
}

async function openStructure(buffer: ArrayBuffer): Promise<EpubStructure> {
	const zip = await openEpubZip(buffer);
	const opfPath = await findOpfPath(zip);
	const opfFile = zip.file(opfPath);
	if (!opfFile) throw new Error("EPUB 缺少 content.opf");
	const opf = parseOpf(await opfFile.async("string"));
	return { buffer, zip, opfPath, opfDir: dirOf(opfPath), opf };
}

/** 释放结构与 zip 缓存（关闭/切换书籍时调用；后续再打开会重新解包）。 */
export function releaseEpubStructure(buffer: ArrayBuffer): void {
	structureCache.delete(buffer);
	releaseEpubZip(buffer);
}

// ---------- 纯字符串拼装（可单测） ----------

export function chapterAnchorHtml(index: number): string {
	return `<span id="${EPUB_ANCHOR_PREFIX}${index}" class="nyareader-epub-anchor"></span>`;
}

/** 章节正文片段（锚点 + 正文），首屏文档与懒加载追加片段共用。 */
export function chapterBodyHtml(index: number, body: string): string {
	return `${chapterAnchorHtml(index)}${body}`;
}

/** 追加/首屏共用的章节块：新增样式 + 锚点 + 正文。 */
export function chapterChunkHtml(index: number, doc: EpubChapterDoc): string {
	const styles = doc.styles.map((s) => `<style>${s}</style>`).join("\n");
	return `${styles}${chapterBodyHtml(index, doc.body)}`;
}

export function composeEpubDocument(title: string, headStyles: string[], bodies: string[]): string {
	const heads = headStyles.map((s) => `<style>${s}</style>`).join("\n");
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${heads}</head><body>${bodies.join("\n")}</body></html>`;
}

/**
 * 单章失败的可见占位正文（**保留章节锚点**，所以目录跳转与进度换算仍然有效）。
 *
 * 重要：绝不把异常穿透到 EpubLazyLoader —— 那会让后台补章永久停在这一章
 * （用户可见症状＝"书断在中间、原本 6k 页变 2k 页"）。
 */
export function failedChapterBody(index: number, error?: unknown): string {
	const detail = error instanceof Error && error.message ? `：${escapeHtml(error.message)}` : "";
	return `<p class="nyareader-chunk-failed" data-nyar-chunk-failed="${index}">（第 ${index + 1} 章内容读取失败，已跳过${detail}）</p>`;
}

/** 章节读取失败诊断（console.debug，便于用户在控制台看到"哪一章坏了"）。 */
function logChapterFailure(format: string, index: number, href: string, error: unknown): void {
	try {
		// eslint-disable-next-line no-console
		console.debug(
			`[NyaReader] ${format} 第 ${index + 1} 章读取失败（已降级为占位）：${href} — ${error instanceof Error ? error.message : String(error)}`
		);
	} catch {
		/* 诊断日志本身失败不影响阅读 */
	}
}

// ---------- EpubSource ----------

export interface EpubAsset {
	bytes: Uint8Array;
	mime: string;
}

/**
 * 一本书的渲染数据源：按章构建 HTML（首章优先）、按需解析 zip 内图片。
 * 显式持有 zip，因此"后台补章"不必重新解包。
 */
export class EpubSource {
	private readonly registry = new StyleRegistry();
	private readonly cssCache = new Map<string, string>();
	private readonly assetUrls = new Map<string, string | null>();
	private readonly assetInflight = new Map<string, Promise<string | null>>();

	private constructor(private readonly structure: EpubStructure, readonly title: string) {}

	static async open(buffer: ArrayBuffer, fallbackTitle = "EPUB"): Promise<EpubSource> {
		const structure = await loadEpubStructure(buffer);
		return new EpubSource(structure, structure.opf.title || fallbackTitle);
	}

	get chapterCount(): number {
		return this.structure.opf.spine.length;
	}

	/** 已登记的样式条数（去重后）。 */
	get styleCount(): number {
		return this.registry.size;
	}

	/**
	 * 各章内容量权重：取 zip 条目的**未压缩字节数**（JSZip 从中央目录读出，
	 * 不需要解压，成本 O(章数)）。
	 *
	 * 用途：进度百分比按"内容量"而不是"章数"加权。否则一本前面若干短章、
	 * 后面一章占大半篇幅的书，补章会让进度条明显回退。
	 * 缺 size 的条目（罕见）用 1 兜底，读取过程本身不抛异常。
	 */
	chapterWeights(): number[] {
		try {
			const spine = this.structure.opf.spine;
			const out: number[] = new Array(spine.length);
			for (let i = 0; i < spine.length; i++) {
				const href = this.chapterHref(i);
				const file = href ? this.structure.zip.file(href) : null;
				const size = (file as unknown as { _data?: { uncompressedSize?: number } })?._data?.uncompressedSize;
				out[i] = typeof size === "number" && size > 0 ? size : 1;
			}
			return out;
		} catch {
			return [];
		}
	}

	/** 第 index 章的 zip 内绝对路径。 */
	chapterHref(index: number): string {
		return resolveHref(this.structure.opfDir, this.structure.opf.spine[index]?.href ?? "");
	}

	/** 渲染单章（样式经跨章去重）。**永不抛异常**：单章失败降级为可见占位。 */
	async buildChapterDoc(index: number): Promise<EpubChapterDoc> {
		const href = this.chapterHref(index);
		const file = href ? this.structure.zip.file(href) : null;
		let xhtml: string;
		try {
			xhtml = file
				? await file.async("string")
				: `<html><body><p>（缺失章节 ${escapeHtml(this.structure.opf.spine[index]?.href ?? String(index))}）</p></body></html>`;
		} catch (e) {
			// 损坏/无法解压的条目：旧实现会让异常穿到 EpubLazyLoader，
			// 使后台补章永久停在这一章（用户可见症状＝"书断在中间、页数变少"）。
			logChapterFailure("epub", index, href, e);
			return { body: failedChapterBody(index, e), styles: [] };
		}
		// 章节内的相对 href（图片 / 外链 CSS）相对**该章节文档**解析，而不是相对 OPF：
		// 真实 EPUB 常见 OEBPS/text/ch1.xhtml 里写 src="../images/a.png"（旧实现按 OPF 目录解析会丢图/丢样式）。
		try {
			return await transformChapter(xhtml, this.structure.zip, dirOf(href), {
				registry: this.registry,
				cssCache: this.cssCache,
			});
		} catch (e) {
			logChapterFailure("epub", index, href, e);
			return { body: failedChapterBody(index, e), styles: [] };
		}
	}

	/** 渲染单章正文（不含样式），供需要正文片段的调用方使用。 */
	async buildChapterBody(index: number): Promise<string> {
		return (await this.buildChapterDoc(index)).body;
	}

	/** 可直接追加到引擎文档末尾的章节片段（增量样式 + 锚点 + 正文）。永不抛异常。 */
	async buildChapterChunk(index: number): Promise<string> {
		return chapterChunkHtml(index, await this.buildChapterDoc(index));
	}

	/** 首屏文档：只构建前 initialChapters 章。 */
	async buildInitialHtml(initialChapters: number = DEFAULT_INITIAL_CHAPTERS): Promise<string> {
		const total = this.chapterCount;
		const n = Math.max(1, Math.min(total || 1, Math.floor(initialChapters) > 0 ? Math.floor(initialChapters) : 1));
		const headStyles: string[] = [];
		const bodies: string[] = [];
		for (let i = 0; i < n; i++) {
			const doc = await this.buildChapterDoc(i);
			for (const style of doc.styles) headStyles.push(style);
			bodies.push(chapterBodyHtml(i, doc.body));
		}
		return composeEpubDocument(this.title, headStyles, bodies);
	}

	/** 读取 zip 内资源（仅图片类型）。 */
	async readAsset(zipPath: string): Promise<EpubAsset | null> {
		const path = normalizeZipPath(zipPath);
		if (!path) return null;
		const mime = mimeForPath(path);
		if (!mime) return null;
		const file = this.structure.zip.file(path);
		if (!file) return null;
		try {
			return { bytes: await file.async("uint8array"), mime };
		} catch {
			return null;
		}
	}

	/**
	 * 解析登记的资源为可显示 URL（blob:）。解析结果按路径缓存；失败返回 null
	 * （渲染引擎据此保留 `nyareader-img-missing` 占位，而不是把图片隐藏掉）。
	 */
	async resolveAssetUrl(zipPath: string): Promise<string | null> {
		if (this.assetUrls.has(zipPath)) return this.assetUrls.get(zipPath) ?? null;
		const running = this.assetInflight.get(zipPath);
		if (running) return running;
		const task = (async (): Promise<string | null> => {
			const asset = await this.readAsset(zipPath);
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
			this.assetUrls.set(zipPath, url);
			return url;
		})();
		this.assetInflight.set(zipPath, task);
		try {
			return await task;
		} finally {
			this.assetInflight.delete(zipPath);
		}
	}

	/** 释放已创建的 blob: URL。 */
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

	/** 关闭这本书：释放 blob URL 与 zip/结构缓存。 */
	dispose(): void {
		this.releaseAssetUrls();
		releaseEpubStructure(this.structure.buffer);
	}
}

/** 打开 EpubSource（解析与渲染共用结构的便捷入口）。 */
export function openEpubSource(buffer: ArrayBuffer, fallbackTitle = "EPUB"): Promise<EpubSource> {
	return EpubSource.open(buffer, fallbackTitle);
}

/**
 * 兼容旧入口：构建 EPUB 渲染文档。
 * 默认只构建前 2 章（首屏），其余由 EpubLazyLoader 追加；需要整本时传 initialChapters。
 */
export async function buildEpubHtml(
	buffer: ArrayBuffer,
	fallbackTitle = "EPUB",
	options: { initialChapters?: number } = {}
): Promise<string> {
	const source = await EpubSource.open(buffer, fallbackTitle);
	return source.buildInitialHtml(options.initialChapters ?? DEFAULT_INITIAL_CHAPTERS);
}

// ---------- 小工具 ----------

/** 从 container.xml 找 content.opf 路径。 */
export async function findOpfPath(zip: JSZip): Promise<string> {
	const container = zip.file("META-INF/container.xml");
	if (!container) throw new Error("EPUB 缺少 META-INF/container.xml");
	const xml = await container.async("string");
	const m = /<rootfile\b[^>]*full-path=["']([^"']+)["'][^>]*>/i.exec(xml);
	if (!m) throw new Error("EPUB container.xml 缺少 rootfile");
	return m[1];
}

function dirOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx > 0 ? path.slice(0, idx) : "";
}

/** 把相对 href 解析为 zip 内路径（去 #/？、折叠 ./ 与 ../）。 */
function resolveHref(dir: string, href: string): string {
	const clean = href.split("#")[0].split("?")[0];
	if (!clean) return dir;
	const parts = (dir ? dir.split("/") : []).concat(clean.split("/"));
	const out: string[] = [];
	for (const p of parts) {
		if (!p || p === ".") continue;
		if (p === "..") {
			out.pop();
			continue;
		}
		out.push(p);
	}
	return out.join("/");
}

function normalizeZipPath(path: string): string {
	if (!path) return "";
	const clean = path.split("#")[0].split("?")[0];
	const parts = clean.split("/");
	const out: string[] = [];
	for (const p of parts) {
		if (!p || p === ".") continue;
		if (p === "..") {
			out.pop();
			continue;
		}
		out.push(p);
	}
	return out.join("/");
}

function mimeForPath(path: string): string | undefined {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return MIME_BY_EXT[ext];
}

/** 解析标签属性。 */
function parseAttrs(tag: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(tag)) !== null) {
		attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
	}
	return attrs;
}

function stripHead(s: string): string {
	const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(s);
	if (!head) return s;
	return s.slice(0, head.index) + s.slice(head.index + head[0].length);
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
