/**
 * 批注侧车与路径解耦的单测（回归：移动书/换书库后批注丢失）。
 *
 * 背景：旧侧车存在书旁边，而书架移动书只 rename 了书文件本身 →
 * 单本书一移动，批注就读不到。本测试锁死"按内容指纹存"之后的行为：
 * 1. 同一本书换路径后仍读到同一批批注；
 * 2. 旧位置（书旁 v2 / v1）只读兼容且**读到即迁移**，旧文件永不删除/改写；
 * 3. 占位指纹（`pending-…`）与非法指纹**拒绝落盘**（否则会串书）；
 * 4. 跨书隔离：不同指纹互不可见。
 */
import { describe, expect, it } from "vitest";
import {
	annotationDirForBookshelf,
	annotationSidecarDir,
	bookSidecarPathV1,
	bookSidecarPathV2,
	DEFAULT_FINGERPRINT_SIDECAR_DIR,
	fingerprintSidecarPath,
	isValidFingerprint,
	legacySidecarPaths,
	planSidecarMigration,
	setAnnotationSidecarDir,
} from "../src/utils/annotation-sidecar-path";
import {
	FingerprintAnnotationStore,
	type FingerprintSidecarAdapter,
} from "../src/services/annotations/FingerprintAnnotationStore";
import { SidecarAnnotationStore } from "../src/services/annotations/SidecarAnnotationStore";
import { resolveMoveTarget } from "../src/utils/move-folder";

const FP = "9f56ae4d159cd3609e48c49ea89acc39";
const FP2 = "abcf4c5bf198f014047a62f158bc39c9";

/** 内存文件系统适配器（记录写入，便于断言"旧文件未被改写"）。 */
function makeFs(initial: Record<string, string> = {}): FingerprintSidecarAdapter & {
	files: Map<string, string>;
	writes: string[];
} {
	const files = new Map<string, string>(Object.entries(initial));
	const writes: string[] = [];
	const fs = {
		files,
		writes,
		read: async (p: string) => {
			const v = files.get(p);
			if (v === undefined) throw new Error(`ENOENT ${p}`);
			return v;
		},
		write: async (p: string, data: string) => {
			files.set(p, data);
			writes.push(p);
		},
		exists: async (p: string) => files.has(p),
		mkdir: async () => undefined,
	};
	return fs as FingerprintSidecarAdapter & { files: Map<string, string>; writes: string[] };
}

function v2File(annotations: unknown[], fingerprint = FP): string {
	return JSON.stringify({ version: 2, bookFingerprint: fingerprint, annotations });
}

const SAMPLE = {
	id: "a1",
	kind: "highlight",
	bookFingerprint: FP,
	location: "1200",
	target: { location: "1200" },
	text: "被高亮的原文",
	color: "purple",
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_000_000,
};

describe("路径计算", () => {
	it("主存储路径与书位置无关", () => {
		expect(fingerprintSidecarPath(FP)).toBe(`${annotationDirForBookshelf("nyareader/library")}/${FP}.annotations.json`);
	});

	it("旧位置候选：书旁 v2 → v1（顺序固定；无扩展名时追加 .v2 变体）", () => {
		const book = "library/我的书库/测试/银河帝国.epub";
		expect(bookSidecarPathV2(book)).toBe(`${book}.annotations.json`);
		expect(bookSidecarPathV1(book)).toBe("library/我的书库/测试/银河帝国.annotations.json");
		const paths = legacySidecarPaths(book);
		expect(paths[0]).toBe(bookSidecarPathV2(book));
		expect(paths[1]).toBe(bookSidecarPathV1(book));
		// 带扩展名的书不会产生第三个候选
		expect(paths).toHaveLength(2);
	});

	it("无扩展名的书：v2 不会落在 v1 路径上", () => {
		const book = "library/lib/folder/MyBook";
		expect(bookSidecarPathV2(book)).toBe(`${book}.annotations.v2.json`);
		expect(bookSidecarPathV1(book)).toBe(`${book}.annotations.json`);
	});

	it("指纹校验：合法的 32 位十六进制通过；占位与穿越被拒", () => {
		expect(isValidFingerprint(FP)).toBe(true);
		expect(isValidFingerprint("pending-1a2b3c4d")).toBe(false); // 解析期占位指纹
		expect(isValidFingerprint("../../etc/passwd")).toBe(false);
		expect(isValidFingerprint("a/b")).toBe(false);
		expect(isValidFingerprint("")).toBe(false);
		expect(isValidFingerprint("short")).toBe(false);
		expect(isValidFingerprint(undefined)).toBe(false);
	});
});

