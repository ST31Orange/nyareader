/** MOBI/PalmDOC 单测：LZ77 解压往返 + 多记录组装 + HTML 提取 + 目录提取。 */
import { describe, it, expect } from "vitest";
import { decompressPalmDoc } from "../src/services/books/formats/mobi/palmdoc";
import {
	applyFileposAnchors,
	extractAnchorToc,
	extractMobiContent,
	extractTocFromHtml,
	mergeHtmlDocuments,
	readTextRecords,
	rewriteFileposLinks,
} from "../src/services/books/formats/mobi/MobiParser";

/**
 * 构造一个最小可用的 PalmDOC 压缩流（compression=2, LZ77）。
 * 由于算法基于 2048 字节滑动窗口，构造一个简单可验证的输入：
 * 先输出若干 literal，再模拟一段可匹配的重复串。
 * 我们只验证"解压不崩溃且长度正确"这一基本性质，并用一个自编的最小流。
 */
function compressLiteral(bytes: Uint8Array): Uint8Array {
	// 简单编码：<=8 个字节的字面量用 1-8 前缀；否则用 0x80+ 单字节字面量
	const out: number[] = [];
	let i = 0;
	while (i < bytes.length) {
		const run = Math.min(8, bytes.length - i);
		out.push(run);
		for (let j = 0; j < run; j++) out.push(bytes[i + j]);
		i += run;
	}
	return new Uint8Array(out);
}

describe("decompressPalmDoc", () => {
	it("解压纯字面量数据", () => {
		const original = new Uint8Array([72, 101, 108, 108, 111, 32, 78, 121, 97]); // "Hello Nya"
		const compressed = compressLiteral(original);
		const result = decompressPalmDoc(compressed, 0, compressed.length);
		expect(Array.from(result)).toEqual(Array.from(original));
	});

	it("空输入返回空", () => {
		const result = decompressPalmDoc(new Uint8Array(0), 0, 0);
		expect(result.length).toBe(0);
	});

	it("带 0 字节字面量（C 风格字符串尾部）", () => {
		const compressed = new Uint8Array([0, 72, 105]); // 0x00 literal + 0x48,0x69 => "Hi"
		const result = decompressPalmDoc(compressed, 0, compressed.length);
		expect(Array.from(result)).toEqual([0, 72, 105]);
	});
});

describe("decompressPalmDoc: LZ77 位域", () => {
	it("距离字段不需要 +1（回归：+1 会让整段文本错位）", () => {
		// 字面量 "abc"，然后 LZ77: distance=3, length=6 => 值 (3 << 3) | (6 - 3) = 0x1B
		const stream = new Uint8Array([3, 0x61, 0x62, 0x63, 0x80, 0x1b]);
		const out = decompressPalmDoc(stream, 0, stream.length);
		expect(new TextDecoder().decode(out)).toBe("abcabcabc");
	});

	it("0xC0..0xFF 是「空格 + 字符」转义，不是 LZ77", () => {
		// 0xC1 => 空格 + (0xC1 ^ 0x80) = 空格 + 'A'
		const stream = new Uint8Array([1, 0x78, 0xc1]);
		const out = decompressPalmDoc(stream, 0, stream.length);
		expect(new TextDecoder().decode(out)).toBe("x A");
	});

	it("maxOutput 用于丢弃记录尾部的检索数据", () => {
		// 6 个字面量 + 尾部垃圾（会被当成 LZ77 继续产出）
		const stream = new Uint8Array([6, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0x80, 0x03]);
		expect(decompressPalmDoc(stream, 0, stream.length).length).toBeGreaterThan(6);
		const capped = decompressPalmDoc(stream, 0, stream.length, 6);
		expect(new TextDecoder().decode(capped)).toBe("hello!");
	});
});

