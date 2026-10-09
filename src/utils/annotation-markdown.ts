/**
 * 批注 → Markdown 导出（纯函数，便于单测）。
 *
 * 设计取舍（见 docs/annotation-research.md）：
 * - **JSON 侧车是唯一真相**，Markdown 是**自动产物**：这里只做"渲染"，不回读；
 * - 高亮用 Obsidian 原生语法 `==…==`，并按**六色 emoji 前缀**着色
 *   （Obsidian 原生支持 `==🟡高亮==`），导出后天然渲染、天然可 grep；
 * - 笔记用 callout `> [!note]`；
 * - 每条带稳定 id 注释 `<!-- nyar:id=… -->`，便于将来幂等更新（重新导出不会产生重复块）。
 */
import type { Annotation } from "../services/annotations/AnnotationModel";
import { normalizeHighlightColor } from "../services/annotations/AnnotationModel";
import { numericLocation } from "./annotation-sort";

/** 六色 → Obsidian 原生高亮 emoji 前缀（与 Obsidian 自带色板一致）。 */
const COLOR_EMOJI: Record<string, string> = {
	yellow: "🟡",
	green: "🟢",
	blue: "🔵",
	pink: "🌸",
	purple: "🟣",
	orange: "🟠",
};

const COLOR_LABEL: Record<string, string> = {
	yellow: "黄",
	green: "绿",
	blue: "蓝",
	pink: "粉",
	purple: "紫",
	orange: "橙",
};

export interface ExportOptions {
	/** 书名（写入 frontmatter / 标题） */
	bookTitle: string;
	/** 书在 vault 内的路径（写进 frontmatter，便于回链） */
	bookPath?: string;
	/** 书籍指纹（稳定标识） */
	bookFingerprint?: string;
	/** 是否输出 frontmatter */
	frontmatter?: boolean;
	/** 导出时间（可注入，便于测试） */
	now?: Date;
}

/** 把批注列表渲染成一份 Markdown 文档。 */
export function annotationsToMarkdown(annotations: readonly Annotation[], opts: ExportOptions): string {
	// 导出时间只取一次：否则同一次调用里多次 new Date() 会让输出**非幂等**
	// （frontmatter 的 exported 时间戳不同），重复导出无法做"内容一致"判断。
	const now = opts.now ?? new Date();
	const lines: string[] = [];
	if (opts.frontmatter !== false) {
		lines.push("---");
		lines.push(`title: ${yamlString(`《${opts.bookTitle}》批注`)}`);
		lines.push("tags:");
		lines.push("  - nyareader");
		lines.push("  - 批注");
		if (opts.bookPath) lines.push(`book: ${yamlString(opts.bookPath)}`);
		if (opts.bookFingerprint) lines.push(`fingerprint: ${opts.bookFingerprint}`);
		lines.push(`exported: ${yamlString(now.toISOString())}`);
		lines.push(`count: ${annotations.length}`);
		lines.push("---");
		lines.push("");
	}
	lines.push(`# 《${opts.bookTitle}》批注`);
	lines.push("");
	if (!annotations.length) {
		lines.push("_（还没有批注）_");
		lines.push("");
		return lines.join("\n");
	}

	// 按文档位置排序（location 为数值时按数值；否则保持原顺序）
	const ordered = sortForExport(annotations);
	for (const a of ordered) {
		const color = normalizeHighlightColor(a.color);
		lines.push(`<!-- nyar:id=${a.id} -->`);
		const quote = (a.text || "").replace(/\s+/g, " ").trim();
		if (quote) {
			// Obsidian 原生高亮 + 颜色 emoji 前缀
			lines.push(`> ${COLOR_EMOJI[color] ?? ""}==${quote}==`);
		} else {
			lines.push(`> （未记录选中文本）`);
		}
		if (a.note) {
			lines.push(">");
			lines.push(`> [!note] 笔记（${COLOR_LABEL[color] ?? color}）`);
			for (const line of a.note.split(/\r?\n/)) lines.push(`> ${line}`);
		}
		lines.push(`> <sub>${formatTime(a.createdAt)}${a.approximate ? " · ⚠ 位置可能不准" : ""}</sub>`);
		lines.push("");
	}
	return lines.join("\n");
}

/** 导出用排序：数值型 location 升序；非数值保持稳定原序。 */
export function sortForExport(annotations: readonly Annotation[]): Annotation[] {
	return [...annotations].sort((a, b) => {
		const na = numericLocation(a);
		const nb = numericLocation(b);
		if (na !== null && nb !== null && na !== nb) return na - nb;
		return a.createdAt - b.createdAt;
	});
}

/** 建议的文件名（去掉文件系统非法字符）。 */
export function annotationExportFileName(bookTitle: string): string {
	const safe = (bookTitle || "未命名").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
	return `${safe}.批注.md`;
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** YAML 字符串：需要时加引号（避免 `:`/`#` 等破坏 frontmatter）。 */
function yamlString(s: string): string {
	return /[:#{}[\]",\n]/.test(s) ? JSON.stringify(s) : s;
}
