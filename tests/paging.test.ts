/** 分页指示换算单测。 */
import { describe, it, expect } from "vitest";
import { displayPageFromLocation } from "../src/utils/paging";

describe("displayPageFromLocation", () => {
	it("PDF 页码直接返回", () => {
		expect(displayPageFromLocation("1", 10, false)).toBe(1);
		expect(displayPageFromLocation("7", 10, false)).toBe(7);
		expect(displayPageFromLocation("0", 10, false)).toBe(1);
	});

	it("HTML/TXT 分页百分比换算页码", () => {
		// 0% -> 第 1 页，50% -> 中间页，最后 -> 总页数
		expect(displayPageFromLocation("0", 20, true)).toBe(1);
		expect(displayPageFromLocation("10000", 20, true)).toBe(20);
		expect(displayPageFromLocation("5000", 20, true)).toBe(11);
	});

	it("总页数未知时按 1 处理", () => {
		expect(displayPageFromLocation("3000", 0, true)).toBe(1);
	});

	it("非法输入返回 NaN", () => {
		expect(displayPageFromLocation("abc", 10, false)).toBeNaN();
	});
});
