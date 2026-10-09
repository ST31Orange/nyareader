/**
 * 目录迁移内核（与 Obsidian 解耦：文件操作走注入的端口）。
 *
 * ## 为什么重写成这样
 * 前几轮为了"快"，用了"整体重命名上级目录"这类优化路径，结果连环踩坑：
 * - 先建目标再整体 rename → `Destination file already exists`；
 * - 整体 rename 的目标父目录不存在 → `ENOENT`；
 * - 该路径还隐含要求"源恰好是二级目录"，一级目录根本走不通。
 *
 * 现在的做法是用户明确要求的朴素方式，**不做任何"聪明"判断**：
 * 1. 把目标目录建出来（逐级创建）；
 * 2. 递归打开源目录，把里面**每一个条目**搬到目标下（先文件/子目录内容，最后目录本身）；
 * 3. 冲突则在**动手之前**就拒绝（不会产生半搬状态）。
 *
 * ## 可回滚
 * 迁移中途失败时，按"已迁移记录"的**逆序**搬回原地，尽量恢复原状，
 * 并把失败原因带回给调用方。
 *
 * ## 为什么用端口注入
 * 这样可以在**真实文件系统**（真实 temp 目录）上跑单测，真正复现
 * `ENOENT` / `already exists` 这类错误 —— 之前几轮的问题正是"只靠推理没实测"。
 */

/** 文件系统端口（Obsidian 侧用 vault/DataAdapter 实现）。 */
export interface MovePort {
	/** 该路径是否存在（目录或文件都算） */
	exists(path: string): Promise<boolean>;
	/** 递归创建目录 */
	mkdirp(path: string): Promise<void>;
	/** 列出目录下的**直接**子项名（不含路径前缀） */
	list(path: string): Promise<string[]>;
	/** 是否为目录（不存在时返回 false） */
	isDir(path: string): Promise<boolean>;
	/** 重命名/移动（目标父目录必须已存在） */
	rename(from: string, to: string): Promise<void>;
	/** 删除**空目录**（Obsidian 侧用 vault.delete/adapter.rmdir） */
	removeDir(path: string): Promise<void>;
}

/** 迁移结果。 */
export interface MoveResult {
	ok: boolean;
	/** 实际搬动的条目数 */
	moved: number;
	/** 失败原因（ok=false 时给出） */
	error?: string;
	/** 冲突路径（动手前检测到；此时 moved 恒为 0） */
	conflicts?: string[];
	/** 失败后是否回滚成功 */
	rolledBack?: boolean;
}

/** 已执行的动作（用于失败回滚，**含顺序**）。 */
type Step = { kind: "copy-dir"; path: string } | { kind: "move"; from: string; to: string };

const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/**
 * 把一个目录**整体**搬到 `to`（`to` 必须是目标目录本身，可以不存在）。
 *
 * - `to` 不存在 → 逐级创建后把内容搬进去；
 * - `to` 已存在 → 往里合并；若存在同名条目则**在动手前拒绝**（绝不覆盖用户数据）；
 * - 源目录搬空后会被删除（内容是"移走"而不是"复制"）。
 */
export async function moveFolder(port: MovePort, from: string, to: string): Promise<MoveResult> {
	const src = from.replace(/\/+$/, "");
	const dst = to.replace(/\/+$/, "");
	if (!src || !dst) return { ok: false, moved: 0, error: "源或目标路径为空。" };
	if (src === dst) return { ok: true, moved: 0 };
	// 目标不能在源内部（否则会自己搬自己）
	if (dst.startsWith(`${src}/`)) return { ok: false, moved: 0, error: `目标「${dst}」在源目录内部。` };
	if (!(await port.exists(src))) return { ok: false, moved: 0, error: `源目录「${src}」不存在。` };

	// 1) 先做冲突检测（**动手前**，保证要么全成、要么一动不动）
	const conflicts = await findConflicts(port, src, dst);
	if (conflicts.length) {
		return { ok: false, moved: 0, conflicts, error: `目标下已存在同名内容：${conflicts.slice(0, 3).join("、")}` };
	}

	// 2) 建目标（含多级父目录）—— 必须先建，否则 rename 会 ENOENT
	await port.mkdirp(dst);

	// 3) 递归搬移；记录每一步（含目录创建）以便失败回滚
	const steps: Step[] = [];
	let moved = 0;
	try {
		moved = await moveContents(port, src, dst, steps);
		// 源目录此时应为空；移除它（用户要求"旧目录搬走后不要留着"）
		await removeIfEmpty(port, src);
		return { ok: true, moved };
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		// 逆序回滚：后做的先撤销（先搬回文件，再删掉新建的空目录）
		let rolledBack = true;
		for (const step of [...steps].reverse()) {
			try {
				if (step.kind === "move") {
					await port.mkdirp(dirOf(step.from));
					await port.rename(step.to, step.from);
				} else {
					await port.removeDir(step.path).catch(() => undefined);
				}
			} catch {
				rolledBack = false;
			}
		}
		return { ok: false, moved, error, rolledBack };
	}
}

