/**
 * moveFolder 的真实文件系统测试。
 *
 * ⚠️ 为什么必须用真实 FS：前几轮的迁移 bug（`ENOENT`、`Destination file already
 * exists`）全都是"只靠推理没实测"造成的。这里在真实临时目录上真的建目录、真的 rename，
 * 断言最终**磁盘状态**。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveFolder, type MovePort } from "../src/utils/move-folder";

let root = "";

/** 以真实磁盘目录实现的端口（路径用 `/`，内部转成系统分隔符）。 */
function diskPort(base: string): MovePort {
	const abs = (p: string): string => join(base, ...p.split("/").filter(Boolean));
	return {
		exists: async (p) => existsSync(abs(p)),
		mkdirp: async (p) => {
			mkdirSync(abs(p), { recursive: true });
		},
		list: async (p) => readdirSync(abs(p)),
		isDir: async (p) => {
			try {
				return statSync(abs(p)).isDirectory();
			} catch {
				return false;
			}
		},
		rename: async (from, to) => renameSync(abs(from), abs(to)),
		removeDir: async (p) => rmSync(abs(p), { recursive: true, force: true }),
	};
}

/** 造出与真实 vault 一致的目录树。 */
function seed(): void {
	mkdirSync(join(root, "nyareader", "library", "我的书库", "测试"), { recursive: true });
	mkdirSync(join(root, "nyareader", "annotations"), { recursive: true });
	mkdirSync(join(root, "日历"), { recursive: true });
	writeFileSync(join(root, "nyareader", "library", "我的书库", "测试", "a.epub"), "book-a");
	writeFileSync(join(root, "nyareader", "library", "我的书库", "b.mobi"), "book-b");
	writeFileSync(join(root, "nyareader", "annotations", "fp1.annotations.json"), "[]");
	writeFileSync(join(root, "日历", "已有笔记.md"), "keep me");
}

/** 列出某前缀下的文件（集合语义，避免依赖 locale 排序）。 */
function filesUnder(prefix: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(join(root, dir))) {
			const rel = `${dir}/${name}`;
			if (statSync(join(root, rel)).isDirectory()) walk(rel);
			else out.push(rel);
		}
	};
	const start = join(root, prefix);
	if (existsSync(start) && statSync(start).isDirectory()) walk(prefix);
	return out.sort();
}

