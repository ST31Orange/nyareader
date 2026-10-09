/**
 * NyaReader 设置类型、默认值与归一化。
 *
 * 翻译部分设计（v0.2.0 起）：引擎/密钥/缓存等全部委托独立翻译插件 NyaLingo 一份，
 * 本插件只保留 UI 级设置（源/目标语言），与 NyaLingo 配置互不干扰。
 */
import type { ReaderSettings, ReaderTheme } from "./types";
import { DEFAULT_READER_SETTINGS } from "./types";
import {
	DEFAULT_FINGERPRINT_SIDECAR_DIR,
	annotationDirForBookshelf,
} from "./utils/annotation-sidecar-path";

/** 书架卡片显示模式（按区域生效） */
export type BookshelfDisplayMode = "full" | "compact" | "list";
export const BOOKSHELF_MODE_LABEL: Record<BookshelfDisplayMode, string> = {
	full: "完整",
	compact: "紧凑",
	list: "列表",
};

export interface TranslationSettings {
	/** UI 级默认源/目标语言（默认中英互译：auto -> zh-Hans） */
	sourceLanguage: string;
	targetLanguage: string;
}

/** 阅读器 UI 级设置（与翻译服务配置无关）。 */
export interface ReaderUiSettings {
	/** 右侧翻译面板宽度（px），可拖拽调整 */
	translationPanelWidth: number;
}

export interface NyaReaderSettings {
	/** 每本书的版式覆盖：fingerprint -> ReaderSettings */
	bookOverrides: Record<string, ReaderSettings>;
	reader: ReaderSettings;
	translation: TranslationSettings;
	/** 阅读器 UI 设置（翻译面板宽度等） */
	ui: ReaderUiSettings;
	/** 首次运行时是否已提示安装翻译服务（NyaLingo） */
	translationPromptShown: boolean;
	/** 书架各区域的卡片显示模式：区域相对路径 -> 模式 */
	bookshelfModes: Record<string, BookshelfDisplayMode>;
	/** 书架各区域是否折叠：区域相对路径 -> 折叠 */
	bookshelfCollapsed: Record<string, boolean>;
	/** 书架根目录（vault 相对路径）。 */
	bookshelfDir: string;
	/** 书库顺序（书库相对路径数组，手动拖动调序） */
	bookshelfLibraryOrder: string[];
	/** 每个书库内的文件夹顺序：书库相对路径 -> 文件夹相对路径数组 */
	bookshelfFolderOrder: Record<string, string[]>;
	/** 当前选中的书库（相对路径） */
	bookshelfSelectedLibrary: string;
	/** 是否已完成「文件夹 -> 书库」结构迁移 */
	bookshelfMigrated: boolean;
	/** 批注侧车文件名后缀 */
	annotationSidecarSuffix: string;
	/**
	 * 批注主存储目录（vault 相对路径）。
	 * 默认与书架同级：书架 `nyareader/library` ↔ 批注 `nyareader/annotations`，
	 * 迁移书架时两者一起搬（见 settings-tab 的迁移逻辑）。
	 */
	annotationDir: string;
}

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
	sourceLanguage: "auto",
	targetLanguage: "zh-Hans",
};

export const DEFAULT_UI_SETTINGS: ReaderUiSettings = {
	translationPanelWidth: 320,
};

/** 书架根目录默认位置（vault 相对路径）。 */
export const DEFAULT_BOOKSHELF_DIR = "nyareader/library";

/**
 * 书架**上级目录**（书库与批注目录的公共父目录）的默认值。
 *
 * 为什么需要它：书库在 `nyareader/library`、批注在 `nyareader/annotations`，
 * 两者是同级兄弟。迁移时必须搬**上级目录**，否则只搬了 library、批注留在原地
 * （用户实测到的问题）。这个值就是"搬谁"的答案。
 */
export const DEFAULT_BOOKSHELF_ROOT = "nyareader";

export const DEFAULT_SETTINGS: NyaReaderSettings = {
	bookOverrides: {},
	reader: {
		fontFamily: "system-ui",
		fontSize: 18,
		lineHeight: 1.8,
		margin: 24,
		theme: "light",
		layout: "single",
		scrollMode: false,
		pageWidth: DEFAULT_READER_SETTINGS.pageWidth,
	},
	translation: { ...DEFAULT_TRANSLATION_SETTINGS },
	ui: { ...DEFAULT_UI_SETTINGS },
	translationPromptShown: false,
	bookshelfModes: {},
	bookshelfCollapsed: {},
	bookshelfDir: DEFAULT_BOOKSHELF_DIR,
	bookshelfLibraryOrder: [],
	bookshelfFolderOrder: {},
	bookshelfSelectedLibrary: "",
	bookshelfMigrated: false,
	annotationSidecarSuffix: ".annotations",
	annotationDir: DEFAULT_FINGERPRINT_SIDECAR_DIR,
};

