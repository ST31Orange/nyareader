/**
 * 底部进度条（transport）的纯计算与键盘步进。
 *
 * 抽成纯函数的原因：拖动/点击/键盘三条路径都要把"像素/按键"换算成 0~1 的进度，
 * 边界（越界夹取、零宽轨道、非法输入）最容易出错，抽出来就能单测。
 */

/** 把轨道内的横向像素位置换算成 0~1 进度（越界夹取；轨道宽度非法时返回 null）。 */
export function ratioFromClientX(clientX: number, trackLeft: number, trackWidth: number): number | null {
	if (!Number.isFinite(clientX) || !Number.isFinite(trackLeft) || !Number.isFinite(trackWidth)) return null;
	if (trackWidth <= 0) return null;
	const raw = (clientX - trackLeft) / trackWidth;
	return Math.min(1, Math.max(0, raw));
}

/** 键盘方向键步进：返回新的进度（钳到 0~1）。shift 加速到 10%，默认 2%。 */
export function stepSeekPercent(current: number, key: string, shiftKey = false): number | null {
	const step = (shiftKey ? 10 : 2) / 100;
	let next: number;
	switch (key) {
		case "ArrowLeft":
		case "ArrowDown":
			next = current - step;
			break;
		case "ArrowRight":
		case "ArrowUp":
			next = current + step;
			break;
		case "PageUp":
			next = current - 0.1;
			break;
		case "PageDown":
			next = current + 0.1;
			break;
		case "Home":
			next = 0;
			break;
		case "End":
			next = 1;
			break;
		default:
			return null;
	}
	if (!Number.isFinite(next)) return null;
	return Math.min(1, Math.max(0, next));
}

/** 进度（0~1）→ 百分比文字（保留 1 位小数，整数时不留小数）。 */
export function formatSeekPercent(ratio: number): string {
	const pct = Math.round(Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0)) * 1000) / 10;
	return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
}

/**
 * 页码文字。
 *
 * @param page 当前页（1 起）
 * @param totalPages 总页数（<=0 表示未知）
 * @param fullyLoaded 整本是否已全部排版完成。
 *   大文件懒加载时 totalPages 只是"已加载部分的页数"，此时**不能**当全书总页数显示
 *   （6k 页的书显示成 2k 页会让用户以为内容被截断）。
 * @param estimated 总页数是否为**估计值**（按章独立分页时只有当前章附近是精确测量的）。
 *   为 true 时前面加 `≈`，避免把插值估计当成精确值。
 */
export function formatPageIndicator(page: number, totalPages: number, fullyLoaded = true, estimated = false): string {
	if (!Number.isFinite(page)) return "— / —";
	const p = Math.max(1, Math.round(page));
	if (totalPages <= 0) return `${p} 页`;
	if (!fullyLoaded) return `${p} / — 页`;
	return `${p} / ${estimated ? "≈" : ""}${totalPages} 页`;
}
