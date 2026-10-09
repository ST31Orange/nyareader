/**
 * BookshelfService：书架数据服务（书库 / 文件夹 / 书）。
 *
 * 目录模型：
 *   nyareader/library/<书库>/<文件夹>/<书>
 * - 书库 = 一级目录；
 * - 文件夹 = 二级目录；
 * - 书 = 文件（书必须放在文件夹里，书库根目录不放书）。
 *
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
	/** 移动 / 重命名文件或文件夹（对应 vault.rename）。 */
	rename(oldPath: string, newPath: string): Promise<void>;
}

/** 书架中的一本书（视图展示用）。 */
export interface BookshelfBook {
	/** vault 内绝对路径，如 nyareader/library/我的书库/科幻/a.epub */
	path: string;
	name: string;
	ext: string;
	title?: string;
	author?: string;
	/** 0~1 阅读进度 */
	progress?: number;
	lastOpenedAt?: number;
}

/** 一个书库（一级目录）。 */
export interface BookshelfLibrary {
	/** 相对 library 的路径（= 书库名） */
	relPath: string;
	name: string;
}

/** 一个书库内的文件夹（二级目录）。 */
export interface BookshelfFolder {
	/** 文件夹相对路径（相对所属书库） */
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

	private libraryPath(rel: string): string {
		return rel ? this.join(this.libraryDir, rel) : this.libraryDir;
	}

	/** 顶层书库列表（一级目录）。 */
	async loadLibraries(): Promise<BookshelfLibrary[]> {
		if (!(await this.adapter.exists(this.libraryDir))) return [];
		let listing;
		try {
			listing = await this.adapter.list(this.libraryDir);
		} catch {
			return [];
		}
		const out: BookshelfLibrary[] = [];
		const seen = new Set<string>();
		for (const folder of listing.folders) {
			const rel = this.relUnder(this.libraryDir, folder);
			if (!rel || rel.includes("/")) continue; // 只取一级目录
			if (seen.has(rel)) continue;
			seen.add(rel);
			out.push({ relPath: rel, name: rel });
		}
		return out;
	}

	/** 某书库下的文件夹（二级目录 + 各自的书）。书库根目录的书不展示（书必须进文件夹）。 */
	async loadFolders(libraryRel: string): Promise<BookshelfFolder[]> {
		const libDir = this.libraryPath(libraryRel);
		if (!libraryRel || !(await this.adapter.exists(libDir))) return [];
		let listing;
		try {
			listing = await this.adapter.list(libDir);
		} catch {
			return [];
		}
		const byDir = new Map<string, BookshelfBook[]>();
		for (const f of listing.files) {
			const { dir, base, ext } = splitPath(f);
			if (!SUPPORTED_BOOK_EXT.has(ext)) continue;
			const rel = this.relUnder(libDir, dir);
			if (!rel) continue; // 书库根目录的书不展示
			const meta = this.getMeta(f);
			byDir.set(rel, [
				...(byDir.get(rel) ?? []),
				{ path: f, name: base, ext, title: meta?.title, author: meta?.author, progress: meta?.progress, lastOpenedAt: meta?.lastOpenedAt },
			]);
		}
		const folders: BookshelfFolder[] = [];
		const seen = new Set<string>();
		const ensureFolder = (rel: string): void => {
			if (!rel || seen.has(rel) || rel.includes("/")) return; // 只取一级文件夹
			seen.add(rel);
			folders.push({ relPath: rel, name: rel, books: [] });
		};
		for (const folder of listing.folders) ensureFolder(this.relUnder(libDir, folder));
		for (const rel of byDir.keys()) ensureFolder(rel);
		for (const folder of folders) folder.books = byDir.get(folder.relPath) ?? [];
		return folders;
	}

	/** 新建书库（一级目录）。 */
	async createLibrary(name: string): Promise<boolean> {
		const clean = this.sanitize(name);
		if (!clean) return false;
		const dir = this.join(this.libraryDir, clean);
		if (await this.adapter.exists(dir)) return false;
		await this.adapter.mkdir(dir);
		return true;
	}

