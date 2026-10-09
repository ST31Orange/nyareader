/**
 * EPUB 分章懒加载 / 资源登记 / 样式去重 / 首屏性能 单测。
 *
 * 覆盖 task-2 的四条根因：
 * 1. 首章优先：默认只构建前 2 章，其余按序追加（锚点前缀 nyareader-epub-N 不变）；
 * 2. 图片不再 base64 内联、不再 src=""：登记 data-nyar-asset（zip 绝对路径）+ data-nyar-src；
 * 3. 章节样式稳定哈希去重（跨章共享 CSS 只出现一次）；
 * 4. 性能：合成 3000 章 EPUB 下"首屏只建 2 章"与"全量构建"的耗时对比。
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import {
	DEFAULT_INITIAL_CHAPTERS,
	EPUB_ASSET_ATTR,
	EPUB_ASSET_FALLBACK_ATTR,
	StyleRegistry,
	buildEpubHtml,
	openEpubSource,
	registerChapterImages,
	stableStyleKey,
} from "../src/services/books/formats/epub/EpubDocument";
import {
	EpubLazyLoader,
	chapterIndexForPercent,
	toLoadedDocPercent,
	toWholeBookPercent,
	weightedDocPercent,
	weightedDocPercentAbsolute,
	weightedLoadedFraction,
	weightedWholeBookPercent,
} from "../src/services/books/formats/epub/EpubLazyLoader";

/** 所有章节共享的内联样式 */
const SHARED_INLINE_CSS = "p { margin: 0 0 0.8em 0; }";
/** 所有章节共享的外链样式（与内联样式不同，便于断言"两条去重后的样式"） */
const SHARED_LINK_CSS = "body { text-indent: 1.2em; }";

interface EpubSampleOptions {
	/** 每章正文段落字符数（造大样本用） */
	bodyChars?: number;
	/** 每章插入一张共享图片 */
	withImage?: boolean;
	/** 是否压缩 zip（默认 STORE：生成快，等价于"未压缩的大文件"） */
	compress?: boolean;
}

function chapterXhtml(index: number, opts: EpubSampleOptions): string {
	const body = "正".repeat(Math.max(4, opts.bodyChars ?? 24));
	const img = opts.withImage ? '<img src="../images/pic.png" alt="pic"/>' : "";
	return `<html><head><link rel="stylesheet" href="../style.css"/><style>${SHARED_INLINE_CSS}</style></head><body><h1>Chapter ${index}</h1><p>body-${index}</p><p>${body}</p>${img}</body></html>`;
}

