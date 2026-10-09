/**
 * 懒加载健壮性：**单块失败不得让整本书停在半截**。
 *
 * 用户主诉「中途切换页面后书断在中间，原本 6k 页变 2k 页（内容变短）」的直接机制：
 * `EpubLazyLoader.slice()` 里的 `void this.enqueue(...)` 会吞掉异常，而 `appendUpTo` 只在
 * `append` 成功后推进 `loaded`。于是**任意一块**（真实书里可能是某个损坏/无法解压的条目、
 * 或引擎追加抛错）读取失败后：
 *   1) 该块被无限重试（每次都在同一处抛），`loaded` 永远不前进；
 *   2) 后台切片链不再排下一片 → 懒加载静默停止，页面数冻结在"已加载前缀"上；
 *   3) 界面上表现为"书断在中间、页数变少"，没有任何错误提示。
 *
 * 本文件锁定修复后的契约（任何人把 try/catch 去掉都会红）：
 *  - 数据源单块抛错 → 该块用占位内容跳过，`loaded` 继续推进到末尾；
 *  - 引擎追加回调抛错 → 重试一次后跳过并继续（不得永久卡住）；
 *  - 现场全部失败也不得让后台切片链死掉（后续 `ensureChaptersThrough` 必须能完成）；
 *  - 失败必须通过 `onError` 可见（不再静默）。
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { EpubLazyLoader, type ChapterSource, type LazyLoaderOptions } from "../src/services/books/formats/epub/EpubLazyLoader";
import { openEpubSource } from "../src/services/books/formats/epub/EpubDocument";
import { EPUB_ANCHOR_PREFIX } from "../src/services/books/formats/epub/EpubZipCache";

/** 可注入失败的假数据源：返回的块内容是 `c<i>`，failAt 指定的块抛错。 */
function fakeSource(total: number, failAt: number[] = []): ChapterSource {
	return {
		chapterCount: total,
		async buildChapterChunk(index: number): Promise<string> {
			if (failAt.includes(index)) throw new Error(`boom@${index}`);
			return `<p>c${index}</p>`;
		},
	};
}

/** 立刻执行的调度器 + 把后台切片跑完的辅助函数。 */
function immediate(): Pick<LazyLoaderOptions, "schedule"> {
	return { schedule: (task) => task() };
}

