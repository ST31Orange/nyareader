/**
 * TXT 虚拟滚动布局纯函数（v0.5 大文件重构）。
 *
 * 旧实现每次重排都用 `paragraphs.map(...)` 生成三个长度 = 段数的普通数组
 * （heights / measured / prefix）。50 万段的 TXT 一打开就是 150 万个堆元素 +
 * 三次整表遍历，GC 峰值直接卡住界面。
 *
 * 现在：
 * - heights 用 Float64Array、measured 用 Uint8Array、prefix 用 Float64Array，
 *   分配一次可复用，不再产生等量的 JS 对象；
 * - 前缀和增量重建：只从"第一个被测量修正的段落"往后累加；
 * - 二分定位抽成纯函数，可用朴素线性扫描做等价性单测。
 */

/** 每段高度估算：段宽按字符数 / 每行字符数折算行数。 */
export function estimateParagraphHeight(
	textLength: number,
	charsPerLine: number,
	lineHeightPx: number,
	spacingPx: number
): number {
	const perLine = charsPerLine > 0 ? charsPerLine : 1;
	const lines = Math.max(1, Math.ceil(textLength / perLine));
	return lines * lineHeightPx + spacingPx;
}

/** 无测量能力时的兜底：每字符平均宽度 / 字号（中文为主的正文经验值）。 */
export const FALLBACK_CHAR_WIDTH_RATIO = 0.62;

/**
 * 量出「1em 内平均能放几个字符」，即 charsPerLine 的分母比例。
 *
 * 背景：旧实现固定用 0.62 估算，对中文严重偏低（实测 18px system-ui 下一个汉字
 * 正好占 1em = 18px，比例应为 1.0）。低估会高估每行字符数 → 段落高度偏小 →
 * 长文滚动到中段后实测修正把位置往回拉，表现就是"滚动位置跳动"。
 *
 * 做法：优先用 canvas 的 measureText 实测**纯汉字**样本（中文正文的主要成分，
 * 汉字为方块字，宽度稳定），再回退到混合样本。真实浏览器实测：
 * 18px/640px 宽下，纯汉字口径算出 35 字/行，与真实渲染的 34 字/行一致；
 * 旧 0.62 口径算出 57 字/行，误差 68%。
 *
 * 测量失败（无 canvas / 无 ctx / 无 document）时退回 FALLBACK_CHAR_WIDTH_RATIO，
 * 保证任何环境都能工作。
 *
 * @param fontFamily CSS 字体族（与正文一致）
 * @param fontSizePx 字号（px）
 * @returns 每字符宽度 / 字号 的比例（>0）
 */
export function measureCharWidthRatio(fontFamily: string, fontSizePx: number): number {
	const fallback = FALLBACK_CHAR_WIDTH_RATIO;
	if (!(fontSizePx > 0)) return fallback;
	try {
		const doc = typeof document !== "undefined" ? document : null;
		if (!doc) return fallback;
		const canvas = doc.createElement("canvas");
		const ctx = canvas.getContext?.("2d");
		if (!ctx) return fallback;
		ctx.font = `${fontSizePx}px ${fontFamily || "system-ui"}`;
		// 汉字为方块字，宽度最稳定；用足够长的样本摊平取整误差
		const han = "汉字宽窄测试正文内容显示效果的一行文字样本重复出现以便测量";
		const hanWidth = ctx.measureText(han).width;
		let perChar = hanWidth > 0 ? hanWidth / han.length / fontSizePx : 0;
		if (!(perChar > 0)) {
			// 极端字体下汉字测量异常时退回混合样本
			const mixed = "中文正文abc123，。！";
			const mixedWidth = ctx.measureText(mixed).width;
			perChar = mixedWidth > 0 ? mixedWidth / mixed.length / fontSizePx : 0;
		}
		if (!(perChar > 0)) return fallback;
		// 夹在合理区间，避免异常字体度量把布局算飞
		return Math.min(1.4, Math.max(0.3, perChar));
	} catch {
		return fallback;
	}
}

export function createHeights(count: number): Float64Array {
	return new Float64Array(Math.max(0, count));
}

/** prefix[i] = 前 i 段累计高度，长度为 count + 1。 */
export function createPrefix(count: number): Float64Array {
	return new Float64Array(Math.max(0, count) + 1);
}

export function createMeasured(count: number): Uint8Array {
	return new Uint8Array(Math.max(0, count));
}

/** 按估算公式填满 heights（不做任何分配）。 */
export function fillEstimatedHeights(
	paragraphs: readonly string[],
	heights: Float64Array,
	charsPerLine: number,
	lineHeightPx: number,
	spacingPx: number
): void {
	const n = Math.min(paragraphs.length, heights.length);
	for (let i = 0; i < n; i++) {
		heights[i] = estimateParagraphHeight(paragraphs[i].length, charsPerLine, lineHeightPx, spacingPx);
	}
}

/** 从 from 段开始增量重建前缀和；prefix[from] 必须已经是正确值。 */
export function rebuildPrefixFrom(heights: Float64Array, prefix: Float64Array, count: number, from: number): void {
	const start = Math.max(0, Math.min(count, Math.floor(from)));
	prefix[0] = 0;
	for (let i = start; i < count; i++) {
		prefix[i + 1] = prefix[i] + heights[i];
	}
}

/** 内容总高度（= prefix[count]）。 */
export function totalHeight(prefix: Float64Array, count: number): number {
	if (count <= 0) return 0;
	return prefix[count] ?? 0;
}

/**
 * 返回 offset 落在的段落索引：最后一个 prefix[i] <= offset 的 i。
 * 与朴素线性扫描等价（见单测）。
 */
export function indexAtOffset(prefix: Float64Array, count: number, offset: number): number {
	if (count <= 0) return 0;
	let lo = 0;
	let hi = count - 1;
	let ans = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if ((prefix[mid] ?? 0) <= offset) {
			ans = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return ans;
}

/** 段落索引夹取到 [0, count-1]（count 为 0 时返回 0）。 */
export function clampParagraphIndex(index: number, count: number): number {
	if (count <= 0) return 0;
	if (!Number.isFinite(index)) return 0;
	return Math.max(0, Math.min(count - 1, Math.floor(index)));
}
