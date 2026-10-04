/**
 * 批注数据模型与存储接口。
 * PDF 批注写入文件本身；其他格式使用侧车文件（.annotations.json）。
 */
import type { AnnotationTarget } from "../books/IReaderEngine";

export type AnnotationKind = "highlight" | "underline" | "note";

export interface Annotation {
	id: string;
	kind: AnnotationKind;
	/** 书籍指纹 */
	bookFingerprint: string;
	/** 引擎内定位（页码 / CFI / 段索引） */
	location: string;
	target: AnnotationTarget;
	/** 选中原文 */
	text: string;
	/** 笔记内容（note 类型） */
	note?: string;
	color?: string;
	createdAt: number;
	updatedAt: number;
}

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
