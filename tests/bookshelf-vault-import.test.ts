/**
 * 收书（从 Obsidian 文件栏拖进书架）+ 撤销 的单测。
 *
 * 用户诉求：文件栏拖书进书架"什么也不发生"。
 * 根因：Obsidian 内部拖动不走 `dataTransfer.files`，而旧实现只处理 files。
 * 现在补齐"把 vault 里已有的书收进书库"这条路，语义 = **移动**，并支持撤销（C 方案）。
 */
import { describe, expect, it } from "vitest";
import { BookshelfService, type BookshelfAdapter } from "../src/services/storage/BookshelfService";

/** 内存适配器：够用的文件/目录集合 + 真实 rename/remove 语义。 */
function memAdapter(files: string[], folders: string[] = []) {
	const f = new Set(files);
	const d = new Set(folders);
	const adapter: BookshelfAdapter & { files: Set<string>; folders: Set<string> } = {
		files: f,
		folders: d,
		async list(path) {
			const prefix = path.replace(/\/+$/, "") + "/";
			return { files: [...f].filter((x) => x.startsWith(prefix)), folders: [...d].filter((x) => x.startsWith(prefix)) };
		},
		async mkdir(p) {
			d.add(p.replace(/\/+$/, ""));
		},
		async exists(p) {
			const clean = p.replace(/\/+$/, "");
			if (f.has(clean) || d.has(clean)) return true;
			const prefix = clean + "/";
			return [...f].some((x) => x.startsWith(prefix)) || [...d].some((x) => x.startsWith(prefix));
		},
		async readBinary() {
			return new ArrayBuffer(0);
		},
		async writeBinary(p) {
			f.add(p);
		},
		async remove(p) {
			f.delete(p);
			d.delete(p.replace(/\/+$/, ""));
		},
		async rename(from, to) {
			const a = from.replace(/\/+$/, "");
			const b = to.replace(/\/+$/, "");
			if (f.has(a)) {
				f.delete(a);
				f.add(b);
				return;
			}
			if (d.has(a)) {
				d.delete(a);
				d.add(b);
				for (const x of [...f]) if (x.startsWith(`${a}/`)) { f.delete(x); f.add(b + x.slice(a.length)); }
				for (const x of [...d]) if (x.startsWith(`${a}/`)) { d.delete(x); d.add(b + x.slice(a.length)); }
			}
		},
	};
	return adapter;
}

const LIB = "nyareader/library";

function mk(adapter: BookshelfAdapter): BookshelfService {
	return new BookshelfService(adapter, LIB, () => undefined);
}

