/**
 * BookshelfService 单测：书库/文件夹扫描、新建、导入、删除、重命名、移动、排序、路径拆分。
 */
import { describe, it, expect } from "vitest";
import { BookshelfService, BookshelfAdapter, splitPath, SUPPORTED_BOOK_EXT } from "../src/services/storage/BookshelfService";

/** 内存版 adapter，模拟 nyareader/library/ 下的文件树（书库/文件夹/书）。 */
function memAdapter(initialFiles: string[], initialFolders: string[]): BookshelfAdapter & { files: Set<string>; folders: Set<string>; removed: string[]; writes: Array<{ path: string; data: ArrayBuffer }> } {
	const files = new Set(initialFiles);
	const folders = new Set(initialFolders);
	const removed: string[] = [];
	const writes: Array<{ path: string; data: ArrayBuffer }> = [];
	return {
		files,
		folders,
		removed,
		writes,
		async list(path: string) {
			const prefix = path.replace(/\/+$/, "") + "/";
			const fs = [...files].filter((f) => f.startsWith(prefix) || (path === "" && !f.includes("/")));
			const fds = [...folders].filter((f) => f.startsWith(prefix));
			return { files: fs, folders: fds };
		},
		async mkdir(p) {
			folders.add(p.replace(/\/+$/, ""));
		},
		async exists(p) {
			const clean = p.replace(/\/+$/, "");
			if (files.has(clean) || folders.has(clean)) return true;
			const prefix = clean + "/";
			for (const f of files) if (f.startsWith(prefix)) return true;
			for (const f of folders) if (f.startsWith(prefix)) return true;
			return false;
		},
		async readBinary() {
			return new ArrayBuffer(0);
		},
		async writeBinary(p, d) {
			files.add(p);
			writes.push({ path: p, data: d });
		},
		async remove(p) {
			files.delete(p);
			folders.delete(p.replace(/\/+$/, ""));
			removed.push(p);
		},
		async rename(oldPath, newPath) {
			const oldClean = oldPath.replace(/\/+$/, "");
			const newClean = newPath.replace(/\/+$/, "");
			if (files.has(oldClean)) {
				files.delete(oldClean);
				files.add(newClean);
				return;
			}
			if (folders.has(oldClean)) {
				folders.delete(oldClean);
				folders.add(newClean);
				const prefix = oldClean + "/";
				for (const f of [...files]) if (f.startsWith(prefix)) { files.delete(f); files.add(newClean + f.slice(oldClean.length)); }
				for (const d of [...folders]) if (d.startsWith(prefix)) { folders.delete(d); folders.add(newClean + d.slice(oldClean.length)); }
			}
		},
	};
}

const LIB = "nyareader/library";

describe("splitPath", () => {
	it("拆分目录/文件名/扩展名", () => {
		expect(splitPath("nyareader/library/我的书库/科幻/a.epub")).toEqual({ dir: "nyareader/library/我的书库/科幻", base: "a", ext: "epub" });
		expect(splitPath("root/book.PDF")).toEqual({ dir: "root", base: "book", ext: "pdf" });
	});
	it("支持反斜杠", () => {
		expect(splitPath("nyareader\\library\\b.txt").base).toBe("b");
	});
});

describe("BookshelfService.loadLibraries / loadFolders", () => {
	it("顶层目录为书库（只取一级）", async () => {
		const adapter = memAdapter(
			["nyareader/library/我的书库/科幻/a.epub"],
			["nyareader/library/我的书库", "nyareader/library/我的书库/科幻", "nyareader/library/英语"]
		);
		const svc = new BookshelfService(adapter, LIB, () => undefined);
		const libs = await svc.loadLibraries();
		expect(libs.map((l) => l.relPath).sort()).toEqual(["我的书库", "英语"]);
	});
	it("书库内按文件夹分组，忽略书库根目录书；md 也算书", async () => {
		const adapter = memAdapter(
			[
				"nyareader/library/我的书库/root.pdf",
				"nyareader/library/我的书库/科幻/a.epub",
				"nyareader/library/我的书库/科幻/b.mobi",
				"nyareader/library/我的书库/科幻/note.md",
				"nyareader/library/我的书库/科幻/cover.png",
			],
			["nyareader/library/我的书库", "nyareader/library/我的书库/科幻"]
		);
		const svc = new BookshelfService(adapter, LIB, () => ({ title: "T", author: "A", progress: 0.5, lastOpenedAt: 1000 }));
		const folders = await svc.loadFolders("我的书库");
		expect(folders.length).toBe(1);
		expect(folders[0].relPath).toBe("科幻");
		// md 进书架（当书管理），png 这类非书文件被过滤
		expect(folders[0].books.map((b) => b.name)).toEqual(["a", "b", "note"]);
		expect(folders[0].books[0].author).toBe("A");
	});
	it("library 目录不存在时返回空", async () => {
		const adapter = memAdapter([], []);
		const svc = new BookshelfService(adapter, LIB, () => undefined);
		expect(await svc.loadLibraries()).toEqual([]);
		expect(await svc.loadFolders("我的书库")).toEqual([]);
	});
});

