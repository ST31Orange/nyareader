/**
 * 分页指示相关纯函数（便于单测，避免视图层内联逻辑）。
 */

/**
 * 把引擎定位符换算成"第几页"显示。
 *
 * 两种语义：
 * - PDF：location 就是页码字符串（"1"、"2"…），直接使用；
 * - HTML/TXT 分页模式：location 是 0~10000 的百分比，需按总页数换算成页码。
 *
 * @param location 引擎 currentLocation() 的返回值
 * @param totalPages 总页数（<=0 表示未知）
 * @param percentageLocation location 是否为 0~10000 百分比
 */
export function displayPageFromLocation(location: string, totalPages: number, percentageLocation: boolean): number {
	const n = parseInt(location, 10);
	if (!Number.isFinite(n)) return Number.NaN;
	if (percentageLocation) {
		if (totalPages <= 0) return 1;
		return Math.min(totalPages, Math.floor((n / 10000) * totalPages) + 1);
	}
	// PDF 页码：直接返回（至少为 1）
	return Math.max(1, n);
}
