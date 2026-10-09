/**
 * 批注锚点（AnnotationAnchor）与侧车 v2 迁移的纯逻辑单测。
 *
 * 覆盖（对应 task-9 验收）：
 * ① 锚点往返（生成 → 定位）
 * ② 文本指纹在"前面插入一段"后仍能定位
 * ③ 唯一匹配失败时的降级链（exact-range / quote-unique / quote-first / progression-only）
 * ④ v1 → v2 迁移**不破坏旧数据**（旧文件字节不变）
 */
import { describe, it, expect } from "vitest";
import {
	ANCHOR_NORMALIZATION,
	buildTextQuote,
	clamp01,
	createAnchor,
	locateInText,
	normalizeAnchorText,
	normalizeWithIndex,
	parseAnchor,
	quoteFromText,
} from "../src/services/annotations/AnnotationAnchor";
import { normalizeHighlightColor } from "../src/services/annotations/AnnotationModel";
import {
	SIDECAR_VERSION,
	SidecarAnnotationStore,
	anchorFromLegacy,
	migrateV1Annotation,
	type SidecarAdapter,
} from "../src/services/annotations/SidecarAnnotationStore";

/** 内存侧车适配器（记录每次写盘的路径与内容，用于断言"旧文件从未被写"）。 */
function memoryAdapter(seed: Record<string, string> = {}): {
	adapter: SidecarAdapter;
	files: Map<string, string>;
	writes: string[];
} {
	const files = new Map<string, string>(Object.entries(seed));
	const writes: string[] = [];
	const adapter: SidecarAdapter = {
		read: async (p) => {
			const v = files.get(p);
			if (v === undefined) throw new Error(`ENOENT: ${p}`);
			return v;
		},
		write: async (p, d) => {
			writes.push(p);
			files.set(p, d);
		},
		exists: async (p) => files.has(p),
		mkdir: async () => undefined,
	};
	return { adapter, files, writes };
}

const CHAPTER = [
	"第一章 开端",
	"",
	"这是第一段文字，用来测试锚点往返定位。",
	"",
	"这是第二段文字，内容与第一段不同。",
	"",
	"结尾句。",
].join("\n");

describe("归一化口径", () => {
	it("折叠空白 / 去首尾空白 / 丢弃零宽字符 / NFC 合成", () => {
		expect(normalizeAnchorText("  hello \n\n\t world ")).toBe("hello world");
		expect(normalizeAnchorText("a\u200bb")).toBe("ab");
		expect(normalizeAnchorText("e\u0301")).toBe("é");
		expect(ANCHOR_NORMALIZATION).toBe("nyar-nfc-ws1-utf16-v1");
	});

	it("归一化下标映射能把「命中位置」换算回原文偏移", () => {
		const raw = "前文\n\n\n目标内容";
		const norm = normalizeWithIndex(raw);
		expect(norm.text).toBe("前文 目标内容");
		const hit = norm.text.indexOf("目标内容");
		// 折叠后的偏移 ≠ 原文偏移：必须靠映射表换算
		expect(norm.starts[hit]).toBe(raw.indexOf("目标内容"));
		expect(norm.ends[hit + "目标内容".length - 1]).toBe(raw.length);
	});

	it("clamp01 收敛非法进度", () => {
		expect(clamp01(1.7)).toBe(1);
		expect(clamp01(-3)).toBe(0);
		expect(clamp01(Number.NaN)).toBe(0);
		expect(clamp01("0.5")).toBe(0);
	});
});

