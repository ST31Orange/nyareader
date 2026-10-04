/**
 * 文件指纹工具。
 * 书索引以指纹为主键，避免因文件重命名/移动丢失进度与批注关联。
 * 默认使用 WebCrypto SHA-256；对超大文件可用快速指纹（大小+mtime）。
 */

/** 计算二进制内容 SHA-256，返回十六进制前缀（默认 16 字节）。 */
export async function sha256Hex(data: ArrayBuffer, prefixBytes = 16): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(digest);
	let hex = "";
	for (let i = 0; i < Math.min(prefixBytes, bytes.length); i++) {
		hex += bytes[i].toString(16).padStart(2, "0");
	}
	return hex;
}

export interface FastFingerprintInput {
	size: number;
	mtimeMs: number;
	/** 头尾各取若干字节，增强区分度 */
	head: Uint8Array;
	tail: Uint8Array;
}

/** 快速指纹：大小 + 修改时间 + 头尾字节；性能优先，用于缓存索引键。 */
export function fastFingerprint(input: FastFingerprintInput): string {
	let h = 2166136261; // FNV-1a 32bit
	const mix = (bytes: Uint8Array) => {
		for (const b of bytes) {
			h ^= b;
			h = Math.imul(h, 16777619);
		}
	};
	const head = input.head.subarray(0, 256);
	const tail = input.tail.subarray(0, 256);
	mix(new Uint8Array(new Uint32Array([input.size, Math.floor(input.mtimeMs)]).buffer));
	mix(head);
	mix(tail);
	return `f${(h >>> 0).toString(16).padStart(8, "0")}`;
}
