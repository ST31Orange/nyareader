/**
 * 书架封面服务：从电子书提取封面图片并按指纹缓存到插件目录。
 *
 * - EPUB：读 container.xml -> content.opf，按候选链定位封面图片文件：
 *   ① `<meta name="cover" content=ID>`；② `properties="cover-image"`；
 *   ③ `<guide><reference type="cover" href=…>`（若指向 XHTML 再取该页首图）；
 *   ④ manifest 里第一张 `image/*`；⑤ spine 第一页文档里的首图。
 *   每个候选先看 zip 条目**未压缩字节数**，>8MB 直接跳过并记录原因（不解压、不占内存）。
 * - MOBI/AZW3：EXTH 201（封面记录号）→ EXTH 203（fake cover 偏移）→ 正文记录之后第一张图片记录。
 * - PDF/TXT 无内嵌封面，返回 null（书架保留占位）。
 *
 * 诊断（"封面渲染失败"不再静默）：提取失败一律带 `reason` + `attempts`
 * （每个候选的 href/字节数/失败原因），分类为 没有封面声明 / 候选缺失 / 不是图片 /
 * 图片过大（>8MB，跳过）/ 解压解码失败 / 不是 zip / 读取失败 / 结构损坏。
 * 默认走 console.debug，也可由调用方注入 onDiagnostic 收集。
 *
 * 缓存：写入 <插件目录>/covers/<指纹>.cover，指纹 = 内容 sha256，重命名/移动不影响；
 * 书架渲染时对已缓存的封面只需读一个小文件，不需要再整本读文件解析。
 * 缓存读取会**校验魔数**：损坏/空的缓存会被丢弃并重新提取（否则 `<img>` 拿到的 blob
 * 无法解码，表现同样是"封面渲染失败"）；旧版本的 `<插件目录>/covers<指纹>.cover`
 * （少一个斜杠）也兼容读取并自动迁移到新路径。
 *
 * 对象 URL 生命周期：见 clear() —— 当前代延迟一代释放，避免"await 期间卡片拿到已 revoke
 * 的 URL"（Lead 定位的渲染失败原因之一）。
 */
import type { TFile } from "obsidian";
import type NyaReaderPlugin from "../../main";
import { findOpfPath } from "./formats/epub/EpubDocument";
import { sha256Hex } from "../../utils/hash";
import JSZip from "jszip";

export interface CoverImage {
	bytes: Uint8Array;
	mime: string;
}

/** 单张封面图片的字节上限：超过就跳过（不解压），并记录 `too-large`。 */
export const MAX_COVER_BYTES = 8 * 1024 * 1024;

/** 封面候选来源（诊断用）。 */
export type CoverSource =
	| "meta-cover"
	| "cover-image-property"
	| "guide-reference"
	| "first-manifest-image"
	| "first-spine-image"
	| "mobi-exth-201"
	| "mobi-exth-203"
	| "mobi-first-image-record";

/** 封面提取失败原因分类（不再一律 null）。 */
export type CoverFailureReason =
	| "unsupported-format"
	| "read-failed"
	| "not-zip"
	| "no-cover-declared"
	| "candidate-missing"
	| "not-image"
	| "too-large"
	| "decode-failed"
	| "broken-mobi"
	| "empty";

/** 单个候选的诊断记录。 */
export interface CoverAttempt {
	source: CoverSource;
	href: string;
	bytes?: number;
	ok: boolean;
	reason?: CoverFailureReason;
}

/** 封面提取结果（成功时 image 非空、reason 为 null）。 */
export interface CoverExtraction {
	image: CoverImage | null;
	reason: CoverFailureReason | null;
	detail?: string;
	attempts: CoverAttempt[];
}

/** 服务层诊断事件（缓存损坏 / 提取失败 / 图片过大）。 */
export interface CoverDiagnostic {
	path: string;
	fingerprint?: string;
	reason: CoverFailureReason | "cache-invalid";
	detail?: string;
}

