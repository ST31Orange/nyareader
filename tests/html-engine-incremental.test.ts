/**
 * task-7 / task-10（stream-f）回归测试。
 *
 * task-7：大文件"调字号卡死 / 目录跳远章节卡死 / 补章周期性卡顿"的引擎侧纯逻辑；
 * task-10（D 方案）：按章独立分页的**纯函数内核**（版式指纹 / 字符插值估计 /
 * 全局页号↔章号映射 / 活动窗口）。
 *
 * 真实浏览器里的墙钟数字（改字号耗时、补章 50 批、翻页 100 次、估计页数偏差）
 * 由 `tests/manual/perf-reflow.mjs` 产出（CDP + longtask）。
 *
 * 证据强度：
 * - 第 1/2 组：E1（真实纯函数 paging-layout 的增量测量与落盘策略）
 * - 第 3 组：E1（真实 EpubLazyLoader 调度器 + 真实 retry/容错分支）
 * - 第 4 组：E1（真实纯函数：按章分页的估计与映射）
 */
import { describe, expect, it } from "vitest";
import {
	activeWindowRange,
	appendedPageCount,
	chapterForPage,
	chapterPageOffsets,
	charsPerPageFromMeasures,
	computePageLayout,
	estimatePagesFromChars,
	estimateTotalPages,
	layoutFingerprint,
	nextSettleDelayMs,
	pageCountFromMarker,
	pageForChapter,
	type ChapterPageMeasure,
	type PagedLayoutKey,
} from "../src/services/books/formats/html/paging-layout";
import { EpubLazyLoader } from "../src/services/books/formats/epub/EpubLazyLoader";
import type { EpubChapterSource } from "../src/services/books/formats/epub/EpubLazyLoader";

/** 与真实版式一致的一页步长（pageWidth 1112 + gutter 40） */
const STRIDE = 1152;
const LAYOUT = { columnStride: STRIDE };
/** 标记落在第 col 列时的 offsetLeft（列号从 0 开始，页数 = col + 1） */
const markerAtColumn = (col: number): number => col * STRIDE;

// ---------------------------------------------------------------- 1. 增量测量

describe("增量测量：纯末尾追加的页数差（A 步核心算术）", () => {
	it("新增页数 = 两次标记列号之差（与全量测量恒等）", () => {
		// 追加前 3 页（标记在第 2 列），追加后 8 页（标记在第 7 列）
		const prev = markerAtColumn(2);
		const next = markerAtColumn(7);
		expect(pageCountFromMarker(prev, LAYOUT)).toBe(3);
		expect(pageCountFromMarker(next, LAYOUT)).toBe(8);
		expect(appendedPageCount(prev, next, LAYOUT)).toBe(5);
		// 恒等式：全量测量 = 旧全量 + 增量（任何一对列号都成立）
		for (let a = 0; a <= 40; a += 7) {
			for (let b = a; b <= 60; b += 5) {
				const p = markerAtColumn(a);
				const n = markerAtColumn(b);
				expect(pageCountFromMarker(p, LAYOUT) + appendedPageCount(p, n, LAYOUT)).toBe(
					pageCountFromMarker(n, LAYOUT)
				);
			}
		}
	});

	it("新内容仍落在同一列内时增量为 0（不虚报页数）", () => {
		// 标记在第 4 列内移动（不同 offsetLeft，但都取整到第 4 列）
		expect(appendedPageCount(markerAtColumn(4), markerAtColumn(4) + STRIDE * 0.3, LAYOUT)).toBe(0);
		// 跨过列边界才算新页
		expect(appendedPageCount(markerAtColumn(4) + STRIDE * 0.3, markerAtColumn(4) + STRIDE * 0.6, LAYOUT)).toBe(1);
	});

	it("内容收缩/非法输入时夹到 0（绝不返回负增量）", () => {
		expect(appendedPageCount(markerAtColumn(9), markerAtColumn(2), LAYOUT)).toBe(0);
		expect(appendedPageCount(Number.NaN, markerAtColumn(2), LAYOUT)).toBe(0);
		expect(appendedPageCount(markerAtColumn(1), Number.POSITIVE_INFINITY, LAYOUT)).toBe(0);
		expect(appendedPageCount(markerAtColumn(1), markerAtColumn(2), { columnStride: 0 })).toBe(0);
	});

	it("真实版式（computePageLayout）下的增量与页数一致", () => {
		const layout = computePageLayout({ viewWidth: 1200, viewHeight: 800, double: false });
		const pages = 2001;
		const lastMarker = (pages - 1) * layout.columnStride;
		expect(pageCountFromMarker(lastMarker, layout)).toBe(pages);
		// 再追加 137 页
		const grown = lastMarker + 137 * layout.columnStride;
		expect(appendedPageCount(lastMarker, grown, layout)).toBe(137);
		expect(pageCountFromMarker(grown, layout)).toBe(pages + 137);
	});
});