describe("① 锚点往返（生成 → 定位）", () => {
	it("结构定位命中时返回 exact-range（精确）", () => {
		const start = CHAPTER.indexOf("第一段文字");
		const end = start + "第一段文字".length;
		const anchor = createAnchor({
			kind: "paragraph",
			primary: "3",
			paraIndex: 3,
			charStart: start,
			charEnd: end,
			quote: buildTextQuote(CHAPTER, start, end),
			progression: Math.round((start / CHAPTER.length) * 1000) / 1000,
		});
		const result = locateInText(CHAPTER, anchor);
		expect(result.quality).toBe("exact-range");
		expect(result.approximate).toBe(false);
		expect(result.start).toBe(start);
		expect(result.end).toBe(end);
		expect(result.matchedText).toBe("第一段文字");
	});

	it("经 JSON 序列化（侧车落盘形态）后定位结果不变", () => {
		const start = CHAPTER.indexOf("第二段文字");
		const end = start + "第二段文字".length;
		const anchor = createAnchor({
			kind: "chapter",
			primary: "OEBPS/Text/ch1.xhtml",
			charStart: start,
			charEnd: end,
			quote: buildTextQuote(CHAPTER, start, end),
			progression: 0.5,
		});
		const roundTripped = parseAnchor(JSON.parse(JSON.stringify(anchor)));
		expect(roundTripped).not.toBeNull();
		expect(roundTripped).toEqual(anchor);
		const before = locateInText(CHAPTER, anchor);
		const after = locateInText(CHAPTER, roundTripped!);
		expect(after).toEqual(before);
	});

	it("指纹保留原始空白（Readium 要求），前后文长度受控", () => {
		const start = CHAPTER.indexOf("结尾句");
		const quote = buildTextQuote(CHAPTER, start, start + 3, 4);
		expect(quote.exact).toBe("结尾句");
		// prefix/suffix 取自原始字符数据（可能含换行），不做事先清洗
		expect(quote.prefix).toContain("\n");
		expect((quote.prefix ?? "").length).toBeLessThanOrEqual(4);
	});
});

describe("② 文本指纹抗变动", () => {
	it("前面插入一整段后，结构偏移失效但指纹唯一命中（quote-unique，仍精确）", () => {
		const start = CHAPTER.indexOf("第一段文字");
		const anchor = createAnchor({
			kind: "paragraph",
			primary: "3",
			charStart: start,
			charEnd: start + "第一段文字".length,
			quote: buildTextQuote(CHAPTER, start, start + "第一段文字".length),
			progression: 0.3,
		});
		const edited = "新增的前言段落，把后面所有偏移都推后了。\n\n" + CHAPTER;
		const result = locateInText(edited, anchor);
		expect(result.quality).toBe("quote-unique");
		expect(result.approximate).toBe(false);
		expect(result.matchedText).toBe("第一段文字");
		expect(result.start).toBe(edited.indexOf("第一段文字"));
	});

	it("版式变化（多余空白/连字符）不影响定位", () => {
		const start = CHAPTER.indexOf("第一段文字");
		const anchor = createAnchor({
			kind: "chapter",
			primary: "ch1",
			charStart: start,
			charEnd: start + "第一段文字".length,
			quote: buildTextQuote(CHAPTER, start, start + "第一段文字".length),
			progression: 0.3,
		});
		// 模拟 PDF 文本层/分页拖选产生的多余空白
		const reflowed = CHAPTER.replace("这是第一段文字", "这是第一段\n文字");
		const result = locateInText(reflowed, anchor);
		expect(result.quality).toBe("quote-unique");
		expect(result.approximate).toBe(false);
		expect(reflowed.slice(result.start!, result.end!)).toContain("第一段");
	});
});

