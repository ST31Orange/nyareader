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