describe("importVaultBooks：把 vault 里已有的书收进书库", () => {
	it("库外的书 → 移动进目标文件夹（不是复制）", async () => {
		const a = memAdapter(["books/三体.epub", `${LIB}/我的书库/科幻/.keep`]);
		const svc = mk(a);
		const { imported, results } = await svc.importVaultBooks(["books/三体.epub"], "我的书库", "科幻", "move");
		expect(imported).toBe(1);
		expect(results[0].ok).toBe(true);
		expect(results[0].dest).toBe(`${LIB}/我的书库/科幻/三体.epub`);
		expect(a.files.has(`${LIB}/我的书库/科幻/三体.epub`)).toBe(true);
		expect(a.files.has("books/三体.epub")).toBe(false); // 移走了，没留副本
	});

	it("已在书库内、拖到**另一个文件夹** → 移动（不重复收）", async () => {
		const a = memAdapter([`${LIB}/我的书库/未分类/三体.epub`]);
		const svc = mk(a);
		const { imported } = await svc.importVaultBooks([`${LIB}/我的书库/未分类/三体.epub`], "我的书库", "科幻", "move");
		expect(imported).toBe(1);
		expect(a.files.has(`${LIB}/我的书库/科幻/三体.epub`)).toBe(true);
		expect(a.files.has(`${LIB}/我的书库/未分类/三体.epub`)).toBe(false);
	});

	it("拖到它**已经在的那个文件夹** → 无操作并说明原因", async () => {
		const a = memAdapter([`${LIB}/我的书库/科幻/三体.epub`]);
		const svc = mk(a);
		const { imported, results } = await svc.importVaultBooks([`${LIB}/我的书库/科幻/三体.epub`], "我的书库", "科幻", "move");
		expect(imported).toBe(0);
		expect(results[0].error).toContain("已经在这个文件夹");
		expect(a.files.has(`${LIB}/我的书库/科幻/三体.epub`)).toBe(true);
	});

	it("同名冲突 → 自动改成 (1)，**绝不覆盖**", async () => {
		const a = memAdapter(["books/三体.epub", `${LIB}/我的书库/科幻/三体.epub`]);
		const svc = mk(a);
		const { imported, results } = await svc.importVaultBooks(["books/三体.epub"], "我的书库", "科幻", "move");
		expect(imported).toBe(1);
		expect(results[0].dest).toBe(`${LIB}/我的书库/科幻/三体 (1).epub`);
		// 原有的那本没被动过
		expect(a.files.has(`${LIB}/我的书库/科幻/三体.epub`)).toBe(true);
	});

	it("非电子书 / 不存在的路径 → 跳过（不误搬）", async () => {
		const a = memAdapter(["books/cover.png", "books/data.json"]);
		const svc = mk(a);
		const { imported } = await svc.importVaultBooks(["books/cover.png", "books/data.json", "books/幽灵.epub"], "我的书库", "科幻", "move");
		expect(imported).toBe(0);
		expect(a.files.has("books/cover.png")).toBe(true);
	});

	it("多本一次拖入，逐本处理", async () => {
		const a = memAdapter(["books/a.epub", "books/b.mobi", "books/c.azw3"]);
		const svc = mk(a);
		const { imported } = await svc.importVaultBooks(["books/a.epub", "books/b.mobi", "books/c.azw3"], "我的书库", "科幻", "move");
		expect(imported).toBe(3);
		for (const n of ["a.epub", "b.mobi", "c.azw3"]) expect(a.files.has(`${LIB}/我的书库/科幻/${n}`)).toBe(true);
	});

	it("copy 模式：库外的书复制进来，原文件保留", async () => {
		const a = memAdapter(["books/三体.epub"]);
		const svc = mk(a);
		const { imported } = await svc.importVaultBooks(["books/三体.epub"], "我的书库", "科幻", "copy");
		expect(imported).toBe(1);
		expect(a.files.has("books/三体.epub")).toBe(true);
		expect(a.files.has(`${LIB}/我的书库/科幻/三体.epub`)).toBe(true);
	});

	it("书旁的旧批注侧车跟着书一起搬（不留孤儿）", async () => {
		const a = memAdapter(["books/三体.epub", "books/三体.epub.annotations.json", "books/三体.annotations.json"]);
		const svc = mk(a);
		await svc.importVaultBooks(["books/三体.epub"], "我的书库", "科幻", "move");
		expect(a.files.has(`${LIB}/我的书库/科幻/三体.epub.annotations.json`)).toBe(true);
		expect(a.files.has(`${LIB}/我的书库/科幻/三体.annotations.json`)).toBe(true);
		expect(a.files.has("books/三体.epub.annotations.json")).toBe(false);
	});

	it("撤销：书与侧车都回到原位置", async () => {
		const a = memAdapter(["books/三体.epub", "books/三体.epub.annotations.json"]);
		const svc = mk(a);
		const { results } = await svc.importVaultBooks(["books/三体.epub"], "我的书库", "科幻", "move");
		expect(a.files.has(`${LIB}/我的书库/科幻/三体.epub`)).toBe(true);

		const ok = await svc.undoImport(results[0]);
		expect(ok).toBe(true);
		expect(a.files.has("books/三体.epub")).toBe(true);
		expect(a.files.has("books/三体.epub.annotations.json")).toBe(true);
		expect(a.files.has(`${LIB}/我的书库/科幻/三体.epub`)).toBe(false);
	});

	it("撤销 copy 模式：删掉复制出来的那份，原文件不受影响", async () => {
		const a = memAdapter(["books/三体.epub"]);
		const svc = mk(a);
		const { results } = await svc.importVaultBooks(["books/三体.epub"], "我的书库", "科幻", "copy");
		expect(await svc.undoImport(results[0])).toBe(true);
		expect(a.files.has("books/三体.epub")).toBe(true);
		expect(a.files.has(`${LIB}/我的书库/科幻/三体.epub`)).toBe(false);
	});
});

describe("isInsideLibrary：前缀判定（兼容自定义书架目录）", () => {
	it("书库内/外判定正确，且不依赖层级数", () => {
		const svc = mk(memAdapter([]));
		expect(svc.isInsideLibrary(`${LIB}/我的书库/科幻/a.epub`)).toBe(true);
		expect(svc.isInsideLibrary(`${LIB}/a/b/c/d/e.epub`)).toBe(true);
		expect(svc.isInsideLibrary("books/a.epub")).toBe(false);
		// 前缀相似但不同目录，不能误判为"在库内"
		expect(svc.isInsideLibrary("nyareader/library2/a.epub")).toBe(false);
	});

	it("自定义书架目录同样成立", () => {
		const svc = new BookshelfService(memAdapter([]), "我的书籍/书库", () => undefined);
		expect(svc.isInsideLibrary("我的书籍/书库/科幻/a.epub")).toBe(true);
		expect(svc.isInsideLibrary("我的书籍/别的/a.epub")).toBe(false);
	});
});
