/**
 * NyaReader 设置类型、默认值与归一化。
 *
 * 翻译部分设计（v0.2.0 起）：引擎/密钥/缓存等全部委托独立翻译插件 NyaLingo 一份，
 * 本插件只保留 UI 级设置（源/目标语言），与 NyaLingo 配置互不干扰。
 */
import type { ReaderSettings, ReaderTheme } from "./types";

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
	/** 批注侧车文件名后缀 */
	annotationSidecarSuffix: string;
}

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
	sourceLanguage: "auto",
	targetLanguage: "zh-Hans",
};

export const DEFAULT_UI_SETTINGS: ReaderUiSettings = {
	translationPanelWidth: 320,
};

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
		pageWidth: 420,
	},
	translation: { ...DEFAULT_TRANSLATION_SETTINGS },
	ui: { ...DEFAULT_UI_SETTINGS },
	translationPromptShown: false,
	bookshelfModes: {},
	annotationSidecarSuffix: ".annotations",
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
		ui: {
			translationPanelWidth: clamp(Number(u.translationPanelWidth), 240, 760, DEFAULT_UI_SETTINGS.translationPanelWidth),
		},
		translationPromptShown: v.translationPromptShown === true,
		annotationSidecarSuffix: strOr(v.annotationSidecarSuffix, DEFAULT_SETTINGS.annotationSidecarSuffix),
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
