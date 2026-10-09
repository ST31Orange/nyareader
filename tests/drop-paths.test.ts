/**
 * 拖放载荷解析测试（兼容多种格式）。
 *
 * 背景：Obsidian 左侧文件栏拖动**不走 `dataTransfer.files`**，而它内部用哪种载荷
 * 官方没有公开。之前实现只处理 files，所以从文件栏拖进书架"什么也不发生"。
 * 这里覆盖各种可能形态，保证解析器不赌单一格式。
 */
import { describe, expect, it } from "vitest";
import {
	extOf,
	isReadableFile,
	normalizeVaultPath,
	opensInNativeEditor,
	parseVaultDropPaths,
	extractPathCandidates,
} from "../src/utils/drop-paths";

/** vault 校验：只认这些路径"存在"（模拟 TFile 判定）。 */
const existing = new Set([
	"books/三体.epub",
	"books/notes.md",
	"nyareader/library/我的书库/测试/银河帝国.epub",
	"a/b/c.azw3",
]);
const keep = (p: string): boolean => existing.has(p);

describe("路径工具", () => {
	it("extOf 取扩展名（兼容反斜杠、查询串）", () => {
		expect(extOf("a/b/c.EPUB")).toBe("epub");
		expect(extOf("a\\b\\c.azw3")).toBe("azw3");
		expect(extOf("c.md")).toBe("md");
		expect(extOf("noext")).toBe("");
		expect(extOf("a/b.c/d")).toBe("");
	});

	it("isReadableFile 认电子书与 md，不认其它", () => {
		expect(isReadableFile("x.epub")).toBe(true);
		expect(isReadableFile("x.md")).toBe(true);
		expect(isReadableFile("x.markdown")).toBe(true);
		expect(isReadableFile("x.png")).toBe(false);
		expect(isReadableFile("x.json")).toBe(false);
	});

	it("opensInNativeEditor：只有 md 走 Obsidian 原生页面，其它格式走阅读器", () => {
		// 用户要求：md 能当书拖进书架，但点开时用 Obsidian 默认页面
		expect(opensInNativeEditor("notes/a.md")).toBe(true);
		expect(opensInNativeEditor("notes/a.MD")).toBe(true);
		expect(opensInNativeEditor("notes/a.markdown")).toBe(true);
		expect(opensInNativeEditor("books/a.epub")).toBe(false);
		expect(opensInNativeEditor("books/a.pdf")).toBe(false);
		expect(opensInNativeEditor("books/a.txt")).toBe(false);
		expect(opensInNativeEditor("books/a.mobi")).toBe(false);
	});

	it("normalizeVaultPath 处理反斜杠 / file:// / 前后斜杠 / 多斜杠", () => {
		expect(normalizeVaultPath("\\books\\三体.epub")).toBe("books/三体.epub");
		expect(normalizeVaultPath("file:///books/a.epub")).toBe("books/a.epub");
		expect(normalizeVaultPath("/books//a.epub/")).toBe("books/a.epub");
		expect(normalizeVaultPath("./a.epub")).toBe("a.epub");
	});

	it("normalizeVaultPath 拒绝明显不是路径的内容（URL/多行/超长）", () => {
		expect(normalizeVaultPath("https://example.com/a.epub")).toBeNull();
		expect(normalizeVaultPath("data:text/plain,hi")).toBeNull();
		expect(normalizeVaultPath("line1\nline2")).toBeNull();
		expect(normalizeVaultPath("x".repeat(600))).toBeNull();
		expect(normalizeVaultPath("   ")).toBeNull();
	});
});

