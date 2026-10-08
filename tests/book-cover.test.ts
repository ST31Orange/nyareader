/** 书架封面提取单测：EPUB（meta[name=cover]/cover-image）与 MOBI（EXTH 201/兜底）。 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { extractEpubCover, extractMobiCover, findEpubCoverCandidates, isImageBytes } from "../src/services/books/BookCoverService";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

async function buildEpub(opts: { metaCover?: boolean; propertiesCover?: boolean } = {}): Promise<ArrayBuffer> {
	const zip = new JSZip();
	zip.file(
		"META-INF/container.xml",
		`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
	);
	const props = opts.propertiesCover ? ' properties="cover-image"' : "";
	zip.file(
		"OEBPS/content.opf",
		`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test</dc:title>
    ${opts.metaCover ? '<meta name="cover" content="cover-img"/>' : ""}
  </metadata>
  <manifest>
    <item id="cover-img" href="images/cover.png" media-type="image/png"${props}/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`
	);
	zip.file("OEBPS/images/cover.png", PNG);
	zip.file("OEBPS/c1.xhtml", "<html><body><p>hi</p></body></html>");
	return await zip.generateAsync({ type: "arraybuffer" });
}

function writeU16(buf: Uint8Array, off: number, v: number): void {
	buf[off] = (v >> 8) & 0xff;
	buf[off + 1] = v & 0xff;
}
function writeU32(buf: Uint8Array, off: number, v: number): void {
	buf[off] = (v >>> 24) & 0xff;
	buf[off + 1] = (v >>> 16) & 0xff;
	buf[off + 2] = (v >>> 8) & 0xff;
	buf[off + 3] = v & 0xff;
}

/** 构造最小 PalmDB：记录 0=PalmDoc 头+MOBI 头+EXTH，记录 1=正文，记录 2=封面 JPEG。 */
function buildMobi(opts: { coverRecord?: number }): Uint8Array {
	const text = new TextEncoder().encode("Hello NyaReader cover test.");
	const recordCount = 3;
	const headerSize = 78 + 8 * recordCount;
	const mobiLen = 232;
	const exthLen = 8 + 12; // EXTH 头 8 字节 + 一条记录 12 字节
	const record0Size = 16 + 4 + 4 + mobiLen + exthLen;
	const rec0 = headerSize;
	const rec1 = rec0 + record0Size;
	const rec2 = rec1 + text.length;
	const buf = new Uint8Array(rec2 + JPEG.length);
	buf.set(new TextEncoder().encode("BOOKMOBI"), 60);
	writeU16(buf, 76, recordCount);
	writeU32(buf, 78 + 0 * 8, rec0);
	writeU32(buf, 78 + 1 * 8, rec1);
	writeU32(buf, 78 + 2 * 8, rec2);
	// PalmDoc 头
	writeU16(buf, rec0, 1); // compression = 1（不压缩）
	writeU16(buf, rec0 + 2, 0);
	writeU32(buf, rec0 + 4, text.length);
	writeU16(buf, rec0 + 8, 1); // textRecordCount
	writeU16(buf, rec0 + 10, 4096);
	writeU16(buf, rec0 + 12, 0); // encryption
	writeU16(buf, rec0 + 14, 0);
	// MOBI 头
	buf.set(new TextEncoder().encode("MOBI"), rec0 + 16);
	writeU32(buf, rec0 + 20, mobiLen);
	// EXTH
	const exth = rec0 + 16 + 4 + 4 + mobiLen;
	buf.set(new TextEncoder().encode("EXTH"), exth);
	writeU32(buf, exth + 4, exthLen);
	if (opts.coverRecord != null) {
		writeU32(buf, exth + 8, 201);
		writeU32(buf, exth + 12, 12);
		writeU32(buf, exth + 16, opts.coverRecord);
	} else {
		// 无封面标记：放一条无关 EXTH（作者=100），触发"正文记录后第一张图"兜底
		writeU32(buf, exth + 8, 100);
		writeU32(buf, exth + 12, 12);
		writeU32(buf, exth + 16, 0);
	}
	buf.set(text, rec1);
	buf.set(JPEG, rec2);
	return buf;
}

describe("isImageBytes", () => {
	it("识别 JPEG/PNG 幻数", () => {
		expect(isImageBytes(JPEG)).toBe(true);
		expect(isImageBytes(PNG)).toBe(true);
		expect(isImageBytes(new Uint8Array([1, 2, 3, 4]))).toBe(false);
	});
});

describe("extractEpubCover", () => {
	it("meta[name=cover] 定位封面并返回原图字节", async () => {
		const img = await extractEpubCover(await buildEpub({ metaCover: true }));
		expect(img).not.toBeNull();
		expect(img!.mime).toBe("image/png");
		expect(Array.from(img!.bytes)).toEqual(Array.from(PNG));
	});
	it("properties=cover-image 兜底", async () => {
		const img = await extractEpubCover(await buildEpub({ propertiesCover: true }));
		expect(img?.mime).toBe("image/png");
	});
	it("非 zip 返回 null", async () => {
		expect(await extractEpubCover(new TextEncoder().encode("not a zip").buffer as ArrayBuffer)).toBeNull();
	});
});

describe("findEpubCoverCandidates", () => {
	it("meta 优先、cover-image 兜底", () => {
		const xml = `<package><metadata><meta name="cover" content="a"/></metadata><manifest>
			<item id="a" href="images/c.png" media-type="image/png"/>
			<item id="b" href="other/c.png" media-type="image/png" properties="cover-image"/>
		</manifest></package>`;
		const out = findEpubCoverCandidates(xml);
		expect(out[0]).toBe("images/c.png");
		expect(out).toContain("other/c.png");
	});
});

describe("extractMobiCover", () => {
	it("EXTH 201 取封面记录", () => {
		const img = extractMobiCover(buildMobi({ coverRecord: 2 }));
		expect(img).not.toBeNull();
		expect(img!.mime).toBe("image/jpeg");
		expect(Array.from(img!.bytes)).toEqual(Array.from(JPEG));
	});
	it("无 EXTH 封面标记时用正文记录后的第一张图片", () => {
		const img = extractMobiCover(buildMobi({}));
		expect(img?.mime).toBe("image/jpeg");
	});
	it("损坏输入返回 null", () => {
		expect(extractMobiCover(new Uint8Array(4))).toBeNull();
		expect(extractMobiCover(new Uint8Array(200))).toBeNull();
	});
});