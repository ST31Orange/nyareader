/**
 * NyaReader 全局共享接口与类型。
 *
 * 分层约定：
 * - 视图层（view/）只依赖 ReaderController；
 * - ReaderController 面向接口（IReaderEngine / ITranslationProvider / IAnnotationStore / IStorage）调用服务层；
 * - 服务层与工具层不得 import 插件类或视图类。
 */

/** 支持的电子书格式 */
export type BookFormat = "epub" | "pdf" | "mobi" | "azw3" | "txt" | "unknown";

/** 一本书的元数据与内容索引（由解析服务构建） */
export interface BookModel {
	/** 文件指纹（sha256 前缀），用于跨重命名关联进度/批注 */
	fingerprint: string;
	/** 打开时的 vault 内路径（注意：仅作展示，持久化索引不依赖路径） */
	path: string;
	format: BookFormat;
	title: string;
	author?: string;
	/** 目录条目列表 */
	toc: TocItem[];
	/** 内容单元（spine）列表 */
	spine: SpineItem[];
	/** 书内总字符数（若可廉价估算，用于进度展示） */
	estimatedChars?: number;
}

export interface TocItem {
	id: string;
	label: string;
	/** 引擎内部定位符，例如 EPUB CFI、PDF 页码、TXT 段索引 */
	location: string;
	children?: TocItem[];
	/** 是否可跳转 */
	href?: string;
}

export interface SpineItem {
	id: string;
	/** EPUB 中为内容文档路径；TXT 中为段块 id；PDF 中为页码字符串 */
	href: string;
	title?: string;
}

/** 阅读进度（各格式可扩展，故用 Record 承载引擎特定字段） */
export interface ReadingProgress {
	fingerprint: string;
	format: BookFormat;
	/** 引擎内部定位符（CFI / 页码 / 段索引等） */
	location: string;
	/** 0~1 相对进度，用于滑动条展示 */
	percentage: number;
	updatedAt: number;
	/** 引擎特定附加信息（如 PDF 滚动偏移、EPUB 章节） */
	meta?: Record<string, unknown>;
}

/** 阅读版式设置（全局默认 + 每书覆盖） */
export interface ReaderSettings {
	fontFamily: string;
	fontSize: number; // px
	lineHeight: number; // 倍数
	margin: number; // px（左右）
	theme: ReaderTheme;
	layout: "single" | "double";
	scrollMode: boolean;
	pageWidth: number; // px（双栏时单栏宽度）
}

export type ReaderTheme = "light" | "dark" | "sepia";

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
	fontFamily: "system-ui",
	fontSize: 18,
	lineHeight: 1.8,
	margin: 24,
	theme: "light",
	layout: "single",
	scrollMode: false,
	pageWidth: 420,
};