describe("planSidecarMigration", () => {
	it("主存储已存在时：只读主存储，不需要迁移", async () => {
		const plan = await planSidecarMigration({
			fingerprint: FP,
			bookPath: "library/lib/f/book.epub",
			exists: (p) => p === fingerprintSidecarPath(FP),
		});
		expect(plan.primaryPath).toBe(fingerprintSidecarPath(FP));
		expect(plan.shouldMigrate).toBe(false);
		expect(plan.readCandidates[0]).toBe(fingerprintSidecarPath(FP));
	});

	it("书旁有 v2 时：候选包含主存储与旧位置，且需要迁移", async () => {
		const book = "library/lib/f/book.epub";
		const plan = await planSidecarMigration({
			fingerprint: FP,
			bookPath: book,
			exists: (p) => p === bookSidecarPathV2(book),
		});
		expect(plan.legacyExisting).toEqual([bookSidecarPathV2(book)]);
		expect(plan.shouldMigrate).toBe(true);
		expect(plan.readCandidates).toContain(bookSidecarPathV2(book));
	});

	it("指纹非法时不给主存储路径（宁可不迁移，也不写到会串书的位置）", async () => {
		const plan = await planSidecarMigration({
			fingerprint: "pending-abc12345",
			bookPath: "library/lib/f/book.epub",
			exists: () => true,
		});
		expect(plan.primaryPath).toBeNull();
		expect(plan.shouldMigrate).toBe(false);
	});
});

describe("FingerprintAnnotationStore（核心：移动后批注仍在）", () => {
	it("同一本书换路径（换文件夹/换书库）后仍读到同一批批注", async () => {
		const fs = makeFs();
		const store = new FingerprintAnnotationStore(fs);
		const before = "library/我的书库/未分类/银河帝国.epub";
		await store.write(FP, [SAMPLE as never], before);

		// 模拟"移动到另一个书库/文件夹"：书路径变了，指纹不变
		const after = "library/另一个书库/科幻/银河帝国.epub";
		const read = await store.readWithReport(FP, after);
		expect(read.source).toBe("fingerprint");
		expect(read.annotations).toHaveLength(1);
		expect(read.annotations[0].id).toBe("a1");
		expect(read.annotations[0].color).toBe("purple");
		// 实际读取路径与书位置无关
		expect(read.readPath).toBe(fingerprintSidecarPath(FP));
	});

	it("旧位置（书旁 v2）读到即迁移到指纹存储，且旧文件内容不变", async () => {
		const book = "library/lib/f/book.epub";
		const legacy = bookSidecarPathV2(book);
		const legacyRaw = v2File([SAMPLE]);
		const fs = makeFs({ [legacy]: legacyRaw });
		const store = new FingerprintAnnotationStore(fs);

		const read = await store.readWithReport(FP, book);
		expect(read.source).toBe("legacy-migrated");
		expect(read.migrated).toBe(true);
		expect(read.annotations).toHaveLength(1);
		// 旧文件字节未变（硬约束）
		expect(fs.files.get(legacy)).toBe(legacyRaw);
		// 已写入指纹主存储
		expect(fs.files.has(fingerprintSidecarPath(FP))).toBe(true);
	});

	it("迁移后即使原书旁文件被删除，仍能从指纹存储读到", async () => {
		const book = "library/lib/f/book.epub";
		const fs = makeFs({ [bookSidecarPathV2(book)]: v2File([SAMPLE]) });
		const store = new FingerprintAnnotationStore(fs);
		await store.read(FP, book);
		fs.files.delete(bookSidecarPathV2(book)); // 用户手动清理旧文件
		const again = await store.read(FP, "library/other/lib/book.epub");
		expect(again).toHaveLength(1);
		expect(again[0].id).toBe("a1");
	});

	it("v1（书旁、去扩展名、缺锚点）也能读并升级成锚点模型", async () => {
		const book = "library/lib/f/book.epub";
		const v1 = bookSidecarPathV1(book);
		const fs = makeFs({
			[v1]: JSON.stringify({ version: 1, annotations: [{ text: "老批注", location: "3000", kind: "highlight" }] }),
		});
		const store = new FingerprintAnnotationStore(fs);
		const read = await store.readWithReport(FP, book);
		expect(read.source).toBe("legacy-migrated");
		expect(read.annotations).toHaveLength(1);
		expect(read.annotations[0].text).toBe("老批注");
		expect(read.annotations[0].anchor?.quote.exact).toBe("老批注");
		expect(fs.files.get(v1)).toContain("老批注"); // 旧文件未被改写
	});

	it("占位/非法指纹拒绝落盘（不会串书）", async () => {
		const fs = makeFs();
		const store = new FingerprintAnnotationStore(fs);
		await expect(store.write("pending-abc12345", [SAMPLE as never], "x.epub")).rejects.toThrow(/指纹非法/);
		expect(fs.writes).toHaveLength(0);
	});

	it("不同指纹互相隔离（两本书的批注不会串）", async () => {
		const fs = makeFs();
		const store = new FingerprintAnnotationStore(fs);
		await store.addForBook(FP, "a.epub", { bookFingerprint: FP, location: "1", target: { location: "1" }, text: "书A", kind: "highlight" } as never);
		await store.addForBook(FP2, "b.epub", { bookFingerprint: FP2, location: "2", target: { location: "2" }, text: "书B", kind: "highlight" } as never);
		expect((await store.read(FP)).map((a) => a.text)).toEqual(["书A"]);
		expect((await store.read(FP2)).map((a) => a.text)).toEqual(["书B"]);
	});

	it("增 / 改色 / 删 都作用在指纹存储上（移动后同样有效）", async () => {
		const fs = makeFs();
		const store = new FingerprintAnnotationStore(fs);
		const a = await store.addForBook(FP, "old/path/book.epub", {
			bookFingerprint: FP,
			location: "100",
			target: { location: "100" },
			text: "句子",
			kind: "highlight",
		} as never);
		// 移动后再改色 + 删除，仍命中同一条
		await store.updateForBook(FP, "new/path/book.epub", a.id, { color: "green" });
		expect((await store.read(FP, "new/path/book.epub"))[0].color).toBe("green");
		await store.removeForBook(FP, "new/path/book.epub", a.id);
		expect(await store.read(FP, "new/path/book.epub")).toHaveLength(0);
	});

	it("坏 JSON 只读不写（不写坏用户数据）", async () => {
		const fs = makeFs({ [fingerprintSidecarPath(FP)]: "{ 坏掉的 json" });
		const store = new FingerprintAnnotationStore(fs);
		expect(await store.read(FP)).toEqual([]);
		expect(fs.writes).toHaveLength(0);
	});
});