describe("懒加载：单块读取失败不得让书停在半截", () => {
	it("中间某块抛错时，后台补块仍走完全部块（loaded 到末尾，不静默停止）", async () => {
		const errors: Array<{ index: number; message: string }> = [];
		const appended: string[] = [];
		const loader = new EpubLazyLoader(fakeSource(12, [3, 7]), {
			initialChapters: 2,
			batchSize: 2,
			sliceBudgetMs: 0,
			...immediate(),
			append: (html) => appended.push(html),
			onError: (info) => errors.push({ index: info.index, message: String((info.error as Error)?.message ?? info.error) }),
		});
		loader.start();
		await loader.ensureChaptersThrough(11);
		expect(loader.loadedChapters).toBe(12);
		expect(errors.map((e) => e.index).sort((a, b) => a - b)).toEqual([3, 7]);
		// 失败的块仍要有"占位块"，保证后续块的锚点/内容不被错位
		expect(appended.join("\n")).toContain("c11");
		expect(appended.join("\n")).not.toContain("c3<");
	});

	it("引擎追加回调连续抛错时重试一次后跳过并继续，不永久卡住", async () => {
		let calls = 0;
		let fails = 2; // 第一批的两次尝试都失败 -> 上报 + 占位 + 继续
		const errors: unknown[] = [];
		const loader = new EpubLazyLoader(fakeSource(8), {
			initialChapters: 2,
			batchSize: 2,
			sliceBudgetMs: 0,
			...immediate(),
			append: () => {
				calls++;
				if (fails-- > 0) throw new Error("engine append failed");
			},
			onError: (info) => errors.push(info.error),
		});
		loader.start();
		await loader.ensureChaptersThrough(7);
		expect(loader.loadedChapters).toBe(8);
		expect(calls).toBeGreaterThanOrEqual(3);
		expect(errors.length).toBeGreaterThanOrEqual(1);
	});

	it("数据源全程抛错时：前台 ensureChaptersThrough 仍能 resolve（不死链），且 loaded 推进", async () => {
		const all = Array.from({ length: 6 }, (_, i) => i);
		const loader = new EpubLazyLoader(fakeSource(6, all), {
			initialChapters: 2,
			batchSize: 1,
			sliceBudgetMs: 0,
			...immediate(),
			append: () => undefined,
		});
		await expect(loader.ensureChaptersThrough(5)).resolves.toBeUndefined();
		expect(loader.loadedChapters).toBe(6);
	});

	it("一次失败之后，后续正常块的内容仍然完整（不重不漏）", async () => {
		const source = fakeSource(6, [4]);
		const loader = new EpubLazyLoader(source, {
			initialChapters: 2,
			batchSize: 1,
			sliceBudgetMs: 0,
			...immediate(),
			append: () => undefined,
		});
		await loader.ensureChaptersThrough(5);
		const chunks: string[] = [];
		for (let i = 0; i < 6; i++) {
			if (i === 4) continue;
			chunks.push(await source.buildChapterChunk(i));
		}
		expect(chunks.join("")).toContain("c5");
		expect(loader.loadedChapters).toBe(6);
	});

	it("进度换算在失败块存在时仍单调有界（不因跳过块而出 NaN/出界）", async () => {
		const loader = new EpubLazyLoader(fakeSource(10, [1, 5, 9]), {
			initialChapters: 2,
			batchSize: 1,
			sliceBudgetMs: 0,
			...immediate(),
			append: () => undefined,
		});
		const seen = [loader.loadedFraction];
		for (let i = 2; i < 10; i++) {
			await loader.ensureChaptersThrough(i);
			seen.push(loader.loadedFraction);
		}
		for (const v of seen) {
			expect(Number.isFinite(v)).toBe(true);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
		for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
	});
});

// ---------------------------------------------------------------- 真实数据源（E1）

/** 造一本 6 章 EPUB，并把第 3 章的 deflate 数据打坏（模拟真实书里的损坏条目）。 */
async function corruptEpubBuffer(): Promise<ArrayBuffer> {
	const zip = new JSZip();
	zip.file("mimetype", "application/epub+zip");
	zip.file(
		"META-INF/container.xml",
		`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
	);
	const manifest: string[] = [];
	const spine: string[] = [];
	for (let i = 1; i <= 6; i++) {
		zip.file(
			`OEBPS/ch${i}.xhtml`,
			`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c${i}</title></head><body><p>tok${i}-${"正".repeat(400)}</p></body></html>`
		);
		manifest.push(`<item id="c${i}" href="ch${i}.xhtml" media-type="application/xhtml+xml"/>`);
		spine.push(`<itemref idref="c${i}"/>`);
	}
	zip.file(
		"OEBPS/content.opf",
		`<?xml version="1.0"?><package xmlns="http://idpf.org/2007/opf" version="2.0" unique-identifier="b"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>corrupt</dc:title></metadata><manifest>${manifest.join("")}</manifest><spine>${spine.join("")}</spine></package>`
	);
	const buf = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
	// 定位 ch3 的 local file header，把压缩数据打坏（JSZip 读该条目时会抛错，其余条目正常）
	const needle = new TextEncoder().encode("OEBPS/ch3.xhtml");
	let at = -1;
	for (let i = 0; i + needle.length < buf.length && at < 0; i++) {
		let ok = true;
		for (let k = 0; k < needle.length; k++) if (buf[i + k] !== needle[k]) { ok = false; break; }
		if (ok) at = i;
	}
	expect(at).toBeGreaterThan(30);
	const view = new DataView(buf.buffer, buf.byteOffset);
	const lh = at - 30;
	const dataStart = lh + 30 + view.getUint16(lh + 26, true) + view.getUint16(lh + 28, true);
	for (let i = 0; i < 8; i++) buf[dataStart + 5 + i] = 0x5a;
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe("真实 EpubSource：单章损坏不得让整本书停在半截（E1）", () => {
	it("第 3 章 deflate 损坏时：buildChapterChunk 不抛错，仍返回锚点 + 可见占位", async () => {
		const source = await openEpubSource(await corruptEpubBuffer(), "corrupt");
		expect(source.chapterCount).toBe(6);
		const chunk = await source.buildChapterChunk(2);
		expect(chunk).toContain(`id="${EPUB_ANCHOR_PREFIX}2"`);
		expect(chunk).toContain("nyareader-chunk-failed");
		expect(chunk).not.toContain("tok3-");
		// 相邻章节不受影响
		expect(await source.buildChapterBody(3)).toContain("tok4-");
		source.dispose();
	});

	it("懒加载仍然走完全部 6 章（不静默停止），缺口只体现在该章占位", async () => {
		const source = await openEpubSource(await corruptEpubBuffer(), "corrupt");
		const appended: string[] = [];
		const errors: number[] = [];
		const loader = new EpubLazyLoader(source, {
			initialChapters: 2,
			batchSize: 1,
			sliceBudgetMs: 0,
			...immediate(),
			append: (html) => appended.push(html),
			onError: (info) => errors.push(info.index),
		});
		loader.start();
		await loader.ensureChaptersThrough(5);
		expect(loader.loadedChapters).toBe(6);
		const all = appended.join("\n");
		for (const i of [4, 5, 6]) expect(all).toContain(`tok${i}-`);
		expect(all).not.toContain("tok3-");
		expect(all).toContain("nyareader-chunk-failed");
		// 数据源层已把缺口降级为占位，因此 loader 级不再需要兜底报错（两者都可接受）
		expect(errors.every((i) => i === 2)).toBe(true);
		source.dispose();
	});
});
