/**
 * 书架封面服务：从电子书提取封面图片并按指纹缓存到插件目录。
 *
 * - EPUB：读 container.xml -> content.opf，按 <meta name="cover"> / properties="cover-image"
 *   定位封面图片文件（zip 内只解压那一张，不做全书解包）。
 * - MOBI/AZW3：读 EXTH 记录 201（封面记录号）取对应 PalmDB 记录原始字节；
 *   缺失时退回 EXTH 203（fake cover 偏移）或"正文记录之后的第一张图片记录"。
 * - PDF/TXT 无内嵌封面，返回 null（书架保留占位）。
 *
 * 缓存：写入 <插件目录>/covers/<指纹>.cover，指纹 = 内容 sha256，重命名/移动不影响；
 * 书架渲染时对已缓存的封面只需读一个小文件，不需要再整本读文件解析。
 * 对象 URL 由书架视图在关闭时统一 clear() 释放。
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

export class BookCoverService {
	/** 已创建的 object URL，按缓存路径去重（同一本书复用同一个 URL）。 */
	private urlCache = new Map<string, string>();
	/** 同一本书并发提取只做一次（书架一屏多卡片同书去重）。 */
	private inflight = new Map<string, Promise<string | null>>();

	constructor(private plugin: NyaReaderPlugin) {}

	private coverDir(): string {
		const dir = this.plugin.manifest.dir ? `${this.plugin.manifest.dir}/` : "";
		return `${dir}covers/`.replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
	}

	private cachePath(fp: string): string {
		return `${this.coverDir()}${fp}.cover`;
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
		} catch {
			return null;
		}
		const fp = knownFingerprint || (await sha256Hex(buffer));
		const existing = await this.readCached(fp);
		if (existing) return this.urlFor(fp, existing);

		const img = await extractCoverForFile(file.extension, buffer);
		if (!img) return null;
		try {
			const dir = this.coverDir();
			await this.plugin.app.vault.adapter.mkdir(dir).catch(() => undefined);
			await this.plugin.app.vault.adapter.writeBinary(this.cachePath(fp), img.bytes.slice().buffer as ArrayBuffer);
		} catch {
			/* 缓存写失败不影响本次展示 */
		}
		return this.urlFor(fp, img.bytes);
	}

	private async readCached(fp: string): Promise<Uint8Array | null> {
		try {
			if (!(await this.plugin.app.vault.adapter.exists(this.cachePath(fp)))) return null;
			const buf = await this.plugin.app.vault.adapter.readBinary(this.cachePath(fp));
			return new Uint8Array(buf);
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

	/** 书架视图关闭/重渲染时释放全部对象 URL。 */
	clear(): void {
		for (const url of this.urlCache.values()) URL.revokeObjectURL(url);
		this.urlCache.clear();
	}
}

/** 按扩展名分派封面提取。 */
export async function extractCoverForFile(ext: string, buffer: ArrayBuffer): Promise<CoverImage | null> {
	const lower = ext.toLowerCase();
	if (lower === "epub") return extractEpubCover(buffer);
	if (lower === "mobi" || lower === "azw3" || lower === "azw") return extractMobiCover(new Uint8Array(buffer));
	// PDF/TXT 无内嵌封面
	return null;
}

// ---------- EPUB ----------

/** 从 EPUB zip 提取封面图（只解压候选图片文件）。 */
export async function extractEpubCover(buffer: ArrayBuffer): Promise<CoverImage | null> {
	let zip: JSZip;
	try {
		zip = await JSZip.loadAsync(buffer);
	} catch {
		return null;
	}
	let opfPath: string;
	try {
		opfPath = await findOpfPath(zip);
	} catch {
		return null;
	}
	const opfFile = zip.file(opfPath);
	if (!opfFile) return null;
	let xml: string;
	try {
		xml = await opfFile.async("string");
	} catch {
		return null;
	}
	const opfDir = dirOf(opfPath);
	for (const href of findEpubCoverCandidates(xml)) {
		const p = resolveHref(opfDir, href);
		const f = zip.file(p);
		if (!f) continue;
		try {
			const bytes = await f.async("uint8array");
			if (isImageBytes(bytes)) return { bytes, mime: sniffImageMime(bytes) };
		} catch {
			/* 试下一个候选 */
		}
	}
	return null;
}

/** 定位 OPF 里的封面候选 href（优先 meta[name=cover]，其次 properties=cover-image）。 */
export function findEpubCoverCandidates(xml: string): string[] {
	const out: string[] = [];
	const items = new Map<string, { href: string; properties?: string }>();
	const itemRe = /<item\b[^>]*>/gi;
	let m: RegExpExecArray | null;
	while ((m = itemRe.exec(xml)) !== null) {
		const attrs = parseAttrs(m[0]);
		if (attrs.id && attrs.href) items.set(attrs.id, { href: attrs.href, properties: attrs.properties });
	}
	const metaRe = /<meta\b[^>]*>/gi;
	while ((m = metaRe.exec(xml)) !== null) {
		const attrs = parseAttrs(m[0]);
		if (attrs.name === "cover" && attrs.content && items.has(attrs.content)) {
			out.push(items.get(attrs.content)!.href);
		}
	}
	for (const item of items.values()) {
		if (/cover-image/i.test(item.properties ?? "")) out.push(item.href);
	}
	return out;
}

// ---------- MOBI / AZW3 ----------

const EXTH_COVER_OFFSET = 201;
const EXTH_FAKE_COVER = 203;

/** 从 MOBI/AZW3 二进制提取封面：EXTH 201 记录号 -> EXTH 203 fake offset -> 首个非正文图片记录。 */
export function extractMobiCover(bytes: Uint8Array): CoverImage | null {
	try {
		if (bytes.length < 86) return null;
		const recordCount = readU16(bytes, 76);
		if (recordCount < 2) return null;
		const recordOffset = (index: number): number => (index < recordCount ? readU32(bytes, 78 + index * 8) : bytes.length);
		const record0 = recordOffset(0);
		if (record0 <= 0 || record0 + 16 > bytes.length) return null;
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
				if (isImageBytes(rec)) return { bytes: rec, mime: sniffImageMime(rec) };
			}
		}
		// 2) EXTH 203：fake cover 是文件内字节偏移处的图片，截到下一个记录边界
		if (typeof fakeOffset === "number" && fakeOffset > 0 && fakeOffset < bytes.length) {
			let boundary = bytes.length;
			for (let i = 0; i < recordCount; i++) {
				const off = recordOffset(i);
				if (off > fakeOffset) boundary = Math.min(boundary, off);
			}
			const rec = bytes.slice(fakeOffset, Math.min(boundary, fakeOffset + 3 * 1024 * 1024));
			if (isImageBytes(rec)) return { bytes: rec, mime: sniffImageMime(rec) };
		}
		// 3) 兜底：正文记录之后的第一张图片记录（很多老 MOBI 无 EXTH 封面标记）
		for (let i = Math.max(1, textRecordCount + 1); i < recordCount; i++) {
			const start = recordOffset(i);
			const end = recordOffset(i + 1);
			if (start < 0 || start >= end || start >= bytes.length) continue;
			const rec = bytes.slice(start, Math.min(end, bytes.length));
			if (isImageBytes(rec)) return { bytes: rec, mime: sniffImageMime(rec) };
		}
		return null;
	} catch {
		return null;
	}
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