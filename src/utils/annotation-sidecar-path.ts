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

/**
 * 指纹侧车主目录（默认值）。
 *
 * **它会与书架目录联动**：默认书架是 `nyareader/library`，批注目录就是同级的
 * `nyareader/annotations`。用户在设置里迁移书架位置时，两者一起搬 —— 否则
 * "迁移后批注全丢"（用户实测到的问题）。
 * 运行期由 `setAnnotationSidecarDir()` 按设置注入。
 */
export const DEFAULT_FINGERPRINT_SIDECAR_DIR = "nyareader/annotations";

let sidecarDir = DEFAULT_FINGERPRINT_SIDECAR_DIR;

/** 当前批注目录（vault 相对路径，不含尾部斜杠）。 */
export function annotationSidecarDir(): string {
	return sidecarDir;
}

/**
 * 由**书架目录**推导批注目录：取书架的上级目录 + `/annotations`。
 *
 * 这是"迁移时两个文件夹一起搬"的基础 —— 两者必须是同级兄弟，
 * 才能用一个 `vault.rename(上级目录)` 一次搬完。
 */
export function annotationDirForBookshelf(bookshelfDir: string): string {
	const normalized = normalizePath(bookshelfDir).replace(/\/+$/, "");
	const slash = normalized.lastIndexOf("/");
	// 书架直接放在 vault 根目录时，批注也放根目录下的 annotations/
	if (slash <= 0) return "annotations";
	return `${normalized.slice(0, slash)}/annotations`;
}

/**
 * 迁移时"用户该填的目录"（= 书库与批注的公共上级目录）。
 *
 * - 默认形态（两者同级兄弟）：`nyareader/library` + `nyareader/annotations` → **`nyareader`**
 * - 自定义/不标准形态：退回返回书库目录本身（迁移会走"分别搬子目录"的路径）
 *
 * 设置页用它在提示文案与输入框初值里显示"上级目录"，避免用户填到子目录上。
 */
export function bookshelfAnchor(bookshelfDir: string, annotationDir?: string): string {
	const shelf = normalizePath(bookshelfDir).replace(/\/+$/, "");
	if (!shelf) return "";
	const ann = (annotationDir ?? annotationDirForBookshelf(shelf)).replace(/\/+$/, "");
	if (ann !== annotationDirForBookshelf(shelf)) return shelf;
	const slash = shelf.lastIndexOf("/");
	return slash > 0 ? shelf.slice(0, slash) : shelf;
}

/** 注入批注目录（设置加载/迁移后调用；非法值忽略）。 */
export function setAnnotationSidecarDir(dir: string | undefined | null): void {	if (typeof dir !== "string") return;
	const normalized = normalizePath(dir).trim().replace(/^\/+|\/+$/g, "");
	if (!normalized) return;
	sidecarDir = normalized;
}

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

/** 主存储路径：`<批注目录>/<fingerprint><suffix>.json`。 */
export function fingerprintSidecarPath(fingerprint: string, suffix = ".annotations"): string {
	return `${sidecarDir}/${fingerprint}${suffix}.json`;
}

/** 规范化为 vault 内路径（统一 `/`）。 */
export function normalizePath(p: string): string {
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
