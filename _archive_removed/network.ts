/** 网络可达性探测：用于"是否弹窗提示下载离线翻译引擎"。 */
export async function isOnline(timeoutMs = 4000): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		const res = await fetch("https://www.gstatic.com/generate_204", { mode: "no-cors", signal: ctrl.signal });
		clearTimeout(timer);
		return res.type === "opaque" || res.ok;
	} catch {
		return false;
	}
}