describe("SidecarAnnotationStore 指纹优先（实际接线后的行为）", () => {
	it("有合法指纹时：主存储写在指纹路径，不在书旁边", async () => {
		const fs = makeFs();
		const store = new SidecarAnnotationStore(fs);
		await store.writeForBook("library/lib/f/book.epub", [SAMPLE as never], FP);
		expect(fs.files.has(fingerprintSidecarPath(FP))).toBe(true);
		expect(fs.files.has(bookSidecarPathV2("library/lib/f/book.epub"))).toBe(false);
	});

	it("移动书后（路径变了、指纹不变）仍读到同一批", async () => {
		const fs = makeFs();
		const store = new SidecarAnnotationStore(fs);
		await store.writeForBook("library/我的书库/未分类/book.epub", [SAMPLE as never], FP);
		const read = await store.readForBook("library/另一个书库/科幻/book.epub", FP);
		expect(read).toHaveLength(1);
		expect(read[0].id).toBe("a1");
	});

	it("指纹不可用（占位 pending-…）时退回书旁 v2 路径（功能不丢）", async () => {
		const fs = makeFs();
		const store = new SidecarAnnotationStore(fs);
		const legacyPath = bookSidecarPathV2("library/lib/f/book.epub");
		await store.writeForBook("library/lib/f/book.epub", [SAMPLE as never], "pending-abc12345");
		expect(fs.files.has(legacyPath)).toBe(true);
		// 不会被写到指纹目录下
		expect([...fs.files.keys()].every((p) => !p.includes("annotations/"))).toBe(true);
	});

	it("旧书旁侧车仍能读到，且读到后写入指纹路径（旧文件不变）", async () => {
		const book = "library/lib/f/book.epub";
		const legacy = bookSidecarPathV2(book);
		const legacyRaw = v2File([SAMPLE]);
		const fs = makeFs({ [legacy]: legacyRaw });
		const store = new SidecarAnnotationStore(fs);
		const read = await store.readWithReport(book, FP);
		expect(read.annotations).toHaveLength(1);
		expect(fs.files.get(legacy)).toBe(legacyRaw); // 旧文件字节不变
		await store.writeForBook(book, read.annotations, FP);
		expect(fs.files.has(fingerprintSidecarPath(FP))).toBe(true);
	});
});

/**
 * 回归：设置里"迁移书架位置"曾经只搬 `library`，把 `annotations` 留在原地
 * → 迁移后批注全"消失"（其实还在旧目录）。
 *
 * 现在书库与批注由**同一套目录推导**绑定：批注目录 = 书架的上级目录 + `/annotations`。
 * 搬上级目录即一次搬走两者；`setAnnotationSidecarDir()` 让运行期跟随设置。
 */