export class BookCoverService {
	/** 已创建的 object URL，按缓存路径去重（同一本书复用同一个 URL）。 */
	private urlCache = new Map<string, string>();
	/**
	 * 上一代 URL（延迟释放）。
	 *
	 * 为什么不能立即 revoke：`getCoverUrl()` 是异步的，书架卡片在 await 期间会把
	 * 拿到的 URL 写进 `<img src>`；若此时视图刚好关闭（`clear()`）就 revoke，
	 * 浏览器会加载失败 —— 表现就是"封面偶尔渲染失败"。
	 * 折中：`clear()` 只清空当前映射（后续请求重建 URL），把实际 revoke 推迟到
	 * **下一次** clear，这样最多残留一代 URL，内存可控（一个 vault 的封面通常几 MB）。
	 */
	private pendingRevoke: string[] = [];
	/** 同一本书并发提取只做一次（书架一屏多卡片同书去重）。 */
	private inflight = new Map<string, Promise<string | null>>();

	constructor(
		private plugin: NyaReaderPlugin,
		/** 诊断输出口（默认 console.debug；测试可注入收集）。 */
		private onDiagnostic: (d: CoverDiagnostic) => void = defaultDiagnostic
	) {}

	/** 封面缓存目录（插件目录下的 covers/）。 */
	private coverDir(): string {
		const dir = this.plugin.manifest.dir ? `${this.plugin.manifest.dir}/` : "";
		return `${dir}covers`.replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
	}

	/** 当前缓存路径：`<插件目录>/covers/<指纹>.cover`（目录与文件名之间必须有斜杠）。 */
	private cachePath(fp: string): string {
		return `${this.coverDir()}/${fp}.cover`;
	}

	/**
	 * 旧版本写出的路径：`<插件目录>/covers<指纹>.cover`。
	 *
	 * 根因：旧 `cachePath()` 是 `${coverDir()}${fp}.cover`，而 `coverDir()` 去掉了结尾斜杠，
	 * 于是封面文件被写在**插件根目录**（covers/ 目录一直是空的）。用户 vault 里可以观察到
	 * `covers9f56ae4d….cover` 这类文件。这里保留一次读取做无损迁移，不再往旧路径写。
	 */
	private legacyCachePath(fp: string): string {
		const dir = this.plugin.manifest.dir ? `${this.plugin.manifest.dir}/` : "";
		return `${dir}covers${fp}.cover`.replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
	}

	/** 取封面可显示 URL；无封面返回 null。knownFingerprint 来自书架索引（省一次哈希）。 */
	async getCoverUrl(file: TFile, knownFingerprint?: string): Promise<string | null> {
		if (knownFingerprint) {
			const cached = await this.readCached(knownFingerprint);
			if (cached) return this.urlFor(knownFingerprint, cached);
		}
		const key = file.path;
		let promise = this.inflight.get(key);
		if (!promise) {
			promise = this.doExtract(file, knownFingerprint);
			this.inflight.set(key, promise);
		}
		try {
			return await promise;
		} finally {
			this.inflight.delete(key);
		}
	}

	private async doExtract(file: TFile, knownFingerprint?: string): Promise<string | null> {
		let buffer: ArrayBuffer;
		try {
			buffer = await this.plugin.app.vault.readBinary(file);
		} catch (e) {
			this.report({ path: file.path, fingerprint: knownFingerprint, reason: "read-failed", detail: message(e) });
			return null;
		}
		const fp = knownFingerprint || (await sha256Hex(buffer));
		const existing = await this.readCached(fp);
		if (existing) return this.urlFor(fp, existing);

		const result = await extractCoverForFileDetailed(file.extension, buffer);
		if (!result.image) {
			this.report({
				path: file.path,
				fingerprint: fp,
				reason: result.reason ?? "no-cover-declared",
				detail: describeAttempts(result),
			});
			return null;
		}
		try {
			const dir = this.coverDir();
			await this.plugin.app.vault.adapter.mkdir(dir).catch(() => undefined);
			await this.plugin.app.vault.adapter.writeBinary(this.cachePath(fp), result.image.bytes.slice().buffer as ArrayBuffer);
		} catch {
			/* 缓存写失败不影响本次展示 */
		}
		return this.urlFor(fp, result.image.bytes);
	}

