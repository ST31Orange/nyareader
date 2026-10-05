/**
 * BookshelfService：书架数据服务。
 * 职责：
 * - 扫描 nyareader/library/ 下的电子书，按子文件夹（区域）分组
 * - 新建区域（文件夹，命名即文件夹名）
 * - 导入（复制文件到目标区域）
 * - 删除书籍 / 删除区域
 * - 排序（最近读 / 标题 / 进度）
 * 纯逻辑 + 注入 DataAdapter 适配，便于单元测试。
 */
import type { BookFormat } from "../../types";

export const SUPPORTED_BOOK_EXT = new Set(["epub", "pdf", "mobi", "azw3", "azw", "txt"]);

export interface BookshelfAdapter {
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	mkdir(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	remove(path: string): Promise<void>;
}

/** 书架中的一本书（视图展示用）。 */
export interface BookshelfBook {
	/** vault 内绝对路径，如 nyareader/library/科幻/a.epub */
	path: string;
	name: string;
	ext: string;
	title?: string;
	author?: string;
	/** 0~1 阅读进度 */
	progress?: number;
	lastOpenedAt?: number;
}

/** 一个书架区域（文件夹）。 */
export interface BookshelfFolder {
	/** 相对 library 的路径，根目录为 "" */
	relPath: string;
	name: string;
	books: BookshelfBook[];
}

export type BookshelfSort = "recent" | "title" | "progress";

/** 从路径取文件名与扩展名（兼容正反斜杠）。 */
export function splitPath(p: string): { dir: string; base: string; ext: string } {
	const parts = p.replace(/\\/g, "/").split("/");
	const base = parts.pop() ?? "";
	const dot = base.lastIndexOf(".");
	const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
	const name = dot > 0 ? base.slice(0, dot) : base;
	return { dir: parts.join("/"), base: name, ext };
}

export class BookshelfService {
	constructor(
		private adapter: BookshelfAdapter,
		private libraryDir: string,
		private getMeta: (path: string) => { title?: string; author?: string; progress?: number; lastOpenedAt?: number } | undefined
	) {}

	/** 扫描书架：返回按文件夹分组的列表。library 目录不存在时返回空。 */
	async loadBooks(): Promise<BookshelfFolder[]> {
		if (!(await this.adapter.exists(this.libraryDir))) return [];
		let listing;
		try {
			listing = await this.adapter.list(this.libraryDir);
		} catch {
			return [];
		}
		const byDir = new Map<string, BookshelfBook[]>();
		for (const f of listing.files) {
			const { dir, base, ext } = splitPath(f);
			if (!SUPPORTED_BOOK_EXT.has(ext)) continue;
			const rel = dir === this.libraryDir || dir === "" ? "" : dir.replace(this.libraryDir.replace(/\/+$/, ""), "").replace(/^\/+/, "");
			const meta = this.getMeta(f);
			byDir.set(rel, [
				...(byDir.get(rel) ?? []),
				{ path: f, name: base, ext, title: meta?.title, author: meta?.author, progress: meta?.progress, lastOpenedAt: meta?.lastOpenedAt },
			]);
		}
		// 文件夹（含空的区域也保留）
		const folders: BookshelfFolder[] = [];
		const seen = new Set<string>();
		const ensureFolder = (rel: string): void => {
			if (seen.has(rel)) return;
			seen.add(rel);
			const name = rel === "" ? "全部书籍" : rel.split("/").pop() ?? rel;
			folders.push({ relPath: rel, name, books: [] });
		};
		ensureFolder("");
		for (const folder of listing.folders) {
			const rel = folder === this.libraryDir ? "" : folder.replace(this.libraryDir.replace(/\/+$/, ""), "").replace(/^\/+/, "");
			ensureFolder(rel);
		}
		for (const [rel, books] of byDir) ensureFolder(rel);
		for (const folder of folders) {
			folder.books = byDir.get(folder.relPath) ?? [];
		}
		return folders;
	}

	/** 新建区域（文件夹）。已存在时返回 false。 */
	async createFolder(name: string): Promise<boolean> {
		const clean = name.trim().replace(/[\\/:*?"<>|]/g, "_");
		if (!clean) return false;
		const dir = this.join(this.libraryDir, clean);
		if (await this.adapter.exists(dir)) return false;
		await this.adapter.mkdir(dir);
		return true;
	}

	/** 导入文件到指定区域（relPath 为空表示根目录）。返回成功导入数。 */
	async importFiles(files: Array<{ name: string; data: ArrayBuffer }>, relPath = ""): Promise<number> {
		const dir = relPath ? this.join(this.libraryDir, relPath) : this.libraryDir;
		await this.adapter.mkdir(dir).catch(() => undefined);
		let ok = 0;
		for (const f of files) {
			const { ext } = splitPath(f.name);
			if (!SUPPORTED_BOOK_EXT.has(ext)) continue;
			const safe = f.name.replace(/[\\/:*?"<>|]/g, "_");
			await this.adapter.writeBinary(this.join(dir, safe), f.data);
			ok++;
		}
		return ok;
	}

	/** 删除一本书（文件本身）。 */
	async deleteBook(vaultPath: string): Promise<void> {
		await this.adapter.remove(vaultPath);
	}

	/** 删除整个区域（文件夹，递归）。 */
	async deleteFolder(relPath: string): Promise<void> {
		const dir = relPath ? this.join(this.libraryDir, relPath) : this.libraryDir;
		await this.adapter.remove(dir);
	}

	/** 排序（对区域内的书籍）。 */
	sortBooks(books: BookshelfBook[], sort: BookshelfSort): BookshelfBook[] {
		const list = [...books];
		switch (sort) {
			case "title":
				return list.sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name));
			case "progress":
				return list.sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0));
			case "recent":
			default:
				return list.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
		}
	}

	private join(...parts: string[]): string {
		return parts.filter(Boolean).join("/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
	}
}
