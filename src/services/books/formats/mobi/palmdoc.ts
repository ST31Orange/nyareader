/**
 * PalmDOC LZ77 解压：MOBI/AZW3 文本记录使用的压缩算法。
 * 算法公开、实现简单（约百行），纯函数便于单测。
 *
 * 位域与转义规则以 KindleUnpack `PalmdocReader.unpack` 为参考实现：
 *  - 0x00         : 字面量 0
 *  - 0x01..0x08   : 紧随其后的 N 个字节为字面量
 *  - 0x09..0x7F   : 单字节字面量
 *  - 0x80..0xBF   : 2 字节 LZ77，distance = (v >> 3) & 0x7FF，length = (v & 7) + 3
 *  - 0xC0..0xFF   : 空格 + (c ^ 0x80) 的固定转义（**不是** LZ77）
 *
 * 历史教训：早期实现把 0x80..0xBF 的 distance 写成 `((v >> 3) & 0x7FF) + 1`，
 * 只错 1 个字节就会让整段文本错位成乱码（表现为“MOBI/AZW3 无法解析”）；
 * 同时把 0xC0..0xFF 误当成 LZ77，也会破坏正文。两处均已按参考实现修正。
 */

/** 解压一段 PalmDOC 压缩数据。maxOutput 用于按记录停止（去掉记录尾部的检索数据）。 */
export function decompressPalmDoc(data: Uint8Array, start: number, end: number, maxOutput = Infinity): Uint8Array {
	const out: number[] = [];
	let pos = start;

	while (pos < end && out.length < maxOutput) {
		const c = data[pos++];
		if (c >= 1 && c <= 8) {
			// copy next c bytes literally
			for (let i = 0; i < c; i++) {
				if (pos >= end) break;
				out.push(data[pos++]);
			}
			continue;
		}
		if (c < 0x80) {
			// literal byte（含 0x00）
			out.push(c);
			continue;
		}
		if (c >= 0xc0) {
			// 固定转义：空格 + (c ^ 0x80)
			out.push(32, c ^ 0x80);
			continue;
		}
		if (c >= 0x80 && c <= 0xbf) {
			// LZ77: distance = (v >> 3) & 0x7FF，length = (v & 7) + 3
			if (pos >= end) break;
			const c2 = data[pos++];
			const v = (c << 8) | c2;
			const dist = (v >> 3) & 0x07ff;
			const length = (v & 7) + 3;
			for (let i = 0; i < length; i++) {
				const from = out.length - dist;
				out.push(from < 0 || from >= out.length ? 32 : out[from]);
			}
			continue;
		}
	}
	return new Uint8Array(out);
}

/** 判断一段数据是否为有效的 PalmDOC 头。 */
export function isPalmDocHeader(data: Uint8Array, offset: number): boolean {
	// Compression type 字段在 PalmDOC 头偏移 0（字节 0-1），1=无压缩 2=LZ77
	if (offset + 16 > data.length) return false;
	const compression = (data[offset] << 8) | data[offset + 1];
	return compression === 1 || compression === 2;
}