describe("③ 降级链", () => {
	const exact = "目标句子内容";
	const body = `开头段落。\n\n${exact}\n\n结尾段落。`;
	const start = body.indexOf(exact);

	it("exact-range：结构区间与指纹一致", () => {
		const anchor = createAnchor({ kind: "paragraph", primary: "p", charStart: start, charEnd: start + exact.length, quote: buildTextQuote(body, start, start + exact.length), progression: 0.5 });
		const r = locateInText(body, anchor);
		expect([r.quality, r.approximate]).toEqual(["exact-range", false]);
	});

	it("结构区间越界 → 退回 quote-unique", () => {
		const anchor = createAnchor({ kind: "paragraph", primary: "p", charStart: 99999, charEnd: 100000, quote: buildTextQuote(body, start, start + exact.length), progression: 0.5 });
		const r = locateInText(body, anchor);
		expect([r.quality, r.approximate]).toEqual(["quote-unique", false]);
		expect(r.start).toBe(start);
	});

	it("结构区间仍合法但与指纹不符（内容被改动）→ 退回 quote-unique", () => {
		const anchor = createAnchor({ kind: "paragraph", primary: "p", charStart: 0, charEnd: exact.length, quote: buildTextQuote(body, start, start + exact.length), progression: 0.5 });
		const r = locateInText(body, anchor);
		expect([r.quality]).toEqual(["quote-unique"]);
		expect(body.slice(r.start!, r.end!)).toBe(exact);
	});

	it("同句出现两次 → quote-first（近似），并按前后文打分选中正确那一处", () => {
		const twice = `AAA ${exact} BBB —— 中间 —— ${exact} CCC`;
		const anchor = createAnchor({
			kind: "chapter",
			primary: "ch1",
			quote: { exact, prefix: "AAA ", suffix: " BBB" },
			progression: 0.1,
		});
		const r = locateInText(twice, anchor);
		expect([r.quality, r.approximate]).toEqual(["quote-first", true]);
		expect(r.start).toBe(twice.indexOf(exact));
		expect(r.reason).toContain("2 处");
	});

	it("指纹中段被改动 → 首尾片段模糊命中（quote-first，近似）", () => {
		const original = "0123456789ABCDEFGHIJ";
		const modified = "01234567" + "ZZZZ" + "CDEFGHIJ"; // 首 8 / 末 8 保留，中段被改
		const text = `前缀 ${modified} 后缀`;
		const anchor = createAnchor({ kind: "chapter", primary: "ch1", quote: quoteFromText(original), progression: 0.2 });
		const r = locateInText(text, anchor);
		expect([r.quality, r.approximate]).toEqual(["quote-first", true]);
		expect(text.slice(r.start!, r.end!)).toBe(modified);
		expect(r.reason).toContain("片段");
	});

	it("指纹完全找不到（过短，无法模糊）→ progression-only（只跳转，不给区间）", () => {
		const anchor = createAnchor({ kind: "chapter", primary: "ch1", quote: quoteFromText("不存在"), progression: 0.42 });
		const r = locateInText(body, anchor);
		expect([r.quality, r.approximate]).toEqual(["progression-only", true]);
		expect(r.start).toBeUndefined();
		expect(r.progression).toBeCloseTo(0.42);
		expect(r.reason).toContain("进度");
	});

	it("目标文本为空 → progression-only（不静默、给出原因）", () => {
		const anchor = createAnchor({ kind: "chapter", primary: "ch1", quote: quoteFromText("任意"), progression: 0.7 });
		const r = locateInText("", anchor);
		expect(r.quality).toBe("progression-only");
		expect(r.reason).toContain("尚未加载");
		expect(r.progression).toBeCloseTo(0.7);
	});
});

