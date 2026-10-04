/**
 * 翻译服务：面向阅读器的即划即译编排。
 * 职责：Provider 选择、分块、缓存、并发去重、错误归一化。
 * 视图层通过本服务获取译文，不直接触碰 Provider。
 */
import type { ITranslationProvider } from "./providers/providers";
import { createProvider } from "./providers/providers";
import type { HttpTransport } from "../../utils/http";
import type { TranslationSettings } from "../../settings";
import { splitTranslationChunks } from "../../utils/text";
import { TranslationCache, translationKey, ITranslationCacheStore } from "./TranslationCache";
import type { HistoryStore } from "../history/HistoryStore";

export interface TranslationServiceDeps {
	config: () => TranslationSettings;
	http: HttpTransport;
	history?: HistoryStore;
	persistentCacheStore?: ITranslationCacheStore;
}

export interface TranslateSelectionOptions {
	from?: string;
	to?: string;
	bookFingerprint?: string;
}

export class TranslationService {
	private provider: ITranslationProvider;
	private cache: TranslationCache;
	private inFlight = new Map<string, Promise<string>>();

	constructor(private deps: TranslationServiceDeps) {
		const cfg = this.deps.config();
		this.cache = new TranslationCache(deps.persistentCacheStore ?? null, cfg.cacheMaxEntries);
		this.provider = createProvider({ config: deps.config, http: deps.http });
	}

	async initialize(): Promise<void> {
		await this.cache.load();
	}

	getProviderInfo(): { id: string; displayName: string } {
		return { id: this.provider.id, displayName: this.provider.displayName };
	}

	/** 设置变更后重建 Provider 与缓存参数。 */
	async reloadConfig(): Promise<void> {
		const cfg = this.deps.config();
		this.provider = createProvider({ config: this.deps.config, http: this.deps.http });
		this.cache = new TranslationCache(this.deps.persistentCacheStore ?? null, cfg.cacheMaxEntries);
		await this.cache.load();
	}

	/**
	 * 翻译一段选中文本。返回译文；失败抛带用户可读信息的错误。
	 */
	async translateSelection(text: string, opts: TranslateSelectionOptions = {}): Promise<string> {
		const cfg = this.deps.config();
		const from = opts.from ?? cfg.sourceLanguage;
		const to = opts.to ?? cfg.targetLanguage;
		if (!text.trim()) return "";

		const chunks = splitTranslationChunks(text);
		// 并发去重：同一文本+语言对只有一个在途请求
		const joinedKey = translationKey(text, from, to, this.provider.id);
		const pending = this.inFlight.get(joinedKey);
		if (pending) return pending;

		const task = this.translateChunks(chunks, from, to, cfg)
			.then((result) => {
				if (this.deps.history) {
					void this.deps.history.add({
						sourceText: text,
						translatedText: result,
						from,
						to,
						provider: this.provider.id,
						bookFingerprint: opts.bookFingerprint,
					});
				}
				return result;
			})
			.finally(() => this.inFlight.delete(joinedKey));
		this.inFlight.set(joinedKey, task);
		return task;
	}

	private async translateChunks(chunks: ReturnType<typeof splitTranslationChunks>, from: string, to: string, cfg: TranslationSettings): Promise<string> {
		const values: string[] = [];
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const key = translationKey(chunk.text, from, to, this.provider.id);
			let part: string;
			if (cfg.cacheEnabled) {
				const cached = this.cache.get(key);
				if (cached !== undefined) {
					part = cached;
				} else {
					part = await this.fetchAndCache(chunk.text, from, to, key);
				}
			} else {
				part = (await this.provider.translateText(chunk.text, false, from, to)).translatedText;
			}
			values.push(i < chunks.length - 1 ? part + chunks[i].separator : part);
		}
		return values.join("");
	}

	private async fetchAndCache(text: string, from: string, to: string, key: string): Promise<string> {
		const result = await this.provider.translateText(text, false, from, to);
		this.cache.set(key, result.translatedText);
		void this.cache.persist();
		return result.translatedText;
	}

	async healthCheck(): Promise<boolean> {
		return this.provider.healthCheck();
	}

	async clearCache(): Promise<void> {
		this.cache.clear();
	}
}

