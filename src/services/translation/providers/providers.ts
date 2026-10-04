/**
 * 翻译 Provider 抽象与统一服务。
 * 设计继承 NyaHome 既有 translation 模块的风格（ITranslationServiceV1 / 分块 / 缓存），
 * 但扩展为可插拔多后端（OpenAI 兼容 / DeepL / MTranServer）。
 */
import type { HttpTransport } from "../../../utils/http";
import type { TranslationSettings } from "../../../settings";

export interface TranslationTextResult {
	translatedText: string;
	fromCache: boolean;
}

export interface ITranslationProvider {
	readonly id: string;
	readonly displayName: string;
	/** 翻译一段文本；html 表示是否按标记处理。 */
	translateText(text: string, html: boolean, from: string, to: string, signal?: AbortSignal): Promise<TranslationTextResult>;
	/** 尽力探测可用性，绝不抛异常。 */
	healthCheck(): Promise<boolean>;
}

export interface ProviderDeps {
	config: () => TranslationSettings;
	http: HttpTransport;
}

/** 依据当前设置构造合适的 Provider。 */
export function createProvider(deps: ProviderDeps): ITranslationProvider {
	const cfg = deps.config();
	switch (cfg.provider) {
		case "openai":
			return new OpenAICompatibleProvider(deps);
		case "deepl":
			return new DeepLProvider(deps);
		case "mtran":
		default:
			return new MTranServerProvider(deps);
	}
}

/** 超时包装。 */
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`翻译请求超时（${ms}ms）。`)), ms);
		task.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			}
		);
	});
}

/**
 * OpenAI 兼容 Chat Completions Provider。
 * 支持任意 base URL / apiKey / model，满足自定义中转需求。
 */
export class OpenAICompatibleProvider implements ITranslationProvider {
	readonly id = "openai";
	readonly displayName = "OpenAI 兼容 API";

	constructor(private deps: ProviderDeps) {}

	private cfg() {
		return this.deps.config();
	}

	private endpoint(): string {
		const base = this.cfg().openaiBaseUrl.trim().replace(/\/+$/, "");
		return `${base}/chat/completions`;
	}

	async translateText(text: string, _html: boolean, from: string, to: string, signal?: AbortSignal): Promise<TranslationTextResult> {
		const cfg = this.cfg();
		const langPair = `（${from || "auto"} → ${to}）`;
		const body = {
			model: cfg.openaiModel,
			messages: [
				{ role: "system", content: `You are a translation engine. Translate the user's text into ${to}. Only output the translation, no explanation.` },
				{ role: "user", content: text },
			],
			temperature: 0.2,
		};
		const res = await withTimeout(
			this.deps.http.request({
				url: this.endpoint(),
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${cfg.openaiApiKey.trim()}`,
				},
				body: JSON.stringify(body),
				timeoutMs: cfg.timeoutMs,
			}),
			cfg.timeoutMs + 1000
		);
		if (res.status >= 400) {
			throw new Error(`OpenAI 翻译失败（HTTP ${res.status}）: ${res.body.slice(0, 300)}`);
		}
		const data = JSON.parse(res.body) as { choices?: Array<{ message?: { content?: string } }> };
		const content = data.choices?.[0]?.message?.content?.trim();
		if (!content) throw new Error(`OpenAI 翻译返回为空 ${langPair}。`);
		return { translatedText: content, fromCache: false };
	}

	async healthCheck(): Promise<boolean> {
		try {
			await this.translateText("ok", false, "auto", "zh-Hans");
			return true;
		} catch {
			return false;
		}
	}
}

/** DeepL REST v2 Provider。 */
export class DeepLProvider implements ITranslationProvider {
	readonly id = "deepl";
	readonly displayName = "DeepL";

	constructor(private deps: ProviderDeps) {}

	private cfg() {
		return this.deps.config();
	}

	private endpoint(): string {
		const base = this.cfg().deeplBaseUrl.trim().replace(/\/+$/, "");
		return `${base}/translate`;
	}

	async translateText(text: string, _html: boolean, from: string, to: string, _signal?: AbortSignal): Promise<TranslationTextResult> {
		const cfg = this.cfg();
		const params = new URLSearchParams();
		params.set("text", text);
		// DeepL 源语言要求 "auto" 或具体语言码；目标语言转大写
		params.set("source_lang", from === "auto" ? "auto" : from.toUpperCase().replace(/-.*$/, ""));
		params.set("target_lang", to.toUpperCase().replace(/-.*$/, ""));
		const res = await withTimeout(
			this.deps.http.request({
				url: this.endpoint(),
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Authorization: `DeepL-Auth-Key ${cfg.deeplApiKey.trim()}`,
				},
				body: params.toString(),
				timeoutMs: cfg.timeoutMs,
			}),
			cfg.timeoutMs + 1000
		);
		if (res.status >= 400) {
			throw new Error(`DeepL 翻译失败（HTTP ${res.status}）: ${res.body.slice(0, 300)}`);
		}
		const data = JSON.parse(res.body) as { translations?: Array<{ text?: string }> };
		const content = data.translations?.[0]?.text?.trim();
		if (!content) throw new Error("DeepL 翻译返回为空。");
		return { translatedText: content, fromCache: false };
	}

	async healthCheck(): Promise<boolean> {
		try {
			await this.translateText("ok", false, "auto", "zh-Hans");
			return true;
		} catch {
			return false;
		}
	}
}

/** MTranServer Provider：完全沿用既有配置字段（endpoint/token），可迁移。 */
export class MTranServerProvider implements ITranslationProvider {
	readonly id = "mtran";
	readonly displayName = "MTranServer（本地离线翻译）";

	constructor(private deps: ProviderDeps) {}

	private cfg() {
		return this.deps.config();
	}

	private endpoint(): string {
		const base = this.cfg().offlineEndpoint.trim().replace(/\/+$/, "");
		if (!base) return "";
		return /\/translate\/?$/i.test(base) ? base : `${base}/translate`;
	}

	async translateText(text: string, html: boolean, from: string, to: string, _signal?: AbortSignal): Promise<TranslationTextResult> {
		const cfg = this.cfg();
		if (!cfg.offlineEndpoint.trim()) throw new Error("MTranServer 地址未配置。请在设置中填写离线翻译引擎地址。");
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (cfg.offlineToken.trim()) headers.Authorization = `Bearer ${cfg.offlineToken.trim()}`;
		const res = await withTimeout(
			this.deps.http.request({
				url: this.endpoint(),
				method: "POST",
				headers,
				body: JSON.stringify({ from, to, text, html }),
				timeoutMs: cfg.timeoutMs,
			}),
			cfg.timeoutMs + 1000
		);
		if (res.status >= 400) {
			throw new Error(`MTranServer 翻译失败（HTTP ${res.status}）: ${res.body.slice(0, 300)}`);
		}
		let parsed: { translatedText?: unknown; result?: unknown };
		try {
			parsed = JSON.parse(res.body);
		} catch {
			throw new Error("MTranServer 返回了非 JSON 内容。");
		}
		const translated = typeof parsed.translatedText === "string" ? parsed.translatedText : parsed.result;
		if (typeof translated !== "string") throw new Error("MTranServer 响应缺少译文。");
		return { translatedText: translated, fromCache: false };
	}

	async healthCheck(): Promise<boolean> {
		try {
			await this.translateText("ok", false, "auto", "zh-Hans");
			return true;
		} catch {
			return false;
		}
	}
}

