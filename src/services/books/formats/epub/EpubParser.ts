/**
 * EPUB 解析器：基于 epub.js（复用优先）。
 * epub.js 可直接从 ArrayBuffer 打开（内部走 JSZip，不依赖网络），
 * 提供 metadata / spine / navigation，并生成 CFI 定位能力。
 * 本解析器只提取 BookModel；渲染由 EpubEngine 负责。
 */
import Epub from "epubjs";
import type { BookModel, TocItem } from "../../../../types";
import type { IBookParser, ParseContext } from "../../Parser";

export class EpubParser implements IBookParser {
	readonly format = "epub" as const;

	async parse(ctx: ParseContext): Promise<BookModel> {
		// epub.js 接受 ArrayBuffer；openEpub 返回 Promise<Book>
		const book = await Epub(ctx.buffer).ready as unknown as { opened?: Promise<unknown> } & {
			packaging: { metadata: { title?: string; creator?: string }; spine: unknown[] };
			spine: { spineItems: Array<{ id: string; href: string }> };
			navigation: { toc: EpubNavItem[] };
		};
		await (book.opened ?? Promise.resolve());

		const meta = book.packaging.metadata;
		const spine = book.spine.spineItems.map((s, i) => ({ id: s.id || `s${i}`, href: s.href, title: undefined }));
		const toc = buildToc(book.navigation.toc, spine);

		return {
			fingerprint: ctx.fingerprint,
			path: ctx.path,
			format: "epub",
			title: meta.title?.trim() || ctx.path.split("/").pop()?.replace(/\.epub$/i, "") || "未命名 EPUB",
			author: meta.creator?.trim() || undefined,
			toc,
			spine,
		};
	}
}

interface EpubNavItem {
	label: string;
	href?: string;
	subitems?: EpubNavItem[];
}

/** 把 epub.js 的嵌套目录转成 TocItem；location 存 spine 索引（渲染时可 display(index)）。 */
function buildToc(items: EpubNavItem[], spine: Array<{ id: string; href: string }>): TocItem[] {
	const resolveIndex = (href?: string): number => {
		if (!href) return 0;
		const base = href.split("#")[0];
		const idx = spine.findIndex((s) => s.href === base || s.href.endsWith(`/${base}`));
		return idx >= 0 ? idx : 0;
	};
	const walk = (nodes: EpubNavItem[], depth: number): TocItem[] =>
		nodes.map((n, i) => {
			const item: TocItem = {
				id: `epub-toc-${depth}-${i}`,
				label: n.label || "(无标题)",
				location: String(resolveIndex(n.href)),
			};
			if (n.subitems?.length) item.children = walk(n.subitems, depth + 1);
			return item;
		});
	return walk(items, 0);
}