describe("④ 侧车 v1 → v2 迁移", () => {
	const V1_PATH = "library/MyBook.annotations.json";
	const V2_PATH = "library/MyBook.epub.annotations.json";
	const v1Raw = JSON.stringify(
		{
			version: 1,
			annotations: [
				{
					id: "a1",
					kind: "highlight",
					bookFingerprint: "fp1",
					location: "4200",
					target: { location: "4200", rects: [{ left: 1, top: 2, width: 3, height: 4 }], selectedText: "被高亮的原句" },
					text: "被高亮的原句",
					color: "red",
					createdAt: 100,
					updatedAt: 200,
				},
				{
					id: "a2",
					kind: "note",
					bookFingerprint: "fp1",
					location: "#nyareader-epub-3",
					target: { location: "#nyareader-epub-3", selectedText: "带笔记的句子" },
					text: "带笔记的句子",
					note: "我的想法",
					createdAt: 300,
					updatedAt: 400,
				},
			],
		},
		null,
		2
	);

	it("路径口径：v2 保留原扩展名，v1 保持旧路径", () => {
		const store = new SidecarAnnotationStore(memoryAdapter().adapter, ".annotations");
		expect(store.sidecarPath("library/MyBook.epub")).toBe(V2_PATH);
		expect(store.legacySidecarPath("library/MyBook.epub")).toBe(V1_PATH);
		// 无扩展名的书：v2 不得与 v1 重合（否则会覆盖旧文件）
		expect(store.legacySidecarPath("library/MyBook")).toBe("library/MyBook.annotations.json");
		expect(store.sidecarPath("library/MyBook")).toBe("library/MyBook.annotations.v2.json");
	});

	it("读到 v1：内存里升级锚点，且**不写任何文件**", async () => {
		const { adapter, files, writes } = memoryAdapter({ [V1_PATH]: v1Raw });
		const store = new SidecarAnnotationStore(adapter, ".annotations");
		const result = await store.readWithReport("library/MyBook.epub", "fp1");
		expect(result.source).toBe("v1-migrated");
		expect(result.migrated).toBe(2);
		expect(result.annotations).toHaveLength(2);
		// v1 → 进度兜底 + 文本指纹
		const first = result.annotations[0];
		expect(first.anchor?.quote.exact).toBe("被高亮的原句");
		expect(first.anchor?.progression).toBeCloseTo(0.42);
		expect(first.approximate).toBe(true);
		expect(first.anchorResolvedBy).toBe("progression-only");
		expect(first.source).toBe("sidecar-v1");
		expect(first.note).toBeUndefined();
		// 非数字 location（章节锚点）不要瞎猜进度
		expect(result.annotations[1].anchor?.progression).toBe(0);
		expect(result.annotations[1].note).toBe("我的想法");
		// 硬约束：读不写
		expect(writes).toHaveLength(0);
		expect(files.get(V1_PATH)).toBe(v1Raw);
	});

	it("ensureV2：写新文件，旧文件字节不变", async () => {
		const { adapter, files } = memoryAdapter({ [V1_PATH]: v1Raw });
		const store = new SidecarAnnotationStore(adapter, ".annotations");
		const read = await store.readWithReport("library/MyBook.epub", "fp1");
		const wrote = await store.ensureV2("library/MyBook.epub", read.annotations, "fp1");
		expect(wrote).toBe(true);
		const v2 = JSON.parse(files.get(V2_PATH) ?? "{}") as { version: number; annotations: Array<Record<string, unknown>> };
		expect(v2.version).toBe(SIDECAR_VERSION);
		expect(v2.annotations).toHaveLength(2);
		expect((v2.annotations[0].anchor as { quote: { exact: string } }).quote.exact).toBe("被高亮的原句");
		// 旧文件字节完全不变
		expect(files.get(V1_PATH)).toBe(v1Raw);
		// 已存在 v2 时不覆盖
		expect(await store.ensureV2("library/MyBook.epub", read.annotations, "fp1")).toBe(false);
	});

	it("向只有 v1 的书新增批注：v1 原样保留，v2 带上迁移内容 + 新条目", async () => {
		const { adapter, files, writes } = memoryAdapter({ [V1_PATH]: v1Raw });
		const store = new SidecarAnnotationStore(adapter, ".annotations");
		const added = await store.addForBook(
			"library/MyBook.epub",
			{
				kind: "highlight",
				bookFingerprint: "fp1",
				location: "100",
				target: { location: "100", selectedText: "新高亮" },
				text: "新高亮",
				color: "purple",
				anchor: createAnchor({ kind: "chapter", primary: "ch2", quote: quoteFromText("新高亮"), progression: 0.1 }),
			},
			"fp1"
		);
		expect(added.color).toBe("purple");
		// 旧文件从未被写、内容逐字节相同
		expect(writes).not.toContain(V1_PATH);
		expect(files.get(V1_PATH)).toBe(v1Raw);
		const v2 = JSON.parse(files.get(V2_PATH) ?? "{}") as { annotations: Array<Record<string, unknown>> };
		expect(v2.annotations).toHaveLength(3);
		expect(v2.annotations.map((a) => a.id)).toContain(added.id);
		// 再次读取：v2 优先，旧文件仍在
		const again = await store.readWithReport("library/MyBook.epub", "fp1");
		expect(again.source).toBe("v2");
		expect(again.migrated).toBe(0);
		expect(again.annotations).toHaveLength(3);
		expect(files.get(V1_PATH)).toBe(v1Raw);
	});

	it("删除/改色只改 v2：v1 仍然逐字节不变", async () => {
		const { adapter, files, writes } = memoryAdapter({ [V1_PATH]: v1Raw });
		const store = new SidecarAnnotationStore(adapter, ".annotations");
		await store.removeForBook("library/MyBook.epub", "a1", "fp1");
		await store.updateForBook("library/MyBook.epub", "a2", { note: "改过的笔记", color: "green" }, "fp1");
		expect(writes).not.toContain(V1_PATH);
		expect(files.get(V1_PATH)).toBe(v1Raw);
		const v2 = JSON.parse(files.get(V2_PATH) ?? "{}") as { annotations: Array<Record<string, unknown>> };
		expect(v2.annotations).toHaveLength(1);
		expect(v2.annotations[0].id).toBe("a2");
		expect(v2.annotations[0].note).toBe("改过的笔记");
		expect(v2.annotations[0].color).toBe("green");
	});

	it("v1 文件损坏：只读不写，返回空列表且旧文件不变", async () => {
		const corrupt = "{ this is not json";
		const { adapter, files, writes } = memoryAdapter({ [V1_PATH]: corrupt });
		const store = new SidecarAnnotationStore(adapter, ".annotations");
		expect(await store.readForBook("library/MyBook.epub", "fp1")).toEqual([]);
		expect(writes).toHaveLength(0);
		expect(files.get(V1_PATH)).toBe(corrupt);
	});

	it("migrateV1Annotation：无法识别的条目返回 null，绝不抛异常", () => {
		expect(migrateV1Annotation(null)).toBeNull();
		expect(migrateV1Annotation("x")).toBeNull();
		expect(migrateV1Annotation({})).toBeNull();
		const migrated = migrateV1Annotation({ text: "只有文本" });
		expect(migrated?.kind).toBe("highlight");
		expect(migrated?.anchor?.quote.exact).toBe("只有文本");
		expect(migrated?.color).toBe("yellow");
	});

	it("anchorFromLegacy：百分比 location → progression；非数字 location → 不猜进度", () => {
		expect(anchorFromLegacy("4200", "句子").progression).toBeCloseTo(0.42);
		expect(anchorFromLegacy("epubcfi(/6/4!/4/2/1:0)", "句子").progression).toBe(0);
		expect(anchorFromLegacy("4200", "句子").kind).toBe("chapter");
	});
});

