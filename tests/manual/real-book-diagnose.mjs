/**
 * 真实电子书诊断（只读，不修改用户文件）。
 *
 * 目的：在没有 Obsidian 运行时的环境里，用**真实产品代码**（esbuild 打包 src/**）
 * 跑真实书文件的打开链路，量出：
 *   - 打开各阶段耗时（read / sha256 / JSZip+OPF / 首屏 HTML / 全量 HTML）
 *   - EPUB 封面提取的失败原因分类（声明缺失 / 文件缺失 / 非图片 / 超大 / 解码异常）
 *   - MOBI/AZW3 的块数、权重、首屏/整本 HTML 体积、封面提取
 *   - 懒加载进度换算的单调性与互逆性（整书百分比 ↔ 已加载文档百分比）
 *
 * 用法：
 *   node tests/manual/real-book-diagnose.mjs                 # 用默认的用户 vault 路径（只读）
 *   node tests/manual/real-book-diagnose.mjs --full          # 额外跑全量 HTML 构建（更慢、更占内存）
 *   node tests/manual/real-book-diagnose.mjs --json out.json # 结果写文件
 *   NYAR_LIBRARY=<dir> node tests/manual/real-book-diagnose.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, basename } from "node:path";
import { createRequire } from "node:module";

const ROOT = process.cwd();
const DEFAULT_LIBRARY =
	process.env.NYAR_LIBRARY ||
	"C:\\Users\\ST31ORANGEJUICE\\OneDrive - buaa.edu.cn\\ST31___NOTES\\NyaNotes\\nyareader\\library";

const args = process.argv.slice(2);
const WANT_FULL = args.includes("--full");
const DETAIL = args.includes("--detail");
const jsonOutIdx = args.indexOf("--json");
const JSON_OUT = jsonOutIdx >= 0 ? args[jsonOutIdx + 1] : null;
const BOOK_ARGS = args.filter((a) => !a.startsWith("--") && a !== JSON_OUT);

// ---------------------------------------------------------------- 打包真实代码

async function bundleApi() {
	const esbuild = await import("esbuild");
	const entry = `
import * as epub from "./src/services/books/formats/epub/EpubDocument.ts";
import * as epubParser from "./src/services/books/formats/epub/EpubParser.ts";
import * as epubLazy from "./src/services/books/formats/epub/EpubLazyLoader.ts";
import * as mobi from "./src/services/books/formats/mobi/MobiDocument.ts";
import * as mobiParser from "./src/services/books/formats/mobi/MobiParser.ts";
import * as cover from "./src/services/books/BookCoverService.ts";
import * as parser from "./src/services/books/Parser.ts";
import * as hash from "./src/utils/hash.ts";
export const api = { epub, epubParser, epubLazy, mobi, mobiParser, cover, parser, hash };
`;
	const outdir = mkdtempSync(join(tmpdir(), "nyar-diag-"));
	const outfile = join(outdir, "api.cjs");
	await esbuild.build({
		stdin: { contents: entry, resolveDir: ROOT, loader: "ts", sourcefile: "diag-entry.ts" },
		bundle: true,
		platform: "node",
		format: "cjs",
		outfile,
		logLevel: "error",
		external: ["obsidian"],
	});
	const require = createRequire(import.meta.url);
	return require(outfile).api;
}

// ---------------------------------------------------------------- 工具

const ms = (t) => Math.round(t * 10) / 10;
const now = () => Number(process.hrtime.bigint()) / 1e6;
const mb = (n) => Math.round((n / 1024 / 1024) * 100) / 100;
const kb = (n) => Math.round(n / 1024);

function listBooks(dir, only) {
	const out = [];
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.(epub|mobi|azw3|azw)$/i.test(e.name)) out.push(p);
		}
	};
	if (!existsSync(dir)) return out;
	walk(dir);
	if (only && only.length) return only.map((f) => (existsSync(f) ? f : join(dir, f))).filter(existsSync);
	return out;
}

/** 读文件（只读）：ArrayBuffer 精确切片，模拟 vault.adapter.readBinary。 */
function readBinary(path) {
	const buf = readFileSync(path);
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// ---------------------------------------------------------------- EPUB 诊断

async function diagnoseEpub(api, path) {
	const out = { path: basename(path), ext: "epub", sizeMB: mb(statSync(path).size), stages: {} };
	out.stages.readBinaryMs = 0; // 见下方计时
	let t = now();
	const buffer = readBinary(path);
	out.stages.readBinaryMs = ms(now() - t);

	// sha256（与 ReaderController 一样走 WebCrypto；这里串行计时，便于对比"是否值得阻塞首屏"）
	t = now();
	const fp = await api.hash.sha256Hex(buffer);
	out.stages.sha256Ms = ms(now() - t);
	out.fingerprint = fp.slice(0, 12);

	// JSZip.load + container.xml/OPF（openEpubSource 内部走 loadEpubStructure 缓存）
	t = now();
	const source = await api.epub.openEpubSource(buffer, basename(path));
	out.stages.openSourceMs = ms(now() - t);
	out.chapterCount = source.chapterCount;
	out.title = source.title;

	t = now();
	const weights = source.chapterWeights();
	out.stages.weightsMs = ms(now() - t);
	out.weights = {
		length: weights.length,
		totalMB: mb(weights.reduce((a, b) => a + b, 0)),
		maxMB: mb(Math.max(...weights, 0)),
		min: Math.min(...weights, 1),
	};

	// 首屏（默认 2 章）
	t = now();
	const initial = await source.buildInitialHtml(2);
	out.stages.initialHtmlMs = ms(now() - t);
	out.initialHtmlKB = kb(initial.length);

	// 前几章明细：区分"原始 zip 字节 / 构建后正文 / 增量样式 / 内联资源引用"
	if (DETAIL) {
		out.chapterDetail = [];
		for (let i = 0; i < Math.min(5, source.chapterCount); i++) {
			const href = source.chapterHref(i);
			const f = source.structure?.zip?.file?.(href);
			const doc = await source.buildChapterDoc(i);
			out.chapterDetail.push({
				index: i,
				href,
				rawKB: f ? kb((await f.async("uint8array")).length) : null,
				bodyKB: kb(doc.body.length),
				stylesKB: kb(doc.styles.reduce((a, s) => a + s.length, 0)),
				imgRefs: (doc.body.match(/data-nyar-asset=/g) ?? []).length,
			});
		}
	}

	// 逐章构建：真实"读完前 k 章/全量"成本
	const probeChapters = Math.min(source.chapterCount, 40);
	t = now();
	let built = 0;
	for (let i = 0; i < probeChapters; i++) built += (await source.buildChapterChunk(i)).length;
	out.stages.first40ChaptersMs = ms(now() - t);
	out.first40ChaptersKB = kb(built);

	if (WANT_FULL) {
		t = now();
		let total = 0;
		for (let i = 0; i < source.chapterCount; i++) total += (await source.buildChapterChunk(i)).length;
		out.stages.fullHtmlMs = ms(now() - t);
		out.fullHtmlMB = mb(total);
	}

	// 封面
	const cov = await diagnoseEpubCover(api, buffer, path);
	out.cover = cov;
	source.dispose();
	out.assetsDisposed = true;
	return out;
}

async function diagnoseEpubCover(api, buffer, path) {
	const result = { extractMs: 0, ok: false, mime: null, bytesKB: null, reason: null, candidates: [], opf: {} };
	let t = now();
	let img = null;
	try {
		img = await api.cover.extractEpubCover(buffer);
	} catch (e) {
		result.reason = `throw:${e && e.message}`;
	}
	result.extractMs = ms(now() - t);
	if (img) {
		result.ok = true;
		result.mime = img.mime;
		result.bytesKB = kb(img.bytes.length);
		return result;
	}
	result.reason = result.reason || "null（静默失败）";

	// 手工拆开 OPF，定位失败环节
	let JSZipMod = null;
	try {
		JSZipMod = (await import("jszip")).default;
	} catch {
		return result;
	}
	const zip = await JSZipMod.loadAsync(buffer);
	let opfPath = null;
	try {
		opfPath = await api.epub.findOpfPath(zip);
	} catch (e) {
		result.opf.error = String(e && e.message);
		return result;
	}
	result.opf.path = opfPath;
	const xml = await zip.file(opfPath).async("string");
	const rawCandidates = api.cover.findEpubCoverCandidates(xml);
	result.opf.candidateCount = rawCandidates.length;

	const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";
	// 与 EpubDocument.resolveHref 等价的折叠
	const fold = (dir, href) => {
		const clean = href.split("#")[0].split("?")[0];
		const parts = (dir ? dir.split("/") : []).concat(clean.split("/"));
		const o = [];
		for (const p of parts) {
			if (!p || p === ".") continue;
			if (p === "..") {
				o.pop();
				continue;
			}
			o.push(p);
		}
		return o.join("/");
	};
	for (const href of rawCandidates) {
		const p = fold(opfDir, href);
		const f = zip.file(p);
		const entry = { href, zipPath: p, exists: !!f };
		if (f) {
			try {
				const bytes = await f.async("uint8array");
				entry.bytesKB = kb(bytes.length);
				entry.isImage = api.cover.isImageBytes(bytes);
				entry.head = Array.from(bytes.slice(0, 4)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
			} catch (e) {
				entry.readError = String(e && e.message);
			}
		}
		result.candidates.push(entry);
	}
	// OPF 里声明的封面相关标记 + manifest 里的第一个图片
	result.opf.hasMetaCover = /<meta\b[^>]*name=["']cover["']/i.test(xml);
	const items = [];
	const itemRe = /<item\b[^>]*>/gi;
	let m;
	while ((m = itemRe.exec(xml)) !== null) {
		const attrs = {};
		const re = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
		let a;
		while ((a = re.exec(m[0])) !== null) attrs[a[1]] = a[2] ?? a[3] ?? a[4] ?? "";
		items.push(attrs);
	}
	result.opf.itemCount = items.length;
	result.opf.images = items
		.filter((i) => /^image\//i.test(i["media-type"] || ""))
		.slice(0, 12)
		.map((i) => ({ id: i.id, href: i.href, type: i["media-type"], props: i.properties || "" }));
	result.opf.coverPropsItems = items.filter((i) => /cover-image/i.test(i.properties || "")).map((i) => i.href);
	// 首张 manifest 图片的实际字节大小（兜底策略的可行性）
	const firstImage = result.opf.images[0];
	if (firstImage) {
		const f = zip.file(fold(opfDir, firstImage.href));
		if (f) {
			const b = await f.async("uint8array");
			result.firstManifestImage = { href: firstImage.href, bytesKB: kb(b.length), isImage: api.cover.isImageBytes(b) };
		} else {
			result.firstManifestImage = { href: firstImage.href, exists: false };
		}
	}
	return result;
}

// ---------------------------------------------------------------- MOBI/AZW3 诊断

async function diagnoseMobi(api, path, format) {
	const out = { path: basename(path), ext: format, sizeMB: mb(statSync(path).size), stages: {} };
	let t = now();
	const buffer = readBinary(path);
	out.stages.readBinaryMs = ms(now() - t);
	const bytes = new Uint8Array(buffer);
	out.sniffed = api.parser.sniffFormat(buffer);

	t = now();
	const structure = api.mobi.parseMobiStructure(bytes);
	out.stages.structureMs = ms(now() - t);
	out.recordCount = structure.recordCount;
	out.textRecordCount = structure.textRecordCount;
	out.textMB = mb(structure.textLength);
	out.chapterCount = structure.chapters.length;
	out.headings = structure.headings.length;
	out.anchorLinks = structure.anchorLinks.length;
	out.fileposTargets = structure.fileposTargets.length;
	out.firstImageRecord = structure.firstImageRecord;
	out.compression = structure.compression;
	out.title = structure.title;
	const sizes = structure.chapters.map((c) => c.end - c.start);
	out.chapterSizes = {
		maxKB: kb(Math.max(...sizes, 0)),
		minKB: kb(Math.min(...sizes, 0)),
		overCap: sizes.filter((s) => s > api.mobi.MAX_CHAPTER_BYTES).length,
	};

	const source = new api.mobi.MobiContentSource(structure, structure.title || format);
	const weights = source.chapterWeights();
	out.weights = { length: weights.length, totalKB: kb(weights.reduce((a, b) => a + b, 0)) };

	t = now();
	const initial = await source.buildInitialHtml(api.mobi.DEFAULT_MOBI_INITIAL_CHAPTERS);
	out.stages.initialHtmlMs = ms(now() - t);
	out.initialHtmlKB = kb(initial.length);

	t = now();
	const full = source.buildFullHtml();
	out.stages.fullHtmlMs = ms(now() - t);
	out.fullHtmlMB = mb(full.length);

	// 解析器入口（目录/元数据）
	t = now();
	const book = await new api.mobiParser.MobiParser().parse({
		fingerprint: "diag",
		path,
		format,
		buffer,
	});
	out.stages.parserMs = ms(now() - t);
	out.book = { title: book.title, author: book.author, toc: book.toc.length, estimatedChars: book.estimatedChars };
	out.tocSample = book.toc.slice(0, 3).map((i) => ({ label: i.label, location: i.location }));

	// 封面
	t = now();
	const cover = api.cover.extractMobiCover(bytes);
	out.stages.coverMs = ms(now() - t);
	out.cover = cover
		? { ok: true, mime: cover.mime, bytesKB: kb(cover.bytes.length), head: Array.from(cover.bytes.slice(0, 4)).map((b) => b.toString(16).padStart(2, "0")).join(" ") }
		: { ok: false, reason: "null（静默失败）" };

	// 懒加载进度换算：单调 + 互逆（真实块权重）
	out.progress = progressProbe(api, source);
	source.dispose();
	return out;
}

/** 懒加载百分比换算的单调性与互逆性（真实权重）。 */
function progressProbe(api, source) {
	const total = source.chapterCount;
	const rows = [];
	const inverses = [];
	for (const frac of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
		const loaded = Math.max(1, Math.min(total, Math.ceil(frac * total) || 1));
		const loader = new api.epubLazy.EpubLazyLoader(source, { initialChapters: loaded, append: () => undefined });
		const docP = 0.37;
		const book = loader.wholeBookPercent(docP);
		const back = loader.loadedDocPercent(book);
		rows.push({ loaded, loadedFraction: Number(loader.loadedFraction.toFixed(6)), bookPercent: Number(book.toFixed(6)) });
		inverses.push(Math.abs(back - docP) < 1e-9);
	}
	return { rows, inverseOk: inverses.every(Boolean) };
}

// ---------------------------------------------------------------- main

async function main() {
	if (!existsSync(DEFAULT_LIBRARY)) throw new Error(`书库目录不存在：${DEFAULT_LIBRARY}`);
	const api = await bundleApi();
	const books = listBooks(DEFAULT_LIBRARY, BOOK_ARGS);
	if (!books.length) throw new Error("未找到样本书");
	const report = { library: DEFAULT_LIBRARY, fullBuild: WANT_FULL, books: [] };
	for (const p of books) {
		const ext = extname(p).toLowerCase().replace(".", "");
		try {
			if (ext === "epub") report.books.push(await diagnoseEpub(api, p));
			else report.books.push(await diagnoseMobi(api, p, ext === "azw3" || ext === "azw" ? "azw3" : "mobi"));
		} catch (e) {
			report.books.push({ path: basename(p), error: String((e && e.message) || e) });
		}
	}
	const text = JSON.stringify(report, null, 2);
	if (JSON_OUT) writeFileSync(JSON_OUT, text, "utf8");
	console.log(text);
}

main().catch((e) => {
	console.error("diagnose failed:", e && e.message);
	process.exitCode = 1;
});
