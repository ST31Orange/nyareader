/** TXT 解析单测：编码检测 + 章节识别 + 分页内容模型。 */
import { describe, it, expect } from "vitest";
import { decodeBuffer, splitParagraphs } from "../src/services/books/formats/txt/TxtParser";

function utf8Bytes(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

describe("decodeBuffer", () => {
	it("无 BOM 的合法 UTF-8 直接解码", () => {
		const bytes = utf8Bytes("你好，世界。\n\n第二段。");
		const { content, encoding } = decodeBuffer(bytes.buffer as ArrayBuffer);
		expect(content).toContain("你好");
		expect(encoding).toBe("utf-8");
	});

	it("UTF-8 BOM 被剥离", () => {
		const body = utf8Bytes("带BOM内容");
		const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
		const { content } = decodeBuffer(withBom.buffer as ArrayBuffer);
		expect(content).toBe("带BOM内容");
	});

	it("GBK 编码（ASCII 范围内）内容仍可解码", () => {
		const bytes = utf8Bytes("hello world\nplain ascii text");
		const { content, encoding } = decodeBuffer(bytes.buffer as ArrayBuffer);
		expect(content).toContain("hello");
		expect(["utf-8", "gb18030"]).toContain(encoding);
	});
});

describe("splitParagraphs", () => {
	it("按空行切段并过滤空段", () => {
		const { paragraphs } = splitParagraphs("第一段\n\n第二段\n\n\n第三段");
		expect(paragraphs).toEqual(["第一段", "第二段", "第三段"]);
	});

	it("识别常见中文章节标题", () => {
		const text = "第一章 楔子\n\n正文内容一\n\n第二章 开始\n\n正文内容二";
		const { chapters } = splitParagraphs(text);
		expect(chapters.length).toBe(2);
		expect(chapters[0].title).toContain("第一章");
		expect(chapters[1].startParagraph).toBe(2);
	});

	it("不把普通句子当章节", () => {
		const { chapters } = splitParagraphs("今天天气很好\n\n我们出去散步");
		expect(chapters.length).toBe(0);
	});
});