/** 归一化用户数据，保证运行时永远拿到合法形状（旧版多余翻译字段自动忽略）。 */
export function normalizeSettings(raw: unknown): NyaReaderSettings {
	const v = (raw ?? {}) as Partial<NyaReaderSettings>;
	const t = (v.translation ?? {}) as Partial<TranslationSettings>;
	const r = (v.reader ?? {}) as Partial<ReaderSettings>;
	const u = (v.ui ?? {}) as Partial<ReaderUiSettings>;
	return {
		bookOverrides: v.bookOverrides && typeof v.bookOverrides === "object" ? (v.bookOverrides as Record<string, ReaderSettings>) : {},
		reader: {
			fontFamily: typeof r.fontFamily === "string" && r.fontFamily ? r.fontFamily : DEFAULT_SETTINGS.reader.fontFamily,
			fontSize: clamp(Number(r.fontSize), 10, 40, DEFAULT_SETTINGS.reader.fontSize),
			lineHeight: clamp(Number(r.lineHeight), 1.2, 3, DEFAULT_SETTINGS.reader.lineHeight),
			margin: clamp(Number(r.margin), 0, 200, DEFAULT_SETTINGS.reader.margin),
			theme: isTheme(r.theme) ? r.theme : DEFAULT_SETTINGS.reader.theme,
			layout: r.layout === "double" ? "double" : "single",
			scrollMode: r.scrollMode === true,
			pageWidth: clamp(Number(r.pageWidth), 240, 900, DEFAULT_SETTINGS.reader.pageWidth),
		},
		translation: {
			sourceLanguage: strOr(t.sourceLanguage, DEFAULT_TRANSLATION_SETTINGS.sourceLanguage),
			targetLanguage: strOr(t.targetLanguage, DEFAULT_TRANSLATION_SETTINGS.targetLanguage),
		},
		bookshelfModes: sanitizeBookshelfModes(v.bookshelfModes),
		bookshelfCollapsed: sanitizeBookshelfCollapsed(v.bookshelfCollapsed),
		bookshelfDir: typeof v.bookshelfDir === "string" && v.bookshelfDir ? v.bookshelfDir : DEFAULT_BOOKSHELF_DIR,
		bookshelfLibraryOrder: arrayOfStrings(v.bookshelfLibraryOrder),
		bookshelfFolderOrder: sanitizeFolderOrder(v.bookshelfFolderOrder),
		bookshelfSelectedLibrary: strOr(v.bookshelfSelectedLibrary, ""),
		bookshelfMigrated: v.bookshelfMigrated === true,
		ui: {
			translationPanelWidth: clamp(Number(u.translationPanelWidth), 240, 760, DEFAULT_UI_SETTINGS.translationPanelWidth),
		},
		translationPromptShown: v.translationPromptShown === true,
		annotationSidecarSuffix: strOr(v.annotationSidecarSuffix, DEFAULT_SETTINGS.annotationSidecarSuffix),
		// 老配置没有 annotationDir：按书架目录推导（两者默认同级），保证升级后能找到已有批注
		annotationDir: strOr(
			v.annotationDir,
			annotationDirForBookshelf(typeof v.bookshelfDir === "string" && v.bookshelfDir ? v.bookshelfDir : DEFAULT_BOOKSHELF_DIR)
		),
	};
}

/** 只保留合法的显示模式值。 */
export function sanitizeBookshelfModes(raw: unknown): Record<string, BookshelfDisplayMode> {
	if (!raw || typeof raw !== "object") return {};
	const out: Record<string, BookshelfDisplayMode> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (v === "full" || v === "compact" || v === "list") out[k] = v;
	}
	return out;
}

/** 字符串数组（去空、去重）。 */
export function arrayOfStrings(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const v of raw) if (typeof v === "string" && v && !out.includes(v)) out.push(v);
	return out;
}

/** 每个书库的文件夹顺序：只保留 string[]。 */
export function sanitizeFolderOrder(raw: unknown): Record<string, string[]> {
	if (!raw || typeof raw !== "object") return {};
	const out: Record<string, string[]> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (Array.isArray(v)) out[k] = arrayOfStrings(v);
	}
	return out;
}

/** 只保留布尔折叠值。 */
export function sanitizeBookshelfCollapsed(raw: unknown): Record<string, boolean> {
	if (!raw || typeof raw !== "object") return {};
	const out: Record<string, boolean> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof v === "boolean") out[k] = v;
	}
	return out;
}

function clamp(n: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}
function strOr(v: unknown, fallback: string): string {
	return typeof v === "string" && v ? v : fallback;
}
function isTheme(v: unknown): v is ReaderTheme {
	return v === "light" || v === "dark" || v === "sepia";
}