	/**
	 * 读缓存并**校验**：只有真正的图片字节才算命中。
	 *
	 * 旧版本/中断写入可能留下空文件或非图片内容，此时 `<img src=blob:>` 会解码失败
	 * —— 用户看到的就是"封面渲染失败"。命中无效缓存时删除并返回 null（调用方会重新提取）。
	 */
	private async readCached(fp: string): Promise<Uint8Array | null> {
		const primary = await this.tryReadCacheFile(this.cachePath(fp), fp);
		if (primary) return primary;
		// 旧路径迁移：读到有效图片就写到新路径并删除旧文件
		const legacyPath = this.legacyCachePath(fp);
		const legacy = await this.tryReadCacheFile(legacyPath, fp);
		if (legacy) {
			try {
				await this.plugin.app.vault.adapter.writeBinary(this.cachePath(fp), legacy.slice().buffer as ArrayBuffer);
				await this.plugin.app.vault.adapter.remove(legacyPath);
			} catch {
				/* 迁移失败不影响本次展示（下次再试） */
			}
			return legacy;
		}
		return null;
	}

	private async tryReadCacheFile(path: string, fp: string): Promise<Uint8Array | null> {
		try {
			if (!(await this.plugin.app.vault.adapter.exists(path))) return null;
			const buf = await this.plugin.app.vault.adapter.readBinary(path);
			const bytes = new Uint8Array(buf);
			if (isImageBytes(bytes) && bytes.length > 0 && bytes.length <= MAX_COVER_BYTES) return bytes;
			this.report({ path, fingerprint: fp, reason: "cache-invalid", detail: `缓存 ${bytes.length} 字节，不是有效图片` });
			await this.plugin.app.vault.adapter.remove(path).catch(() => undefined);
			return null;
		} catch {
			return null;
		}
	}

	private urlFor(fp: string, bytes: Uint8Array): string {
		const key = this.cachePath(fp);
		const hit = this.urlCache.get(key);
		if (hit) return hit;
		const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: sniffImageMime(bytes) }));
		this.urlCache.set(key, url);
		return url;
	}

	/**
	 * 书架视图关闭/重渲染时调用：清空当前映射，并释放**上一代**URL。
	 * 当前这一代延迟到下次 clear 再释放，避免"await 期间的卡片拿到已 revoke 的 URL"。
	 */
	clear(): void {
		for (const url of this.pendingRevoke) {
			try {
				URL.revokeObjectURL(url);
			} catch {
				/* 已释放/环境不支持：忽略 */
			}
		}
		this.pendingRevoke = Array.from(this.urlCache.values());
		this.urlCache.clear();
	}

	private report(d: CoverDiagnostic): void {
		try {
			this.onDiagnostic(d);
		} catch {
			/* 诊断本身失败不影响封面 */
		}
	}
}

