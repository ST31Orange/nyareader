/** 翻译历史条目 */
export interface TranslationHistoryEntry {
	id: string;
	sourceText: string;
	translatedText: string;
	from: string;
	to: string;
	provider: string;
	bookFingerprint?: string;
	createdAt: number;
}

export interface HistoryStoreData {
	version: 1;
	entries: TranslationHistoryEntry[];
}

const HISTORY_FILE = "nyareader-history.json";
const MAX_HISTORY = 500;

/**
 * 翻译历史存储：可开关；只保留最近的 N 条，提供清空与导出。
 */
export class HistoryStore {
	private data: HistoryStoreData = { version: 1, entries: [] };
	private loaded = false;

	constructor(private adapter: { read: (p: string) => Promise<string>; write: (p: string, d: string) => Promise<void>; mkdir: (p: string) => Promise<void> }, private dir = "") {}

	private path(): string {
		return `${this.dir}${HISTORY_FILE}`.replace(/\/+/g, "/").replace(/\/{2,}/g, "/").replace(/^\//, "");
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		try {
			const raw = await this.adapter.read(this.path());
			this.data = JSON.parse(raw) as HistoryStoreData;
			if (!Array.isArray(this.data.entries)) this.data.entries = [];
		} catch {
			this.data = { version: 1, entries: [] };
		}
		this.loaded = true;
	}

	async add(entry: Omit<TranslationHistoryEntry, "id" | "createdAt">): Promise<void> {
		const full: TranslationHistoryEntry = { ...entry, id: crypto.randomUUID(), createdAt: Date.now() };
		this.data.entries.unshift(full);
		if (this.data.entries.length > MAX_HISTORY) this.data.entries.length = MAX_HISTORY;
		if (this.dir) await this.adapter.mkdir(this.dir).catch(() => undefined);
		await this.adapter.write(this.path(), JSON.stringify(this.data, null, 2));
		return;
	}

	list(): TranslationHistoryEntry[] {
		return [...this.data.entries];
	}

	async clear(): Promise<void> {
		this.data.entries = [];
		if (this.dir) await this.adapter.write(this.path(), JSON.stringify(this.data, null, 2));
	}
}
