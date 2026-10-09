/**
 * tests/verify-reader.test.ts —— 独立验证者的回归测试（不依赖 verify/ 下的 headless harness）。
 *
 * 覆盖两件「用户主诉」在单元层的契约：
 *  1) 图片不再消失：EPUB 构建产物里，<img> 绝不能出现 src=""（旧实现 >1.5MB 就走这条路，
 *     再被 CSS `img[src=""] { display: none }` 隐藏 → 大图直接没了）；
 *     取而代之的是 data-nyar-asset 资源登记，由引擎按需解析成 blob: URL。
 *  2) 分页版式的几何上限：bookWidth + 2×页边距 必须 ≤ 可用宽度（否则出横向滚动条 / 右页被裁）。
 *
 * 证据强度标注：
 *  - 第 1 组：E1（真实 buildEpubHtml / registerChapterImages + 真实 jszip 输入）
 *  - 第 2 组：E1（真实纯函数 computePageLayout / pageCountFromMarker）
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
	EPUB_ASSET_ATTR,
	EPUB_ASSET_FALLBACK_ATTR,
	buildEpubHtml,
	registerChapterImages,
} from "../src/services/books/formats/epub/EpubDocument";
import { computePageLayout, pageCountFromMarker } from "../src/services/books/formats/html/paging-layout";

// ------------------------------------------------------------------ 1. 图片登记

describe("EPUB 图片登记：不再把图片清成 src=\"\"", () => {
	it("普通相对路径图片被登记为 data-nyar-asset，且原始 src 被移除", () => {
		const out = registerChapterImages(`<p>x</p><img src="images/a.png" alt="A"/>`, "OEBPS");
		expect(out).not.toMatch(/\ssrc\s*=/i);
		expect(out).toContain(`${EPUB_ASSET_ATTR}="OEBPS/images/a.png"`);
		expect(out).toContain(`${EPUB_ASSET_FALLBACK_ATTR}="images/a.png"`);
		expect(out).toContain('alt="A"');
	});

	it("绝不产生 src=\"\"（旧实现在图片 >1.5MB 或缺失时就会走到这一步）", () => {
		const html = `<img src="a.png"/><img src="missing/none.png"/><img src="b.jpg"/>`;
		const out = registerChapterImages(html, "OEBPS");
		expect(out).not.toMatch(/src\s*=\s*(""|'')/);
		expect(out.match(new RegExp(EPUB_ASSET_ATTR, "g"))).toHaveLength(3);
	});

	it("只有 srcset 的图片同样被登记（懒加载书常见写法）", () => {
		const out = registerChapterImages(`<img srcset="images/x.webp 1x, images/x2.webp 2x"/>`, "OEBPS");
		expect(out).not.toContain("srcset");
		expect(out).toContain(`${EPUB_ASSET_ATTR}="OEBPS/images/x.webp"`);
	});

	it("属性名大小写不敏感，且 href 里的引号被转义", () => {
		const out = registerChapterImages(`<img SRC="images/&quot;q&quot;.png"/>`, "OEBPS");
		expect(out).toContain(EPUB_ASSET_ATTR);
		expect(out).not.toMatch(/\sSRC=/);
	});

	it("上级目录路径被正确折叠", () => {
		const out = registerChapterImages(`<img src="../Images/a.png"/>`, "OEBPS/text");
		expect(out).toContain(`${EPUB_ASSET_ATTR}="OEBPS/Images/a.png"`);
	});
});

// ------------------------------------------------------------------ 2. 整本构建

/** 造一本 3 章、含一张 1.6MB「大图」的最小 EPUB。 */
async function makeEpubWithHugeImage(): Promise<ArrayBuffer> {
	const zip = new JSZip();
	zip.file("mimetype", "application/epub+zip");
	zip.file(
		"META-INF/container.xml",
		`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
	);
	// 1.6MB > 旧的 1.5MB 内联上限：旧实现会把它写成 src=""（然后被 CSS 隐藏）
	zip.file("OEBPS/images/huge.png", Buffer.alloc(1_600_000, 7));
	zip.file("OEBPS/images/big.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="3000"/>`);
	zip.file("OEBPS/style.css", "p { margin: 0 0 0.8em 0; }");
	const manifest = [
		`<item id="css" href="style.css" media-type="text/css"/>`,
		`<item id="huge" href="images/huge.png" media-type="image/png"/>`,
		`<item id="big" href="images/big.svg" media-type="image/svg+xml"/>`,
	];
	const spine: string[] = [];
	for (let i = 1; i <= 3; i++) {
		const img = i === 2 ? `<img src="images/huge.png"/><img src="images/big.svg"/>` : "";
		zip.file(
			`OEBPS/ch${i}.xhtml`,
			`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c${i}</title><link rel="stylesheet" href="style.css"/></head><body><p>${i}-1</p>${img}<p>${i}-2</p></body></html>`
		);
		manifest.push(`<item id="c${i}" href="ch${i}.xhtml" media-type="application/xhtml+xml"/>`);
		spine.push(`<itemref idref="c${i}"/>`);
	}
	zip.file(
		"OEBPS/content.opf",
		`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="b"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>verify</dc:title></metadata><manifest>${manifest.join("")}</manifest><spine>${spine.join("")}</spine></package>`
	);
	return zip.generateAsync({ type: "arraybuffer" });
}