describe("readTextRecords: 多记录组装", () => {
	it("逐记录解压并按 recordSize 截断，丢弃尾部数据", () => {
		// 记录 1: 压缩出 5 字节正文 + 3 字节尾部垃圾；记录 2 同理
		const rec1 = new Uint8Array([5, 0x41, 0x41, 0x41, 0x41, 0x41, 0x80, 0x03]);
		const rec2 = new Uint8Array([5, 0x42, 0x42, 0x42, 0x42, 0x42, 0x80, 0x03]);
		const bytes = new Uint8Array(rec1.length + rec2.length);
		bytes.set(rec1, 0);
		bytes.set(rec2, rec1.length);
		const offset = (i: number) => (i === 0 ? 0 : i === 1 ? 0 : i === 2 ? rec1.length : bytes.length);
		const text = readTextRecords(bytes, offset, {
			compression: 2,
			textLength: 10,
			textRecordCount: 2,
			recordSize: 5,
		});
		expect(new TextDecoder().decode(text)).toBe("AAAAABBBBB");
	});

	it("无压缩记录按 recordSize 直接切片", () => {
		const bytes = new TextEncoder().encode("hello world");
		const offset = (i: number) => (i === 2 ? bytes.length : 0);
		const text = readTextRecords(bytes, offset, {
			compression: 1,
			textLength: 5,
			textRecordCount: 1,
			recordSize: 5,
		});
		expect(new TextDecoder().decode(text)).toBe("hello");
	});
});

describe("KF8/AZW3 多文档合并", () => {
	it("把多份 XHTML 合并为单文档（浏览器只认第一个根节点）", () => {
		const merged = mergeHtmlDocuments(
			`<?xml version="1.0"?><html><head><title>A</title><style>p{color:red}</style></head><body><p>one</p></body></html>` +
				`<?xml version="1.0"?><html><head><title>B</title></head><body><p>two</p></body></html>`
		);
		expect((merged.match(/<html\b/gi) || []).length).toBe(1);
		expect(merged).toContain("<p>one</p>");
		expect(merged).toContain("<p>two</p>");
		expect(merged).toContain("p{color:red}");
	});

	it("单文档原样返回", () => {
		const html = `<html><body><p>x</p></body></html>`;
		expect(mergeHtmlDocuments(html)).toBe(html);
	});
});

describe("MOBI6 filepos 锚点", () => {
	it("在目标偏移插入锚点并把链接改写为 # 链接", () => {
		// 数字 28 指向 `<p ...>` 标签开始处（28 号字节是 '<'）
		const text = new TextEncoder().encode(`<a filepos=0000000028>Go</a><p id="x">target</p>`);
		const anchored = applyFileposAnchors(text);
		const html = rewriteFileposLinks(new TextDecoder().decode(anchored));
		expect(html).toContain(`href="#nyareader-fp-28"`);
		expect(html).toContain(`<span id="nyareader-fp-28"></span>`);
		expect(extractAnchorToc(html).map((t) => t.label)).toEqual(["Go"]);
	});

	it("目标不在标签起始处时不插入锚点（避免切断字符）", () => {
		const text = new TextEncoder().encode(`<a filepos=0000000001>x</a>`);
		const anchored = applyFileposAnchors(text);
		expect(new TextDecoder().decode(anchored)).not.toContain("span");
	});
});