describe("批注目录与书架目录绑定（迁移书架必须一起搬）", () => {
	it("由书架目录推导批注目录：取上级目录 + /annotations", () => {
		expect(annotationDirForBookshelf("nyareader/library")).toBe("nyareader/annotations");
		expect(annotationDirForBookshelf("Books/MyShelf")).toBe("Books/annotations");
		expect(annotationDirForBookshelf("library")).toBe("annotations");
		expect(annotationDirForBookshelf("nyareader/library/")).toBe("nyareader/annotations");
	});

	it("批注目录与书库是**同级兄弟**（这样才能用一个 rename 一起搬）", () => {
		const shelf = "nyareader/library";
		const ann = annotationDirForBookshelf(shelf);
		expect(shelf.slice(0, shelf.lastIndexOf("/"))).toBe(ann.slice(0, ann.lastIndexOf("/")));
	});

	it("注入新目录后，主存储路径随之改变（迁移后仍找得到批注）", async () => {
		const before = annotationSidecarDir();
		try {
			setAnnotationSidecarDir(DEFAULT_FINGERPRINT_SIDECAR_DIR);
			expect(fingerprintSidecarPath(FP)).toBe(`${DEFAULT_FINGERPRINT_SIDECAR_DIR}/${FP}.annotations.json`);
			// 模拟迁移：改成新位置
			const moved = annotationDirForBookshelf("newhome/library");
			setAnnotationSidecarDir(moved);
			expect(moved).toBe("newhome/annotations");
			expect(fingerprintSidecarPath(FP)).toBe(`newhome/annotations/${FP}.annotations.json`);
			// 同一本书（指纹不变）换目录后仍能读到同一批
			const fs = makeFs();
			const store = new FingerprintAnnotationStore(fs);
			await store.write(FP, [SAMPLE as never], "newhome/library/x/book.epub");
			expect((await store.read(FP, "newhome/library/x/book.epub"))[0].id).toBe("a1");
			expect(fs.files.has(`newhome/annotations/${FP}.annotations.json`)).toBe(true);
		} finally {
			setAnnotationSidecarDir(before);
		}
	});

	it("非法目录被忽略（不会把批注写到空路径或根路径）", () => {
		const before = annotationSidecarDir();
		try {
			setAnnotationSidecarDir("");
			expect(annotationSidecarDir()).toBe(before);
			setAnnotationSidecarDir("   ");
			expect(annotationSidecarDir()).toBe(before);
			setAnnotationSidecarDir(undefined);
			expect(annotationSidecarDir()).toBe(before);
		} finally {
			setAnnotationSidecarDir(before);
		}
	});
});

/**
 * 迁移目标路径解析（设置页现在真正调用的就是它）。
 *
 * 采用与"拖文件夹"一致的直觉，用户不必猜该填到哪一级。
 */
describe("迁移目标解析 resolveMoveTarget", () => {
	it("填「日历/NyaReader」→ 最终就是那个路径（不额外套一层）", () => {
		expect(resolveMoveTarget({ from: "nyareader", rawTarget: "日历/NyaReader" })).toEqual({ to: "日历/NyaReader" });
	});

	it("填「日历」→ 也是最终路径（规则唯一：填什么就是什么，不做推断）", () => {
		expect(resolveMoveTarget({ from: "nyareader", rawTarget: "日历" })).toEqual({ to: "日历" });
	});

	it("源在二级（如 吉米/nyareader）时同样适用", () => {
		expect(resolveMoveTarget({ from: "吉米/nyareader", rawTarget: "日历" })).toEqual({ to: "日历" });
		expect(resolveMoveTarget({ from: "吉米/nyareader", rawTarget: "日历/NyaReader书库" })).toEqual({
			to: "日历/NyaReader书库",
		});
	});

	it("反斜杠与首尾斜杠都做规范化", () => {
		expect(resolveMoveTarget({ from: "nyareader", rawTarget: "\\日历\\NyaReader\\" })).toEqual({ to: "日历/NyaReader" });
	});

	it("空输入 / 与当前位置相同 / 搬进自己的子目录 → 拒绝并说明原因", () => {
		expect(resolveMoveTarget({ from: "nyareader", rawTarget: "   " }).error).toContain("请填写");
		expect(resolveMoveTarget({ from: "nyareader", rawTarget: "nyareader" }).error).toContain("相同");
		expect(resolveMoveTarget({ from: "nyareader", rawTarget: "nyareader/inner" }).error).toContain("子目录");
		expect(resolveMoveTarget({ from: "", rawTarget: "x" }).error).toContain("找不到当前目录");
	});});