describe("BookshelfService.create / import / delete / rename / move", () => {
	it("新建书库与文件夹并去除非安全字符", async () => {
		const adapter = memAdapter([], []);
		const svc = new BookshelfService(adapter, LIB, () => undefined);
		expect(await svc.createLibrary(" 我的书库 ")).toBe(true);
		expect(await svc.createLibrary(" 我的书库 ")).toBe(false);
		expect(await svc.createFolder("我的书库", " 玄幻/新 ")).toBe(true);
		expect(await svc.createFolder("我的书库", " 玄幻/新 ")).toBe(false);
	});
	it("导入文件写入书库内的文件夹并过滤不支持格式（md 现在算书）", async () => {
		const adapter = memAdapter([], []);
		const svc = new BookshelfService(adapter, LIB, () => undefined);
		const data = new TextEncoder().encode("abc").buffer as ArrayBuffer;
		const ok = await svc.importFiles(
			[{ name: "x.epub", data }, { name: "y.md", data }, { name: "z.png", data }],
			"我的书库",
			"科幻"
		);
		expect(ok).toBe(2); // x.epub + y.md；z.png 被过滤
		expect(adapter.writes.map((w) => w.path)).toEqual([
			"nyareader/library/我的书库/科幻/x.epub",
			"nyareader/library/我的书库/科幻/y.md",
		]);
	});
	it("重命名书库（移动一级目录）", async () => {
		const adapter = memAdapter(["nyareader/library/旧库/科幻/a.epub"], ["nyareader/library/旧库", "nyareader/library/旧库/科幻"]);
		const svc = new BookshelfService(adapter, LIB, () => undefined);
		const newRel = await svc.renameLibrary("旧库", "新库");
		expect(newRel).toBe("新库");
		expect(adapter.files.has("nyareader/library/新库/科幻/a.epub")).toBe(true);
	});
	it("移动书籍到另一书库的文件夹", async () => {
		const adapter = memAdapter(["nyareader/library/A/科幻/a.epub"], ["nyareader/library/A", "nyareader/library/A/科幻", "nyareader/library/B"]);
		const svc = new BookshelfService(adapter, LIB, () => undefined);
		const dest = await svc.moveBook("nyareader/library/A/科幻/a.epub", "B", "历史");
		expect(dest).toBe("nyareader/library/B/历史/a.epub");
		expect(adapter.files.has("nyareader/library/B/历史/a.epub")).toBe(true);
	});
	it("删除书、文件夹、书库", async () => {
		const adapter = memAdapter(["nyareader/library/A/科幻/a.epub"], ["nyareader/library/A", "nyareader/library/A/科幻"]);
		const svc = new BookshelfService(adapter, LIB, () => undefined);
		await svc.deleteBook("nyareader/library/A/科幻/a.epub");
		expect(adapter.removed).toContain("nyareader/library/A/科幻/a.epub");
		await svc.deleteFolder("A", "科幻");
		expect(adapter.removed).toContain("nyareader/library/A/科幻");
		await svc.deleteLibrary("A");
		expect(adapter.removed).toContain("nyareader/library/A");
	});
	it("拒绝删除书库根目录（防御性护栏）", async () => {
		const adapter = memAdapter([], []);
		const svc = new BookshelfService(adapter, LIB, () => undefined);
		await expect(svc.deleteLibrary("")).rejects.toThrow(/根目录/);
		await expect(svc.deleteFolder("", "x")).rejects.toThrow(/根目录/);
		expect(adapter.removed).toHaveLength(0);
	});
});

describe("BookshelfService.sortBooks", () => {
	const mk = (title: string, progress: number, lastOpenedAt: number) => ({ path: "", name: title, ext: "epub", title, progress, lastOpenedAt });
	it("按最近阅读 / 书名 / 进度排序", async () => {
		const adapter = memAdapter([], []);
		const svc = new BookshelfService(adapter, LIB, () => undefined);
		const books = [mk("b", 0.9, 100), mk("a", 0.1, 300), mk("c", 0.5, 200)];
		expect(svc.sortBooks(books, "recent").map((b) => b.title)).toEqual(["a", "c", "b"]);
		expect(svc.sortBooks(books, "title").map((b) => b.title)).toEqual(["a", "b", "c"]);
		expect(svc.sortBooks(books, "progress").map((b) => b.title)).toEqual(["b", "c", "a"]);
	});
});

describe("SUPPORTED_BOOK_EXT", () => {
	it("覆盖全部目标格式（含 md：可以当书放进书架）", () => {
		for (const ext of ["epub", "pdf", "mobi", "azw3", "azw", "txt", "md", "markdown"]) {
			expect(SUPPORTED_BOOK_EXT.has(ext)).toBe(true);
		}
	});
	it("不含非书类型", () => {
		for (const ext of ["png", "jpg", "json", "pdfx", "txtx"]) expect(SUPPORTED_BOOK_EXT.has(ext)).toBe(false);
	});
});