/** 构造一个最小但结构真实的 PalmDB/MOBI 文件，用于端到端解析测试。 */
function buildSyntheticMobi(textRecords: Uint8Array[], textLength: number, recordSize: number, title: string): Uint8Array {
	const recordCount = textRecords.length + 1;
	const tableEnd = 78 + recordCount * 8;

	const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
	const exthEntry = (type: number, value: string): number[] => {
		const data = Array.from(new TextEncoder().encode(value));
		return [...be32(type), ...be32(8 + data.length), ...data];
	};
	const exthBody = [...exthEntry(503, `${title}\0`), ...exthEntry(100, "Author\0")];
	const exth = [0x45, 0x58, 0x54, 0x48, ...be32(12 + exthBody.length), ...be32(2), ...exthBody];
	const mobiHeader = [..."MOBI"].map((c) => c.charCodeAt(0));
	mobiHeader.push(0, 0, 0, 20, ...new Array(12).fill(0));
	const palmDocHeader = [
		0, 2, // compression = 2 (LZ77)
		0, 0,
		0, 0, 0, 0, // textLength 占位
		0, textRecords.length,
		(recordSize >> 8) & 0xff, recordSize & 0xff,
		0, 0, // encryption = 0
		0, 0,
	];
	const record0 = [...palmDocHeader, ...mobiHeader, ...exth];
	// PalmDOC 头内的 textLength 需要按小端写成大端 4 字节
	record0[4] = (textLength >>> 24) & 0xff;
	record0[5] = (textLength >>> 16) & 0xff;
	record0[6] = (textLength >>> 8) & 0xff;
	record0[7] = textLength & 0xff;

	const offsets: number[] = [tableEnd];
	let cursor = tableEnd + record0.length;
	for (const rec of textRecords) {
		offsets.push(cursor);
		cursor += rec.length;
	}
	const bytes = new Uint8Array(cursor);
	bytes[0] = 0x54; // 'T'
	"BOOKMOBI".split("").forEach((c, i) => (bytes[60 + i] = c.charCodeAt(0)));
	bytes[76] = (recordCount >> 8) & 0xff;
	bytes[77] = recordCount & 0xff;
	offsets.forEach((off, i) => {
		bytes[78 + i * 8] = (off >>> 24) & 0xff;
		bytes[78 + i * 8 + 1] = (off >>> 16) & 0xff;
		bytes[78 + i * 8 + 2] = (off >>> 8) & 0xff;
		bytes[78 + i * 8 + 3] = off & 0xff;
	});
	bytes.set(Uint8Array.from(record0), tableEnd);
	let p = tableEnd + record0.length;
	for (const rec of textRecords) {
		bytes.set(rec, p);
		p += rec.length;
	}
	return bytes;
}

describe("extractMobiContent 端到端", () => {
	it("按记录偏移表定位记录 0，逐记录解压并忽略尾部垃圾", () => {
		const html = `<html><body><p>AAAAABBBBB</p></body></html>`;
		const raw = new TextEncoder().encode(html);
		const chunk1 = compressLiteral(raw.subarray(0, 20));
		const chunk2 = compressLiteral(raw.subarray(20));
		// 每条记录后追加尾部检索数据（会被解压成乱码，必须被 recordSize 截断掉）
		const junk = new Uint8Array([0x80, 0x03]);
		const rec1 = new Uint8Array([...chunk1, ...junk]);
		const rec2 = new Uint8Array([...chunk2, ...junk]);
		const bytes = buildSyntheticMobi([rec1, rec2], raw.length, 20, "Test Book");

		const result = extractMobiContent(bytes);
		expect(result).not.toBeNull();
		expect(result?.title).toBe("Test Book");
		expect(result?.author).toBe("Author");
		expect(result?.html).toContain("AAAAABBBBB");
		expect(result?.html).not.toContain("\u0000");
	});

	it("加密文件抛出 encrypted 原因", () => {
		const raw = new TextEncoder().encode("<html><body>x</body></html>");
		const bytes = buildSyntheticMobi([compressLiteral(raw)], raw.length, 4096, "T");
		const record0 = readU32ForTest(bytes, 78);
		bytes[record0 + 13] = 1; // encryptionType = 1
		expect(() => extractMobiContent(bytes)).toThrowError(/加密/);
	});
});

function readU32ForTest(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

describe("extractTocFromHtml", () => {
	it("从 HTML 提取 h1-h3 目录", () => {
		const html = `<html><body>
			<h1>前言</h1>
			<p>正文</p>
			<h2>第一章</h2>
			<h3>1.1 小节</h3>
		</body></html>`;
		const toc = extractTocFromHtml(html);
		expect(toc.map((t) => t.label)).toEqual(["前言", "第一章", "1.1 小节"]);
	});

	it("无标题返回空", () => {
		expect(extractTocFromHtml("<html><body><p>no headings</p></body></html>")).toEqual([]);
	});
});