	/** 重命名书库（移动一级目录）。返回新的相对路径；失败/重名返回 null。 */
	async renameLibrary(oldRel: string, newName: string): Promise<string | null> {
		const clean = this.sanitize(newName);
		if (!clean || clean === oldRel) return null;
		const oldDir = this.join(this.libraryDir, oldRel);
		const newDir = this.join(this.libraryDir, clean);
		if (!(await this.adapter.exists(oldDir))) return null;
		if (await this.adapter.exists(newDir)) return null;
		await this.adapter.rename(oldDir, newDir);
		return clean;
	}

	/** 删除书库（递归，连同其中的文件夹与书）。 */
	async deleteLibrary(rel: string): Promise<void> {
		if (!rel) throw new Error("不能删除书架根目录。");
		await this.adapter.remove(this.join(this.libraryDir, rel));
	}

	/** 在书库内新建文件夹。 */
	async createFolder(libraryRel: string, name: string): Promise<boolean> {
		if (!libraryRel) return false;
		const clean = this.sanitize(name);
		if (!clean) return false;
		const dir = this.join(this.libraryDir, libraryRel, clean);
		if (await this.adapter.exists(dir)) return false;
		await this.adapter.mkdir(dir);
		return true;
	}

	/** 导入文件到书库内的文件夹（书必须进文件夹）。返回成功导入数。 */
	async importFiles(files: Array<{ name: string; data: ArrayBuffer }>, libraryRel: string, folderRel: string): Promise<number> {
		if (!libraryRel || !folderRel) return 0;
		const dir = this.join(this.libraryDir, libraryRel, folderRel);
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

	/** 删除书库内的文件夹（递归）。 */
	async deleteFolder(libraryRel: string, folderRel: string): Promise<void> {
		if (!libraryRel || !folderRel) throw new Error("不能删除书库根目录。");
		await this.adapter.remove(this.join(this.libraryDir, libraryRel, folderRel));
	}

	/** 把一本书移动到目标书库/文件夹（含跨书库）。返回新路径或 null。 */
	async moveBook(vaultPath: string, targetLibraryRel: string, targetFolderRel: string): Promise<string | null> {
		if (!targetLibraryRel || !targetFolderRel) return null;
		const dir = this.join(this.libraryDir, targetLibraryRel, targetFolderRel);
		await this.adapter.mkdir(dir).catch(() => undefined);
		const { base, ext } = splitPath(vaultPath);
		const fileName = ext ? `${base}.${ext}` : base;
		const dest = await this.uniquePath(dir, fileName);
		await this.adapter.rename(vaultPath, dest);
		return dest;
	}

	/** 生成不冲突的目标路径（同名自动加 (1)、(2)…）。 */
	private async uniquePath(dir: string, fileName: string): Promise<string> {
		const dot = fileName.lastIndexOf(".");
		const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
		const ext = dot > 0 ? fileName.slice(dot) : "";
		let candidate = this.join(dir, fileName);
		let i = 1;
		while (await this.adapter.exists(candidate)) {
			candidate = this.join(dir, `${stem} (${i})${ext}`);
			i++;
		}
		return candidate;
	}

	/** 排序（对文件夹内的书籍）。 */
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

	/** 书库名 / 文件夹名 -> 合法目录名。 */
	private sanitize(name: string): string {
		return name.trim().replace(/[\\/:*?"<>|]/g, "_");
	}

	/** path 相对 base 的路径（不在其下则返回 ""）。 */
	private relUnder(base: string, path: string): string {
		const b = base.replace(/\/+$/, "");
		if (path === b) return "";
		const prefix = b + "/";
		return path.startsWith(prefix) ? path.slice(prefix.length) : "";
	}

	private join(...parts: string[]): string {
		return parts.filter(Boolean).join("/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
	}
}