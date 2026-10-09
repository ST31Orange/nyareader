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
	/** 书库与批注当前是否同级兄弟（诊断用） */
	siblings: boolean;
	/**
	 * 采用的搬法。**现在恒为 `move-children`** —— 见 {@link migrationOps} 的说明：
	 * "整体重命名上级目录"在目标父目录不存在时必然 ENOENT，且依赖源必须是二级目录，
	 * 所以不再区分一级/二级，统一走"建好目标 + 分别把子目录移进去"。
	 */
	strategy?: "move-children";
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

	const shelfName = shelf.slice(shelf.lastIndexOf("/") + 1) || "library";
	const annName = ann.slice(ann.lastIndexOf("/") + 1) || "annotations";
	const join = (parent: string, name: string): string => (parent ? `${parent}/${name}` : name);
	const newShelfDir = join(anchor, shelfName);
	const newAnnDir = join(anchor, annName);

	// 统一走 move-children：
	// 目标目录不存在也能用（先建），已存在也能用（直接往里搬），
	// 且**不再要求源必须是二级目录** —— 一级/二级/多级一律同样处理。
	return { anchor, newShelfDir, newAnnDir, siblings, strategy: "move-children" };
}

/** 一次迁移要执行的文件操作。 */
export type MigrationOp =
	/** 递归创建目录（必须先于"往里搬"执行） */
	| { kind: "ensure-parent"; path: string }
	/** 移动书库目录 */
	| { kind: "move-shelf"; from: string; to: string }
	/** 移动批注目录（失败不阻断，只提示） */
	| { kind: "move-annotations"; from: string; to: string };

/**
 * 把迁移计划展开成**有序操作序列**。
 *
 * ## 为什么统一成"建好目标 + 分别搬子目录"（不再有 whole-parent）
 * 用户实测过三种情况：
 * - 搬到**一级不存在目录** → 成功（目标父目录 = vault 根，天然存在）
 * - 搬到**二级存在目录** → `ENOENT ... rename '...\nyareader' -> '...\日历\NyaReader'`
 * - 搬到**二级不存在目录** → `ENOENT ... rename '...\吉米' -> '...\日历\NyaReader书库'`
 *
 * 两次 ENOENT 的根因相同：`rename` 的**目标父目录必须已经存在**（`日历` 不存在），
 * 而且"整体搬上级目录"还隐含要求**源恰好是二级目录**（一级目录时根本没有可搬的上级）。
 *
 * 所以现在**不再区分一级/二级**，统一三步：
 * 1. `ensure-parent`：把目标目录（含多级父目录）建出来；
 * 2. `move-shelf` / `move-annotations`：把两个子目录分别移进去。
 * 这样目标存在与否、源在几级，行为都一致。
 *
 * 另一条同样重要的铁律：**`ensure-parent` 必须先执行**，不能"先搬再建"，否则又是 ENOENT。
 */
export function migrationOps(plan: MigrationPlan, oldAnchor: string, oldShelf: string, oldAnnotations: string): MigrationOp[] {
	if (!plan.anchor || !plan.newShelfDir || !plan.newAnnDir) return [];
	void oldAnchor; // 不再整体搬上级目录，保留参数以便调用点稳定
	return [
		{ kind: "ensure-parent", path: plan.anchor },
		{ kind: "move-shelf", from: oldShelf, to: plan.newShelfDir },
		{ kind: "move-annotations", from: oldAnnotations, to: plan.newAnnDir },
	];
}