describe("buildEpubHtml：整本构建后图片全部有登记、没有空 src", () => {
	it("1.6MB 大图不再变成 src=\"\"，而是 data-nyar-asset 登记", async () => {
		const html = await buildEpubHtml(await makeEpubWithHugeImage(), "verify", { initialChapters: 3 });
		const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
		expect(imgs.length).toBeGreaterThanOrEqual(2);
		expect(html).not.toMatch(/src\s*=\s*(""|'')/);
		for (const tag of imgs) {
			expect(tag).toMatch(new RegExp(EPUB_ASSET_ATTR));
		}
		expect(html).toContain(`${EPUB_ASSET_ATTR}="OEBPS/images/huge.png"`);
	});

	it("外链 CSS 被内联，且默认只构建前 2 章（首屏懒加载契约）", async () => {
		const buf = await makeEpubWithHugeImage();
		const first = await buildEpubHtml(buf, "verify");
		expect(first).toContain("margin: 0 0 0.8em 0");
		expect(first).toContain("1-1");
		expect(first).toContain("2-1");
		expect(first).not.toContain("3-1");
	});
});

// ------------------------------------------------------------------ 3. 版式几何上限

describe("分页版式：书窗宽度不超过可用宽度（不出横向滚动条）", () => {
	for (const [w, h] of [
		[360, 800],
		[900, 800],
		[2200, 800],
	] as const) {
		for (const double of [false, true]) {
			it(`viewWidth=${w} double=${double} 时 bookWidth+2×页边距 ≤ 视口宽`, () => {
				const layout = computePageLayout({ viewWidth: w, viewHeight: h, double });
				const occupied = layout.bookWidth + layout.pageMarginX * 2;
				expect(occupied).toBeLessThanOrEqual(w);
				expect(layout.pageWidth).toBeGreaterThanOrEqual(120);
				expect(layout.columnStride).toBe(layout.pageWidth + layout.gutter);
			});
		}
	}

	it("窄窗下用户选了双页也必须退回单页（且槽宽/页边距用单页值）", () => {
		const layout = computePageLayout({ viewWidth: 560, viewHeight: 800, double: true });
		expect(layout.double).toBe(false);
		expect(layout.gutter).toBe(40);
		expect(layout.pageMarginX).toBe(28);
	});

	it("末尾标记反推页码：整列倍数时正好是「列数+1」", () => {
		const stride = 613;
		expect(pageCountFromMarker(0, { columnStride: stride })).toBe(1);
		expect(pageCountFromMarker(stride * 3, { columnStride: stride })).toBe(4);
		expect(pageCountFromMarker(stride * 3 + stride / 4, { columnStride: stride })).toBe(4);
	});
});
