/**
 * EPUB 渲染文档构建：把整本书的 spine 章节合并为一份可渲染 HTML。
 *
 * 为什么不用 epub.js 渲染（v0.3.4）：
 * - epub.js 的 rendition 在本插件的 Obsidian 容器里反复出现"打不开/白屏"，
 *   依赖其 fixture/flow 内部实现，难以逐版本适配；
 * - 我们已有经 MOBI/AZW3 验证的 HtmlDocEngine（滚动、主题、划词、目录锚点都可用），
 *   把 EPUB 章节按顺序合并成单文档即可复用同一套成熟渲染链路；
 * - 图片/内联 CSS 尽可能内联为 data URI，跨章节锚点用于目录跳转。
 */
import type JSZip from "jszip";
import { parseOpf } from "./EpubParser";
import { openEpubZip, EPUB_ANCHOR_PREFIX } from "./EpubZipCache";

export interface EpubChapterDoc {
	body: string;
	styles: string[];
}

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
};

const MAX_INLINE_IMAGE = 1.5 * 1024 * 1024;
const MAX_INLINE_CSS = 512 * 1024;

/** 构建整本 EPUB 的合并 HTML（含章节锚点与内联资源）。 */
export async function buildEpubHtml(buffer: ArrayBuffer, fallbackTitle = "EPUB"): Promise<string> {
	const zip = await openEpubZip(buffer);
	const opfPath = await findOpfPath(zip);
	const opfFile = zip.file(opfPath);
	if (!opfFile) throw new Error("EPUB 缺少 content.opf");
	const opf = parseOpf(await opfFile.async("string"));
	const dir = dirOf(opfPath);

	const heads: string[] = [];
	const bodies: string[] = [];
	const seenStyles = new Set<string>();
	for (let i = 0; i < opf.spine.length; i++) {
		const href = resolveHref(dir, opf.spine[i].href);
		const file = zip.file(href);
		const text = file ? await file.async("string") : `<html><body><p>（缺失章节 ${opf.spine[i].href}）</p></body></html>`;
		const doc = await transformChapter(text, zip, dir);
		bodies.push(`<span id="${EPUB_ANCHOR_PREFIX}${i}" class="nyareader-epub-anchor"></span>` + doc.body);
		for (const style of doc.styles) {
			if (!seenStyles.has(style)) {
				seenStyles.add(style);
				heads.push(`<style>${style}</style>`);
			}
		}
	}
	const title = escapeHtml(opf.title || fallbackTitle);
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>${heads.join("\n")}</head><body>${bodies.join("\n")}</body></html>`;
}

/** 转换单个 XHTML 章节：去 xml/script，抽取样式，内联图片，保留正文。 */
export async function transformChapter(xhtml: string, zip: JSZip, dir: string): Promise<EpubChapterDoc> {
	let s = xhtml
		.replace(/<\?xml[^>]*\?>/gi, "")
		.replace(/<!DOCTYPE[^>]*>/gi, "")
		.replace(/<script\b[\s\S]*?<\/script>/gi, "");

	const styles: string[] = [];
	const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(s);
	if (head) {
		const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
		let m: RegExpExecArray | null;
		while ((m = styleRe.exec(head[1])) !== null) {
			if (m[1].trim()) styles.push(m[1].trim());
		}
		// 外链样式表：存在且不超限则内联
		const linkRe = /<link\b[^>]*>/gi;
		while ((m = linkRe.exec(head[1])) !== null) {
			const attrs = parseAttrs(m[0]);
			if (/stylesheet/i.test(attrs.rel ?? "") && attrs.href) {
				const cssPath = resolveHref(dir, attrs.href);
				const cssFile = zip.file(cssPath);
				if (cssFile) {
					const raw = await cssFile.async("uint8array");
					if (raw.length <= MAX_INLINE_CSS) {
						const css = new TextDecoder("utf-8").decode(raw);
						if (css.trim()) styles.push(css.trim());
					}
				}
			}
		}
		// 移除外链样式表标签（内联后避免双重加载/破链接）
		s = s.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, "");
	}

	const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(s);
	const bodyHtml = body ? body[1] : stripHead(s);
	const inlined = await inlineImages(bodyHtml, zip, dir);
	return { body: inlined, styles };
}

/** 把章节里引用的图片内联为 data URI（缺失/超限则清空 src，避免破图）。 */
async function inlineImages(body: string, zip: JSZip, dir: string): Promise<string> {
	const imgRe = /<img\b[^>]*>/gi;
	const tags: Array<{ tag: string; index: number; length: number }> = [];
	let m: RegExpExecArray | null;
	while ((m = imgRe.exec(body)) !== null) tags.push({ tag: m[0], index: m.index, length: m[0].length });
	let out = body;
	for (const t of tags.reverse()) {
		const attrs = parseAttrs(t.tag);
		const src = attrs.src;
		let replacement = t.tag;
		if (src) {
			const imgPath = resolveHref(dir, src);
			const file = zip.file(imgPath);
			const ext = src.split("?")[0].split("#")[0].split(".").pop()?.toLowerCase() ?? "";
			const mime = MIME_BY_EXT[ext];
			if (file && mime) {
				const raw = await file.async("uint8array");
				if (raw.length <= MAX_INLINE_IMAGE) {
					const dataUri = `data:${mime};base64,${bytesToBase64(raw)}`;
					replacement = t.tag.replace(/src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, `src="${dataUri}"`).replace(/\ssrcset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "");
				} else {
					replacement = t.tag.replace(/src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, 'src=""').replace(/\ssrcset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "");
				}
			} else {
				replacement = t.tag.replace(/src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, 'src=""').replace(/\ssrcset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "");
			}
		}
		out = out.slice(0, t.index) + replacement + out.slice(t.index + t.length);
	}
	return out;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
	}
	return btoa(binary);
}

function stripHead(s: string): string {
	const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(s);
	if (!head) return s;
	return s.slice(0, head.index) + s.slice(head.index + head[0].length);
}

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

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
