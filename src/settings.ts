/**
 * NyaReader 设置类型、默认值与归一化。
 * 翻译部分刻意沿用 NyaHome 既有 MTranServer 配置字段命名，便于用户原样迁移。
 */
import type { ReaderSettings, ReaderTheme } from "./types";

export type TranslationMode = "offline" | "online";

export type TranslationProviderType = "openai" | "deepl" | "mtran";

export interface TranslationSettings {
	/** 默认源/目标语言（默认中英互译：auto -> zh-Hans） */
	sourceLanguage: string;
	targetLanguage: string;
	mode: TranslationMode;
	provider: TranslationProviderType;
	/** 离线翻译引擎（如 MTranServer）地址 */
	offlineEndpoint: string;
	offlineToken: string;
	/** OpenAI 兼容 API */
	openaiBaseUrl: string;
	openaiApiKey: string;
	openaiModel: string;
	/** DeepL */
	deeplApiKey: string;
	deeplBaseUrl: string;
	/** 公共 */
	timeoutMs: number;
	cacheEnabled: boolean;
	cacheMaxEntries: number;
}

export interface NyaReaderSettings {
	/** 每本书的版式覆盖：fingerprint -> ReaderSettings */
	bookOverrides: Record<string, ReaderSettings>;
	reader: ReaderSettings;
	translation: TranslationSettings;
	/** 首次运行时是否已提示安装离线翻译引擎 */
	translationOfflinePromptShown: boolean;
	/** 批注侧车文件名后缀 */
	annotationSidecarSuffix: string;
}

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
	sourceLanguage: "auto",
	targetLanguage: "zh-Hans",
	mode: "offline",
	provider: "mtran",
	offlineEndpoint: "",
	offlineToken: "",
	openaiBaseUrl: "https://api.openai.com/v1",
	openaiApiKey: "",
	openaiModel: "gpt-4o-mini",
	deeplApiKey: "",
	deeplBaseUrl: "https://api-free.deepl.com/v2",
	timeoutMs: 15000,
	cacheEnabled: true,
	cacheMaxEntries: 500,
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
	translationOfflinePromptShown: false,
	annotationSidecarSuffix: ".annotations",
};

/** 归一化用户数据，保证运行时永远拿到合法形状 */
export function normalizeSettings(raw: unknown): NyaReaderSettings {
	const v = (raw ?? {}) as Partial<NyaReaderSettings>;
	const t = (v.translation ?? {}) as Partial<TranslationSettings>;
	const r = (v.reader ?? {}) as Partial<ReaderSettings>;
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
			mode: t.mode === "online" ? "online" : "offline",
			provider: isProvider(t.provider) ? t.provider : "mtran",
			offlineEndpoint: strOr(t.offlineEndpoint, ""),
			offlineToken: strOr(t.offlineToken, ""),
			openaiBaseUrl: strOr(t.openaiBaseUrl, DEFAULT_TRANSLATION_SETTINGS.openaiBaseUrl),
			openaiApiKey: strOr(t.openaiApiKey, ""),
			openaiModel: strOr(t.openaiModel, DEFAULT_TRANSLATION_SETTINGS.openaiModel),
			deeplApiKey: strOr(t.deeplApiKey, ""),
			deeplBaseUrl: strOr(t.deeplBaseUrl, DEFAULT_TRANSLATION_SETTINGS.deeplBaseUrl),
			timeoutMs: clamp(Number(t.timeoutMs), 1000, 120000, DEFAULT_TRANSLATION_SETTINGS.timeoutMs),
			cacheEnabled: t.cacheEnabled !== false,
			cacheMaxEntries: clamp(Number(t.cacheMaxEntries), 10, 10000, DEFAULT_TRANSLATION_SETTINGS.cacheMaxEntries),
		},
		translationOfflinePromptShown: v.translationOfflinePromptShown === true,
		annotationSidecarSuffix: strOr(v.annotationSidecarSuffix, DEFAULT_SETTINGS.annotationSidecarSuffix),
	};
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
function isProvider(v: unknown): v is TranslationProviderType {
	return v === "openai" || v === "deepl" || v === "mtran";
}
