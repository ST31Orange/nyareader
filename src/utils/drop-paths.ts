/**
 * 拖放载荷解析（纯逻辑，便于单测）。
 *
 * ## 为什么要兼容多种格式
 * Obsidian 的**左侧文件栏拖动**不通过 `dataTransfer.files` 传数据（那是系统文件管理器的做法），
 * 而是走它自己的内部拖放。官方没有公开这个载荷格式，实测/资料里出现过多种：
 * - `text/plain` = vault 相对路径
 * - `text/plain` = JSON（`{"file":"..."}` / `{"files":[...]}` / 数组）
 * - `application/obsidian-*` 之类的自定义 MIME
 *
 * 所以这里不赌某一种：把**所有能拿到的数据**都过一遍，从中提取出**看起来像 vault 内
 * 文件路径、且确实是电子书**的字符串。提取不到就返回空数组，调用方据此不做事。
 *
 * 纯函数：不碰 DOM、不碰 Obsidian，因此可以直接单测各种载荷形态。
 */

/** 视为"电子书"的扩展名（与书架/插件白名单保持一致，另加 md）。 */
export const READABLE_EXT = new Set(["epub", "pdf", "mobi", "azw3", "azw", "txt", "md", "markdown"]);

export interface DropPayload {
	/** 自定义 MIME -> 字符串（`dataTransfer.getData(type)`） */
	byType?: Record<string, string | undefined>;
	/** `dataTransfer.types`（用于遍历，顺序可能重要） */
	types?: readonly string[];
	/** `dataTransfer.files` 里的文件名（系统拖文件时才有；只取名字用于判断是否电子书） */
	fileNames?: readonly string[];
}

