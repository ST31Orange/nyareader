/**
 * 批注数据模型与存储接口。
 * PDF 批注写入文件本身；其他格式使用侧车文件（.annotations.json）。
 */
import type { AnnotationTarget } from "../books/IReaderEngine";
import type { AnnotationAnchor } from "./AnnotationAnchor";

export type { AnnotationAnchor, AnchorKind, AnchorLocateQuality, TextQuote } from "./AnnotationAnchor";

export type AnnotationKind = "highlight" | "underline" | "note";

/**
 * 六色高亮：命名与顺序与 Obsidian 原生高亮（`==🟡…==` 等 emoji 前缀）一致，
 * 这样导出成 Markdown 后天然渲染、天然可 grep。
 */
export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple" | "orange";

export const HIGHLIGHT_COLORS: readonly HighlightColor[] = ["yellow", "green", "blue", "pink", "purple", "orange"];

export const HIGHLIGHT_COLOR_LABEL: Record<HighlightColor, string> = {
	yellow: "黄",
	green: "绿",
	blue: "蓝",
	pink: "粉",
	purple: "紫",
	orange: "橙",
};

/** 把任意历史值收敛成合法颜色（旧数据里可能是别的字符串/缺失）。 */
export function normalizeHighlightColor(raw: unknown): HighlightColor {
	return typeof raw === "string" && (HIGHLIGHT_COLORS as readonly string[]).includes(raw)
		? (raw as HighlightColor)
		: "yellow";
}

export interface Annotation {
	id: string;
	kind: AnnotationKind;
	/** 书籍指纹 */
	bookFingerprint: string;
	/** 引擎内定位（页码 / CFI / 段索引）——旧字段，保留兼容 */
	location: string;
	target: AnnotationTarget;
	/** 选中原文 */
	text: string;
	/** 笔记内容（note 类型） */
	note?: string;
	/** 六色高亮颜色；旧数据可能是任意字符串，读取时用 normalizeHighlightColor 收敛 */
	color?: string;
	createdAt: number;
	updatedAt: number;
	/** 定位是否降级（锚点只能靠文本指纹/百分比兜底）：面板据此提示"位置可能不准" */
	approximate?: boolean;
	/** 实际生效的定位方式（exact-range / quote-unique / quote-first / progression-only） */
	anchorResolvedBy?: string;
	/** 统一锚点（三层冗余）；v1 旧数据没有该字段，读取时由迁移函数补出 */
	anchor?: AnnotationAnchor;
	/** 数据来源：v2 侧车 / v1 侧车迁移 / PDF 内联索引（诊断与迁移展示用） */
	source?: AnnotationSource;
}

/** 批注数据来源。 */
export type AnnotationSource = "sidecar-v2" | "sidecar-v1" | "pdf-inline";

export interface IAnnotationStore {
	/** 读取某书全部批注 */
	list(bookFingerprint: string): Promise<Annotation[]>;
	/** 新增批注 */
	add(annotation: Omit<Annotation, "id" | "createdAt" | "updatedAt">): Promise<Annotation>;
	/** 更新批注（如修改笔记） */
	update(id: string, patch: Partial<Pick<Annotation, "note" | "color">>): Promise<void>;
	/** 删除批注 */
	remove(bookFingerprint: string, id: string): Promise<void>;
	/** 导出为 JSON 文本 */
	exportJson(bookFingerprint: string): Promise<string>;
}

/** 生成稳定 id。 */
export function annotationId(): string {
	return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
