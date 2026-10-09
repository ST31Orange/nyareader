/**
 * MOBI/AZW3 分块懒加载单测。
 *
 * 覆盖本次重构的四条主线：
 * 1. 切章：真边界优先（`<mbp:pagebreak>` → `<html>` 骨架 → `<h1..h3>`），三级都不可用时
 *    才退化为"近似块"（按标签边界 ≤128KB）；不变量 = 覆盖完整、严格递增、不切在 style 里；
 * 2. 锚点：块锚点 `nyareader-mobi-N` 顺序追加、每块一次、追加不改变已有锚点；
 *    filepos 锚点仍用绝对偏移 `nyareader-fp-N`（跨块跳转语义不变）；标题锚点 `nyareader-toc-N`；
 * 3. 图片三态：可解析 -> `data-nyar-asset="mobi-rec-<记录号>"` + blob 回填；
 *    不可解析 -> 登记为 `mobi-missing:*` 由引擎给可见占位；外链/无 src 保持原样；
 * 4. 性能：合成大样本上「旧：整本构建」vs「新：首屏只建前 N 块」的耗时与 HTML 体积对比，
 *    以及"解析期 + 渲染期共用一次结构"的缓存命中。
 */
import { describe, it, expect } from "vitest";
import {
	DEFAULT_MOBI_INITIAL_CHAPTERS,
	MAX_CHAPTER_BYTES,
	MIN_CHAPTER_BYTES,
	MOBI_ANCHOR_PREFIX,
	MOBI_ASSET_ATTR,
	MOBI_ASSET_FALLBACK_ATTR,
	MOBI_TOC_ANCHOR_PREFIX,
	MobiContentSource,
	buildMobiChapters,
	fileposAnchorId,
	imageRecordForIndex,
	loadMobiStructure,
	openMobiSource,
	parseMobiImageRef,
	parseMobiStructure,
	readTextRecords,
	readTextRecordsIndexed,
	registerMobiImages,
	releaseMobiStructure,
	scanMobiText,
	sniffImageMime,
	stableMobiStyleKey,
} from "../src/services/books/formats/mobi/MobiDocument";
import { MobiParser, extractMobiContent } from "../src/services/books/formats/mobi/MobiParser";
import { EpubLazyLoader, chapterIndexForPercent, type ChapterSource } from "../src/services/books/formats/epub/EpubLazyLoader";

// ---------- 合成样本 ----------

