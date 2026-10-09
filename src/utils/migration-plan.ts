/**
 * 迁移目录的**纯决策逻辑**（不碰文件系统，便于单测）。
 *
 * 用户实测过两类失败，都必须在这里被挡住或纠正：
 * 1. `Destination file already exists` —— 先把目标目录建出来、再整体 rename；
 * 2. 只搬了 `library`，`annotations` 留在原地 —— 批注"消失"。
 */
import { annotationDirForBookshelf, bookshelfAnchor, normalizePath } from "./annotation-sidecar-path";

/** 迁移输入：只描述"现状"与"用户填了什么"。 */
export interface MigrationPlanInput {
	/** 当前书库目录（vault 相对路径） */
	bookshelfDir: string;
	/** 当前批注目录 */
	annotationDir: string;
	/** 用户填的目录（**语义 = 上级目录**；容错：也接受填到 library 的情况） */
	rawTarget: string;
	/** 目标目录当前状态 */
	targetState: "missing" | "empty-folder" | "non-empty-folder" | "file";
	/** 书库目录是否存在（不存在则无法迁移） */
	shelfExists: boolean;
}

/** 迁移决策结果。 */
export interface MigrationPlan {
	/** 可以执行时：目标上级目录（规范化的 vault 相对路径） */
	anchor?: string;
	/** 新的书库目录 */
	newShelfDir?: string;
	/** 新的批注目录 */
	newAnnDir?: string;
	/** 书库与批注当前是否同级兄弟（决定能否"整体搬上级目录"） */
	siblings: boolean;
	/**
	 * 采用的搬法：
	 * - `whole-parent`：整体重命名上级目录（最快，要求目标**不存在**）
	 * - `move-children`：把 library / annotations 分别移进已存在的目标目录
	 */
	strategy?: "whole-parent" | "move-children";
	/** 不能执行时的用户可读原因 */
	error?: string;
}

/** 迁移纯决策：把"用户填的目录"规范化并判断能否执行、用哪种搬法。 */
export function planBookshelfMigration(input: MigrationPlanInput): MigrationPlan {
	const shelf = normalizePath(input.bookshelfDir).replace(/\/+$/, "");
	const ann = normalizePath(input.annotationDir).replace(/\/+$/, "");
	const siblings = ann === annotationDirForBookshelf(shelf);
	const currentAnchor = bookshelfAnchor(shelf, ann);

	const raw = normalizePath(input.rawTarget ?? "").trim().replace(/\/+$/, "");
	if (!raw) return { siblings, error: "请填写上级目录（例如 nyareader）。" };
	// 容错：用户可能按旧习惯填到 library/annotations，自动纠正到上级目录
	const anchor = raw.replace(/\/(library|annotations)$/i, "");
	if (!anchor) return { siblings, error: "请填写上级目录，而不是 library/annotations 本身。" };
	if (anchor === currentAnchor) return { siblings, error: "目标与当前位置相同，无需迁移。" };
	if (currentAnchor && anchor.startsWith(`${currentAnchor}/`)) {
		return { siblings, error: "不能迁移到自己的子目录里。" };
	}
	if (!input.shelfExists) return { siblings, error: "找不到当前书库目录，无法迁移。" };
	if (input.targetState === "file") return { siblings, error: `目标「${anchor}」已被一个文件占用，请换一个路径。` };
	if (input.targetState === "non-empty-folder") {
		return { siblings, error: `目标目录「${anchor}」里已有内容，请选一个空白文件夹（或让程序新建）。` };
	}

	const shelfName = shelf.slice(shelf.lastIndexOf("/") + 1) || "library";
	const annName = ann.slice(ann.lastIndexOf("/") + 1) || "annotations";
	const join = (parent: string, name: string): string => (parent ? `${parent}/${name}` : name);
	const newShelfDir = join(anchor, shelfName);
	const newAnnDir = join(anchor, annName);

	// 目标不存在 + 旧形态标准 → 整体搬上级目录（一次搬完，最快）
	// 目标已存在（哪怕是空文件夹）→ 只能分别搬子目录，**绝不能整体 rename**
	//   （整体 rename 到已存在目录正是用户看到的 Destination file already exists）
	const strategy: MigrationPlan["strategy"] =
		input.targetState === "missing" && siblings && Boolean(currentAnchor) ? "whole-parent" : "move-children";

	return { anchor, newShelfDir, newAnnDir, siblings, strategy };
}
