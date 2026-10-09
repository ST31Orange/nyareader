/**
 * 批注侧车路径计算（纯函数，可单测）。
 *
 * ## 为什么要有这个模块
 * 旧实现把侧车存在**书旁边**（`<书名>.epub.annotations.json`），路径随书走。
 * 而书架"移动书/换书库"只 `rename` 了书文件本身，**没有搬侧车** ——
 * 结果单本书一移动，批注就读不到了。
 *
 * 新方案：主存储按**内容指纹**（`nyareader/annotations/<fingerprint>.json`），
 * 与路径完全无关；同时保留对两种旧位置的**只读兼容 + 读到即迁移**（不删旧文件）。
 *
 * PDF 侧本来就是按指纹存的（`PdfInlineAnnotationStore`），因此 PDF 移动不受影响。
 */
import type { AnnotationAnchor } from "../services/annotations/AnnotationAnchor";

/** 指纹侧车主目录（相对 vault）。 */
export const FINGERPRINT_SIDECAR_DIR = "nyareader/annotations";

/**
 * 指纹是否可用于落盘。
 *
 * 必须排除：
 * - 占位指纹（解析期用的 `pending-…`）：它不是内容指纹，用它落盘会把不同书的批注串在一起；
 * - 任何含路径分隔符/`..`/空白的值：防路径穿越（指纹本应是十六进制，但防御性校验）。
 */
export function isValidFingerprint(fp: unknown): fp is string {
	if (typeof fp !== "string") return false;
	const v = fp.trim();
	if (v.length < 8 || v.length > 128) return false;
	if (/^pending-/i.test(v)) return false;
	if (!/^[A-Za-z0-9_-]+$/.test(v)) return false;
	return true;
}

/** 主存储路径：`nyareader/annotations/<fingerprint><suffix>.json`。 */
export function fingerprintSidecarPath(fingerprint: string, suffix = ".annotations"): string {
	return `${FINGERPRINT_SIDECAR_DIR}/${fingerprint}${suffix}.json`;
}

/** 规范化为 vault 内路径（统一 `/`）。 */
function normalizePath(p: string): string {
	return (p ?? "").replace(/\\/g, "/");
}

/** 旧 v1（书旁、去扩展名）：`<书名去扩展名><suffix>.json`。 */
export function bookSidecarPathV1(bookPath: string, suffix = ".annotations"): string {
	const normalized = normalizePath(bookPath);
	const slash = normalized.lastIndexOf("/");
	const dot = normalized.lastIndexOf(".");
	const base = dot > slash + 1 ? normalized.slice(0, dot) : normalized;
	return `${base}${suffix}.json`;
}

/** 旧 v2（书旁、含扩展名）：`<书名含扩展名><suffix>.json`；无扩展名时退化为 `.v2.json` 避免与 v1 重合。 */
export function bookSidecarPathV2(bookPath: string, suffix = ".annotations"): string {
	const normalized = normalizePath(bookPath);
	const candidate = `${normalized}${suffix}.json`;
	return candidate === bookSidecarPathV1(bookPath, suffix) ? `${normalized}${suffix}.v2.json` : candidate;
}

/** 旧位置候选（按优先级：书旁 v2 → 书旁 v1；无扩展名的书再补 `.v2.json` 变体）。 */
/**
 * 旧位置候选（书旁的旧侧车文件）。
 *
 * 历史上真正出现过的命名只有这三种，直接穷举，避免用后缀推断而写出边界 bug：
 * - v2（带扩展名）：`<书名>.<扩展名><suffix>.json`
 * - v1（去扩展名）：`<书名><suffix>.json`
 * - v2 退化（无扩展名的书）：`<书名><suffix>.v2.json`
 *
 * 顺序 = 读取优先级（v2 优先，v1 兜底）。
 */
export function legacySidecarPaths(bookPath: string, suffix = ".annotations"): string[] {
	if (!bookPath) return [];
	const normalized = normalizePath(bookPath);
	const slash = normalized.lastIndexOf("/");
	const dot = normalized.lastIndexOf(".");
	const hasExt = dot > slash + 1;
	const stem = hasExt ? normalized.slice(0, dot) : normalized;
	const candidates = [
		// 无扩展名的书没有 `<stem>.<ext>` 这一段，退化形态放在第一位
		hasExt ? `${normalized}${suffix}.json` : `${normalized}${suffix}.v2.json`,
		`${stem}${suffix}.json`,
	];
	// 统一去重（无扩展名时上面两项不同，有扩展名时也可能与文件名本身重合）
	return [...new Set(candidates)];
}

export interface SidecarMigrationInput {
	fingerprint: string;
	/** 书在 vault 内的当前路径（可能与上次不同——这正是要解决的问题） */
	bookPath: string;
	suffix?: string;
	/** 探测某个路径是否存在（注入以便单测） */
	exists: (path: string) => boolean | Promise<boolean>;
}

export interface SidecarMigrationPlan {
	/** 主存储路径（指纹）；指纹非法时为 null，表示"继续用书旁旧路径"，不做迁移 */
	primaryPath: string | null;
	/** 读取候选顺序：先主存储，再旧位置（去重） */
	readCandidates: string[];
	/** 旧位置里实际存在的那些（用于"读到即迁移"） */
	legacyExisting: string[];
	/** 是否需要把读到的内容写一份到主存储 */
	shouldMigrate: boolean;
}

/**
 * 规划一次侧车读取/迁移。
 *
 * 纯决策函数：不读写文件，只根据 `exists()` 的探测结果给出路径与顺序，
 * 便于单测覆盖"移动后仍能读到""旧文件存在时迁移""指纹非法时不落盘"等场景。
 */
export async function planSidecarMigration(input: SidecarMigrationInput): Promise<SidecarMigrationPlan> {
	const suffix = input.suffix ?? ".annotations";
	const primary = isValidFingerprint(input.fingerprint) ? fingerprintSidecarPath(input.fingerprint, suffix) : null;
	const legacy = legacySidecarPaths(input.bookPath, suffix);
	const legacyExisting: string[] = [];
	for (const p of legacy) {
		if (p === primary) continue;
		try {
			if (await input.exists(p)) legacyExisting.push(p);
		} catch {
			/* 探测失败视为不存在 */
		}
	}
	const readCandidates: string[] = [];
	if (primary) readCandidates.push(primary);
	for (const p of legacyExisting) if (!readCandidates.includes(p)) readCandidates.push(p);
	return {
		primaryPath: primary,
		readCandidates,
		legacyExisting,
		// 只有在"有合法主存储路径"且"主存储里还没有、但旧位置有内容"时才需要迁移
		shouldMigrate: Boolean(primary) && legacyExisting.length > 0,
	};
}

/**
 * 从一条批注的锚点判断它属于哪一章/什么位置（用于迁移时保持顺序与分组）——纯工具。
 * 没有锚点时返回 `null`。
 */
export function anchorPrimaryOf(anchor: AnnotationAnchor | undefined): string | null {
	return anchor?.primary ?? null;
}