/** 简单字面量编码（1-8 前缀 + 原字节），等价于"未压缩正文"。 */
function compressLiteral(bytes: Uint8Array): Uint8Array {
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

interface MobiSampleOptions {
	recordSize?: number;
	title?: string;
	author?: string;
	images?: Uint8Array[];
	/** 在 MOBI 头 0x60 写 firstImageIndex（否则走魔数校验 / 正文记录后线性扫描） */
	writeFirstImageIndex?: boolean;
	trailingJunk?: boolean;
}

interface MobiSample {
	bytes: Uint8Array;
	/** 与 bytes 同一份内存的 ArrayBuffer（供 loadMobiStructure/openMobiSource 按身份缓存）。 */
	buffer: ArrayBuffer;
	textRecordCount: number;
	recordSize: number;
	firstImageRecord: number;
}

/** 构造一个结构真实的 PalmDB/MOBI 文件（PalmDOC 头 + MOBI 头 + EXTH + 正文记录 + 图片记录）。 */
function buildSyntheticMobi(text: string, opts: MobiSampleOptions = {}): MobiSample {
	const raw = new TextEncoder().encode(text);
	const recordSize = opts.recordSize ?? 4096;
	const junk = opts.trailingJunk === false ? [] : [0x80, 0x03];
	const records: Uint8Array[] = [];
	for (let off = 0; off < raw.length; off += recordSize) {
		const slice = compressLiteral(raw.subarray(off, Math.min(raw.length, off + recordSize)));
		records.push(new Uint8Array([...slice, ...junk]));
	}
	if (records.length === 0) records.push(new Uint8Array([1, 0x41]));
	const images = opts.images ?? [];
	const recordCount = 1 + records.length + images.length;
	const tableEnd = 78 + recordCount * 8;
	const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
	const exthEntry = (type: number, value: string): number[] => {
		const data = Array.from(new TextEncoder().encode(value));
		return [...be32(type), ...be32(8 + data.length), ...data];
	};
	const exthBody = [...exthEntry(503, `${opts.title ?? "Lazy MOBI"}\0`), ...exthEntry(100, `${opts.author ?? "Author"}\0`)];
	const exth = [0x45, 0x58, 0x54, 0x48, ...be32(12 + exthBody.length), ...be32(2), ...exthBody];
	const firstImageRecord = images.length > 0 ? 1 + records.length : -1;
	const mobiHeaderLen = opts.writeFirstImageIndex && firstImageRecord > 0 ? 0x70 : 20;
	const mobiHeader = new Array<number>(mobiHeaderLen).fill(0);
	"MOBI".split("").forEach((c, i) => (mobiHeader[i] = c.charCodeAt(0)));
	be32(mobiHeaderLen).forEach((b, i) => (mobiHeader[4 + i] = b));
	if (firstImageRecord > 0 && mobiHeaderLen > 0x64) {
		be32(firstImageRecord).forEach((b, i) => (mobiHeader[0x60 + i] = b));
	}
	const textLength = raw.length;
	const palmDocHeader = [
		0, 2, // compression = 2 (LZ77)
		0, 0,
		(textLength >>> 24) & 0xff, (textLength >>> 16) & 0xff, (textLength >>> 8) & 0xff, textLength & 0xff,
		(records.length >> 8) & 0xff, records.length & 0xff,
		(recordSize >> 8) & 0xff, recordSize & 0xff,
		0, 0, // encryption = 0
		0, 0,
	];
	const record0 = [...palmDocHeader, ...mobiHeader, ...exth];
	const offsets: number[] = [tableEnd];
	let cursor = tableEnd + record0.length;
	for (const rec of [...records, ...images]) {
		offsets.push(cursor);
		cursor += rec.length;
	}
	const bytes = new Uint8Array(cursor);
	"BOOKMOBI".split("").forEach((c, i) => (bytes[60 + i] = c.charCodeAt(0)));
	bytes[76] = (recordCount >> 8) & 0xff;
	bytes[77] = recordCount & 0xff;
	offsets.forEach((off, i) => be32(off).forEach((b, k) => (bytes[78 + i * 8 + k] = b)));
	bytes.set(Uint8Array.from(record0), tableEnd);
	let p = tableEnd + record0.length;
	for (const rec of [...records, ...images]) {
		bytes.set(rec, p);
		p += rec.length;
	}
	return { bytes, buffer: bytes.buffer as ArrayBuffer, textRecordCount: records.length, recordSize, firstImageRecord };
}

const bytesOf = (s: string): number => new TextEncoder().encode(s).length;

/** 断言：区间覆盖完整、严格递增、无重叠。 */
function expectFullCoverage(ranges: Array<{ start: number; end: number }>, total: number): void {
	expect(ranges.length).toBeGreaterThan(0);
	expect(ranges[0].start).toBe(0);
	expect(ranges[ranges.length - 1].end).toBe(total);
	for (let i = 0; i < ranges.length; i++) {
		expect(ranges[i].end).toBeGreaterThan(ranges[i].start);
		if (i > 0) expect(ranges[i].start).toBe(ranges[i - 1].end);
	}
}

function readOffset(bytes: Uint8Array, index: number): number {
	const at = 78 + index * 8;
	return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/** 临时包住 URL.revokeObjectURL 数调用次数（环境不支持时返回 null）。 */
function spyOnRevoke(): { count: () => number; restore: () => void } | null {
	const target = URL as unknown as { revokeObjectURL?: (u: string) => void };
	if (typeof target.revokeObjectURL !== "function") return null;
	const original = target.revokeObjectURL;
	let n = 0;
	try {
		target.revokeObjectURL = (u: string): void => {
			n++;
			try {
				original.call(URL, u);
			} catch {
				/* 忽略：URL 已被回收 */
			}
		};
	} catch {
		return null;
	}
	if (target.revokeObjectURL === original) return null;
	return {
		count: () => n,
		restore: () => {
			target.revokeObjectURL = original;
		},
	};
}

// ---------- 1. 切章 ----------

describe("切章：真边界优先，覆盖完整且不切进 style", () => {
	it("<mbp:pagebreak>（MOBI6）切成 6 块，区间覆盖完整/递增", () => {
		const chapters = Array.from({ length: 6 }, (_, i) => `<h1>第${i + 1}章</h1><p>${"正".repeat(300)}-${i}-</p>`);
		const text = `<html><head><style>p{color:red}</style></head><body>${chapters.join("<mbp:pagebreak/>")}</body></html>`;
		const sample = buildSyntheticMobi(text, { recordSize: 512 });
		const structure = parseMobiStructure(sample.bytes);
		expect(structure.chapters.length).toBe(6);
		expectFullCoverage(structure.chapters, bytesOf(text));
		for (const r of structure.chapters) expect(r.end - r.start).toBeGreaterThanOrEqual(MIN_CHAPTER_BYTES);
	});

	it("KF8/AZW3：按 <html> 骨架文档切块，骨架之间的正文归属正确", async () => {
		const docs = Array.from(
			{ length: 4 },
			(_, i) =>
				`<?xml version="1.0"?><html><head><title>c${i}</title></head><body aid="0"></body></html>` +
				`<section id="ch${i}"><h1>Doc ${i}</h1><p>${`tok${i}`.repeat(40)}${"文".repeat(400)}</p></section>`
		);
		const text = docs.join("");
		const sample = buildSyntheticMobi(text, { recordSize: 4096 });
		const structure = parseMobiStructure(sample.bytes);
		expect(structure.chapters.length).toBe(4);
		expectFullCoverage(structure.chapters, bytesOf(text));

		const source = new MobiContentSource(structure, "t");
		const bodies: string[] = [];
		for (let i = 0; i < source.chapterCount; i++) {
			bodies.push((await source.buildChapterChunk(i)).replace(/<style>[\s\S]*?<\/style>/g, ""));
		}
		for (let i = 0; i < 4; i++) {
			expect(bodies[i]).toContain(`<section id="ch${i}">`);
			expect(bodies[i]).toContain(`tok${i}`);
			for (let j = 0; j < 4; j++) if (j !== i) expect(bodies[i]).not.toContain(`tok${j}`);
		}
		for (const b of bodies) {
			expect(b).not.toMatch(/<html\b/i);
			expect(b).not.toMatch(/<body\b/i);
		}
	});

	it("无 pagebreak/骨架时退回 <h1..h3> 标题切块", () => {
		const text = `<p>${"前".repeat(300)}</p>${Array.from({ length: 5 }, (_, i) => `<h2>标题${i}</h2><p>${"字".repeat(260)}</p>`).join("")}`;
		const scan = scanMobiText(new TextEncoder().encode(text));
		expect(scan.pagebreaks.length).toBe(0);
		expect(scan.htmlStarts.length).toBe(0);
		expect(scan.headings.length).toBe(5);
		const sample = buildSyntheticMobi(text);
		const structure = parseMobiStructure(sample.bytes);
		expect(structure.chapters.length).toBe(6); // 前言 + 5 个标题块
		expectFullCoverage(structure.chapters, bytesOf(text));
	});

	it("三级候选都不可用：退化为按标签边界的近似块（≤ MAX + 搜索窗口），不切进 <style>", () => {
		const paragraph = `<p>${"甲".repeat(1200)}</p>`;
		const text =
			`<html><head><style>p{margin:0}.x>p{color:red}a[b="<"]{z:1}</style></head><body>` +
			paragraph.repeat(60) +
			`</body></html>`;
		const sample = buildSyntheticMobi(text, { recordSize: 4096 });
		const bytes = sample.bytes;
		const textBytes = new TextEncoder().encode(text);
		const structure = parseMobiStructure(bytes);
		expect(structure.chapters.length).toBeGreaterThan(1);
		expectFullCoverage(structure.chapters, bytesOf(text));
		for (const r of structure.chapters) {
			expect(r.end - r.start).toBeLessThanOrEqual(MAX_CHAPTER_BYTES + 8192);
			// 切点必须是标签起点（'<' + 字母 / '/' / '!'）；最后一块的 end 就是正文末尾
			if (r.end < textBytes.length) expect(textBytes[r.end]).toBe(0x3c);
		}
		// style 块没被切开：整块被抽出且只登记一次（body 里不会出现半截 <style>）
		const source = new MobiContentSource(structure, "t");
		let styleBlocks = 0;
		for (let i = 0; i < source.chapterCount; i++) {
			const doc = source.buildChapterDoc(i);
			styleBlocks += doc.styles.length;
			expect((doc.body.match(/<style\b/gi) ?? []).length).toBe((doc.body.match(/<\/style>/gi) ?? []).length);
		}
		expect(styleBlocks).toBe(1);
	});

	it("buildMobiChapters/scanMobiText 纯函数：空文本、单块、候选过密都被安全处理", () => {
		expect(buildMobiChapters(new Uint8Array(0), scanMobiText(new Uint8Array(0)))).toEqual([]);
		const tiny = new TextEncoder().encode("<p>hi</p>");
		const ranges = buildMobiChapters(tiny, scanMobiText(tiny));
		expect(ranges).toEqual([{ start: 0, end: tiny.length }]);
		// 候选间距 < MIN_CHAPTER_BYTES 的会被过滤掉，不会切出几百个碎块
		const dense = new TextEncoder().encode(Array.from({ length: 20 }, () => "<h3>x</h3>").join(""));
		expect(buildMobiChapters(dense, scanMobiText(dense)).length).toBe(1);
	});

	it("按需重解压与一次性解压完全一致（recordStarts/recordLengths 不变量）", () => {
		const text = `<html><body>${Array.from({ length: 30 }, (_, i) => `<p>rec${i}-${"正".repeat(120)}</p>`).join("")}</body></html>`;
		const sample = buildSyntheticMobi(text, { recordSize: 256 }); // 强制跨多条记录
		const structure = parseMobiStructure(sample.bytes);
		expect(structure.textRecordCount).toBeGreaterThan(3);
		const source = new MobiContentSource(structure, "t");
		const rebuilt = source
			.buildChapterDoc(0)
			.body.replace(/<[^>]+>/g, "")
			.replace(/\s+/g, "");
		expect(rebuilt).toContain("rec0");
		expect(rebuilt).toContain("rec29");
		// 每条记录长度之和 >= 正文字节数（字面量编码允许 ≤7 字节/条的溢出）
		const sum = structure.recordLengths.reduce((a, b) => a + b, 0);
		expect(sum).toBeGreaterThanOrEqual(structure.textLength);
		expect(sum).toBeLessThanOrEqual(structure.textLength + 7 * structure.textRecordCount);
		// 索引版与旧签名完全一致
		const spec = {
			compression: structure.compression,
			textLength: structure.textLength,
			textRecordCount: structure.textRecordCount,
			recordSize: structure.recordSize,
		};
		const indexed = readTextRecordsIndexed(sample.bytes, structure.recordOffset, spec);
		const legacy = readTextRecords(sample.bytes, structure.recordOffset, spec);
		expect(indexed.text.length).toBe(structure.textLength);
		expect(Array.from(legacy)).toEqual(Array.from(indexed.text));
	});

	it("整本构建 vs 分块构建：正文与可见文本完全一致（分块不漏内容）", async () => {
		const chapters = Array.from({ length: 12 }, (_, i) => `<h1>第${i + 1}章</h1><p>token-${i}-${"正".repeat(200)}</p>`);
		const text = `<html><head><style>p{margin:0}</style></head><body>${chapters.join("<mbp:pagebreak/>")}</body></html>`;
		const sample = buildSyntheticMobi(text, { recordSize: 700 }); // 每块跨多条记录
		const fullHtml = extractMobiContent(sample.bytes)?.html ?? "";
		const source = await openMobiSource(sample.buffer);
		expect(source.chapterCount).toBe(12);
		let chunked = "";
		for (let i = 0; i < source.chapterCount; i++) chunked += await source.buildChapterChunk(i);
		for (let i = 0; i < 12; i++) {
			expect((fullHtml.match(new RegExp(`token-${i}-`, "g")) ?? []).length).toBe(1);
			expect((chunked.match(new RegExp(`token-${i}-`, "g")) ?? []).length).toBe(1);
		}
		const bodyOf = (s: string): string => /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(s)?.[1] ?? s;
		// 可见文本 = 去掉 <style> 块与标签后的正文（首屏/追加片段里的 <style> 属于样式，不是正文）
		const visible = (s: string): string =>
			bodyOf(s)
				.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
				.replace(/<[^>]+>/g, "")
				.replace(/\s+/g, "");
		expect(visible(chunked)).toBe(visible(fullHtml));
	});
});

// ---------- 2. 追加与锚点 ----------

describe("懒加载补块：顺序、锚点稳定、进度单调", () => {
	async function pagebreakSource(count = 8) {
		const chapters = Array.from(
			{ length: count },
			(_, i) => `<h1>第${i + 1}章</h1><p>${`c${i}-`.repeat(30)}${"正".repeat(200)}</p>`
		);
		const text = `<html><head><style>p{margin:0 0 .8em}</style></head><body>${chapters.join("<mbp:pagebreak/>")}</body></html>`;
		const sample = buildSyntheticMobi(text, { recordSize: 512 });
		return openMobiSource(sample.buffer);
	}

	it("首屏只含前 N 块，其余按序追加，锚点唯一且严格递增", async () => {
		const source = await pagebreakSource(8);
		expect(source.chapterCount).toBe(8);
		const initial = await source.buildInitialHtml(DEFAULT_MOBI_INITIAL_CHAPTERS);
		expect(initial).toContain(`id="${MOBI_ANCHOR_PREFIX}0"`);
		expect(initial).toContain(`id="${MOBI_ANCHOR_PREFIX}1"`);
		expect(initial).not.toContain(`id="${MOBI_ANCHOR_PREFIX}2"`);

		const appended: Array<{ html: string; from: number }> = [];
		const loader = new EpubLazyLoader(source, {
			initialChapters: DEFAULT_MOBI_INITIAL_CHAPTERS,
			batchSize: 2,
			preloadBatchSize: 2,
			sliceBudgetMs: 0,
			schedule: (task) => task(),
			append: (html, from) => appended.push({ html, from }),
		});
		loader.start();
		await loader.ensureChaptersThrough(7);
		expect(loader.loadedChapters).toBe(8);
		expect(appended.map((a) => a.from)).toEqual([2, 4, 6]);

		// 每块锚点全文档唯一，且顺序严格递增
		const all = [initial, ...appended.map((a) => a.html)].join("\n");
		const anchors = (all.match(new RegExp(`id="${MOBI_ANCHOR_PREFIX}(\\d+)"`, "g")) ?? []).map((s) =>
			parseInt(s.replace(/\D+/g, ""), 10)
		);
		expect(anchors).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(new Set(anchors).size).toBe(anchors.length);
		// 已追加的块可重复构建且锚点/正文稳定（追加不会改动已有锚点）
		const rebuilt0 = await source.buildChapterChunk(0);
		expect(rebuilt0).toContain(`id="${MOBI_ANCHOR_PREFIX}0"`);
		expect(rebuilt0).toContain("c0-");
		// 正文内容不重不漏
		for (let i = 0; i < 8; i++) {
			expect((all.match(new RegExp(`c${i}-`, "g")) ?? []).length).toBe(30);
		}
	});

	it("进度：按内容量加权，补块过程单调不回退；权重函数抛错/为空时安全退化", async () => {
		const source = await pagebreakSource(10);
		const loader = new EpubLazyLoader(source, {
			initialChapters: 2,
			batchSize: 1,
			sliceBudgetMs: 0,
			schedule: (task) => task(),
			append: () => undefined,
		});
		const fractions = [loader.loadedFraction];
		for (let i = 2; i < source.chapterCount; i++) {
			await loader.ensureChaptersThrough(i);
			fractions.push(loader.loadedFraction);
		}
		// 补块过程中"已加载占比"单调不回退，加载完后恒为 1
		for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
		expect(loader.loadedFraction).toBeCloseTo(1, 9);

		// 进度换算不变量：有界、单调、不出 NaN、不出界
		// （具体口径由 EpubLazyLoader 定义，MOBI 侧只依赖"单调 + 有界 + 跳转前补块"）
		const ps = [0, 0.1, 0.42, 0.8, 1];
		const docs = ps.map((p) => loader.loadedDocPercent(p));
		const books = ps.map((p) => loader.wholeBookPercent(p));
		for (const v of [...docs, ...books]) {
			expect(Number.isFinite(v)).toBe(true);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
		for (let i = 1; i < docs.length; i++) {
			expect(docs[i]).toBeGreaterThanOrEqual(docs[i - 1]);
			expect(books[i]).toBeGreaterThanOrEqual(books[i - 1]);
		}
		// 跳到"已加载前缀之外的远端"时文档进度钳到 1（调用方会先补块）
		const partial = new EpubLazyLoader(source, { initialChapters: 5, append: () => undefined });
		expect(partial.loadedDocPercent(1)).toBeCloseTo(1, 6);

		// 进度恢复用的"百分比 -> 块索引"单调（installLazyJumpHook/restoreLazyProgress 依赖它）
		const idxs = ps.map((p) => chapterIndexForPercent(p, source.chapterCount));
		for (let i = 1; i < idxs.length; i++) expect(idxs[i]).toBeGreaterThanOrEqual(idxs[i - 1]);
		expect(idxs[idxs.length - 1]).toBe(source.chapterCount - 1);

		// 权重函数抛异常/返回空 -> 退回按块数，不抛错、不出 NaN
		const broken: ChapterSource = {
			chapterCount: 4,
			buildChapterChunk: async () => "<p>x</p>",
			chapterWeights: () => {
				throw new Error("boom");
			},
		};
		const brokenLoader = new EpubLazyLoader(broken, { initialChapters: 2, schedule: (t) => t(), append: () => undefined });
		expect(brokenLoader.loadedFraction).toBeCloseTo(0.5, 9);
		expect(Number.isFinite(brokenLoader.wholeBookPercent(0.5))).toBe(true);
		const emptyLoader = new EpubLazyLoader(
			{ chapterCount: 3, buildChapterChunk: async () => "<p>x</p>", chapterWeights: () => [] },
			{ initialChapters: 1, schedule: (t) => t(), append: () => undefined }
		);
		expect(emptyLoader.loadedFraction).toBeCloseTo(1 / 3, 9);
	});

	it("chapterWeights 长度 = 块数、全为正；块锚点/标题锚点/filepos 锚点都能先补块", async () => {
		const source = await pagebreakSource(6);
		const weights = source.chapterWeights();
		expect(weights.length).toBe(6);
		expect(weights.every((w) => w > 0)).toBe(true);
		expect(source.chapterIndexForAnchor(`#${MOBI_ANCHOR_PREFIX}3`)).toBe(3);
		expect(source.chapterIndexForAnchor(`#${MOBI_ANCHOR_PREFIX}999`)).toBe(5);
		expect(source.chapterIndexForAnchor("5000")).toBeNull();
		expect(source.chapterIndexForAnchor("#nyareader-fp-123")).toBe(0);
	});
});

// ---------- 3. 图片三态 ----------

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8, 9, 10]);

function imageText(): string {
	return (
		`<html><body>` +
		`<img recindex="00001" alt="a"/>` +
		`<img src="kindle:embed:0002" srcset="kindle:embed:0002 1x" alt="b"/>` +
		`<img src="kindle:flow:0001" alt="c"/>` +
		`<img src="images/local.png" alt="d"/>` +
		`<img src="https://example.com/x.png" alt="e"/>` +
		`<img alt="no-src"/>` +
		`<p>${"正".repeat(300)}</p>` +
		`<svg><image xlink:href="kindle:embed:0001"/></svg>` +
		`</body></html>`
	);
}

describe("内嵌图片：登记 / blob 回填 / 可见占位 三态", () => {
	it.each([true, false])("recindex 与 kindle:embed 都映射到图片记录（写 firstImageIndex=%s）", async (write) => {
		const sample = buildSyntheticMobi(imageText(), { images: [PNG, JPEG], writeFirstImageIndex: write });
		const source = await openMobiSource(sample.buffer);
		const html = await source.buildChapterChunk(0);

		// 三态 1：可解析 -> 登记记录号
		expect(html).toContain(`${MOBI_ASSET_ATTR}="mobi-rec-${sample.firstImageRecord}"`);
		expect(html).toContain(`${MOBI_ASSET_ATTR}="mobi-rec-${sample.firstImageRecord + 1}"`);
		// 三态 2：不可解析（flow / 相对路径）-> 仍是登记态，由引擎给可见占位
		expect(html).toContain(`${MOBI_ASSET_ATTR}="mobi-missing:kindle:flow:0001"`);
		expect(html).toContain(`${MOBI_ASSET_ATTR}="mobi-missing:images/local.png"`);
		// 三态 3：外链与无 src 保持原样
		expect(html).toContain(`src="https://example.com/x.png"`);
		expect(html).toContain(`<img alt="no-src"/>`);
		// 原始引用保留在 data-nyar-src；src/srcset 被移除；绝不出现 src=""
		expect(html).toContain(`${MOBI_ASSET_FALLBACK_ATTR}="kindle:embed:0002"`);
		expect(html).toContain(`${MOBI_ASSET_FALLBACK_ATTR}="kindle:flow:0001"`);
		expect(html).toContain(`${MOBI_ASSET_FALLBACK_ATTR}="recindex:00001"`);
		expect(html).not.toMatch(/\ssrc\s*=\s*["']?kindle:/i);
		expect(html).not.toContain('src=""');
		expect(html).not.toMatch(/<img[^>]*\ssrcset=/i);
		// 占位三态由 source 侧完全决定：有 data-nyar-asset、无 src、保留 alt
		// -> 引擎 resolvePendingAssets 解析返回 null 时加 nyareader-img-missing
		//    （引擎样式：display:inline-block + min-width:96px + min-height:72px + 虚线边框，alt 文本照常显示）
		const missingTag = /<img[^>]*data-nyar-asset="mobi-missing:kindle:flow:0001"[^>]*>/i.exec(html)?.[0] ?? "";
		expect(missingTag).toContain('alt="c"');
		expect(missingTag).toMatch(/data-nyar-asset=/);
		expect(missingTag).not.toMatch(/\ssrc=/i);
		// 单图 <svg> 包装（KF8/AZW3 封面页、漫画页）已改写成 <img data-nyar-asset>：
		// 引擎的资源回填只认 <img>，留在 <image xlink:href> 里在 srcdoc 下必然解析失败 -> 空白页
		expect(html).not.toMatch(/<image\b/i);
		expect(html).toMatch(new RegExp(`<img[^>]*${MOBI_ASSET_ATTR}="mobi-rec-\\d+"`));
	});

	it("readAsset/resolveAssetUrl：记录 -> MIME/blob，同一资源只创建一个 URL，缺失返回 null", async () => {
		const sample = buildSyntheticMobi(imageText(), { images: [PNG, JPEG], writeFirstImageIndex: true });
		const structure = parseMobiStructure(sample.bytes);
		const source = new MobiContentSource(structure, "t");
		const firstKey = `mobi-rec-${sample.firstImageRecord}`;
		const png = source.readAsset(firstKey);
		expect(png?.mime).toBe("image/png");
		expect(Array.from(png?.bytes ?? []).slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
		expect(source.readAsset(`mobi-rec-${sample.firstImageRecord + 1}`)?.mime).toBe("image/jpeg");
		// 非本格式 key / 越界记录 / 非图片记录
		expect(source.readAsset("OEBPS/images/a.png")).toBeNull();
		expect(source.readAsset("mobi-rec-9999")).toBeNull();
		expect(source.readAsset("mobi-missing:kindle:flow:0001")).toBeNull();

		const canBlob = typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
		const url = await source.resolveAssetUrl(firstKey);
		if (canBlob) {
			expect(url).toMatch(/^blob:/);
			// 同一资源不重复创建 blob URL（多张图指向同一记录时复用）
			expect(await source.resolveAssetUrl(firstKey)).toBe(url);
		} else {
			expect(url).toBeNull();
		}
		// 占位 key 解析必然失败 -> 引擎加 nyareader-img-missing 可见占位
		expect(await source.resolveAssetUrl("mobi-missing:kindle:flow:0001")).toBeNull();
		// 释放后重建（与 EpubSource.releaseAssetUrls 对称）
		source.releaseAssetUrls();
		if (canBlob) expect(await source.resolveAssetUrl(firstKey)).not.toBe(url);
		// dispose 与 EPUB 的 EpubSource.dispose 对称：revoke 且清缓存
		const recreated = await source.resolveAssetUrl(firstKey);
		const spy = spyOnRevoke();
		source.dispose();
		if (spy) {
			try {
				if (canBlob) expect(spy.count()).toBeGreaterThanOrEqual(1);
			} finally {
				spy.restore();
			}
		}
		if (canBlob) expect(await source.resolveAssetUrl(firstKey)).not.toBe(recreated);
	});

	it("纯函数：图片魔数识别、base32 embed 解析、firstImageIndex 缺失时按魔数兜底", () => {
		expect(sniffImageMime(PNG)).toBe("image/png");
		expect(sniffImageMime(JPEG)).toBe("image/jpeg");
		expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe("image/gif");
		expect(sniffImageMime(new TextEncoder().encode("<svg xmlns='x'/>"))).toBe("image/svg+xml");
		expect(sniffImageMime(new TextEncoder().encode("FLISxxxx"))).toBeUndefined();
		expect(parseMobiImageRef("kindle:embed:0002")).toEqual({ kind: "record", index: 2 });
		expect(parseMobiImageRef("kindle:embed:000A")).toEqual({ kind: "record", index: 10 }); // base32
		expect(parseMobiImageRef("kindle:flow:0001")).toEqual({ kind: "unresolvable" });
		expect(parseMobiImageRef("data:image/png;base64,AAAA")).toEqual({ kind: "external" });
		expect(parseMobiImageRef("https://x/y.png")).toEqual({ kind: "external" });
		expect(parseMobiImageRef("../images/a.png")).toEqual({ kind: "unresolvable" });

		// 不写 firstImageIndex 时（MOBI 头里的偏移读不到），仍能从正文记录之后按魔数找到
		const noHeader = buildSyntheticMobi(imageText(), { images: [PNG, JPEG] });
		const structure = parseMobiStructure(noHeader.bytes);
		expect(structure.firstImageRecord).toBe(noHeader.firstImageRecord);
		expect(imageRecordForIndex(structure, 1)).toBe(noHeader.firstImageRecord);
		expect(imageRecordForIndex(structure, 2)).toBe(noHeader.firstImageRecord + 1);
		expect(imageRecordForIndex(structure, 99)).toBe(-1);

		// 没有图片记录的书：所有内嵌引用都退化为占位
		const noImages = parseMobiStructure(buildSyntheticMobi(imageText()).bytes);
		expect(noImages.firstImageRecord).toBe(-1);
		const html = registerMobiImages('<img recindex="00001" alt="a"/><img src="kindle:embed:0001"/>', noImages);
		expect(html).toContain(`${MOBI_ASSET_ATTR}="mobi-missing:`);
	});

	it("样式跨块去重：同一 CSS 只注入一次，稳定键可判定", () => {
		const css = "p{margin:0}";
		expect(stableMobiStyleKey(css)).toBe(stableMobiStyleKey(css));
		expect(stableMobiStyleKey(css)).not.toBe(stableMobiStyleKey("p{margin:1px}"));
	});
});

// ---------- 4. 目录与解析入口 ----------

describe("MobiParser：结构 -> BookModel（目录落到真锚点）", () => {
	it("标题目录 -> #nyareader-toc-N，且该锚点确实在对应块里", async () => {
		const text = `<html><body>${Array.from({ length: 4 }, (_, i) => `<h1>章${i}</h1><p>${"正".repeat(300)}</p>`).join("")}</body></html>`;
		const sample = buildSyntheticMobi(text);
		const book = await new MobiParser().parse({
			fingerprint: "fp",
			path: "lib/a.mobi",
			format: "mobi",
			buffer: sample.buffer,
		});
		expect(book.title).toBe("Lazy MOBI");
		expect(book.author).toBe("Author");
		expect(book.format).toBe("mobi");
		expect(book.estimatedChars).toBe(bytesOf(text));
		expect(book.toc.map((t) => t.label)).toEqual(["章0", "章1", "章2", "章3"]);
		expect(book.toc[0].location).toBe(`#${MOBI_TOC_ANCHOR_PREFIX}0`);

		const source = await openMobiSource(sample.buffer);
		const idx = source.chapterIndexForAnchor(book.toc[2].location);
		expect(idx).not.toBeNull();
		const chunk = await source.buildChapterChunk(idx as number);
		expect(chunk).toContain(`id="${MOBI_TOC_ANCHOR_PREFIX}2"`);
		expect(chunk).toContain("章2");
		expect(chunk).not.toContain("章3");
	});

	it("MOBI6 filepos 内联目录 -> #nyareader-fp-N，链接与锚点都在文档里", async () => {
		const linkText = (n: number): string => `<a filepos=${String(n).padStart(10, "0")}>跳转</a>`;
		const A = `<html><body><p>目录</p>`;
		const B = `<p>${"正".repeat(200)}</p>`;
		const C = `<p id="target">目标</p></body></html>`;
		const targetOffset = bytesOf(A) + bytesOf(linkText(0)) + bytesOf(B);
		const text = A + linkText(targetOffset) + B + C;
		const bytes = new TextEncoder().encode(text);
		expect(bytes[targetOffset]).toBe(0x3c); // 目标确实落在标签起始处

		const sample = buildSyntheticMobi(text);
		const structure = parseMobiStructure(sample.bytes);
		expect(structure.fileposTargets).toContain(targetOffset);
		expect(structure.anchorLinks[0]).toEqual({ label: "跳转", target: targetOffset });

		const book = await new MobiParser().parse({ fingerprint: "f", path: "a.azw3", format: "azw3", buffer: sample.buffer });
		expect(book.format).toBe("azw3");
		expect(book.toc[0].location).toBe(`#${fileposAnchorId(targetOffset)}`);

		const source = await openMobiSource(sample.buffer);
		const chapter = source.chapterIndexForAnchor(book.toc[0].location) as number;
		expect(chapter).toBe(0);
		const chunk = await source.buildChapterChunk(chapter);
		expect(chunk).toContain(`href="#${fileposAnchorId(targetOffset)}"`);
		expect(chunk).toContain(`id="${fileposAnchorId(targetOffset)}"`);
	});

	it("加密文件仍抛可读错误（既有错误语义不变）", () => {
		const sample = buildSyntheticMobi("<html><body><p>x</p></body></html>");
		const record0 = readOffset(sample.bytes, 0);
		sample.bytes[record0 + 13] = 1; // encryptionType = 1
		expect(() => extractMobiContent(sample.bytes)).toThrowError(/加密/);
	});

	it("结构解析结果按 buffer 身份缓存，释放后重新解析", async () => {
		const sample = buildSyntheticMobi(imageText());
		const first = await loadMobiStructure(sample.buffer);
		const second = await loadMobiStructure(sample.buffer);
		expect(second).toBe(first); // 解析期与渲染期共用同一次解压 + 扫描
		expect(first.chapters.length).toBe(second.chapters.length);
		releaseMobiStructure(sample.buffer);
		const third = await loadMobiStructure(sample.buffer);
		expect(third).not.toBe(first);
	});
});

// ---------- 5. 性能：整本构建 vs 首屏只建前 N 块 ----------

interface MobiPerf {
	fileBytes: number;
	textBytes: number;
	/** 旧路径：一次性整本构建（旧 parseMobiHtml 的行为） */
	oldMs: number;
	oldHtmlBytes: number;
	/** 新路径：结构解析（解压 + 单趟扫描，可被解析期缓存复用） */
	structureMs: number;
	/** 新路径：首屏只建前 N 块 */
	firstMs: number;
	firstHtmlBytes: number;
	/** 对照：同一数据源上的全量构建 */
	fullMs: number;
	fullHtmlBytes: number;
	/** 缓存命中（第二次打开同一 buffer） */
	cachedStructureMs: number;
	/** 旧打开链路：解析期整本一次 + 挂载期再整本一次（旧 parseMobiHtml） */
	oldOpenMs: number;
	/** 新打开链路（同一本书再次打开，结构缓存命中）：结构 0ms + 首屏 N 块 */
	warmOpenMs: number;
	chapters: number;
}

async function measureMobi(chapters: number, bodyChars: number): Promise<MobiPerf> {
	const parts = Array.from({ length: chapters }, (_, i) => `<h1>第${i + 1}章</h1><p>${"正".repeat(bodyChars)}</p>`);
	const text = `<html><head><style>p{margin:0 0 .8em 0}</style></head><body>${parts.join("<mbp:pagebreak/>")}</body></html>`;
	const sample = buildSyntheticMobi(text, { recordSize: 4096 });
	const t0 = performance.now();
	const oldHtml = extractMobiContent(sample.bytes)?.html ?? "";
	const t1 = performance.now();
	const source = await openMobiSource(sample.buffer);
	const t2 = performance.now();
	const firstHtml = await source.buildInitialHtml(DEFAULT_MOBI_INITIAL_CHAPTERS);
	const t3 = performance.now();
	const fullHtml = source.buildFullHtml();
	const t4 = performance.now();
	const t5 = performance.now();
	await loadMobiStructure(sample.buffer);
	const t6 = performance.now();
	// 旧打开链路：解析期整本一次 + 挂载期再整本一次
	extractMobiContent(sample.bytes);
	extractMobiContent(sample.bytes);
	const t7 = performance.now();
	// 新打开链路（再次打开同一本）：结构缓存命中 + 首屏前 N 块
	await openMobiSource(sample.buffer);
	await source.buildInitialHtml(DEFAULT_MOBI_INITIAL_CHAPTERS);
	const t8 = performance.now();
	return {
		fileBytes: sample.bytes.length,
		textBytes: bytesOf(text),
		oldMs: t1 - t0,
		oldHtmlBytes: oldHtml.length,
		structureMs: t2 - t1,
		firstMs: t3 - t2,
		firstHtmlBytes: firstHtml.length,
		fullMs: t4 - t3,
		fullHtmlBytes: fullHtml.length,
		cachedStructureMs: t6 - t5,
		oldOpenMs: t7 - t6,
		warmOpenMs: t8 - t7,
		chapters: source.chapterCount,
	};
}

describe("性能：首屏只建前 N 块 vs 整本构建", () => {
	it("600 章合成 MOBI：首屏 HTML 与耗时都远小于整本", async () => {
		const r = await measureMobi(600, 900);
		// eslint-disable-next-line no-console
		console.log(
			`[mobi-perf] ${r.chapters} 块 / 文件 ${(r.fileBytes / 1024 / 1024).toFixed(2)}MB / 正文 ${(r.textBytes / 1024 / 1024).toFixed(2)}MB：\n` +
				`  旧（整本构建）      ${r.oldMs.toFixed(1)}ms，HTML ${(r.oldHtmlBytes / 1024 / 1024).toFixed(2)}MB\n` +
				`  新（结构解析）      ${r.structureMs.toFixed(1)}ms（缓存命中 ${r.cachedStructureMs.toFixed(2)}ms）\n` +
				`  新（首屏前 2 块）   ${r.firstMs.toFixed(1)}ms，HTML ${(r.firstHtmlBytes / 1024).toFixed(0)}KB\n` +
				`  对照（全量构建）    ${r.fullMs.toFixed(1)}ms，HTML ${(r.fullHtmlBytes / 1024 / 1024).toFixed(2)}MB\n` +
				`  旧打开链路（解析+挂载各整本一次） ${r.oldOpenMs.toFixed(1)}ms，首屏 iframe 解析 ${(r.oldHtmlBytes / 1024 / 1024).toFixed(2)}MB HTML\n` +
				`  新打开链路（首次）  ${(r.structureMs + r.firstMs).toFixed(1)}ms，首屏 iframe 解析 ${(r.firstHtmlBytes / 1024).toFixed(0)}KB HTML\n` +
				`  新打开链路（再次打开，结构缓存命中） ${r.warmOpenMs.toFixed(1)}ms\n` +
				`  首屏 HTML 体积比整本小 ${(r.fullHtmlBytes / Math.max(1, r.firstHtmlBytes)).toFixed(0)}x；构建耗时比 ${(r.fullMs / Math.max(0.1, r.firstMs)).toFixed(0)}x`
		);
		expect(r.chapters).toBe(600);
		// 首屏 HTML 远小于整本（iframe 解析成本的主因）
		expect(r.fullHtmlBytes).toBeGreaterThan(r.firstHtmlBytes * 20);
		// 首屏构建远快于整本构建
		expect(r.fullMs).toBeGreaterThan(r.firstMs * 5);
		// 旧路径（整本构建）比新路径首屏慢
		expect(r.oldMs).toBeGreaterThan(r.firstMs);
		// 结构缓存命中几乎是免费的
		expect(r.cachedStructureMs).toBeLessThan(r.structureMs);
		// 旧打开链路（两遍整本）比新打开链路（缓存命中 + 首屏）慢得多
		expect(r.oldOpenMs).toBeGreaterThan(r.warmOpenMs * 20);
		expect(r.oldHtmlBytes).toBeGreaterThan(0);
	}, 300_000);
});
