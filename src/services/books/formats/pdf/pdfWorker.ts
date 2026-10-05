/**
 * pdf.js worker 加载器。
 * pdf.js 4.x 通过 `new Worker(workerSrc, { type: "module" })` 创建 worker，
 * 且跨域时会包一层 CDN wrapper。Obsidian 中 worker 无法直接访问插件目录文件，
 * 因此采用：构建期复制 pdf.worker.min.mjs 到插件目录，运行时用
 * vault.adapter 读取其文本并生成 Blob URL 作为 workerSrc。
 * 该方案已被多个社区插件验证，且只使用公开 API。
 *
 * 注意：pdfjs-dist 必须静态导入（而非 import()）——esbuild 对动态 import
 * 的 bundle 会复制出第二份模块状态，导致 workerSrc 写进一份、getDocument
 * 读到另一份（报 "No GlobalWorkerOptions.workerSrc specified"）。
 */
import * as pdfjs from "pdfjs-dist";
import { GlobalWorkerOptions } from "pdfjs-dist";
import type { Plugin } from "obsidian";

let workerInit: Promise<void> | null = null;

/** 初始化 workerSrc（幂等）。返回 Promise，失败时抛出可读错误。 */
export function initPdfWorker(plugin: Plugin): Promise<void> {
	if (workerInit) return workerInit;
	workerInit = (async () => {
		const dir = plugin.manifest.dir ? `${plugin.manifest.dir}/` : "";
		const workerPath = `${dir}pdf.worker.min.mjs`.replace(/\/+/g, "/").replace(/^\//, "");
		try {
			const code = await plugin.app.vault.adapter.read(workerPath);
			const blob = new Blob([code], { type: "text/javascript" });
			GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
		} catch (e) {
			workerInit = null; // 允许重试
			throw new Error(`pdf.js worker 初始化失败：${e instanceof Error ? e.message : String(e)}`);
		}
	})();
	return workerInit;
}

/** 单例 pdfjs 模块（与 workerSrc 同一份状态）。 */
export { pdfjs };
