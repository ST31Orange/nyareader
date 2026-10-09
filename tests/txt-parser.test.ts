/** TXT 解析单测：编码检测 + 章节识别 + 分页内容模型 + 布局纯函数（前缀和/二分定位）。 */
import { describe, it, expect, afterEach } from "vitest";
import {
	TxtParser,
	buildTxtSpine,
	decodeBuffer,
	loadTxtContent,
	releaseTxtContent,
	splitParagraphs,
} from "../src/services/books/formats/txt/TxtParser";
import {
	FALLBACK_CHAR_WIDTH_RATIO,
	clampParagraphIndex,
	createHeights,
	createPrefix,
	estimateParagraphHeight,
	fillEstimatedHeights,
	indexAtOffset,
	measureCharWidthRatio,
	rebuildPrefixFrom,
	totalHeight,
} from "../src/services/books/formats/txt/TxtLayout";

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

	it("单遍扫描与旧实现（replace + split + map + filter）结果一致", () => {
		const reference = (content: string): string[] =>
			content
				.replace(/\r\n/g, "\n")
				.split(/\n{2,}/)
				.map((b) => b.trim())
				.filter((b) => b.length > 0);
		const samples = [
			"第一段\n\n第二段",
			"a\r\n\r\nb\r\n\r\n\r\nc",
			"  \n\n  前后空白  \n\n",
			"单段",
			"多行\n在段内\n\n下一段",
			"\n\n\n",
			"a\rb\n\nc",
			"第一章 开端\n\n正文\n\n第二章 继续\n\n正文二",
		];
		for (const sample of samples) {
			expect(splitParagraphs(sample).paragraphs).toEqual(reference(sample));
		}
	});

	it("识别章节不依赖每段 split(\"\\n\") 的临时数组：多行段只取首行", () => {
		const { paragraphs, chapters } = splitParagraphs("第一章 楔子\n第二行说明\n\n正文");
		expect(paragraphs[0]).toBe("第一章 楔子\n第二行说明");
		expect(chapters).toEqual([{ title: "第一章 楔子", startParagraph: 0 }]);
	});
});

describe("loadTxtContent：解析器与引擎共用一次解码/切段", () => {
	it("同一 buffer 复用同一份段落数组（不再解码两遍）", () => {
		const buffer = new TextEncoder().encode("第一章 开端\n\n正文\n\n第二章 继续\n\n正文二").buffer as ArrayBuffer;
		const first = loadTxtContent(buffer, "book.txt");
		const second = loadTxtContent(buffer, "book.txt");
		expect(second.paragraphs).toBe(first.paragraphs);
		expect(second.chapters).toBe(first.chapters);
		expect(first.paragraphs).toEqual(["第一章 开端", "正文", "第二章 继续", "正文二"]);
		expect(first.chapters.map((c) => c.startParagraph)).toEqual([0, 2]);
		// 首行是章节标题 -> 书名回退到文件名
		expect(first.title).toBe("book");
		expect(first.estimatedChars).toBe("第一章 开端\n\n正文\n\n第二章 继续\n\n正文二".length);
		// 释放后重新解码，得到新的数组（缓存不再持有整本书）
		releaseTxtContent(buffer);
		expect(loadTxtContent(buffer, "book.txt").paragraphs).not.toBe(first.paragraphs);
	});

	it("TxtParser.parse 产出的 spine 与旧实现一致（内容惰性构建）", async () => {
		const content = "第一段\n\n第二段\n\n第三段";
		const buffer = new TextEncoder().encode(content).buffer as ArrayBuffer;
		const book = await new TxtParser().parse({ fingerprint: "fp", path: "a.txt", format: "txt", buffer });
		// 首个非空行较短且不是章节标题 -> 作为书名（与旧实现一致）
		expect(book.title).toBe("第一段");
		expect(book.estimatedChars).toBe(content.length);
		expect(book.spine).toHaveLength(3);
		expect(book.spine[1]).toEqual({ id: "p1", href: "1", title: undefined });
		expect(buildTxtSpine(2)).toEqual([
			{ id: "p0", href: "0", title: undefined },
			{ id: "p1", href: "1", title: undefined },
		]);
	});
});

