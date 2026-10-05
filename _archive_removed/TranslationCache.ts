/**
 * 翻译缓存：内存 LRU + 可选持久化。键 = 文本哈希 + 语言对 + provider。
 * 沿用 NyaHome translation 模块的缓存思路，保证重复选中不重复请求。
 */
import type { TranslationSettings } from "../../settings";

export interface ITranslationCacheStore {
	load(): Promise<Record<string, string>>;
	save(data: Record<string, string>): Promise<void>;
}

export function translationKey(text: string, from: string, to: string, provider: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) {
		h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	}
	return `${provider}:${from}:${to}:${(h >>> 0).toString(36)}:${text.length}`;
}

export class TranslationCache {
	private map = new Map<string, string>();

	constructor(private store: ITranslationCacheStore | null, private maxEntries: number) {}

	async load(): Promise<void> {
		if (!this.store) return;
		try {
			const data = await this.store.load();
			this.map = new Map(Object.entries(data));
			this.prune();
		} catch {
			this.map = new Map();
		}
	}

	get(key: string): string | undefined {
		const v = this.map.get(key);
		if (v !== undefined) {
			// LRU：重新插入到末尾
			this.map.delete(key);
			this.map.set(key, v);
		}
		return v;
	}

	set(key: string, value: string): void {
		this.map.delete(key);
		this.map.set(key, value);
		this.prune();
	}

	private prune(): void {
		while (this.map.size > this.maxEntries) {
			const oldest = this.map.keys().next().value;
			if (oldest === undefined) break;
			this.map.delete(oldest);
		}
	}

	size(): number {
		return this.map.size;
	}

	/** 持久化当前快照（fire-and-forget）。 */
	async persist(): Promise<void> {
		if (!this.store) return;
		try {
			await this.store.save(Object.fromEntries(this.map));
		} catch {
			// 持久化失败不阻塞翻译
		}
	}

	clear(): void {
		this.map.clear();
	}
}