// ---------------------------------------------------------------- 2. 落盘策略

describe("补章落盘策略：合并连续追加 + 最长持有时间（A/B 步）", () => {
	it("静默窗口内追加一次落盘（延迟 = 静默窗口）", () => {
		expect(nextSettleDelayMs(1000, 1000, 120, 1000)).toBe(120);
		expect(nextSettleDelayMs(1050, 1000, 120, 1000)).toBe(120);
	});

	it("最长持有时间封顶：持续补章也必须按时落盘", () => {
		// 第一批出现在 1000，最长持有 1000ms
		expect(nextSettleDelayMs(1900, 1000, 120, 1000)).toBe(100); // 只剩 100ms
		expect(nextSettleDelayMs(2000, 1000, 120, 1000)).toBe(0); // 到点：立即落盘
		expect(nextSettleDelayMs(5000, 1000, 120, 1000)).toBe(0);
	});

	it("没有待落盘内容时立即（0ms）", () => {
		expect(nextSettleDelayMs(1000, 0, 120, 1000)).toBe(0);
		expect(nextSettleDelayMs(Number.NaN, 1000, 120, 1000)).toBe(0);
		expect(nextSettleDelayMs(1000, Number.NaN, 120, 1000)).toBe(0);
	});
});

// ---------------------------------------------------------------- 3. 按章独立分页（task-10 / D）

/** 一套基准版式；改任一字段都应让指纹失效。 */
const BASE_KEY: PagedLayoutKey = {
	fontSize: 18,
	lineHeight: 1.8,
	fontFamily: "system-ui",
	pageWidth: 1112,
	pageHeight: 744,
	gutter: 40,
	pageMarginX: 28,
	double: false,
};
const FP = layoutFingerprint(BASE_KEY);
const measure = (pages: number, chars: number, fingerprint = FP): ChapterPageMeasure => ({ pages, chars, fingerprint });

describe("按章独立分页：版式指纹（缓存是否可复用由它决定）", () => {
	it("同版式 → 同指纹；任一影响断行的字段变化 → 指纹变化", () => {
		expect(layoutFingerprint({ ...BASE_KEY })).toBe(FP);
		expect(layoutFingerprint({ ...BASE_KEY, fontSize: 20 })).not.toBe(FP);
		expect(layoutFingerprint({ ...BASE_KEY, lineHeight: 2 })).not.toBe(FP);
		expect(layoutFingerprint({ ...BASE_KEY, fontFamily: "serif" })).not.toBe(FP);
		expect(layoutFingerprint({ ...BASE_KEY, pageWidth: 900 })).not.toBe(FP);
		expect(layoutFingerprint({ ...BASE_KEY, pageHeight: 800 })).not.toBe(FP);
		expect(layoutFingerprint({ ...BASE_KEY, gutter: 30 })).not.toBe(FP);
		expect(layoutFingerprint({ ...BASE_KEY, pageMarginX: 18 })).not.toBe(FP);
		expect(layoutFingerprint({ ...BASE_KEY, double: true })).not.toBe(FP);
	});

	it("浮点噪声不让缓存失效，但真实的 0.01 差异必须区分", () => {
		expect(layoutFingerprint({ ...BASE_KEY, fontSize: 18.0000000001 })).toBe(FP);
		expect(layoutFingerprint({ ...BASE_KEY, fontSize: 18.01 })).not.toBe(FP);
	});
});

