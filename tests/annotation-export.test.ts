/**
 * 批注导出 Markdown 与面板排序的纯函数单测。
 *
 * 重点：
 * 1. 导出必须**幂等友好**（每条带稳定 id 注释，重复导出不产生重复块）；
 * 2. 高亮用 Obsidian 原生 `==…==` + 六色 emoji 前缀（导出后天然渲染、可 grep）；
 * 3. frontmatter 里出现 `:`/`#` 等字符时必须加引号，否则 YAML 会坏；
 * 4. 面板排序默认"按书内位置"，无位置信息的条目排最后且保持稳定。
 */
import { describe, expect, it } from "vitest";
import type { Annotation } from "../src/services/annotations/AnnotationModel";
import {
	annotationExportFileName,
	annotationsToMarkdown,
	sortForExport,
} from "../src/utils/annotation-markdown";
import { numericLocation, sortAnnotations } from "../src/utils/annotation-sort";

function makeA(partial: Partial<Annotation>): Annotation {
	return {
		id: "a1",
		kind: "highlight",
		bookFingerprint: "fp",
		location: "100",
		target: { location: "100" },
		text: "被高亮的原文",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		...partial,
	} as Annotation;
}

describe("annotationsToMarkdown", () => {
	it("输出 Obsidian 原生高亮 + 六色 emoji 前缀", () => {
		const md = annotationsToMarkdown([makeA({ color: "purple", text: "重点句" })], { bookTitle: "测试书" });
		expect(md).toContain("==重点句==");
		expect(md).toContain("🟣");
		expect(md).toContain("# 《测试书》批注");
	});

	it("笔记渲染为 callout，并带书名/标签 frontmatter", () => {
		const md = annotationsToMarkdown([makeA({ note: "我的想法\n第二行" })], { bookTitle: "测试书", bookPath: "a/b.epub" });
		expect(md).toContain("> [!note] 笔记（黄）");
		expect(md).toContain("> 我的想法");
		expect(md).toContain("> 第二行");
		expect(md).toContain("  - nyareader");
		expect(md).toContain("book: a/b.epub");
	});

	it("每条都带稳定 id 注释（重复导出不产生重复块的依据）", () => {
		// 注入固定时间：导出内容应当**完全确定**（除 frontmatter 时间戳外无随机性）
		const now = new Date("2026-10-09T10:00:00Z");
		const list = [makeA({ id: "abc123" }), makeA({ id: "def456", location: "200" })];
		const md = annotationsToMarkdown(list, { bookTitle: "T", now });
		expect(md).toContain("<!-- nyar:id=abc123 -->");
		expect(md).toContain("<!-- nyar:id=def456 -->");
		// 相同输入 + 相同时间 → 输出逐字节一致（幂等）
		expect(annotationsToMarkdown(list, { bookTitle: "T", now })).toBe(md);
		// 重复导出不会重复输出同一条
		expect(md.match(/nyar:id=/g)?.length).toBe(2);
	});

	it("空列表也产出合法文档（不抛异常）", () => {
		const md = annotationsToMarkdown([], { bookTitle: "空书" });
		expect(md).toContain("# 《空书》批注");
		expect(md).toContain("_（还没有批注）_");
	});

	it("frontmatter 含特殊字符时加引号（避免 YAML 坏掉）", () => {
		const md = annotationsToMarkdown([makeA({})], { bookTitle: "标题: 带冒号 #标签" });
		expect(md).toContain('title: "《标题: 带冒号 #标签》批注"');
	});

	it("标记 approximate 的条目会提示位置可能不准", () => {
		const md = annotationsToMarkdown([makeA({ approximate: true })], { bookTitle: "T" });
		expect(md).toContain("位置可能不准");
	});

	it("缺少选中文本时不产出空高亮块", () => {
		const md = annotationsToMarkdown([makeA({ text: "" })], { bookTitle: "T" });
		expect(md).toContain("（未记录选中文本）");
		expect(md).not.toContain("====");
	});
});

describe("sortForExport / numericLocation", () => {
	it("按 location 数值升序（PDF 页码 / TXT 段索引 / 百分比）", () => {
		const list = [
			makeA({ id: "c", location: "300" }),
			makeA({ id: "a", location: "10" }),
			makeA({ id: "b", location: "120" }),
		];
		expect(sortForExport(list).map((a) => a.id)).toEqual(["a", "b", "c"]);
	});

	it("非数值 location 返回 null（排序时靠后）", () => {
		expect(numericLocation(makeA({ location: "OEBPS/ch3.xhtml" }))).toBeNull();
		expect(numericLocation(makeA({ location: "42" }))).toBe(42);
	});
});

describe("sortAnnotations（面板排序）", () => {
	const list = [
		makeA({ id: "late", location: "900", createdAt: 300 }),
		makeA({ id: "early", location: "100", createdAt: 100 }),
		makeA({ id: "mid", location: "500", createdAt: 200 }),
		makeA({ id: "noLoc", location: "#anchor", createdAt: 50 }),
	];

	it("默认按位置升序，无位置信息的排最后", () => {
		expect(sortAnnotations(list, "position").map((a) => a.id)).toEqual(["early", "mid", "late", "noLoc"]);
	});

	it("按时间升序 / 降序", () => {
		expect(sortAnnotations(list, "created").map((a) => a.id)).toEqual(["noLoc", "early", "mid", "late"]);
		expect(sortAnnotations(list, "created-desc").map((a) => a.id)).toEqual(["late", "mid", "early", "noLoc"]);
	});

	it("不修改入参数组（纯函数）", () => {
		const before = list.map((a) => a.id);
		sortAnnotations(list, "position");
		expect(list.map((a) => a.id)).toEqual(before);
	});
});

describe("annotationExportFileName", () => {
	it("去掉文件系统非法字符并加后缀", () => {
		expect(annotationExportFileName('A/B:C*D?E"F<G>H|I')).toBe("A_B_C_D_E_F_G_H_I.批注.md");
	});

	it("空书名有兜底，且长度受限", () => {
		expect(annotationExportFileName("")).toBe("未命名.批注.md");
		expect(annotationExportFileName("x".repeat(200)).length).toBeLessThanOrEqual(80 + ".批注.md".length);
	});
});