/** 默认诊断输出（用户控制台可见；不弹 Notice、不影响阅读）。 */
function defaultDiagnostic(d: CoverDiagnostic): void {
	try {
		// eslint-disable-next-line no-console
		console.debug(`[NyaReader] 封面不可用（${d.reason}）：${d.path}${d.detail ? ` — ${d.detail}` : ""}`);
	} catch {
		/* 忽略 */
	}
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** 把候选尝试记录压成一行诊断文本（便于日志里一眼看出卡在哪一步）。 */
function describeAttempts(result: CoverExtraction): string {
	if (!result.attempts.length) return result.detail ?? "无候选";
	return result.attempts
		.map((a) => `${a.source}:${a.href || "-"}${a.ok ? "=ok" : `=${a.reason ?? "fail"}${a.bytes ? `(${a.bytes}B)` : ""}`}`)
		.join("; ");
}

/** 按扩展名分派封面提取（详细版：带失败原因与候选记录）。 */
export async function extractCoverForFileDetailed(ext: string, buffer: ArrayBuffer): Promise<CoverExtraction> {
	const lower = ext.toLowerCase();
	if (lower === "epub") return extractEpubCoverDetailed(buffer);
	if (lower === "mobi" || lower === "azw3" || lower === "azw") return extractMobiCoverDetailed(new Uint8Array(buffer));
	// PDF/TXT 无内嵌封面（不是"失败"，是格式本身没有）
	return { image: null, reason: "unsupported-format", detail: `格式 ${lower} 没有内嵌封面`, attempts: [] };
}

/** 按扩展名分派封面提取（兼容旧签名：只要图片）。 */
export async function extractCoverForFile(ext: string, buffer: ArrayBuffer): Promise<CoverImage | null> {
	return (await extractCoverForFileDetailed(ext, buffer)).image;
}

// ---------- EPUB ----------

/** 从 EPUB zip 提取封面图（兼容旧签名：只要图片）。 */
export async function extractEpubCover(buffer: ArrayBuffer): Promise<CoverImage | null> {
	return (await extractEpubCoverDetailed(buffer)).image;
}

/**
 * EPUB 封面提取（详细版）。
 *
 * 候选链（按顺序，同一套过滤：存在 → 未压缩大小 ≤ 8MB → 字节是图片）：
 *   ① meta[name=cover]  ② properties=cover-image  ③ guide reference[type=cover]
 *   ④ manifest 第一张 image/*  ⑤ spine 第一页文档里的首张图
 * ③⑤ 指向的通常是 XHTML，需要再解析该页里的首图（真实书常见"封面页"写法）。
 */
export async function extractEpubCoverDetailed(buffer: ArrayBuffer): Promise<CoverExtraction> {
	const attempts: CoverAttempt[] = [];
	let zip: JSZip;
	try {
		zip = await JSZip.loadAsync(buffer);
	} catch (e) {
		return { image: null, reason: "not-zip", detail: message(e), attempts };
	}
	let opfPath: string;
	try {
		opfPath = await findOpfPath(zip);
	} catch (e) {
		return { image: null, reason: "not-zip", detail: message(e), attempts };
	}
	const opfFile = zip.file(opfPath);
	if (!opfFile) return { image: null, reason: "not-zip", detail: `缺少 ${opfPath}`, attempts };
	let xml: string;
	try {
		xml = await opfFile.async("string");
	} catch (e) {
		return { image: null, reason: "decode-failed", detail: message(e), attempts };
	}
	const opfDir = dirOf(opfPath);
	const opf = parseOpfForCover(xml);

	// 候选 ①②：显式封面声明
	for (const c of opf.coverCandidates) {
		const img = await tryZipImage(zip, attempts, c.source, resolveHref(opfDir, c.href));
		if (img) return { image: img, reason: null, attempts };
	}
	// 候选 ③：guide reference type=cover（通常指向封面页 XHTML）
	if (opf.guideCoverHref) {
		const img = await tryZipImageOrPage(zip, attempts, "guide-reference", resolveHref(opfDir, opf.guideCoverHref));
		if (img) return { image: img, reason: null, attempts };
	}
	// 候选 ④：manifest 里第一张 image/*
	if (opf.firstImageHref) {
		const img = await tryZipImage(zip, attempts, "first-manifest-image", resolveHref(opfDir, opf.firstImageHref));
		if (img) return { image: img, reason: null, attempts };
	}
	// 候选 ⑤：spine 第一页文档里的首图
	if (opf.firstSpineHref) {
		const chapterPath = resolveHref(opfDir, opf.firstSpineHref);
		const inline = await firstImageInZipDocument(zip, chapterPath);
		if (inline) {
			const img = await tryZipImage(zip, attempts, "first-spine-image", resolveHref(dirOf(chapterPath), inline));
			if (img) return { image: img, reason: null, attempts };
		} else {
			attempts.push({ source: "first-spine-image", href: chapterPath, ok: false, reason: "candidate-missing" });
		}
	}
	return { image: null, reason: dominantReason(attempts), attempts };
}

/** 取 zip 内一个图片条目（先查未压缩大小上限，避免为超大图解压）。 */
async function tryZipImage(
	zip: JSZip,
	attempts: CoverAttempt[],
	source: CoverSource,
	zipPath: string
): Promise<CoverImage | null> {
	const f = zip.file(zipPath);
	if (!f) {
		attempts.push({ source, href: zipPath, ok: false, reason: "candidate-missing" });
		return null;
	}
	const declared = zipEntrySize(f);
	if (declared !== undefined && declared > MAX_COVER_BYTES) {
		attempts.push({ source, href: zipPath, bytes: declared, ok: false, reason: "too-large" });
		return null;
	}
	let bytes: Uint8Array;
	try {
		bytes = await f.async("uint8array");
	} catch {
		attempts.push({ source, href: zipPath, ok: false, reason: "decode-failed" });
		return null;
	}
	if (bytes.length > MAX_COVER_BYTES) {
		attempts.push({ source, href: zipPath, bytes: bytes.length, ok: false, reason: "too-large" });
		return null;
	}
	if (bytes.length === 0) {
		attempts.push({ source, href: zipPath, bytes: 0, ok: false, reason: "empty" });
		return null;
	}
	if (!isImageBytes(bytes)) {
		attempts.push({ source, href: zipPath, bytes: bytes.length, ok: false, reason: "not-image" });
		return null;
	}
	attempts.push({ source, href: zipPath, bytes: bytes.length, ok: true });
	return { bytes, mime: sniffImageMime(bytes) };
}

/** 候选可能是图片本体，也可能是"封面页 XHTML"：是 XHTML 就再取该页首图。 */
async function tryZipImageOrPage(
	zip: JSZip,
	attempts: CoverAttempt[],
	source: CoverSource,
	zipPath: string
): Promise<CoverImage | null> {
	const f = zip.file(zipPath);
	if (!f) {
		attempts.push({ source, href: zipPath, ok: false, reason: "candidate-missing" });
		return null;
	}
	if (/\.(x?html?|xhtml)$/i.test(zipPath)) {
		const inline = await firstImageInZipDocument(zip, zipPath);
		if (!inline) {
			attempts.push({ source, href: zipPath, ok: false, reason: "candidate-missing" });
			return null;
		}
		return tryZipImage(zip, attempts, source, resolveHref(dirOf(zipPath), inline));
	}
	return tryZipImage(zip, attempts, source, zipPath);
}

/** 读 zip 内一个 XHTML 文档，返回其中的首张图片路径（相对该文档；找不到返回 null）。 */
async function firstImageInZipDocument(zip: JSZip, docPath: string): Promise<string | null> {
	const f = zip.file(docPath);
	if (!f) return null;
	let text: string;
	try {
		const bytes = await f.async("uint8array");
		// 只看前 256KB 就够找"首图"了：避免为一个大章节解压全文
		text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 256 * 1024)));
	} catch {
		return null;
	}
	const img = /<img\b[^>]*>/i.exec(text)?.[0];
	const src = img ? attrFromTag(img, "src") ?? firstSrcset(attrFromTag(img, "srcset")) : undefined;
	if (src) return src;
	const svgImage = /<image\b[^>]*>/i.exec(text)?.[0];
	if (!svgImage) return null;
	// attrFromTag 可能返回 undefined（属性缺失），统一收窄成 null
	return (attrFromTag(svgImage, "xlink:href") ?? attrFromTag(svgImage, "href")) ?? null;
}