describe("TxtLayout：类型化前缀和 + 二分定位", () => {
	const lineHeight = 18 * 1.8;
	const spacing = 18 * 0.6;

	it("前缀和与朴素累计一致、总高 = prefix[count]", () => {
		const paragraphs = ["a".repeat(50), "b".repeat(120), "短", "x".repeat(3000), ""];
		const heights = createHeights(paragraphs.length);
		fillEstimatedHeights(paragraphs, heights, 20, lineHeight, spacing);
		const prefix = createPrefix(paragraphs.length);
		rebuildPrefixFrom(heights, prefix, paragraphs.length, 0);

		let acc = 0;
		for (let i = 0; i < paragraphs.length; i++) {
			const expected = estimateParagraphHeight(paragraphs[i].length, 20, lineHeight, spacing);
			expect(heights[i]).toBeCloseTo(expected);
			acc += expected;
			expect(prefix[i + 1]).toBeCloseTo(acc);
		}
		expect(totalHeight(prefix, paragraphs.length)).toBeCloseTo(acc);
		expect(totalHeight(prefix, 0)).toBe(0);
		// 结构就是 Float64Array（50 万段也不会退化成堆对象数组）
		expect(prefix).toBeInstanceOf(Float64Array);
		expect(heights).toBeInstanceOf(Float64Array);
	});

	it("二分定位与线性扫描在每个偏移上一致", () => {
		const paragraphs = Array.from({ length: 37 }, (_, i) => "字".repeat((i * 7) % 23));
		const heights = createHeights(paragraphs.length);
		fillEstimatedHeights(paragraphs, heights, 12, 27, 9);
		const prefix = createPrefix(paragraphs.length);
		rebuildPrefixFrom(heights, prefix, paragraphs.length, 0);
		const total = totalHeight(prefix, paragraphs.length);

		const linear = (offset: number): number => {
			let ans = 0;
			for (let i = 0; i < paragraphs.length; i++) if (prefix[i] <= offset) ans = i;
			return ans;
		};
		for (let offset = -5; offset <= total + 5; offset += 3.5) {
			expect(indexAtOffset(prefix, paragraphs.length, offset)).toBe(linear(offset));
		}
		expect(indexAtOffset(prefix, 0, 100)).toBe(0);
	});

	it("增量重建只从变化处开始（之前的前缀保持不变）", () => {
		const heights = new Float64Array([10, 20, 30, 40]);
		const prefix = createPrefix(4);
		rebuildPrefixFrom(heights, prefix, 4, 0);
		expect(Array.from(prefix)).toEqual([0, 10, 30, 60, 100]);
		heights[2] = 35;
		rebuildPrefixFrom(heights, prefix, 4, 2);
		expect(Array.from(prefix)).toEqual([0, 10, 30, 65, 105]);
		heights[1] = 25;
		rebuildPrefixFrom(heights, prefix, 4, 1);
		expect(Array.from(prefix)).toEqual([0, 10, 35, 70, 110]);
	});

	it("clampParagraphIndex 夹取到合法段索引", () => {
		expect(clampParagraphIndex(-3, 10)).toBe(0);
		expect(clampParagraphIndex(4, 10)).toBe(4);
		expect(clampParagraphIndex(99, 10)).toBe(9);
		expect(clampParagraphIndex(Number.NaN, 10)).toBe(0);
		expect(clampParagraphIndex(3, 0)).toBe(0);
	});

	describe("measureCharWidthRatio（回归：固定 0.62 低估中文行数导致滚动跳动）", () => {
		const originalDocument = (globalThis as { document?: unknown }).document;
		afterEach(() => {
			if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
			else (globalThis as { document?: unknown }).document = originalDocument;
		});

		const stubDocument = (measuredWidth: number | null): void => {
			(globalThis as { document?: unknown }).document = {
				createElement: () => ({
					getContext: () => (measuredWidth === null ? null : { font: "", measureText: () => ({ width: measuredWidth }) }),
				}),
			};
		};

		/** 按「每字符宽度」造一个按样本长度缩放的 measureText（更贴近真实）。 */
		const stubDocumentPerChar = (perCharWidth: number, zeroFirstCall = false): void => {
			let call = 0;
			(globalThis as { document?: unknown }).document = {
				createElement: () => ({
					getContext: () => ({
						font: "",
						measureText: (text: string) => {
							const isFirst = call++ === 0;
							return { width: zeroFirstCall && isFirst ? 0 : text.length * perCharWidth };
						},
					}),
				}),
			};
		};

		it("无 document（Node/测试环境）时退回兜底常量，不抛异常", () => {
			delete (globalThis as { document?: unknown }).document;
			expect(measureCharWidthRatio("system-ui", 18)).toBe(FALLBACK_CHAR_WIDTH_RATIO);
		});

		it("字号非法时退回兜底常量", () => {
			stubDocument(180);
			expect(measureCharWidthRatio("system-ui", 0)).toBe(FALLBACK_CHAR_WIDTH_RATIO);
			expect(measureCharWidthRatio("system-ui", Number.NaN)).toBe(FALLBACK_CHAR_WIDTH_RATIO);
		});

		it("拿不到 2d 上下文时退回兜底常量", () => {
			stubDocument(null);
			expect(measureCharWidthRatio("system-ui", 18)).toBe(FALLBACK_CHAR_WIDTH_RATIO);
		});

		it("按实测宽度换算比例：汉字口径应接近 1.0（真实浏览器实测 18px 汉字 = 1em）", () => {
			// 纯汉字样本，每个字符 18px（=1em）
			stubDocumentPerChar(18);
			const ratio = measureCharWidthRatio("system-ui", 18);
			expect(ratio).toBeCloseTo(1, 3);
			expect(ratio).toBeGreaterThan(FALLBACK_CHAR_WIDTH_RATIO);
		});

		it("汉字样本测量为 0 时退回混合样本（不再直接给兜底）", () => {
			// 第一次 measureText（汉字）返回 0，后续（混合样本）返回有效宽度
			stubDocumentPerChar(18, true);
			const ratio = measureCharWidthRatio("system-ui", 18);
			expect(ratio).toBeGreaterThan(0);
			expect(ratio).not.toBe(FALLBACK_CHAR_WIDTH_RATIO);
		});

		it("异常字体度量被夹在 [0.3, 1.4]，不会把布局算飞", () => {
			stubDocumentPerChar(10_000);
			expect(measureCharWidthRatio("system-ui", 18)).toBeLessThanOrEqual(1.4);
			stubDocumentPerChar(1);
			expect(measureCharWidthRatio("system-ui", 18)).toBeGreaterThanOrEqual(0.3);
		});

		it("用于行数估算时更接近真实：640px/18px 下 35 字/行（旧口径 57 字/行、真实 34）", () => {
			const width = 640;
			const fontSize = 18;
			// 纯汉字 1em/字
			stubDocumentPerChar(fontSize);
			const ratio = measureCharWidthRatio("system-ui", fontSize);
			const newCharsPerLine = Math.floor(width / (fontSize * ratio));
			const oldCharsPerLine = Math.floor(width / (fontSize * FALLBACK_CHAR_WIDTH_RATIO));
			expect(newCharsPerLine).toBe(35);
			expect(oldCharsPerLine).toBe(57);
			// 与真实渲染（34 字/行）的误差从 68% 降到 3%
			expect(Math.abs(newCharsPerLine - 34)).toBeLessThanOrEqual(1);
		});
	});
});
