/**
 * EPUB 解析器：纯 zip + OPF/NCX 解析，不依赖 epub.js。
 *
 * 为什么不用 epub.js 解析（v0.3.3 重写）：
 * - 旧实现 `await Epub(buffer).ready` 会等 epub.js 把整本书的清单与所有资源
 *   全部加载完才 resolve，一本 Gutenberg 书在桌面环境要数秒以上，
 *   期间阅读区一片空白、界面像卡死。
 * - 解析只需要 container.xml / content.opf / toc（NCX 或 EPUB3 nav），
 *   完全可以在毫秒级完成；渲染仍由 EpubEngine 内的 epub.js 负责。
 */
import type { BookModel, TocItem } from "../../../../types";
import type { IBookParser, ParseContext } from "../../Parser";
import { openEpubZip, EPUB_ANCHOR_PREFIX } from "./EpubZipCache";
import { findOpfPath } from "./EpubDocument";

interface EpubNavItem {
	label: string;
	href?: string;
	subitems?: EpubNavItem[];
}

interface OpfData {
	title?: string;
	author?: string;
	spine: Array<{ id: string; href: string }>;
	ncxHref?: string;
	navHref?: string;
}

export class EpubParser implements IBookParser {
	readonly format = "epub" as const;

	async parse(ctx: ParseContext): Promise<BookModel> {
		const zip = await openEpubZip(ctx.buffer);
		const opfPath = await findOpfPath(zip);
		const opfFile = zip.file(opfPath);
		if (!opfFile) throw new Error("EPUB 缺少 content.opf");
		const opf = await opfFile.async("string");
		const data = parseOpf(opf);
		const opfDir = dirOf(opfPath);

		let toc: EpubNavItem[] = [];
		if (data.ncxHref) {
			const ncx = zip.file(resolveHref(opfDir, data.ncxHref));
			if (ncx) toc = parseNcx(await ncx.async("string"));
		}
		if (!toc.length && data.navHref) {
			const nav = zip.file(resolveHref(opfDir, data.navHref));
			if (nav) toc = parseEpub3Nav(await nav.async("string"));
		}

		const tocItems = buildToc(toc, data.spine);
		return {
			fingerprint: ctx.fingerprint,
			path: ctx.path,
			format: "epub",
			title: data.title || ctx.path.split("/").pop()?.replace(/\.epub$/i, "") || "未命名电子书",
			author: data.author || undefined,
			toc: tocItems,
			spine: data.spine,
			estimatedChars: data.spine.length,
		};
	}
}

/** 解析 OPF：元数据、manifest、spine、NCX/EPUB3 nav 引用。 */
export function parseOpf(xml: string): OpfData {
	const title = extractTagText(xml, "dc:title") || extractTagText(xml, "title:title");
	const author = extractTagText(xml, "dc:creator") || extractTagText(xml, "creator");

	const manifest = new Map<string, { href: string; properties?: string }>();
	const itemRe = /<item\b[^>]*>/gi;
	let m: RegExpExecArray | null;
	while ((m = itemRe.exec(xml)) !== null) {
		const attrs = parseAttrs(m[0]);
		if (attrs.id && attrs.href) manifest.set(attrs.id, { href: attrs.href, properties: attrs.properties });
	}

	const spineIdRefs: string[] = [];
	const itemrefRe = /<itemref\b[^>]*>/gi;
	while ((m = itemrefRe.exec(xml)) !== null) {
		const idref = parseAttrs(m[0]).idref;
		if (idref) spineIdRefs.push(idref);
	}
	const spine = spineIdRefs.map((idref) => ({
		id: idref,
		href: manifest.get(idref)?.href ?? idref,
	}));

	const spineTag = /<spine\b[^>]*>/i.exec(xml);
	const tocAttr = spineTag ? parseAttrs(spineTag[0]).toc : undefined;
	const ncxHref = tocAttr ? manifest.get(tocAttr)?.href : undefined;

	let navHref: string | undefined;
	for (const item of manifest.values()) {
		if (/nav/i.test(item.properties ?? "")) {
			navHref = item.href;
			break;
		}
	}
	return { title, author, spine, ncxHref, navHref };
}

