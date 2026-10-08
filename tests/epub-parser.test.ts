/** EPUB 解析器单测：OPF/NCX/nav 解析 + 合成 zip 端到端。 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { EpubParser, parseNcx, parseEpub3Nav, parseOpf } from "../src/services/books/formats/epub/EpubParser";
import type { ParseContext } from "../src/services/books/Parser";

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Pride and Prejudice</dc:title>
    <dc:creator>Jane Austen</dc:creator>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

async function makeEpub(): Promise<ArrayBuffer> {
	const zip = new JSZip();
	zip.file("mimetype", "application/epub+zip");
	zip.file(
		"META-INF/container.xml",
		`<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
	);
	zip.file("OEBPS/content.opf", OPF);
	zip.file(
		"OEBPS/toc.ncx",
		`<?xml version="1.0"?><ncx><navMap>
			<navPoint id="n1"><navLabel><text>Chapter One</text></navLabel><content src="text/ch1.xhtml"/></navPoint>
			<navPoint id="n2"><navLabel><text>Chapter Two</text></navLabel><content src="text/ch2.xhtml#mid"/>
				<navPoint id="n2a"><navLabel><text>Two Point A</text></navLabel><content src="text/ch2.xhtml#a"/></navPoint>
			</navPoint>
		</navMap></ncx>`
	);
	zip.file("OEBPS/text/ch1.xhtml", "<html><body><p>one</p></body></html>");
	zip.file("OEBPS/text/ch2.xhtml", "<html><body><p>two</p></body></html>");
	return zip.generateAsync({ type: "arraybuffer" });
}

describe("parseOpf", () => {
	it("提取标题/作者与 spine 顺序", () => {
		const data = parseOpf(OPF);
		expect(data.title).toBe("Pride and Prejudice");
		expect(data.author).toBe("Jane Austen");
		expect(data.spine.map((s) => s.href)).toEqual(["text/ch1.xhtml", "text/ch2.xhtml"]);
		expect(data.ncxHref).toBe("toc.ncx");
	});
});

describe("parseNcx / parseEpub3Nav", () => {
	it("NCX 嵌套目录", () => {
		const toc = parseNcx(
			`<ncx><navMap><navPoint id="a"><navLabel><text>A</text></navLabel><content src="1.xhtml"/></navPoint>
			<navPoint id="b"><navLabel><text>B</text></navLabel><content src="2.xhtml#x"/>
				<navPoint id="b1"><navLabel><text>B1</text></navLabel><content src="2.xhtml#y"/></navPoint>
			</navPoint></navMap></ncx>`
		);
		expect(toc.map((t) => t.label)).toEqual(["A", "B"]);
		expect(toc[1].subitems?.[0].label).toBe("B1");
	});

	it("EPUB3 nav 扁平化链接", () => {
		const toc = parseEpub3Nav(`<nav epub:type="toc"><ol><li><a href="1.xhtml">One</a></li><li><a href="2.xhtml#x">Two</a></li></ol></nav>`);
		expect(toc.map((t) => t.label)).toEqual(["One", "Two"]);
		expect(toc[1].href).toBe("2.xhtml#x");
	});
});

describe("EpubParser 端到端", () => {
	it("合成 EPUB：解析出元数据、spine 与可跳转目录", async () => {
		const buffer = await makeEpub();
		const ctx: ParseContext = {
			fingerprint: "fp1",
			path: "nyareader/library/test.epub",
			format: "epub",
			buffer,
		};
		const parser = new EpubParser();
		const book = await parser.parse(ctx);
		expect(book.title).toBe("Pride and Prejudice");
		expect(book.author).toBe("Jane Austen");
		expect(book.format).toBe("epub");
		expect(book.spine).toHaveLength(2);
		// 目录 location 对应 spine 索引
		const byLabel = new Map(book.toc.map((t) => [t.label, t.location]));
		expect(byLabel.get("Chapter One")).toBe("0");
		expect(byLabel.get("Chapter Two")).toBe("1");
		expect(book.toc.find((t) => t.label === "Chapter Two")?.children?.[0].label).toBe("Two Point A");
	});

	it("损坏的 EPUB 抛出可读错误", async () => {
		const zip = new JSZip();
		zip.file("mimetype", "application/epub+zip");
		const buffer = await zip.generateAsync({ type: "arraybuffer" });
		const parser = new EpubParser();
		await expect(
			parser.parse({ fingerprint: "fp", path: "x.epub", format: "epub", buffer })
		).rejects.toThrow(/container\.xml/);
	});
});