describe("v2 侧车（已是新格式）", () => {
	it("直接读 v2，不做迁移，颜色收敛成六色之一", async () => {
		const v2Path = "library/Book.txt.annotations.json";
		const anchor = createAnchor({ kind: "paragraph", primary: "12", charStart: 0, charEnd: 4, quote: quoteFromText("abcd"), progression: 0.5 });
		const raw = JSON.stringify({
			version: 2,
			annotations: [
				{ id: "n1", kind: "highlight", bookFingerprint: "fp", location: "12", target: { location: "12", selectedText: "abcd" }, text: "abcd", color: "not-a-color", anchor, createdAt: 1, updatedAt: 2 },
			],
		});
		const { adapter, files, writes } = memoryAdapter({ [v2Path]: raw });
		const store = new SidecarAnnotationStore(adapter, ".annotations");
		const result = await store.readWithReport("library/Book.txt", "fp");
		expect(result.source).toBe("v2");
		expect(result.migrated).toBe(0);
		expect(result.annotations[0].color).toBe("yellow");
		expect(result.annotations[0].anchor?.kind).toBe("paragraph");
		expect(writes).toHaveLength(0);
		expect(files.get(v2Path)).toBe(raw);
	});

	it("自定义 sidecar 后缀（设置语义不变）", () => {
		const store = new SidecarAnnotationStore(memoryAdapter().adapter, ".nyar");
		expect(store.sidecarPath("lib/A.epub")).toBe("lib/A.epub.nyar.json");
		expect(store.legacySidecarPath("lib/A.epub")).toBe("lib/A.nyar.json");
	});

	it("normalizeHighlightColor 把历史值收敛为合法六色", () => {
		expect(normalizeHighlightColor("blue")).toBe("blue");
		expect(normalizeHighlightColor("crimson")).toBe("yellow");
		expect(normalizeHighlightColor(undefined)).toBe("yellow");
	});
});
