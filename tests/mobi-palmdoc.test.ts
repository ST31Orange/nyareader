/** MOBI/PalmDOC 单测：LZ77 解压往返 + HTML 提取 + 目录提取。 */
import { describe, it, expect } from "vitest";
import { decompressPalmDoc } from "../src/services/books/formats/mobi/palmdoc";
import { extractTocFromHtml } from "../src/services/books/formats/mobi/MobiParser";

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