describe("按章独立分页：字符插值估计", () => {
	it("已经测过的章节用测量值，未测章节按每页字符数插值", () => {
		const chars = [900, 1800, 900, 900];
		const measures = [measure(1, 900), measure(2, 1800), null, null];
		const est = estimateTotalPages(measures, chars, FP);
		// 已测：1 + 2 = 3；未测：900 字 / (每页 900 字) = 1 页 ×2
		expect(est.pages).toBe(5);
		expect(est.measuredChapters).toBe(2);
		expect(est.estimatedChapters).toBe(2);
		expect(est.charsPerPage).toBe(900);
		expect(est.estimatedFraction).toBeCloseTo(2 / 5, 6);
	});

	it("版式指纹变了 → 旧测量全部作废并走插值（不会复用错误页数）", () => {
		const chars = [900, 900];
		const old = [measure(1, 900, layoutFingerprint({ ...BASE_KEY, fontSize: 18 })), measure(1, 900, FP)];
		const est = estimateTotalPages(old, chars, layoutFingerprint({ ...BASE_KEY, fontSize: 20 }));
		expect(est.measuredChapters).toBe(0);
		expect(est.estimatedChapters).toBe(2);
		expect(est.estimatedFraction).toBe(1);
	});

	it("空白输入不炸：至少 1 页，且字符数为 0 的章算 1 页", () => {
		expect(estimateTotalPages([], [], FP).pages).toBe(1);
		expect(estimateTotalPages([null], [0], FP).pages).toBe(1);
		expect(estimatePagesFromChars(0, 0)).toBe(1);
		expect(estimatePagesFromChars(Number.NaN, 900)).toBe(1);
	});

	it("章节篇幅越大页数越多（单调），且加权每页字符数来自已测章节", () => {
		const chars = [1000, 2000, 3000, 4000];
		const small = estimateTotalPages([measure(1, 1000), null, null, null], chars, FP);
		const big = estimateTotalPages([measure(2, 1000), null, null, null], chars, FP);
		expect(big.pages).toBeGreaterThan(small.pages);
		// 每页 500 字（2 页 / 1000 字）时，4000 字的章应估 8 页
		expect(charsPerPageFromMeasures([measure(2, 1000)], [1000], FP)).toBe(500);
		expect(estimatePagesFromChars(4000, 500)).toBe(8);
	});
});

describe("按章独立分页：全局页号 ↔ (章, 章内页) 映射", () => {
	const pages = [3, 5, 2, 4];
	const offsets = chapterPageOffsets(pages);

	it("前缀和正确（offsets[0] = 1，offsets[n] = 总页数 + 1）", () => {
		expect(offsets).toEqual([1, 4, 9, 11, 15]);
	});

	it("往返映射一致且严格单调（翻页不会跳页/回跳）", () => {
		const total = offsets[offsets.length - 1] - 1;
		let prevChapter = -1;
		for (let p = 1; p <= total; p++) {
			const { chapter, pageInChapter } = chapterForPage(p, offsets);
			expect(pageForChapter(chapter, pageInChapter, offsets)).toBe(p);
			expect(chapter).toBeGreaterThanOrEqual(prevChapter);
			prevChapter = chapter;
		}
	});

	it("越界页号被夹到 [1, 总页数]", () => {
		expect(chapterForPage(0, offsets)).toEqual({ chapter: 0, pageInChapter: 1 });
		expect(chapterForPage(-5, offsets)).toEqual({ chapter: 0, pageInChapter: 1 });
		expect(chapterForPage(999, offsets)).toEqual({ chapter: 3, pageInChapter: 4 });
		expect(chapterForPage(Number.NaN, offsets)).toEqual({ chapter: 0, pageInChapter: 1 });
	});

	it("章内页号越界被夹到该章范围", () => {
		expect(pageForChapter(1, 99, offsets)).toBe(8); // 第 2 章最后一页
		expect(pageForChapter(1, 0, offsets)).toBe(4); // 第 2 章第一页
		expect(pageForChapter(99, 1, offsets)).toBe(11); // 章号越界 → 最后一章第一页
	});

	it("空章节列表也不返回非法值", () => {
		expect(chapterPageOffsets([])).toEqual([1]);
		expect(chapterForPage(3, [1])).toEqual({ chapter: 0, pageInChapter: 1 });
		expect(pageForChapter(0, 1, [1])).toBe(1);
	});

	/**
	 * 回归：目录跳到"远处的章"曾静默失效。
	 *
	 * 旧实现里 `pageOfElement()` 用 `currentPage - 1 + col` 算绝对页号。
	 * 激活远处章节后 currentPage 仍停在**旧章**，于是算出来的是旧章的页；
	 * 随后 `showPage()` 用 `chapterForPage()` 反推回旧章 → 又调 `ensureWindow(旧章)`
	 * → 窗口被弹回去，跳转"看起来没反应"。
	 *
	 * 正确口径是：绝对页号 = 该章起始页（offsets[chapter]）+ 章内列号。
	 * 这样 showPage 反推回来仍是同一章，不会再弹回。
	 */
	it("回归：远处章节的绝对页号必须落在该章区间（否则 showPage 会把窗口弹回旧章）", () => {
		const pages = [3, 5, 4, 2]; // 4 章
		const offsets = chapterPageOffsets(pages); // [1, 4, 9, 13, 15]
		// 第 3 章（index=2）起始页是 9；章内第 0 列 → 绝对页 9
		const chapter = 2;
		const chapterStart = offsets[chapter];
		expect(chapterStart).toBe(9);
		const absolute = chapterStart + 0;
		// 绝对页号反推回同一章 —— 这正是旧写法违反的性质
		expect(chapterForPage(absolute, offsets).chapter).toBe(chapter);
		expect(chapterForPage(absolute, offsets).pageInChapter).toBe(1);
		// 章内最后一列同样落在该章
		const lastCol = pages[chapter] - 1;
		expect(chapterForPage(chapterStart + lastCol, offsets).chapter).toBe(chapter);
		// 对照：旧写法 `currentPage - 1 + col`（currentPage 停在旧章）会落到别的章
		const staleCurrentPage = 2; // 读者还在第 1 章
		const buggy = staleCurrentPage - 1 + 0;
		expect(chapterForPage(Math.max(1, buggy), offsets).chapter).not.toBe(chapter);
	});
});

