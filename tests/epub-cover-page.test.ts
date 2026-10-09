/**
 * 「封面页 / 整页插图在阅读器里是空白」的真实写法回归（《银河帝国完整版》实测结构）。
 *
 * 真实样本（只读取证）：
 * - `OEBPS/Text/cover.xhtml`：
 *   `<div style="text-align:center"><svg viewBox="0 0 960 1280"><image xlink:href="../Images/cover.jpg"/></svg></div>`
 * - `OEBPS/Text/Section0001.xhtml`（分卷封面页）：
 *   `<body style="background-image:url('../Images/1cover.jpg');..."></body>`（正文为空）
 *
 * 两种写法都不是 `<img>`，而引擎的资源回填只认 `<img data-nyar-asset>`：
 * 相对路径在 srcdoc iframe 里必然 404 → 该页空白（用户报的"封面渲染失败"就是它）。
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
	EPUB_ASSET_ATTR,
	EPUB_ASSET_FALLBACK_ATTR,
	openEpubSource,
	registerBodyBackgroundImage,
	registerChapterImages,
	registerSvgImages,
} from "../src/services/books/formats/epub/EpubDocument";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

describe("registerSvgImages：单图 <svg> 包装 -> <img>（封面页/整页插图）", () => {
	it("真实《银河帝国》cover.xhtml 写法被改写成可回填的 <img>", () => {
		const body =
			`<div style="text-align: center; padding: 0pt; margin: 0pt;">` +
			`<svg xmlns="http://www.w3.org/2000/svg" height="100%" preserveAspectRatio="xMidYMid meet" version="1.1" viewBox="0 0 960 1280" width="100%" xmlns:xlink="http://www.w3.org/1999/xlink">` +
			`<image height="1280" width="960" xlink:href="../Images/cover.jpg"/></svg></div>`;
		const out = registerSvgImages(body, "OEBPS/Text");
		expect(out).not.toMatch(/<svg\b/i);
		expect(out).not.toMatch(/<image\b/i);
		expect(out).toContain(`<img width="960"`);
		expect(out).toContain(`${EPUB_ASSET_ATTR}="OEBPS/Images/cover.jpg"`);
		expect(out).toContain(`${EPUB_ASSET_FALLBACK_ATTR}="../Images/cover.jpg"`);
		// 外层 div 的排版意图保留
		expect(out).toContain("text-align: center");
	});

	it("含其它矢量元素的复杂 SVG 原样保留（不误伤）", () => {
		const body = `<svg viewBox="0 0 10 10"><rect width="10" height="10"/><image xlink:href="a.png"/></svg>`;
		expect(registerSvgImages(body, "OEBPS")).toBe(body);
	});

	it("多张 <image> 的 SVG 原样保留", () => {
		const body = `<svg><image xlink:href="a.png"/><image xlink:href="b.png"/></svg>`;
		expect(registerSvgImages(body, "OEBPS")).toBe(body);
	});

	it("外链/data: 图片不改写（浏览器自己能加载）", () => {
		const body = `<svg><image xlink:href="https://x/y.png"/></svg>`;
		expect(registerSvgImages(body, "OEBPS")).toBe(body);
	});

	it("registerChapterImages 同时处理 <img> 与单图 <svg>", () => {
		const body = `<p>t</p><img src="images/a.png"/><svg viewBox="0 0 1 1"><image xlink:href="images/b.png" width="20"/></svg>`;
		const out = registerChapterImages(body, "OEBPS");
		expect(out).toContain(`${EPUB_ASSET_ATTR}="OEBPS/images/a.png"`);
		expect(out).toContain(`${EPUB_ASSET_ATTR}="OEBPS/images/b.png"`);
		expect(out).not.toMatch(/<svg\b|<image\b/i);
	});
});

describe("registerBodyBackgroundImage：整页只有背景图的章节不再空白", () => {
	it("真实分卷封面页写法（body 内无内容 + background-image）注入 <img>", () => {
		const out = registerBodyBackgroundImage(
			"",
			` style="background-image:url('../Images/1cover.jpg');background-repeat:no-repeat;background-size: contain;background-position: center center;"`,
			"OEBPS/Text"
		);
		expect(out).toContain(`${EPUB_ASSET_ATTR}="OEBPS/Images/1cover.jpg"`);
		expect(out).toContain(`${EPUB_ASSET_FALLBACK_ATTR}="../Images/1cover.jpg"`);
	});

	it("背景图写在内部 div 的 style 上也能识别", () => {
		const plain = registerBodyBackgroundImage(`<div style="background-image: url('Images/z1.png')"></div>`, "", "OEBPS");
		expect(plain).toContain(`${EPUB_ASSET_ATTR}="OEBPS/Images/z1.png"`);
		// HTML 实体引号写法（&quot;）也要还原成正常路径，而不是把实体当路径
		const dq = registerBodyBackgroundImage(`<div style="background-image:url(&quot;Images/z2.png&quot;)"></div>`, "", "OEBPS");
		expect(dq).toContain(`${EPUB_ASSET_ATTR}="OEBPS/Images/z2.png"`);
	});

	it("正文有文字/图片时不改（避免重复插图）", () => {
		const attrs = ` style="background-image:url('Images/z1.png')"`;
		expect(registerBodyBackgroundImage("<p>正文</p>", attrs, "OEBPS")).toBe("<p>正文</p>");
		expect(registerBodyBackgroundImage(`<img ${EPUB_ASSET_ATTR}="x"/>`, attrs, "OEBPS")).toBe(`<img ${EPUB_ASSET_ATTR}="x"/>`);
	});

	it("http/data: 背景图不处理（不需要 blob 回填）", () => {
		expect(registerBodyBackgroundImage("", ` style="background-image:url('https://x/a.png')"`, "OEBPS")).toBe("");
		expect(registerBodyBackgroundImage("", ` style="background-image:url('data:image/png;base64,AA')"`, "OEBPS")).toBe("");
	});
});

// ---------------------------------------------------------------- 端到端（E1）

/** 造一本按《银河帝国》真实结构写的 EPUB：封面页(SVG)、分卷封面页(body 背景图)、正文页。 */
async function buildRealisticEpub(): Promise<ArrayBuffer> {
	const zip = new JSZip();
	zip.file("mimetype", "application/epub+zip");
	zip.file(
		"META-INF/container.xml",
		`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
	);
	zip.file("OEBPS/Images/cover.jpg", JPEG);
	zip.file("OEBPS/Images/1cover.jpg", JPEG);
	zip.file(
		"OEBPS/Text/cover.xhtml",
		`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head><body><div style="text-align: center; padding: 0pt; margin: 0pt;"><svg xmlns="http://www.w3.org/2000/svg" height="100%" preserveAspectRatio="xMidYMid meet" version="1.1" viewBox="0 0 960 1280" width="100%" xmlns:xlink="http://www.w3.org/1999/xlink"><image height="1280" width="960" xlink:href="../Images/cover.jpg"/></svg></div></body></html>`
	);
	zip.file(
		"OEBPS/Text/1.xhtml",
		`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title></title></head><body style="background-image:url('../Images/1cover.jpg');background-repeat:no-repeat;background-size: contain;background-position: center center;"></body></html>`
	);
	zip.file(
		"OEBPS/Text/ch1.xhtml",
		`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c1</title></head><body><p>心理史学家</p></body></html>`
	);
	zip.file(
		"OEBPS/content.opf",
		`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="b"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>银河帝国</dc:title><meta name="cover" content="cover-img"/></metadata><manifest><item id="cover-img" href="Images/cover.jpg" media-type="image/jpeg"/><item id="c0" href="Text/cover.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="Text/1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c0"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>`
	);
	return await zip.generateAsync({ type: "arraybuffer" });
}

describe("端到端：封面页与分卷封面页都能拿到可回填资源（E1）", () => {
	it("buildInitialHtml(3) 里两页都产出了 <img data-nyar-asset>，且能解析成 blob", async () => {
		const source = await openEpubSource(await buildRealisticEpub(), "银河帝国");
		expect(source.chapterCount).toBe(3);
		const html = await source.buildInitialHtml(3);
		expect(html).toContain(`${EPUB_ASSET_ATTR}="OEBPS/Images/cover.jpg"`);
		expect(html).toContain(`${EPUB_ASSET_ATTR}="OEBPS/Images/1cover.jpg"`);
		expect(html).not.toMatch(/<svg\b/i);
		expect((html.match(/data-nyar-asset=/g) ?? []).length).toBe(2);

		const canBlob = typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
		const url = await source.resolveAssetUrl("OEBPS/Images/cover.jpg");
		if (canBlob) expect(url).toMatch(/^blob:/);
		// 缺失资源仍返回 null（引擎会加可见占位），不会静默
		expect(await source.resolveAssetUrl("OEBPS/Images/missing.jpg")).toBeNull();
		source.dispose();
	});
});