/** 比较文件集合，失败时给出可读差异。 */
function expectFiles(prefix: string, expected: string[]): void {
	expect(new Set(filesUnder(prefix))).toEqual(new Set(expected));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "nyar-move-"));
	seed();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("moveFolder（真实文件系统）", () => {
	it("目标不存在：整棵子树搬过去，源目录消失，内容一字不差", async () => {
		const port = diskPort(root);
		const res = await moveFolder(port, "nyareader", "newhome");
		expect(res.ok).toBe(true);
		expectFiles("newhome", [
			"newhome/annotations/fp1.annotations.json",
			"newhome/library/我的书库/测试/a.epub",
			"newhome/library/我的书库/b.mobi",
		]);
		expect(existsSync(join(root, "nyareader"))).toBe(false);
	});

	it("**用户报过的 ENOENT 场景**：搬到二级不存在目录 日历/NyaReader书库", async () => {
		const port = diskPort(root);
		const res = await moveFolder(port, "nyareader", "日历/NyaReader书库");
		expect(res.error).toBeUndefined();
		expect(res.ok).toBe(true);
		expectFiles("日历/NyaReader书库", [
			"日历/NyaReader书库/annotations/fp1.annotations.json",
			"日历/NyaReader书库/library/我的书库/测试/a.epub",
			"日历/NyaReader书库/library/我的书库/b.mobi",
		]);
		// 目标目录原本已有的文件必须还在
		expect(existsSync(join(root, "日历", "已有笔记.md"))).toBe(true);
	});

	it("**用户报过的场景**：搬到二级存在目录 日历（目标里已有别的文件）", async () => {
		const port = diskPort(root);
		const res = await moveFolder(port, "nyareader", "日历/NyaReader");
		expect(res.ok).toBe(true);
		expect(filesUnder("日历/NyaReader/library")).toContain("日历/NyaReader/library/我的书库/b.mobi");
		expect(existsSync(join(root, "日历", "已有笔记.md"))).toBe(true);
	});

	it("目标已存在同名子目录且含内容 → **动手前**拒绝，磁盘上一动未动", async () => {
		// 造一个冲突：目标下已有 library 且里面有文件
		mkdirSync(join(root, "conflict", "library"), { recursive: true });
		writeFileSync(join(root, "conflict", "library", "existing.epub"), "existing");
		const port = diskPort(root);
		const res = await moveFolder(port, "nyareader", "conflict");
		expect(res.ok).toBe(false);
		expect(res.moved).toBe(0);
		expect(res.conflicts?.some((c) => c.endsWith("/library"))).toBe(true);
		// 源完全没动
		expectFiles("nyareader", [
			"nyareader/annotations/fp1.annotations.json",
			"nyareader/library/我的书库/测试/a.epub",
			"nyareader/library/我的书库/b.mobi",
		]);
		// 目标里的东西也没动
		expect(existsSync(join(root, "conflict", "library", "existing.epub"))).toBe(true);
	});

	it("源目录不存在 → 明确报错，不抛异常", async () => {
		const res = await moveFolder(diskPort(root), "no-such-dir", "newhome");
		expect(res.ok).toBe(false);
		expect(res.error).toContain("不存在");
	});

	it("目标在源内部 → 拒绝（不会自己搬自己）", async () => {
		const res = await moveFolder(diskPort(root), "nyareader", "nyareader/inner");
		expect(res.ok).toBe(false);
		expect(res.error).toContain("内部");
	});

	it("多级深目录（三级）也能搬，且空目录不留残余", async () => {
		mkdirSync(join(root, "a", "b", "c"), { recursive: true });
		writeFileSync(join(root, "a", "b", "c", "deep.txt"), "deep");
		const port = diskPort(root);
		const res = await moveFolder(port, "a", "deep/x/y/z");
		expect(res.ok).toBe(true);
		expect(res.moved).toBe(1);
		// 原 a 消失，内容在 deep/x/y/z/b/c
		expect(existsSync(join(root, "a"))).toBe(false);
		expect(existsSync(join(root, "deep", "x", "y", "z", "b", "c", "deep.txt"))).toBe(true);
	});

	it("源是空目录 → 也能搬（只是把目标建出来）", async () => {
		mkdirSync(join(root, "empty-src"), { recursive: true });
		const res = await moveFolder(diskPort(root), "empty-src", "target-here");
		expect(res.ok).toBe(true);
		expect(existsSync(join(root, "target-here"))).toBe(true);
	});

	it("rename 中途失败 → 逆序回滚，源目录内容回到原位", async () => {
		const real = diskPort(root);
		let calls = 0;
		// 只让"第 2 次"rename 失败（模拟搬到一半磁盘满/权限错误）；
		// 之后放行，以便回滚操作能真的把文件搬回去。
		const flaky: MovePort = {
			...real,
			rename: async (from, to) => {
				calls++;
				if (calls === 2) throw new Error("ENOSPC: no space left on device");
				await real.rename(from, to);
			},
		};
		const res = await moveFolder(flaky, "nyareader", "newhome2");
		expect(res.ok).toBe(false);
		expect(res.error).toContain("ENOSPC");
		expect(res.rolledBack).toBe(true);
		// 回滚后：源内容完整回到原位（文件数量与原一致），目标里不留搬过去的文件
		expectFiles("nyareader", [
			"nyareader/annotations/fp1.annotations.json",
			"nyareader/library/我的书库/测试/a.epub",
			"nyareader/library/我的书库/b.mobi",
		]);
		expect(filesUnder("newhome2")).toEqual([]);
	});
});