/** 取扩展名（小写，不含点）。 */
export function extOf(path: string): string {
	const clean = path.split(/[?#]/)[0];
	const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
	const dot = clean.lastIndexOf(".");
	return dot > slash + 1 ? clean.slice(dot + 1).toLowerCase() : "";
}

/** 是否为可读电子书（按扩展名）。 */
export function isReadableFile(path: string): boolean {
	return READABLE_EXT.has(extOf(path));
}

/**
 * 是否应该交给 **Obsidian 原生页面** 打开（而不是 NyaReader 阅读器）。
 *
 * 目前只有 Markdown：它既能当"书"放进书架（便于整理/拖放），
 * 点开时又必须走原生笔记视图 —— 否则会干扰 Obsidian 的编辑体验。
 */
export function opensInNativeEditor(path: string): boolean {
	const ext = extOf(path);
	return ext === "md" || ext === "markdown";
}

/**
 * 规范化成 vault 相对路径。
 *
 * 处理：反斜杠 → `/`、去掉 `./`、去掉前后的 `/`、
 * 去掉 `file://` 前缀、去掉 Windows 绝对路径里 vault 之后的部分交给调用方校验。
 * 返回 null 表示"不像一个 vault 路径"。
 */
export function normalizeVaultPath(raw: string): string | null {
	let s = (raw ?? "").trim();
	if (!s) return null;
	// 只可能是单行短字符串（路径），带换行的多半是正文/HTML，直接放弃
	if (s.includes("\n") || s.length > 512) return null;
	if (/^(https?:|data:|blob:)/i.test(s)) return null;
	s = s.replace(/^file:\/\/\/?/i, "");
	s = s.replace(/\\/g, "/");
	s = s.replace(/^\.\//, "");
	s = s.replace(/\/{2,}/g, "/");
	s = s.replace(/^\/+|\/+$/g, "");
	if (!s) return null;
	// 去掉可能的绝对路径前缀：只保留 `vault 名/...` 之后的部分不做猜测，
	// 交给调用方用 vault.getAbstractFileByPath() 判定（判定失败自然被过滤掉）
	return s;
}

/** 从字符串里抽出所有"像 vault 路径"的候选（覆盖 JSON / 纯文本 / 多行列表）。 */
export function extractPathCandidates(raw: string): string[] {
	const out: string[] = [];
	const push = (v: unknown): void => {
		if (typeof v !== "string") return;
		const norm = normalizeVaultPath(v);
		if (norm) out.push(norm);
	};
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return out;

	// 1) JSON（对象/数组/字符串）：递归找所有字符串值
	if (/^[[{]/.test(trimmed)) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			const walk = (v: unknown, depth: number): void => {
				if (depth > 4 || v === null || v === undefined) return;
				if (typeof v === "string") {
					push(v);
					return;
				}
				if (Array.isArray(v)) {
					for (const item of v) walk(item, depth + 1);
					return;
				}
				if (typeof v === "object") {
					// 常见字段优先，其余也走一遍（不确定字段名）
					const o = v as Record<string, unknown>;
					for (const key of ["file", "path", "files", "paths", "value", "text"]) {
						if (key in o) walk(o[key], depth + 1);
					}
					for (const val of Object.values(o)) walk(val, depth + 1);
				}
			};
			walk(parsed, 0);
			if (out.length) return dedupe(out);
		} catch {
			/* 不是合法 JSON：继续按纯文本处理 */
		}
	}

	// 2) 纯文本：整串、以及逐行
	push(trimmed);
	for (const line of trimmed.split(/\r?\n/)) push(line);

	// 3) 兜底：从任意文本里抓出以扩展名结尾的 token（例如 "file: xxx.epub"）
	for (const m of trimmed.matchAll(/[^\s"'<>()[\]{},;]+\.(?:epub|pdf|mobi|azw3?|txt|markdown|md)\b/gi)) {
		push(m[0]);
	}
	return dedupe(out);
}

function dedupe(list: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of list) {
		if (seen.has(p)) continue;
		seen.add(p);
		out.push(p);
	}
	return out;
}

/**
 * 从拖放载荷里提取**vault 内电子书路径**候选（未经过 vault 校验，按扩展名先筛一遍）。
 *
 * @param payload 从 DataTransfer 里读出来的原始数据
 * @param keep 可选的最终校验（调用方传 `vault.getAbstractFileByPath(p) instanceof TFile`），
 *             用于过滤掉"看似路径但实际不存在"的候选
 */
export function parseVaultDropPaths(
	payload: DropPayload,
	keep?: (path: string) => boolean
): string[] {
	const collected: string[] = [];
	const addFrom = (raw: string | undefined): void => {
		if (!raw) return;
		for (const p of extractPathCandidates(raw)) collected.push(p);
	};

	// 1) 优先看我们自己的内部 MIME（内部拖动，走原有移动逻辑，不该被当成新增导入）
	//    这里同样解析出来，由调用方决定语义
	const types = payload.types ? [...payload.types] : [];
	const byType = payload.byType ?? {};
	// 自定义 MIME 优先（更明确），其次 text/plain，最后其它
	const ordered = [...types].sort((a, b) => weight(b) - weight(a));
	for (const t of ordered) addFrom(byType[t]);
	for (const [t, v] of Object.entries(byType)) {
		if (!types.includes(t)) addFrom(v);
	}

	// 2) 系统拖文件时只有文件名：不构成路径，无法从 vault 里找，交给 Files 分支处理
	void payload.fileNames;

	const candidates = dedupe(collected).filter(isReadableFile);
	if (!keep) return candidates;
	return candidates.filter((p) => {
		try {
			return keep(p);
		} catch {
			return false;
		}
	});
}

/** 载荷类型优先级：自定义 MIME > text/plain > text/uri-list > 其它。 */
function weight(type: string): number {
	if (type.startsWith("application/x-nyareader")) return 5;
	if (type.startsWith("application/")) return 4;
	if (type === "text/plain") return 3;
	if (type === "text/uri-list") return 2;
	if (type === "Files") return 0;
	return 1;
}