async function makeLazyEpub(chapters = 6, opts: EpubSampleOptions = {}): Promise<ArrayBuffer> {
	const zip = new JSZip();
	zip.file("mimetype", "application/epub+zip");
	zip.file(
		"META-INF/container.xml",
		`<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
	);
	const items: string[] = [`<item id="css" href="style.css" media-type="text/css"/>`];
	const refs: string[] = [];
	if (opts.withImage) items.push(`<item id="img" href="images/pic.png" media-type="image/png"/>`);
	for (let i = 0; i < chapters; i++) {
		items.push(`<item id="c${i}" href="text/ch${i}.xhtml" media-type="application/xhtml+xml"/>`);
		refs.push(`<itemref idref="c${i}"/>`);
	}
	zip.file(
		"OEBPS/content.opf",
		`<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Lazy Book</dc:title></metadata>
		<manifest>${items.join("")}</manifest><spine>${refs.join("")}</spine></package>`
	);
	zip.file("OEBPS/style.css", SHARED_LINK_CSS);
	if (opts.withImage) zip.file("OEBPS/images/pic.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
	for (let i = 0; i < chapters; i++) zip.file(`OEBPS/text/ch${i}.xhtml`, chapterXhtml(i, opts));
	return zip.generateAsync({ type: "arraybuffer", compression: opts.compress ? "DEFLATE" : "STORE" });
}

describe("首章优先：首屏只构建前 N 章", () => {
	it("默认只含前 2 章正文，锚点前缀仍是 nyareader-epub-N", async () => {
		const source = await openEpubSource(await makeLazyEpub(6));
		const html = await source.buildInitialHtml();
		expect(source.chapterCount).toBe(6);
		expect(DEFAULT_INITIAL_CHAPTERS).toBe(2);
		// 单文档 + 前 2 章锚点/正文
		expect((html.match(/<html\b/gi) || []).length).toBe(1);
		expect(html).toContain('id="nyareader-epub-0"');
		expect(html).toContain('id="nyareader-epub-1"');
		expect(html).toContain("body-0");
		expect(html).toContain("body-1");
		// 第 3 章起不在首屏文档里（由懒加载追加）
		expect(html).not.toContain('id="nyareader-epub-2"');
		expect(html).not.toContain("body-2");
	});

	it("buildEpubHtml 兼容入口同样支持 initialChapters", async () => {
		const buffer = await makeLazyEpub(4);
		const first = await buildEpubHtml(buffer);
		expect(first).not.toContain("body-2");
		const full = await buildEpubHtml(buffer, "EPUB", { initialChapters: 4 });
		expect(full).toContain("body-2");
		expect(full).toContain("body-3");
	});
});

describe("懒加载补章：顺序、锚点、可选链安全", () => {
	it("按序追加，锚点连续、每章只追加一次", async () => {
		const source = await openEpubSource(await makeLazyEpub(6));
		await source.buildInitialHtml(2);
		const appended: Array<{ html: string; from: number }> = [];
		const loader = new EpubLazyLoader(source, {
			initialChapters: 2,
			batchSize: 2,
			preloadBatchSize: 2,
			sliceBudgetMs: 0,
			schedule: (task) => task(),
			append: (html, from) => appended.push({ html, from }),
		});
		loader.start();
		await loader.ensureChaptersThrough(5);

		expect(loader.loadedChapters).toBe(6);
		expect(loader.loadedFraction).toBe(1);
		// 追加顺序严格递增，且覆盖 2..5
		expect(appended.map((a) => a.from)).toEqual([2, 4]);
		expect(appended[0].html).toContain('id="nyareader-epub-2"');
		expect(appended[0].html).toContain('id="nyareader-epub-3"');
		expect(appended[1].html).toContain('id="nyareader-epub-4"');
		expect(appended[1].html).toContain('id="nyareader-epub-5"');
		// 每个锚点只出现一次（不会重复追加）
		const allAnchors = appended.flatMap((a) => a.html.match(/id="nyareader-epub-\d+"/g) ?? []);
		expect(new Set(allAnchors).size).toBe(allAnchors.length);
	});

	it("引擎未实现 notifyContentAppended 时安全跳过（不追加、不抛错）", async () => {
		const source = await openEpubSource(await makeLazyEpub(4));
		const loader = new EpubLazyLoader(source, { initialChapters: 1 });
		loader.start();
		await loader.ensureChaptersThrough(3);
		expect(loader.loadedChapters).toBe(1);
	});

	it("ensureChaptersThrough 不会重复追加已加载章节", async () => {
		const source = await openEpubSource(await makeLazyEpub(5));
		const calls: number[] = [];
		const loader = new EpubLazyLoader(source, {
			initialChapters: 2,
			batchSize: 8,
			preloadBatchSize: 8,
			sliceBudgetMs: 0,
			schedule: (task) => task(),
			append: (_html, from) => calls.push(from),
		});
		await loader.ensureChaptersThrough(3);
		await loader.ensureChaptersThrough(1);
		await loader.ensureChaptersThrough(4);
		// 第 1 次补到第 3 章（批次 2..3），中间那次已是 no-op，第 3 次只补第 4 章
		expect(calls).toEqual([2, 4]);
		expect(loader.loadedChapters).toBe(5);
	});

	it("dispose 后停止追加", async () => {
		const source = await openEpubSource(await makeLazyEpub(6));
		const calls: number[] = [];
		const loader = new EpubLazyLoader(source, {
			initialChapters: 2,
			batchSize: 1,
			schedule: (task) => task(),
			append: (_html, from) => calls.push(from),
		});
		loader.dispose();
		loader.start();
		await loader.ensureChaptersThrough(5);
		expect(calls).toEqual([]);
		expect(loader.loadedChapters).toBe(2);
	});

	it("百分比换算纯函数：整本书 <-> 已加载前缀", () => {
		expect(chapterIndexForPercent(0, 100)).toBe(0);
		expect(chapterIndexForPercent(0.5, 100)).toBe(49);
		expect(chapterIndexForPercent(1, 100)).toBe(99);
		expect(chapterIndexForPercent(-1, 100)).toBe(0);
		expect(chapterIndexForPercent(2, 100)).toBe(99);
		expect(chapterIndexForPercent(0.5, 0)).toBe(0);

		expect(toWholeBookPercent(0.5, 0.25)).toBeCloseTo(0.125);
		expect(toWholeBookPercent(2, 1)).toBe(1);
		expect(toWholeBookPercent(-1, 0.5)).toBe(0);

		expect(toLoadedDocPercent(0.5, 0.25)).toBeCloseTo(1);
		expect(toLoadedDocPercent(0.25, 0.5)).toBeCloseTo(0.5);
		expect(toLoadedDocPercent(0.5, 0)).toBe(0);
	});
});

describe("图片：资源登记而非内联（不再 src=\"\"）", () => {
	it("registerChapterImages 纯函数：登记 zip 绝对路径 + 保留原 href", () => {
		const out = registerChapterImages(
			'<p>t</p><img src="../images/a.png" alt="x"/><img src="missing.png" alt="y">',
			"OEBPS/text"
		);
		expect(out).toContain(`${EPUB_ASSET_ATTR}="OEBPS/images/a.png"`);
		expect(out).toContain(`${EPUB_ASSET_FALLBACK_ATTR}="../images/a.png"`);
		expect(out).toContain('alt="x"');
		// 相对路径按**章节所在目录**解析（分片目录下的图片/缺失资源同理）
		expect(out).toContain(`${EPUB_ASSET_ATTR}="OEBPS/text/missing.png"`);
		// 原始 src 被移除（srcdoc 下必然失败），但也没有被清成 src=""
		expect(out).not.toMatch(/<img[^>]*\ssrc=/i);
		expect(out).not.toContain('src=""');
	});

	it("只有 srcset 的图片也会被登记（取第一候选）", () => {
		const out = registerChapterImages('<img srcset="../images/a.png 1x, ../images/a@2x.png 2x" alt="x"/>', "OEBPS/text");
		expect(out).toContain(`${EPUB_ASSET_ATTR}="OEBPS/images/a.png"`);
		expect(out).toContain(`${EPUB_ASSET_FALLBACK_ATTR}="../images/a.png"`);
		expect(out).not.toContain("srcset");
		expect(out).not.toMatch(/<img[^>]*\ssrc=/i);
		// 既没有 src 也没有 srcset 的图片保持原样
		expect(registerChapterImages('<img alt="no-src"/>', "OEBPS")).toBe('<img alt="no-src"/>');
	});

	it("合成 EPUB：首屏 HTML 不含 base64，图片带登记态；readAsset/resolveAssetUrl 可回填", async () => {
		const source = await openEpubSource(await makeLazyEpub(2, { withImage: true }));
		const html = await source.buildInitialHtml(2);
		expect(html).toContain(`${EPUB_ASSET_ATTR}="OEBPS/images/pic.png"`);
		expect(html).toContain(`${EPUB_ASSET_FALLBACK_ATTR}="../images/pic.png"`);
		expect(html).not.toContain("data:image");
		expect(html).not.toMatch(/<img[^>]*\ssrc=/i);

		const asset = await source.readAsset("OEBPS/images/pic.png");
		expect(asset?.mime).toBe("image/png");
		expect(asset?.bytes.length).toBe(4);
		// 缺失/非图片资源返回 null -> 引擎保留 nyareader-img-missing 占位
		expect(await source.readAsset("OEBPS/images/nope.png")).toBeNull();
		expect(await source.readAsset("OEBPS/style.css")).toBeNull();

		const canBlob = typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
		const url = await source.resolveAssetUrl("OEBPS/images/pic.png");
		if (canBlob) {
			expect(url).toMatch(/^blob:/);
			// 同一路径只创建一个 blob URL
			expect(await source.resolveAssetUrl("OEBPS/images/pic.png")).toBe(url);
		} else {
			expect(url).toBeNull();
		}
		expect(await source.resolveAssetUrl("OEBPS/images/nope.png")).toBeNull();
		source.releaseAssetUrls();
		expect(await source.resolveAssetUrl("OEBPS/images/pic.png")).not.toBe(url);
	});
});

describe("章节样式：稳定哈希去重", () => {
	it("stableStyleKey/StyleRegistry：同串同键、异串异键、去重可判定", () => {
		expect(stableStyleKey(SHARED_INLINE_CSS)).toBe(stableStyleKey(SHARED_INLINE_CSS));
		expect(stableStyleKey(SHARED_INLINE_CSS)).not.toBe(stableStyleKey(SHARED_LINK_CSS));
		const registry = new StyleRegistry();
		expect(registry.add(SHARED_INLINE_CSS)).toBe(true);
		expect(registry.add(SHARED_INLINE_CSS)).toBe(false);
		expect(registry.add(SHARED_LINK_CSS)).toBe(true);
		expect(registry.size).toBe(2);
		expect(registry.has(SHARED_INLINE_CSS)).toBe(true);
	});

	it("6 章共享同一内联样式与外链 CSS：文档里只出现 2 条样式", async () => {
		const source = await openEpubSource(await makeLazyEpub(6));
		const html = await source.buildInitialHtml(6);
		const styleTags = html.match(/<style>/g) ?? [];
		expect(styleTags.length).toBe(2);
		expect(source.styleCount).toBe(2);
		// 懒加载追加的章节不会重复注入已登记样式
		const chunk = await source.buildChapterChunk(2);
		expect(chunk).not.toContain("<style>");
		expect(source.styleCount).toBe(2);
	});
});

describe("进度加权：按内容量而非章数（回归：补章时进度回退）", () => {
	/** 前 3 章各 1KB、第 4 章 97KB 的极端分布 */
	const FRONT_LIGHT = [1000, 1000, 1000, 97_000];

	it("weightedLoadedFraction：按字节累计，而非按章数", () => {
		// 章数口径：1/4 = 0.25；字节口径：1000/100000 = 0.01
		expect(weightedLoadedFraction(1, FRONT_LIGHT)).toBeCloseTo(0.01, 6);
		expect(weightedLoadedFraction(3, FRONT_LIGHT)).toBeCloseTo(0.03, 6);
		// 加载完全部章节恒为 1
		expect(weightedLoadedFraction(4, FRONT_LIGHT)).toBe(1);
		expect(weightedLoadedFraction(99, FRONT_LIGHT)).toBe(1);
	});

	it("每章等权时与章数口径一致（退化情形）", () => {
		expect(weightedLoadedFraction(2, [1, 1, 1, 1])).toBeCloseTo(0.5, 9);
		expect(weightedLoadedFraction(3, [1, 1, 1, 1])).toBeCloseTo(0.75, 9);
	});

	it("非法/缺失权重不产生 NaN，也不抛异常", () => {
		expect(weightedLoadedFraction(1, [])).toBe(1);
		expect(weightedLoadedFraction(1, [0, 0, 0])).toBeCloseTo(1 / 3, 9);
		expect(Number.isFinite(weightedLoadedFraction(1, [Number.NaN, 10]))).toBe(true);
	});

	it("weightedDocPercent 与 weightedLoadedFraction 互逆（同一位置往返一致）", () => {
		const weights = [1000, 1000, 1000, 97_000];
		// 已加载全部章节时，整书进度 -> 文档进度应回到原值
		for (const p of [0, 0.05, 0.5, 0.99, 1]) {
			const doc = weightedDocPercent(p, 4, weights);
			expect(doc).toBeCloseTo(p, 6);
		}
	});

	it("只加载前 3 章时，指向已加载区域的整书进度映射进 [0,1]", () => {
		const doc = weightedDocPercent(0.03, 3, FRONT_LIGHT);
		expect(doc).toBeGreaterThanOrEqual(0);
		expect(doc).toBeLessThanOrEqual(1);
		// 位于已加载前缀末尾
		expect(doc).toBeCloseTo(1, 6);
		// 指向尚未加载的远端时钳到 1（调用方会先补章）
		expect(weightedDocPercent(0.8, 3, FRONT_LIGHT)).toBeCloseTo(1, 6);
	});

	it("EpubSource.chapterWeights：长度等于章数、全为正数", async () => {
		const source = await openEpubSource(await makeLazyEpub(5));
		const weights = source.chapterWeights();
		expect(weights.length).toBe(5);
		expect(weights.every((w) => w > 0)).toBe(true);
	});

	/**
	 * 回归（v0.5 真实 bug，由 stream-e 用探针实测发现）：
	 * `weightedWholeBookPercent` 曾把 p 当成"最后一个已加载章内的位置"，
	 * 于是全部加载时 doc(0.10) → 0.91、doc(0.42) → 0.94，与引擎语义不符且与逆函数不互逆。
	 * 下面两条断言会在那种实现下直接失败。
	 */
	it("回归：已加载全部章节时 forward map 恒等（doc(p) → p，不再 0.10→0.91）", () => {
		for (const weights of [
			[1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
			[1000, 1000, 1000, 97_000],
			[5000, 1, 1, 1],
		]) {
			const n = weights.length;
			for (const p of [0, 0.1, 0.42, 0.9, 1]) {
				expect(weightedWholeBookPercent(p, n, weights)).toBeCloseTo(p, 9);
				// 逆函数同样恒等
				expect(weightedDocPercentAbsolute(p, n, weights)).toBeCloseTo(p, 9);
			}
		}
	});

	it("回归：部分加载时 forward/inverse 严格互逆（whole(doc(p)) ≈ p）", () => {
		const weights = [1000, 1000, 1000, 97_000];
		for (const loaded of [1, 2, 3, 4]) {
			for (const p of [0, 0.05, 0.3, 0.75, 1]) {
				const doc = weightedDocPercentAbsolute(p, loaded, weights);
				// doc 可能被钳到 1（目标超出已加载范围），此时只要求有界且不 NaN
				expect(doc).toBeGreaterThanOrEqual(0);
				expect(doc).toBeLessThanOrEqual(1);
				const back = weightedWholeBookPercent(doc, loaded, weights);
				// 未发生钳位时必须严格往返
				if (doc < 1) expect(back).toBeCloseTo(p, 9);
			}
		}
	});

	it("回归：同一阅读位置的整书进度不随补章漂移（只随读进新内容变化）", () => {
		const weights = [1000, 1000, 1000, 97_000];
		// 第 2 章内的同一点：loaded=2 时 p 就是该点在已加载前缀内的比例
		const loadedWeight2 = 2000;
		const totalWeight4 = 100_000;
		const pointInPrefix = 1500 / loadedWeight2; // 第 2 章内 50% 处
		const at2 = weightedWholeBookPercent(pointInPrefix, 2, weights);
		const at3 = weightedWholeBookPercent(pointInPrefix * (loadedWeight2 / 3000), 3, weights);
		const at4 = weightedWholeBookPercent(pointInPrefix * (loadedWeight2 / totalWeight4), 4, weights);
		// 同一绝对位置的整书进度应为常量
		expect(at2).toBeCloseTo(at3, 9);
		expect(at3).toBeCloseTo(at4, 9);
		expect(at2).toBeCloseTo(1500 / totalWeight4, 9);
	});
});

interface PerfSample {
	/** 打开结构（container.xml + content.opf + zip 中央目录）耗时 */
	open: number;
	/** 首屏构建（前 2 章）耗时 */
	first: number;
	/** 全量构建（全部章节）耗时 */
	full: number;
	bytes: number;
	firstHtml: number;
	fullHtml: number;
}

describe("打开链路：解析期占位指纹", () => {
	it("确定性、只依赖路径+字节数，且与真实 sha256 形态可区分", async () => {
		const { provisionalFingerprint } = await import("../src/services/books/Parser");
		expect(provisionalFingerprint("a/b.epub", 1000)).toBe(provisionalFingerprint("a/b.epub", 1000));
		expect(provisionalFingerprint("a/b.epub", 1000)).not.toBe(provisionalFingerprint("a/c.epub", 1000));
		expect(provisionalFingerprint("a/b.epub", 1000)).not.toBe(provisionalFingerprint("a/b.epub", 1001));
		expect(provisionalFingerprint("a/b.epub", 0)).toMatch(/^pending-[0-9a-f]{8}$/);
	});
});

/** 首屏（前 2 章）与全量构建的耗时对比（同一份 EpubSource，只测纯构建阶段）。 */
async function measureFirstPaintVsFull(chapters: number, bodyChars: number): Promise<PerfSample> {
	const buffer = await makeLazyEpub(chapters, { bodyChars });
	const t0 = performance.now();
	const source = await openEpubSource(buffer);
	const t1 = performance.now();
	const firstHtml = await source.buildInitialHtml(DEFAULT_INITIAL_CHAPTERS);
	const t2 = performance.now();
	const fullHtml = await source.buildInitialHtml(chapters);
	const t3 = performance.now();
	return {
		open: t1 - t0,
		first: t2 - t1,
		full: t3 - t2,
		bytes: buffer.byteLength,
		firstHtml: firstHtml.length,
		fullHtml: fullHtml.length,
	};
}

describe("性能：首章优先 vs 全量构建", () => {
	it("3000 章合成 EPUB：首屏只构建前 2 章，远快于全量构建", async () => {
		const r = await measureFirstPaintVsFull(3000, 1200);
		// eslint-disable-next-line no-console
		console.log(
			`[perf] 3000 章 / ${(r.bytes / 1024 / 1024).toFixed(1)}MB：结构打开 ${r.open.toFixed(1)}ms，首屏构建 ${r.first.toFixed(1)}ms（${(r.firstHtml / 1024).toFixed(0)}KB HTML）` +
				` vs 全量构建 ${r.full.toFixed(1)}ms（${(r.fullHtml / 1024 / 1024).toFixed(1)}MB HTML），倍率 ${(r.full / Math.max(0.1, r.first)).toFixed(1)}x`
		);
		expect(r.full).toBeGreaterThan(r.first);
		expect(r.full / Math.max(0.1, r.first)).toBeGreaterThan(5);
		expect(r.fullHtml).toBeGreaterThan(r.firstHtml * 100);
	}, 300_000);

	it.skipIf(!process.env.NYAR_PERF_FULL)("3000 章 / 40MB 级（NYAR_PERF_FULL=1 时运行）", async () => {
		// 每章约 4600 个中文字符（≈14KB UTF-8）× 3000 章 ≈ 40MB，STORE 不压缩
		const r = await measureFirstPaintVsFull(3000, 4600);
		// eslint-disable-next-line no-console
		console.log(
			`[perf-full] 3000 章 / ${(r.bytes / 1024 / 1024).toFixed(1)}MB：结构打开 ${r.open.toFixed(1)}ms，首屏构建 ${r.first.toFixed(1)}ms` +
				` vs 全量构建 ${r.full.toFixed(1)}ms，倍率 ${(r.full / Math.max(0.1, r.first)).toFixed(1)}x（全量 HTML ${(r.fullHtml / 1024 / 1024).toFixed(1)}MB）`
		);
		expect(r.full).toBeGreaterThan(r.first);
	}, 600_000);
});