describe("extractPathCandidates", () => {
	it("纯文本路径", () => {
		expect(extractPathCandidates("books/三体.epub")).toContain("books/三体.epub");
	});

	it("JSON 对象：file / path / files 字段都能取到", () => {
		expect(extractPathCandidates('{"file":"books/三体.epub"}')).toContain("books/三体.epub");
		expect(extractPathCandidates('{"path":"books/notes.md"}')).toContain("books/notes.md");
		expect(extractPathCandidates('{"files":["books/三体.epub","a/b/c.azw3"]}')).toEqual(
			expect.arrayContaining(["books/三体.epub", "a/b/c.azw3"])
		);
	});

	it("JSON 字符串数组", () => {
		expect(extractPathCandidates('["books/三体.epub"]')).toEqual(["books/三体.epub"]);
	});

	it("未知字段名也能递归找到（不赌字段名）", () => {
		expect(extractPathCandidates('{"payload":{"whatever":["books/三体.epub"]}}')).toContain("books/三体.epub");
	});

	it("坏 JSON 退化为纯文本处理，不抛异常", () => {
		expect(() => extractPathCandidates('{"file": broken')).not.toThrow();
		expect(extractPathCandidates('{"file": broken')).toContain('{"file": broken');
	});

	it("从带前缀的文本里抓出路径 token（如 'file: xxx.epub'）", () => {
		expect(extractPathCandidates("file: books/三体.epub end")).toContain("books/三体.epub");
	});

	it("多行列表逐个解析", () => {
		const raw = "books/三体.epub\nbooks/notes.md";
		expect(extractPathCandidates(raw)).toEqual(expect.arrayContaining(["books/三体.epub", "books/notes.md"]));
	});
});

describe("parseVaultDropPaths（拖放载荷 → 可导入的书）", () => {
	it("text/plain = vault 路径（最常见的 Obsidian 形态）", () => {
		const out = parseVaultDropPaths({ types: ["text/plain"], byType: { "text/plain": "books/三体.epub" } }, keep);
		expect(out).toEqual(["books/三体.epub"]);
	});

	it("自定义 MIME（application/...）里的路径也能取到", () => {
		const out = parseVaultDropPaths(
			{ types: ["application/x-obsidian-files"], byType: { "application/x-obsidian-files": '{"files":["books/三体.epub"]}' } },
			keep
		);
		expect(out).toEqual(["books/三体.epub"]);
	});

	it("JSON 载荷（text/plain 里是 JSON）", () => {
		const out = parseVaultDropPaths({ types: ["text/plain"], byType: { "text/plain": '{"file":"a/b/c.azw3"}' } }, keep);
		expect(out).toEqual(["a/b/c.azw3"]);
	});

	it("md 也被识别（插件要能看 md）", () => {
		const out = parseVaultDropPaths({ types: ["text/plain"], byType: { "text/plain": "books/notes.md" } }, keep);
		expect(out).toEqual(["books/notes.md"]);
	});

	it("多本一次拖入", () => {
		const out = parseVaultDropPaths(
			{ types: ["text/plain"], byType: { "text/plain": "books/三体.epub\na/b/c.azw3" } },
			keep
		);
		expect(out).toEqual(expect.arrayContaining(["books/三体.epub", "a/b/c.azw3"]));
	});

	it("**不存在的路径被 vault 校验过滤掉**（避免误搬无关文件）", () => {
		const out = parseVaultDropPaths({ types: ["text/plain"], byType: { "text/plain": "books/不存在.epub" } }, keep);
		expect(out).toEqual([]);
	});

	it("非电子书扩展名被过滤（png/json 不会被当成书）", () => {
		const out = parseVaultDropPaths(
			{ types: ["text/plain"], byType: { "text/plain": "books/cover.png\nbooks/data.json" } },
			() => true
		);
		expect(out).toEqual([]);
	});

	it("空载荷 / 只有 Files（系统拖文件）→ 返回空数组，交给 files 分支处理", () => {
		expect(parseVaultDropPaths({ types: [], byType: {} }, keep)).toEqual([]);
		expect(parseVaultDropPaths({ types: ["Files"], byType: {}, fileNames: ["三体.epub"] }, keep)).toEqual([]);
	});

	it("重复路径去重", () => {
		const out = parseVaultDropPaths(
			{ types: ["text/plain", "text/uri-list"], byType: { "text/plain": "books/三体.epub", "text/uri-list": "books/三体.epub" } },
			keep
		);
		expect(out).toEqual(["books/三体.epub"]);
	});

	it("多个候选去重后仍保留 vault 里存在的那些", () => {
		const out = parseVaultDropPaths(
			{ types: ["text/plain"], byType: { "text/plain": '{"a":"nope.epub","b":"books/三体.epub"}' } },
			keep
		);
		expect(out).toEqual(["books/三体.epub"]);
	});
});
