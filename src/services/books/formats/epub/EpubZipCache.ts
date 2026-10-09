/**
 * EPUB zip 打开缓存：解析与渲染共用同一次解压，避免大书重复解包。
 *
 * v0.5 大文件重构：
 * - 同一 buffer 的并发 openEpubZip（解析与渲染可能同时发起）只解包一次（in-flight 去重）；
 * - 提供显式 release，关闭/切换书籍后不再把整本 zip 的索引与解压数据钉在内存里。
 */
import JSZip from "jszip";

/** EPUB 章节锚点 id 前缀（HtmlDocEngine 内跳转用）。 */
export const EPUB_ANCHOR_PREFIX = "nyareader-epub-";

interface ZipCacheEntry {
	buffer: ArrayBuffer;
	zip: JSZip;
}

let cache: ZipCacheEntry | null = null;
/** 同一 buffer 的并发解包去重（解析 + 渲染可能同时调用）。 */
const inflight = new WeakMap<ArrayBuffer, Promise<JSZip>>();

export async function openEpubZip(buffer: ArrayBuffer): Promise<JSZip> {
	if (cache?.buffer === buffer) return cache.zip;
	const running = inflight.get(buffer);
	if (running) return running;
	const task = (async () => {
		const zip = await JSZip.loadAsync(buffer);
		cache = { buffer, zip };
		return zip;
	})();
	inflight.set(buffer, task);
	try {
		return await task;
	} finally {
		inflight.delete(buffer);
	}
}

/** 释放 zip 缓存（关闭书籍/切换书籍时调用，参数省略表示无条件释放）。 */
export function releaseEpubZip(buffer?: ArrayBuffer): void {
	if (!buffer || cache?.buffer === buffer) cache = null;
}