/** 解析 EPUB2 NCX（navPoint 嵌套）。 */
export function parseNcx(xml: string, max = 1000): EpubNavItem[] {
	const out: EpubNavItem[] = [];
	let cursor = 0;
	while (out.length < max) {
		const start = xml.indexOf("<navPoint", cursor);
		if (start < 0) break;
		const openEnd = xml.indexOf(">", start);
		if (openEnd < 0) break;
		// 深度计数找配对的 </navPoint>（正则非贪婪会被内层 navPoint 提前截断）
		const innerStart = openEnd + 1;
		let depth = 1;
		let j = innerStart;
		let closeEnd = -1;
		while (j < xml.length && depth > 0) {
			const openNext = xml.indexOf("<navPoint", j);
			const closeNext = xml.indexOf("</navPoint>", j);
			if (closeNext < 0) break;
			if (openNext >= 0 && openNext < closeNext) {
				depth++;
				j = openNext + "<navPoint".length;
			} else {
				depth--;
				j = closeNext + "</navPoint>".length;
				if (depth === 0) closeEnd = closeNext;
			}
		}
		if (closeEnd < 0) break;
		const inner = xml.slice(innerStart, closeEnd);
		const label = (extractTagText(inner, "text") ?? "").trim() || "(无标题)";
		const content = /<content\b[^>]*>/i.exec(inner);
		const href = content && content[0] ? parseAttrs(content[0]).src : undefined;
		const subitems = parseNcx(inner, 200);
		out.push({ label: label.slice(0, 80), href, subitems: subitems.length ? subitems : undefined });
		cursor = j;
	}
	return out;
}

/** 解析 EPUB3 nav 文档的目录链接（扁平化即可满足导航需求）。 */
export function parseEpub3Nav(xml: string, max = 1000): EpubNavItem[] {
	const out: EpubNavItem[] = [];
	const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null && out.length < max) {
		const label = stripTags(m[2]).replace(/\s+/g, " ").trim();
		if (!label) continue;
		out.push({ label: label.slice(0, 80), href: m[1] });
	}
	return out;
}

/** 把目录条目映射为 TocItem；location 为章节锚点（HtmlDocEngine 内跳转用）。 */
export function buildToc(items: EpubNavItem[], spine: Array<{ id: string; href: string }>): TocItem[] {
	const resolveIndex = (href?: string): number => {
		if (!href) return 0;
		const base = href.split("#")[0].split("?")[0];
		const idx = spine.findIndex((s) => s.href === base || s.href.endsWith(`/${base}`));
		return idx >= 0 ? idx : 0;
	};
	const walk = (nodes: EpubNavItem[], depth: number): TocItem[] =>
		nodes.map((n, i) => {
			const item: TocItem = {
				id: `epub-toc-${depth}-${i}`,
				label: n.label || "(无标题)",
				location: `#${EPUB_ANCHOR_PREFIX}${resolveIndex(n.href)}`,
			};
			if (n.subitems?.length) item.children = walk(n.subitems, depth + 1);
			return item;
		});
	return walk(items, 0);
}

// ---------- 小工具 ----------

/** 提取第一个 <tag>...</tag> 内的纯文本（剥离嵌套标签）。 */
function extractTagText(xml: string, tag: string): string | undefined {
	const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
	const m = re.exec(xml);
	return m ? decodeEntities(stripTags(m[1])).trim() : undefined;
}

function stripTags(s: string): string {
	return s.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}

/** 解析标签属性为对象（支持单双引号、无引号；兼容命名空间前缀）。 */
export function parseAttrs(tag: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(tag)) !== null) {
		attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
	}
	return attrs;
}

function dirOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx > 0 ? path.slice(0, idx) : "";
}

/** 把 OPF 内相对 href 解析为 zip 内绝对路径（去 #/？、折叠 ./ 与 ../）。 */
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
