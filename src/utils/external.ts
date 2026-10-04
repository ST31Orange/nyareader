/** 打开外部链接（浏览器）。优先用 Electron shell，失败降级 window.open。 */
export function openExternal(url: string): void {
	try {
		// Obsidian 桌面端（Electron）渲染进程可用 require("electron")
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const electron = require("electron") as { shell?: { openExternal(u: string): Promise<void> } };
		if (electron?.shell?.openExternal) {
			void electron.shell.openExternal(url);
			return;
		}
	} catch {
		/* 降级 window.open */
	}
	try {
		window.open(url, "_blank", "noopener");
	} catch {
		/* 忽略 */
	}
}

/** 探测当前运行平台，用于给出对应下载包说明。 */
export function detectPlatform(): "win" | "mac" | "linux" | "other" {
	const ua = (navigator.userAgent || "").toLowerCase();
	if (ua.includes("win")) return "win";
	if (ua.includes("mac")) return "mac";
	if (ua.includes("linux")) return "linux";
	return "other";
}