/** 目标下是否已存在与源同名的条目（只查直接子项，够用且快）。 */
async function findConflicts(port: MovePort, src: string, dst: string): Promise<string[]> {
	if (!(await port.exists(dst))) return [];
	const [srcNames, dstNames] = await Promise.all([port.list(src), port.list(dst)]);
	const dstSet = new Set(dstNames);
	return srcNames.filter((n) => dstSet.has(n)).map((n) => join(dst, n));
}

/**
 * 递归搬移目录内容。
 *
 * 顺序策略：**先搬子项，最后搬目录本身**（深度优先）——
 * 这样每一步 rename 的目标父目录都已经存在，彻底避免 ENOENT。
 *
 * @returns 实际搬动的**文件**数（目录搬运不计入，便于调用方向用户报告）
 */
async function moveContents(port: MovePort, src: string, dst: string, steps: Step[]): Promise<number> {
	const names = await port.list(src);
	let moved = 0;
	for (const name of names) {
		const s = join(src, name);
		const d = join(dst, name);
		if (await port.isDir(s)) {
			if (!(await port.exists(d))) {
				await port.mkdirp(d);
				steps.push({ kind: "copy-dir", path: d });
			}
			moved += await moveContents(port, s, d, steps);
			await removeIfEmpty(port, s);
		} else {
			// 文件：目标父目录已存在（上面 mkdirp 过），rename 安全
			await port.mkdirp(dirOf(d));
			await port.rename(s, d);
			steps.push({ kind: "move", from: s, to: d });
			moved++;
		}
	}
	return moved;
}

/** 目录为空则删除（源目录搬空后清理；用户要求"旧目录搬走后不要留着"）。 */
async function removeIfEmpty(port: MovePort, dir: string): Promise<void> {
	try {
		if (!(await port.exists(dir))) return;
		const rest = await port.list(dir);
		if (rest.length) return;
		await port.removeDir(dir);
	} catch {
		/* 清理失败不影响迁移结果（空目录留着无害） */
	}
}

/** 取路径的父目录。 */
function dirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i > 0 ? path.slice(0, i) : "";
}

/** 取路径最后一段。 */
export function lastSegment(path: string): string {
	const p = (path ?? "").replace(/\/+$/, "");
	return p.slice(p.lastIndexOf("/") + 1);
}

export interface MoveTargetInput {
	/** 当前目录（要搬走的那个），如 `nyareader` */
	from: string;
	/** 用户填的目标（可能是"最终路径"，也可能是"要搬进的目录"） */
	rawTarget: string;
}

export interface MoveTargetPlan {
	/** 可以执行时的最终目标路径 */
	to?: string;
	/** 不能执行时的原因 */
	error?: string;
}

/**
 * 解析用户填的目标 → 最终路径。
 *
 * **规则只有一条：你填的路径就是最终路径。** 不做任何"聪明"推断。
 *
 * 为什么放弃启发式：曾经试过"最后一段是否等于目录名 → 决定是最终路径还是父目录"，
 * 但 `NyaReader书库` 这种命名既非相等也非无关，推断必然在某个输入上出人意料。
 * 简单可预期比"偶尔更省事"重要 —— 用户填什么就搬到哪里。
 *
 * 只拦三种必然错误：空输入、与当前位置相同、目标是自己的子目录（会自己搬自己）。
 */
export function resolveMoveTarget(input: MoveTargetInput): MoveTargetPlan {
	const from = (input.from ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const to = (input.rawTarget ?? "").replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
	if (!from) return { error: "找不到当前目录。" };
	if (!to) return { error: "请填写目标位置（例如 日历/NyaReader）。" };
	if (to === from) return { error: "目标与当前位置相同，无需迁移。" };
	if (to.toLowerCase().startsWith(`${from.toLowerCase()}/`)) return { error: "不能把目录搬进它自己的子目录。" };
	return { to };
}
