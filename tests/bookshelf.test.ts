/**
 * BookshelfService 单测：目录扫描分组、新建区域、导入、删除、排序、路径拆分。
 */
import { describe, it, expect } from "vitest";
import { BookshelfService, BookshelfAdapter, splitPath, SUPPORTED_BOOK_EXT } from "../src/services/storage/BookshelfService";
import type { BookFormat } from "../src/types";

/** 内存版 adapter，模拟 nyareader/library/ 下的文件树。 */
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
			// 目录本身不在集合但存在子项时也算存在（贴近真实 DataAdapter）
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
	};
}

const LIB = "nyareader/library";

describe("splitPath", () => {
	it("拆分目录/文件名/扩展名", () => {
		expect(splitPath("nyareader/library/科幻/a.epub")).toEqual({ dir: "nyareader/library/科幻", base: "a", ext: "epub" });
		expect(splitPath("root/book.PDF")).toEqual({ dir: "root", base: "book", ext: "pdf" });
	});
	it("支持反斜杠", () => {
		expect(splitPath("nyareader\\library\\b.txt").base).toBe("b");
	});
});

describe("BookshelfService.loadBooks", () => {
	it("按子文件夹分组，忽略不支持格式", async () => {
		const adapter = memAdapter(
			[
				"nyareader/library/root.pdf",
				"nyareader/library/科幻/a.epub",
				"nyareader/library/科幻/b.mobi",
				"nyareader/library/科幻/note.md",
			],
			["nyareader/library/科幻"]
		);
		const svc = new BookshelfService(adapter, LIB, () => ({ title: "T", author: "A", progress: 0.5, lastOpenedAt: 1000 }));
		const folders = await svc.loadBooks();
		expect(folders.length).toBe(2);
		const root = folders.find((f) => f.relPath === "")!;
		const scifi = folders.find((f) => f.relPath === "科幻")!;
		expect(root.books.map((b) => b.name)).toEqual(["root"]);
		expect(scifi.books.map((b) => b.name)).toEqual(["a", "b"]);
		expect(scifi.books[0].author).toBe("A");
	});
	it("library 目录不存在时返回空列表", async () => {
		const adapter = memAdapter([], []);
		const svc = new BookshelfService(adapter, LIB, () => undefined);
		expect(await svc.loadBooks()).toEqual([]);
	});
});

describe("BookshelfService.createFolder / importFiles / delete", () => {
	it("新建区域并去除非安全字符", async () => {
		const adapter = memAdapter([], []);
		const svc = new BookshelfService(adapter, LIB, () => undefined);
		expect(await svc.createFolder(" 玄幻/新 ")).toBe(true);
		expect(await svc.createFolder(" 玄幻/新 ")).toBe(false); // 已存在
	});
	it("导入文件写入目标区域并过滤不支持格式", async () => {
		const adapter = memAdapter([], []);
		const svc = new BookshelfService(adapter, LIB, () => undefined);
		const data = new TextEncoder().encode("abc").buffer as ArrayBuffer;
		const ok = await svc.importFiles([{ name: "x.epub", data }, { name: "y.md", data }], "科幻");
		expect(ok).toBe(1);
		expect(adapter.writes[0].path).toBe("nyareader/library/科幻/x.epub");
	});
	it("删除书与删除区域", async () => {
		const adapter = memAdapter(["nyareader/library/a.epub"], ["nyareader/library/子"]);
		const svc = new BookshelfService(adapter, LIB, () => undefined);
		await svc.deleteBook("nyareader/library/a.epub");
		expect(adapter.removed).toContain("nyareader/library/a.epub");
		await svc.deleteFolder("子");
		expect(adapter.removed).toContain("nyareader/library/子");
	});
	it("拒绝删除书架根目录（防御性护栏）", async () => {
		const adapter = memAdapter(["nyareader/library/a.epub"], []);
		const svc = new BookshelfService(adapter, LIB, () => undefined);
		await expect(svc.deleteFolder("")).rejects.toThrow(/根目录/);
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
	it("覆盖全部目标格式", () => {
		for (const ext of ["epub", "pdf", "mobi", "azw3", "azw", "txt"]) expect(SUPPORTED_BOOK_EXT.has(ext)).toBe(true);
	});
	it("不含其它类型", () => {
		expect(SUPPORTED_BOOK_EXT.has("md")).toBe(false);
	});
});
