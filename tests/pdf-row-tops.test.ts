/**
 * PdfEngine 行偏移纯计算单测（回归：O(页数²) 的 offsetTop 全表读取）。
 *
 * 背景：旧实现每次修正一页尺寸都遍历全部页读 `el.offsetTop`，
 * 3000 页文档滚动一屏（约 50 页）会退化成 15 万次强制布局。
 * 现在改由 computeRowTops() 纯算术得出，这里锁死它与 DOM 行布局模型的一致性。
 */
import { describe, expect, it } from "vitest";
import { computeRowTops, shiftTopsAfter } from "../src/utils/pdf-viewport";

const layout = { cols: 1, gap: 18, contentTop: 20 };

describe("computeRowTops", () => {
	it("单页模式：每页 top = 前序页高之和 + 行间距，首项为 contentTop", () => {
		const heights = [100, 200, 300];
		const tops = computeRowTops(heights, layout);
		expect(tops).toEqual([20, 138, 356]);
	});

	it("双页对开：行高取行内最高页，同行的两页 top 相同", () => {
		const heights = [100, 150, 80, 80];
		const tops = computeRowTops(heights, { cols: 2, gap: 18, contentTop: 20 });
		// 第 1 行高 150 → 第 2 行 top = 20 + 150 + 18 = 188
		expect(tops[0]).toBe(20);
		expect(tops[1]).toBe(20);
		expect(tops[2]).toBe(188);
		expect(tops[3]).toBe(188);
	});

	it("空输入返回空数组，不抛异常", () => {
		expect(computeRowTops([], layout)).toEqual([]);
	});

	it("高度为 0 的页不产生负偏移（缺页/未渲染）", () => {
		const tops = computeRowTops([0, 0, 100], layout);
		expect(tops[0]).toBe(20);
		expect(tops[1]).toBe(38);
		expect(tops[2]).toBe(56);
	});
});

describe("shiftTopsAfter（可选增量口径）", () => {
	it("单页模式：改第 1 页高度，其后的页全部平移", () => {
		const tops = [20, 138, 356];
		const affected = shiftTopsAfter(tops, [100, 200, 300], 0, 50, layout);
		expect(affected).toBe(2);
		expect(tops).toEqual([20, 188, 406]);
	});

	it("双页模式：行内其它页的 top 不变，只平移后续行", () => {
		const tops = [20, 20, 188, 188, 300, 300];
		const affected = shiftTopsAfter(tops, [100, 150, 80, 80, 90, 90], 0, 30, { cols: 2, gap: 18, contentTop: 20 });
		expect(affected).toBe(4);
		expect(tops).toEqual([20, 20, 218, 218, 330, 330]);
	});

	it("delta 为 0 或索引越界时不改动且返回 0", () => {
		const tops = [20, 138];
		expect(shiftTopsAfter(tops, [100, 200], 0, 0, layout)).toBe(0);
		expect(shiftTopsAfter(tops, [100, 200], 5, 10, layout)).toBe(0);
		expect(tops).toEqual([20, 138]);
	});
});

describe("一致性：纯计算结果与「逐页累计」参考实现一致（模拟混合尺寸 PDF）", () => {
	it("随机页高下与参考实现逐项相等", () => {
		// 固定种子的伪随机，保证可复现
		let seed = 42;
		const rand = (): number => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		for (const cols of [1, 2]) {
			const heights = Array.from({ length: 200 }, () => Math.round(600 + rand() * 400));
			const tops = computeRowTops(heights, { cols, gap: 18, contentTop: 20 });
			// 参考实现：按行累计
			let y = 20;
			for (let i = 0; i < heights.length; i += cols) {
				const row = heights.slice(i, i + cols);
				const rowHeight = Math.max(...row);
				for (let k = i; k < Math.min(heights.length, i + cols); k++) {
					expect(tops[k]).toBeCloseTo(y, 9);
				}
				y += rowHeight + 18;
			}
		}
	});
});