/** OPF 里与封面相关的信息（regex 解析，避免为封面引入完整 XML 依赖）。 */
export interface CoverOpfInfo {
	coverCandidates: Array<{ source: CoverSource; href: string }>;
	guideCoverHref?: string;
	firstImageHref?: string;
	firstSpineHref?: string;
}

export function parseOpfForCover(xml: string): CoverOpfInfo {
	const items = new Map<string, { href: string; type?: string; properties?: string }>();
	const itemRe = /<item\b[^>]*>/gi;
	let m: RegExpExecArray | null;
	while ((m = itemRe.exec(xml)) !== null) {
		const attrs = parseAttrs(m[0]);
		if (attrs.id && attrs.href) items.set(attrs.id, { href: attrs.href, type: attrs["media-type"], properties: attrs.properties });
	}
	const coverCandidates: Array<{ source: CoverSource; href: string }> = [];
	const metaRe = /<meta\b[^>]*>/gi;
	while ((m = metaRe.exec(xml)) !== null) {
		const attrs = parseAttrs(m[0]);
		if (attrs.name === "cover" && attrs.content && items.has(attrs.content)) {
			coverCandidates.push({ source: "meta-cover", href: items.get(attrs.content)!.href });
		}
	}
	for (const item of items.values()) {
		if (/cover-image/i.test(item.properties ?? "")) coverCandidates.push({ source: "cover-image-property", href: item.href });
	}
	// guide reference[type=cover]
	let guideCoverHref: string | undefined;
	const refRe = /<reference\b[^>]*>/gi;
	while ((m = refRe.exec(xml)) !== null) {
		const attrs = parseAttrs(m[0]);
		if (/cover/i.test(attrs.type ?? "") && attrs.href) {
			guideCoverHref = attrs.href;
			break;
		}
	}
	// manifest 第一张图片
	let firstImageHref: string | undefined;
	for (const item of items.values()) {
		if (/^image\//i.test(item.type ?? "")) {
			firstImageHref = item.href;
			break;
		}
	}
	// spine 第一页
	const firstItemref = /<itemref\b[^>]*>/i.exec(xml)?.[0];
	const idref = firstItemref ? parseAttrs(firstItemref).idref : undefined;
	const firstSpineHref = idref && items.has(idref) ? items.get(idref)!.href : undefined;
	return { coverCandidates, guideCoverHref, firstImageHref, firstSpineHref };
}

