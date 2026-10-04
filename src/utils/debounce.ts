/** 简易防抖：返回包装函数，尾沿执行。 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): (...args: A) => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	return (...args: A) => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			fn(...args);
		}, waitMs);
	};
}

/** 节流：头沿执行，忽略窗口内重复调用。 */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, intervalMs: number): (...args: A) => void {
	let last = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	return (...args: A) => {
		const now = Date.now();
		const remaining = intervalMs - (now - last);
		if (remaining <= 0) {
			last = now;
			fn(...args);
			return;
		}
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			last = Date.now();
			timer = null;
			fn(...args);
		}, remaining);
	};
}
