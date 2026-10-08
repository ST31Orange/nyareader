/** EPUB zip 打开缓存：解析与渲染共用同一次解压，避免大书重复解包。 */
import JSZip from "jszip";

/** EPUB 章节锚点 id 前缀（HtmlDocEngine 内跳转用）。 */
export const EPUB_ANCHOR_PREFIX = "nyareader-epub-";

let cache: { buffer: ArrayBuffer; zip: JSZip } | null = null;

export async function openEpubZip(buffer: ArrayBuffer): Promise<JSZip> {
	if (cache?.buffer === buffer) return cache.zip;
	const zip = await JSZip.loadAsync(buffer);
	cache = { buffer, zip };
	return zip;
}
