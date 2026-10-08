/** 文本分块：用于将大段选中文本切成可翻译的片段。 */
export const TRANSLATION_CHUNK_CHARS = 1500;

export interface Chunk {
	text: string;
	separator: string;
}

/**
 * 归一化划词文本：浏览器从 PDF 文本层/分页 iframe 里拖选文本时，
 * 往往把每一行的换行、两个段落之间的空行一起带出来（"划出多余的分段符"）。
 * 规则：所有换行折叠为空格、压缩连续空白 —— 保证交给翻译引擎的是干净的一句话/段。
 */
export function normalizeSelectionText(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\u00a0/g, " ")
		.replace(/\n+/g, " ")
		.replace(/[ \t]+/g, " ")
		.trim();
}

/**
 * 按段落边界切块，保留块间换行以便翻译后还原排版。
 * 规则：尽量在换行处切；单段超长时硬切。
 */
export function splitTranslationChunks(text: string, maxChars = TRANSLATION_CHUNK_CHARS): Chunk[] {
	if (text.length <= maxChars) return [{ text, separator: "" }];
	const chunks: Chunk[] = [];
	// 交替段：文本段 / 换行段
	const segments = text.split(/(\n+)/);
	let current = "";
	let pendingNewlines = "";

	for (const seg of segments) {
		if (seg.length === 0) continue;
		if (/^\n+$/.test(seg)) {
			pendingNewlines += seg;
			continue;
		}
		// 文本段：若加入后超限，先把已累积内容连 pendingNewlines 提交
		const overflow = current.length > 0 && current.length + pendingNewlines.length + seg.length > maxChars;
		if (overflow) {
			chunks.push({ text: current, separator: pendingNewlines });
			current = "";
			pendingNewlines = "";
		}
		if (seg.length > maxChars) {
			// 单段超长：硬切
			for (let i = 0; i < seg.length; i += maxChars) {
				chunks.push({ text: seg.slice(i, i + maxChars), separator: "" });
			}
			continue;
		}
		current += pendingNewlines + seg;
		pendingNewlines = "";
	}
	if (current.length > 0 || pendingNewlines.length > 0) {
		chunks.push({ text: current, separator: pendingNewlines });
	}
	return chunks.length ? chunks : [{ text, separator: "" }];
}

/** 简易 HTML 转纯文本（翻译无需保留标记时使用）。 */
export function htmlToPlainText(html: string): string {
	if (typeof DOMParser === "undefined") {
		return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
	}
	const doc = new DOMParser().parseFromString(html, "text/html");
	return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}