/** 失败原因优先级：越"具体/越需要用户处理"的越优先。 */
function dominantReason(attempts: readonly CoverAttempt[]): CoverFailureReason {
	if (!attempts.length) return "no-cover-declared";
	const order: CoverFailureReason[] = ["too-large", "decode-failed", "not-image", "empty", "candidate-missing"];
	for (const reason of order) {
		if (attempts.some((a) => a.reason === reason)) return reason;
	}
	return "no-cover-declared";
}

/** 定位 OPF 里的封面候选 href（优先 meta[name=cover]，其次 properties=cover-image）。 */
export function findEpubCoverCandidates(xml: string): string[] {
	return parseOpfForCover(xml).coverCandidates.map((c) => c.href);
}

/** zip 条目声明的未压缩大小（JSZip 内部字段；读不到返回 undefined）。 */
function zipEntrySize(file: JSZip.JSZipObject): number | undefined {
	const size = (file as unknown as { _data?: { uncompressedSize?: number } })?._data?.uncompressedSize;
	return typeof size === "number" && size >= 0 ? size : undefined;
}

// ---------- MOBI / AZW3 ----------

const EXTH_COVER_OFFSET = 201;
const EXTH_FAKE_COVER = 203;

/** 从 MOBI/AZW3 二进制提取封面（兼容旧签名：只要图片）。 */
export function extractMobiCover(bytes: Uint8Array): CoverImage | null {
	return extractMobiCoverDetailed(bytes).image;
}

