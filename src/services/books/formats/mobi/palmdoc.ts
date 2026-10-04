/**
 * PalmDOC LZ77 解压：MOBI/AZW3 文本记录使用的压缩算法。
 * 算法公开、实现简单（约百行），纯函数便于单测。
 */
const BACKWARD = 1;
const FORWARD = 0;

/** 解压一段 PalmDOC 压缩数据。 */
export function decompressPalmDoc(data: Uint8Array, start: number, end: number): Uint8Array {
	const out: number[] = [];
	let pos = start;
	let blockPos = 0;
	let lastLen = 0;
	const space: number[] = new Array(2048).fill(32);

	while (pos < end) {
		const c = data[pos++];
		if (c === 0) {
			// literal 0 byte
			out.push(0);
			space[blockPos] = 0;
			blockPos = (blockPos + 1) & 2047;
			continue;
		}
		if (c >= 1 && c <= 8) {
			// copy next c bytes literally
			for (let i = 0; i < c; i++) {
				if (pos >= end) break;
				const b = data[pos++];
				out.push(b);
				space[blockPos] = b;
				blockPos = (blockPos + 1) & 2047;
			}
			lastLen = c;
			continue;
		}
		if (c <= 0x7f) {
			// literal byte
			out.push(c);
			space[blockPos] = c;
			blockPos = (blockPos + 1) & 2047;
			lastLen = 0;
			continue;
		}
		if (c >= 0x80 && c <= 0xbf) {
			// LZ77: 1 0 LLLLLLLL 距离+长度
			const c2 = data[pos++];
			const len = ((c << 8) | c2) & 0x3fff;
			const dist = ((len >> 3) & 0x07ff) + 1;
			const length = (len & 7) + 3;
			lastLen = length;
			for (let i = 0; i < length; i++) {
				const val = space[(blockPos - dist + 2048) & 2047];
				out.push(val);
				space[blockPos] = val;
				blockPos = (blockPos + 1) & 2047;
			}
			continue;
		}
		// c >= 0xc0: LZ77 2 0 LLLLLLLL
		const c2 = data[pos++];
		const len = ((c << 8) | c2) & 0x3fff;
		const dist = ((len >> 5) & 0x01ff) + 1;
		const length = (len & 0x1f) + 3;
		lastLen = length;
		for (let i = 0; i < length; i++) {
			const val = space[(blockPos - dist + 2048) & 2047];
			out.push(val);
			space[blockPos] = val;
			blockPos = (blockPos + 1) & 2047;
		}
		void FORWARD;
		void BACKWARD;
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