describe("按章独立分页：活动窗口", () => {
	it("当前章 ±1，且夹在 [0, n-1]", () => {
		expect(activeWindowRange(0, 600)).toEqual({ from: 0, to: 1 });
		expect(activeWindowRange(5, 600)).toEqual({ from: 4, to: 6 });
		expect(activeWindowRange(599, 600)).toEqual({ from: 598, to: 599 });
	});
	it("窗口大小固定为 min(2r+1, n)，且随半径线性增长（重排成本可控）", () => {
		expect(activeWindowRange(50, 600, 1)).toEqual({ from: 49, to: 51 });
		expect(activeWindowRange(50, 600, 2)).toEqual({ from: 48, to: 52 });
		const single = activeWindowRange(0, 1);
		expect(single).toEqual({ from: 0, to: 0 });
		expect(activeWindowRange(0, 0)).toEqual({ from: 0, to: -1 });
	});
});

// ---------------------------------------------------------------- 4. 补章一致性

/** 合成章节源：每章带唯一标记，便于断言"不重不漏"。 */
function makeSource(total: number, failBuild: number[] = []): EpubChapterSource {
	return {
		chapterCount: total,
		async buildChapterChunk(index: number): Promise<string> {
			if (failBuild.includes(index)) throw new Error(`build fail #${index}`);
			return `<!--C${index}--><p>chunk-${index}</p>`;
		},
	};
}

interface AppendRecord {
	from: number;
	html: string;
}

/** 从追加的 html 里解析出章节标记（顺序即追加顺序）。 */
function markersIn(html: string): number[] {
	return Array.from(html.matchAll(/<!--C(\d+)-->/g)).map((m) => Number(m[1]));
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
	if (!cond()) throw new Error("waitFor 超时");
}