/**
 * MOBI/AZW3 封面提取（详细版）：EXTH 201（封面记录号）→ EXTH 203（fake cover 偏移）
 * → 正文记录之后的第一张图片记录；每一步都记录失败原因与候选大小。
 */
export function extractMobiCoverDetailed(bytes: Uint8Array): CoverExtraction {
	const attempts: CoverAttempt[] = [];
	try {
		if (bytes.length < 86) return { image: null, reason: "broken-mobi", detail: `文件仅 ${bytes.length} 字节`, attempts };
		const recordCount = readU16(bytes, 76);
		if (recordCount < 2) return { image: null, reason: "broken-mobi", detail: "记录表为空", attempts };
		const recordOffset = (index: number): number => (index < recordCount ? readU32(bytes, 78 + index * 8) : bytes.length);
		const record0 = recordOffset(0);
		if (record0 <= 0 || record0 + 16 > bytes.length) {
			return { image: null, reason: "broken-mobi", detail: "PalmDOC 头越界", attempts };
		}
		const textRecordCount = readU16(bytes, record0 + 8);

		// EXTH 元数据区（与正文解析共用同一定位逻辑）
		const mobiHeaderOffset = record0 + 16;
		const mobiHeaderLen = readAscii(bytes, mobiHeaderOffset, 4) === "MOBI" ? readU32(bytes, mobiHeaderOffset + 4) : 0;
		const exthOffset = mobiHeaderOffset + mobiHeaderLen;
		let coverRecord: number | undefined;
		let fakeOffset: number | undefined;
		if (readAscii(bytes, exthOffset, 4) === "EXTH" && exthOffset + 12 <= bytes.length) {
			// 与正文解析一致的 EXTH 定位：exthLen 从 EXTH 数据区起点（+12）算起
			const exthLen = readU32(bytes, exthOffset + 4);
			const exthStart = exthOffset + 12;
			const end = Math.min(exthStart + exthLen, bytes.length);
			let p = exthStart;
			while (p + 8 <= end) {
				const type = readU32(bytes, p);
				const len = readU32(bytes, p + 4);
				if (len < 8 || p + len > end) break;
				if (type === EXTH_COVER_OFFSET && len >= 12) coverRecord = readU32(bytes, p + 8);
				else if (type === EXTH_FAKE_COVER && len >= 12) fakeOffset = readU32(bytes, p + 8);
				p += len;
			}
		}

		// 1) EXTH 201：封面记录号 -> 取该记录原始字节（图片记录不压缩）
		if (typeof coverRecord === "number" && coverRecord >= 0 && coverRecord < recordCount) {
			const start = recordOffset(coverRecord);
			const end = recordOffset(coverRecord + 1);
			if (start >= 0 && start < end && start < bytes.length) {
				const rec = bytes.slice(start, Math.min(end, bytes.length));
				const hit = acceptMobiImage(attempts, "mobi-exth-201", `rec#${coverRecord}`, rec);
				if (hit) return { image: hit, reason: null, attempts };
			} else {
				attempts.push({ source: "mobi-exth-201", href: `rec#${coverRecord}`, ok: false, reason: "candidate-missing" });
			}
		} else if (typeof coverRecord === "number") {
			attempts.push({ source: "mobi-exth-201", href: `rec#${coverRecord}`, ok: false, reason: "candidate-missing" });
		}
		// 2) EXTH 203：fake cover 是文件内字节偏移处的图片，截到下一个记录边界
		if (typeof fakeOffset === "number" && fakeOffset > 0 && fakeOffset < bytes.length) {
			let boundary = bytes.length;
			for (let i = 0; i < recordCount; i++) {
				const off = recordOffset(i);
				if (off > fakeOffset) boundary = Math.min(boundary, off);
			}
			const rec = bytes.slice(fakeOffset, Math.min(boundary, fakeOffset + MAX_COVER_BYTES));
			const hit = acceptMobiImage(attempts, "mobi-exth-203", `@${fakeOffset}`, rec);
			if (hit) return { image: hit, reason: null, attempts };
		}
		// 3) 兜底：正文记录之后的第一张图片记录（很多老 MOBI 无 EXTH 封面标记）
		for (let i = Math.max(1, textRecordCount + 1); i < recordCount; i++) {
			const start = recordOffset(i);
			const end = recordOffset(i + 1);
			if (start < 0 || start >= end || start >= bytes.length) continue;
			const rec = bytes.slice(start, Math.min(end, bytes.length));
			const hit = acceptMobiImage(attempts, "mobi-first-image-record", `rec#${i}`, rec);
			if (hit) return { image: hit, reason: null, attempts };
		}
		return { image: null, reason: dominantReason(attempts), attempts };
	} catch (e) {
		return { image: null, reason: "broken-mobi", detail: message(e), attempts };
	}
}

