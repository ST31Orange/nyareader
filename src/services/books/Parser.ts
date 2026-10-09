/**
 * 解析服务：将原始文件二进制解析为 BookModel。
 * 各格式解析器实现统一的 Parser 接口，便于调度与单测。
 */
import type { BookFormat, BookModel } from "../../types";

export interface ParseContext {
	fingerprint: string;
	path: string;
	format: BookFormat;
	/** 原始二进制内容 */
	buffer: ArrayBuffer;
}

export interface IBookParser {
	readonly format: BookFormat;
	parse(ctx: ParseContext): Promise<BookModel>;
}

/** 依据文件扩展名推断格式。 */
export function formatFromExtension(name: string): BookFormat {
	const ext = name.toLowerCase().split(".").pop() ?? "";
	switch (ext) {
		case "epub":
			return "epub";
		case "pdf":
			return "pdf";
		case "mobi":
			return "mobi";
		case "azw3":
		case "azw":
			return "azw3";
		case "txt":
			return "txt";
		default:
			return "unknown";
	}
}

/** 依据 Buffer 魔数推断格式（mobi/azw3 为 BOOKMOBI）。 */
export function sniffFormat(buffer: ArrayBuffer): BookFormat | null {
	const bytes = new Uint8Array(buffer.slice(0, 16));
	const ascii = Array.from(bytes)
		.map((b) => String.fromCharCode(b))
		.join("");
	if (ascii.startsWith("BOOKMOBI")) return "mobi";
	if (ascii.startsWith("%PDF")) return "pdf";
	if (ascii.startsWith("PK")) return "epub";
	return null;
}

/**
 * 解析期占位指纹：廉价、确定性（仅路径 + 字节数），不需要读完整文件。
 *
 * 用途：打开书籍时"全量 SHA-256"与解析并行进行（SHA-256 走 WebCrypto 后台线程），
 * 解析器先用本占位值构造 BookModel，解析完成后立刻回填真实指纹并写索引，
 * 因此进度/批注/每书版式的主键语义不变。
 * 前缀 `pending-` 便于日志/索引里一眼区分"尚未回填"的临时键。
 */
export function provisionalFingerprint(path: string, byteLength: number): string {
	let h = 2166136261;
	const seed = `${path}:${byteLength}`;
	for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
	return `pending-${h.toString(16).padStart(8, "0")}`;
}
