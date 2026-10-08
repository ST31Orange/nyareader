/** 工具层与翻译分块逻辑的单测。 */
import { describe, it, expect } from "vitest";
import { splitTranslationChunks, normalizeSelectionText, htmlToPlainText } from "../src/utils/text";
import { sha256Hex, fastFingerprint } from "../src/utils/hash";
import { normalizeSettings } from "../src/settings";
import { sanitizeBookshelfModes } from "../src/settings";

describe("splitTranslationChunks", () => {
	it("短文本不切块", () => {
		const chunks = splitTranslationChunks("hello world");
		expect(chunks).toHaveLength(1);
		expect(chunks[0].text).toBe("hello world");
	});

	it("超长文本按段落边界切块并保留分隔符", () => {
		const paragraph = "字".repeat(500);
		const text = `${paragraph}\n${paragraph}\n${paragraph}`;
		const chunks = splitTranslationChunks(text, 1000);
		expect(chunks.length).toBeGreaterThanOrEqual(3);
		// 每块不超过上限
		for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1000);
		// 拼接还原（忽略分隔符顺序影响，仅验证字符数守恒）
		const joined = chunks.map((c) => c.text + c.separator).join("");
		expect(joined.replace(/\n/g, "").length).toBe(text.replace(/\n/g, "").length);
	});

	it("单段超长硬切", () => {
		const text = "a".repeat(3000);
		const chunks = splitTranslationChunks(text, 1000);
		expect(chunks).toHaveLength(3);
		expect(chunks.map((c) => c.text).join("")).toBe(text);
	});
});

describe("normalizeSelectionText", () => {
	it("PDF/分页划词的换行折叠为空格（去掉多余分段符）", () => {
		expect(normalizeSelectionText("first line\nsecond line")).toBe("first line second line");
	});
	it("跨段划词压缩空行", () => {
		expect(normalizeSelectionText("para one\n\n\npara two")).toBe("para one para two");
	});
	it("合并连续空格并去除首尾", () => {
		expect(normalizeSelectionText("  a   b\t\tc  ")).toBe("a b c");
	});
	it("不换行时不改写内容", () => {
		expect(normalizeSelectionText("Hello, world!")).toBe("Hello, world!");
	});
});

describe("hash utils", () => {
	it("sha256Hex 确定性", async () => {
		const buf = new TextEncoder().encode("nyareader").buffer;
		const a = await sha256Hex(buf);
		const b = await sha256Hex(buf);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{32}$/);
	});

	it("fastFingerprint 区分不同内容", () => {
		const mk = (b: number) => ({ size: 10, mtimeMs: 1000, head: new Uint8Array([1, b]), tail: new Uint8Array([b, 2]) });
		expect(fastFingerprint(mk(1))).not.toBe(fastFingerprint(mk(2)));
		expect(fastFingerprint(mk(1))).toBe(fastFingerprint(mk(1)));
	});
});

describe("normalizeSettings", () => {
	it("空输入返回默认值", () => {
		const s = normalizeSettings(null);
		expect(s.reader.fontSize).toBe(18);
		expect(s.translation.targetLanguage).toBe("zh-Hans");
		expect(s.translation.sourceLanguage).toBe("auto");
	});
	it("清洗非法数值", () => {
		const s = normalizeSettings({ reader: { fontSize: 999 } });
		expect(s.reader.fontSize).toBe(40);
	});
	it("忽略旧版多余翻译字段", () => {
		const s = normalizeSettings({ translation: { targetLanguage: "ja", mode: "online", timeoutMs: -5 } });
		expect(s.translation.targetLanguage).toBe("ja");
		expect((s.translation as unknown as Record<string, unknown>).mode).toBeUndefined();
	});
});

describe("sanitizeBookshelfModes", () => {
	it("只保留合法显示模式", () => {
		expect(sanitizeBookshelfModes({ a: "compact", b: "list", c: "full", d: "weird" })).toEqual({ a: "compact", b: "list", c: "full" });
	});
	it("空/非法输入返回空对象", () => {
		expect(sanitizeBookshelfModes(null)).toEqual({});
		expect(sanitizeBookshelfModes("x")).toEqual({});
	});
});