/** MOBI 候选图片的三态判定（过大 / 空 / 非图片 / 通过）。 */
function acceptMobiImage(
	attempts: CoverAttempt[],
	source: CoverSource,
	href: string,
	bytes: Uint8Array
): CoverImage | null {
	if (bytes.length > MAX_COVER_BYTES) {
		attempts.push({ source, href, bytes: bytes.length, ok: false, reason: "too-large" });
		return null;
	}
	if (bytes.length === 0) {
		attempts.push({ source, href, bytes: 0, ok: false, reason: "empty" });
		return null;
	}
	if (!isImageBytes(bytes)) {
		attempts.push({ source, href, bytes: bytes.length, ok: false, reason: "not-image" });
		return null;
	}
	attempts.push({ source, href, bytes: bytes.length, ok: true });
	return { bytes, mime: sniffImageMime(bytes) };
}

// ---------- 工具 ----------

export function isImageBytes(b: Uint8Array): boolean {
	return (
		b.length >= 4 &&
		((b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || // JPEG
			(b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || // PNG
			(b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) || // GIF
			(b[0] === 0x42 && b[1] === 0x4d) || // BMP
			(b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46)) // WEBP (RIFF....WEBP)
	);
}

export function sniffImageMime(b: Uint8Array): string {
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
	if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
	if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "image/webp";
	return "application/octet-stream";
}

function dirOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx > 0 ? path.slice(0, idx) : "";
}

function resolveHref(dir: string, href: string): string {
	const clean = href.split("#")[0].split("?")[0];
	if (!clean) return dir;
	const parts = (dir ? dir.split("/") : []).concat(clean.split("/"));
	const out: string[] = [];
	for (const p of parts) {
		if (!p || p === ".") continue;
		if (p === "..") {
			out.pop();
			continue;
		}
		out.push(p);
	}
	return out.join("/");
}

function parseAttrs(tag: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(tag)) !== null) {
		attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
	}
	return attrs;
}

/** 从标签里取属性（大小写不敏感）。 */
function attrFromTag(tag: string, name: string): string | undefined {
	const attrs = parseAttrs(tag);
	const lower = name.toLowerCase();
	for (const [k, v] of Object.entries(attrs)) if (k.toLowerCase() === lower) return v;
	return undefined;
}

/** srcset 的第一个候选 URL。 */
function firstSrcset(srcset: string | undefined): string | undefined {
	if (!srcset) return undefined;
	const first = srcset.split(",")[0]?.trim();
	if (!first) return undefined;
	return first.split(/\s+/)[0]?.trim() || undefined;
}

function readU16(bytes: Uint8Array, offset: number): number {
	if (offset + 2 > bytes.length) return 0;
	return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32(bytes: Uint8Array, offset: number): number {
	if (offset + 4 > bytes.length) return 0;
	return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
	if (offset < 0 || offset + length > bytes.length) return "";
	let s = "";
	for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i]);
	return s;
}