describe("补章一致性：不重不漏、失败不静默、失败不空转", () => {
	it("跳转预加载（ensureChaptersThrough）覆盖到目标章：每章恰好追加一次且顺序递增", async () => {
		const total = 120;
		const records: AppendRecord[] = [];
		const loader = new EpubLazyLoader(makeSource(total), {
			initialChapters: 2,
			batchSize: 7,
			preloadBatchSize: 13,
			append: (html, from) => records.push({ from, html }),
			schedule: (task) => setTimeout(task, 0),
		});

		await loader.ensureChaptersThrough(99);
		expect(loader.loadedChapters).toBe(100);

		// from 严格递增（同一批不会被重复追加两次）
		const froms = records.map((r) => r.from);
		for (let i = 1; i < froms.length; i++) expect(froms[i]).toBeGreaterThan(froms[i - 1]);

		// 覆盖 0..99 每个索引恰好一次，顺序严格递增
		// （0..initialChapters-1 已在首屏文档里，不在追加记录中）
		const seen = records.flatMap((r) => markersIn(r.html));
		expect(seen).toEqual(Array.from({ length: 98 }, (_, i) => i + 2));
	});

	it("后台补章全程不重不漏（含 50+ 批切片与串行队列）", async () => {
		const total = 240;
		const records: AppendRecord[] = [];
		const loader = new EpubLazyLoader(makeSource(total), {
			initialChapters: 1,
			batchSize: 4,
			sliceBudgetMs: 0, // 每片只追加一批，制造"很多批"的场景
			append: (html, from) => records.push({ from, html }),
			schedule: (task) => setTimeout(task, 0),
		});
		loader.start();
		await waitFor(() => loader.loadedChapters >= total);

		const seen = records.flatMap((r) => markersIn(r.html));
		// 第 0 章在首屏文档里，追加记录从第 1 章开始
		expect(seen).toEqual(Array.from({ length: total - 1 }, (_, i) => i + 1));
		expect(loader.loadedFraction).toBe(1);
		expect(loader.wholeBookPercent(0.5)).toBeCloseTo(0.5, 6);
	});

	it("单块构建失败：用占位跳过并继续推进，不空转（旧实现会永久卡住）", async () => {
		const total = 30;
		const failures: number[] = [];
		const records: AppendRecord[] = [];
		const loader = new EpubLazyLoader(makeSource(total, [7, 19]), {
			initialChapters: 0,
			batchSize: 5,
			sliceBudgetMs: 0,
			append: (html, from) => records.push({ from, html }),
			onError: (info) => failures.push(info.index),
			schedule: (task) => setTimeout(task, 0),
		});
		loader.start();
		await waitFor(() => loader.loadedChapters >= total);

		expect(failures.sort((a, b) => a - b)).toEqual([7, 19]);
		// 失败块用可见占位替代（块序/锚点不错位），其余块顺序完整
		const all = records.map((r) => r.html).join("");
		expect(all).toContain('data-nyar-chunk-failed="7"');
		expect(all).toContain('data-nyar-chunk-failed="19"');
		const seen = records.flatMap((r) => markersIn(r.html));
		expect(seen).toEqual(Array.from({ length: total }, (_, i) => i).filter((i) => i !== 7 && i !== 19));
	});

	it("引擎 append 抛错：重试一次后继续推进，loaded 与追加内容一致（不倒退/不空转）", async () => {
		const total = 24;
		let throwOnce = true;
		const appended: number[] = [];
		const loader = new EpubLazyLoader(makeSource(total), {
			initialChapters: 0,
			batchSize: 6,
			sliceBudgetMs: 0,
			append: (html) => {
				if (throwOnce) {
					throwOnce = false;
					throw new Error("engine append boom");
				}
				appended.push(...markersIn(html));
			},
			schedule: (task) => setTimeout(task, 0),
		});
		loader.start();
		await waitFor(() => loader.loadedChapters >= total);

		// 第一批发起的两次尝试：第一次抛错、第二次成功 → 内容不重复
		const counts = new Map<number, number>();
		for (const i of appended) counts.set(i, (counts.get(i) ?? 0) + 1);
		expect(appended).toEqual(Array.from({ length: total }, (_, i) => i));
		for (const c of counts.values()) expect(c).toBe(1);
		expect(loader.loadedChapters).toBe(total);
	});

	it("dispose 后不再追加（换书/关窗不把旧内容写进新书）", async () => {
		const records: AppendRecord[] = [];
		const loader = new EpubLazyLoader(makeSource(200), {
			initialChapters: 0,
			batchSize: 5,
			sliceBudgetMs: 0,
			append: (html, from) => records.push({ from, html }),
			schedule: (task) => setTimeout(task, 0),
		});
		loader.start();
		await waitFor(() => records.length > 0);
		loader.dispose();
		const snapshot = records.length;
		await new Promise((r) => setTimeout(r, 60));
		expect(records.length).toBe(snapshot);
	});
});
