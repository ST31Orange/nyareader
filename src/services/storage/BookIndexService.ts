/**
 * 书籍索引服务：以指纹为主键，维护 指纹 -> 路径/进度/每书设置 的映射。
 * 依赖 Obsidian DataAdapter（公共 API），读写插件目录下 index.json。
 */
import { Plugin } from "obsidian";
import type { BookFormat, ReadingProgress } from "../../types";

export interface BookIndexEntry {
	fingerprint: string;
	path: string;
	format: BookFormat;
	title: string;
	author?: string;
	lastOpenedAt: number;
	progress?: ReadingProgress;
}

export interface BookIndexData {
	version: 1;
	entries: BookIndexEntry[];
}

const INDEX_FILE = "nyareader-index.json";

export class BookIndexService {
	private data: BookIndexData = { version: 1, entries: [] };
	private loaded = false;

	constructor(private plugin: Plugin) {}

	async load(): Promise<void> {
		if (this.loaded) return;
		try {
			const raw = await this.plugin.app.vault.adapter.read(this.indexPath());
			this.data = JSON.parse(raw) as BookIndexData;
			if (!Array.isArray(this.data.entries)) this.data.entries = [];
		} catch {
			this.data = { version: 1, entries: [] };
		}
		this.loaded = true;
	}

	private indexPath(): string {
		const dir = this.plugin.manifest.dir ? `${this.plugin.manifest.dir}/` : "";
		return `${dir}${INDEX_FILE}`.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
	}

	private async persist(): Promise<void> {
		const dir = this.plugin.manifest.dir ?? "";
		if (dir) await this.plugin.app.vault.adapter.mkdir(dir).catch(() => undefined);
		await this.plugin.app.vault.adapter.write(this.indexPath(), JSON.stringify(this.data, null, 2));
	}

	get(fingerprint: string): BookIndexEntry | undefined {
		return this.data.entries.find((e) => e.fingerprint === fingerprint);
	}

	list(): BookIndexEntry[] {
		return [...this.data.entries].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
	}

	async upsert(entry: BookIndexEntry): Promise<void> {
		const i = this.data.entries.findIndex((e) => e.fingerprint === entry.fingerprint);
		if (i >= 0) this.data.entries[i] = entry;
		else this.data.entries.push(entry);
		await this.persist();
	}

	async updateProgress(fingerprint: string, progress: ReadingProgress): Promise<void> {
		const entry = this.get(fingerprint);
		if (!entry) return;
		entry.progress = progress;
		entry.lastOpenedAt = progress.updatedAt;
		await this.persist();
	}

	async remove(fingerprint: string): Promise<void> {
		this.data.entries = this.data.entries.filter((e) => e.fingerprint !== fingerprint);
		await this.persist();
	}
}
