/**
 * 侧车批注存储。
 *
 * ## v2 与 v1 的关系（硬约束）
 * - **v2 路径**：`<书名>.<原扩展名><suffix>.json`（例：`MyBook.epub.annotations.json`）。
 *   保留原扩展名，修掉旧实现「同名不同格式的书共用一份侧车」的串书隐患。
 * - **v1 路径**：`<书名去扩展名><suffix>.json`（例：`MyBook.annotations.json`）。
 * - v1 文件 **只读兼容、永不删除、永不改写**：读到 v1 时只在**内存**里升级成 v2 锚点模型，
 *   然后写**新文件**（v2 路径）。任何写入前都会断言目标不是 v1 路径。
 * - 解析失败时**只读不写**（宁可这批批注不显示，也不能把用户数据写坏）。
 */
import type { Annotation, IAnnotationStore } from "./AnnotationModel";
import { annotationId, normalizeHighlightColor } from "./AnnotationModel";
import type { AnnotationTarget } from "../books/IReaderEngine";
import { clamp01, createAnchor, parseAnchor, quoteFromText, type AnnotationAnchor } from "./AnnotationAnchor";
import { fingerprintSidecarPath, isValidFingerprint } from "../../utils/annotation-sidecar-path";

/** 侧车文件结构版本。 */
export const SIDECAR_VERSION = 2;

/** v2 侧车文件结构。 */
export interface SidecarFileV2 {
	version: 2;
	/** 写入时的书籍指纹（诊断/冲突排查用；读取时以内存里的指纹为准） */
	bookFingerprint?: string;
	updatedAt?: number;
	annotations: Annotation[];
}

/** v1 旧侧车文件结构（只读兼容）。 */
export interface SidecarFileV1 {
	version?: number;
	annotations?: unknown[];
}

/** 侧车读取结果（含来源与迁移条数，便于 UI 提示"已迁移 N 条旧批注，旧文件已保留"）。 */
export interface SidecarReadResult {
	annotations: Annotation[];
	source: "v2" | "v1-migrated" | "none";
	/** 本次读取中由 v1 字段升级出来的条数 */
	migrated: number;
	v2Path: string;
	v1Path: string;
}

/** 侧车读写所需的 vault 适配器（与 Obsidian DataAdapter 的子集同形，便于单测）。 */
export interface SidecarAdapter {
	read: (path: string) => Promise<string>;
	write: (path: string, data: string) => Promise<void>;
	exists: (path: string) => Promise<boolean>;
	mkdir: (path: string) => Promise<void>;
}

/**
 * 旧数据（v1）→ 统一锚点。**只增字段、不改语义**。
 *
 * - 非 PDF 侧车的 `location` 旧语义有两种：0~10000 百分比（分页）或段落索引（TXT 滚动），
 *   二者无法从数据本身区分，因此一律降到「进度兜底 + 文本指纹」：`progression = v/10000`。
 * - `text` → `quote.exact`：指纹是唯一能在正文里搜回原句的东西，
 *   命中后 `locateInText()` 会把它升级成 `quote-unique`（精确）。
 * - 标记 `approximate`：UI 需要如实告诉用户"这条位置可能不准"。
 */
export function anchorFromLegacy(location: string, text: string): AnnotationAnchor {
	const num = parseInt(location ?? "", 10);
	const hasPercent = Number.isFinite(num) && String(num) === String(location ?? "").trim() && num >= 0;
	return createAnchor({
		kind: "chapter",
		primary: typeof location === "string" ? location : String(location ?? ""),
		quote: quoteFromText(text ?? ""),
		progression: hasPercent ? clamp01(num / 10000) : 0,
	});
}

/** 目标字段的宽容解析（旧数据可能缺 rects/selectedText）。 */
function parseTarget(raw: unknown, location: string, text: string): AnnotationTarget {
	const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const rects = Array.isArray(o.rects)
		? (o.rects as unknown[]).flatMap((r) => {
				if (!r || typeof r !== "object") return [];
				const rect = r as Record<string, unknown>;
				const left = Number(rect.left);
				const top = Number(rect.top);
				const width = Number(rect.width);
				const height = Number(rect.height);
				if (![left, top, width, height].every((n) => Number.isFinite(n))) return [];
				return [{ left, top, width, height }];
			})
		: [];
	const target: AnnotationTarget = {
		location: typeof o.location === "string" && o.location ? o.location : location,
		selectedText: typeof o.selectedText === "string" ? o.selectedText : text,
	};
	if (rects.length) target.rects = rects;
	if (typeof o.scale === "number" && Number.isFinite(o.scale)) target.scale = o.scale;
	return target;
}

const KINDS = new Set(["highlight", "underline", "note"]);

/**
 * v1 条目 → `Annotation`（内存升级）。
 * 无法识别（不是对象/没有文本与位置）时返回 `null`，绝不抛异常、绝不丢弃成损坏数据。
 */
export function migrateV1Annotation(raw: unknown, bookFingerprint = ""): Annotation | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const text = typeof o.text === "string" ? o.text : "";
	const location = typeof o.location === "string" ? o.location : String(o.location ?? "");
	const anchor = parseAnchor(o.anchor) ?? anchorFromLegacy(location, text);
	if (!anchor.quote.exact && !location) return null;
	const kind = typeof o.kind === "string" && KINDS.has(o.kind) ? (o.kind as Annotation["kind"]) : "highlight";
	const now = Date.now();
	const createdAt = typeof o.createdAt === "number" && Number.isFinite(o.createdAt) ? o.createdAt : now;
	const updatedAt = typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) ? o.updatedAt : createdAt;
	const annotation: Annotation = {
		id: typeof o.id === "string" && o.id ? o.id : annotationId(),
		kind,
		bookFingerprint: typeof o.bookFingerprint === "string" && o.bookFingerprint ? o.bookFingerprint : bookFingerprint,
		location: anchor.quote.exact ? location || anchor.primary : location,
		target: parseTarget(o.target, location, text),
		text: text || anchor.quote.exact,
		color: normalizeHighlightColor(o.color),
		createdAt,
		updatedAt,
		anchor,
		source: "sidecar-v1",
	};
	if (typeof o.note === "string") annotation.note = o.note;
	// 旧数据没有结构定位 → 如实标记"可能不准"；渲染时若指纹命中会被升级
	annotation.approximate = o.approximate === false ? false : true;
	annotation.anchorResolvedBy = typeof o.anchorResolvedBy === "string" ? o.anchorResolvedBy : "progression-only";
	return annotation;
}

/** 写入前的收敛（保证落盘数据一定带合法颜色与锚点）。 */
function normalizeForWrite(annotation: Annotation, bookFingerprint: string): Annotation {
	const anchor = parseAnchor(annotation.anchor) ?? anchorFromLegacy(annotation.location, annotation.text);
	return {
		...annotation,
		bookFingerprint: annotation.bookFingerprint || bookFingerprint,
		color: normalizeHighlightColor(annotation.color),
		anchor,
	};
}

export class SidecarAnnotationStore implements IAnnotationStore {
	constructor(private adapter: SidecarAdapter, private suffix = ".annotations") {}

	/** 规范化路径分隔符（vault 内路径统一用 `/`）。 */
	private normalize(bookPath: string): string {
		return (bookPath ?? "").replace(/\\/g, "/");
	}

	/** v1 旧口径路径：`<书名去扩展名><suffix>.json`。**只读**。 */
	legacySidecarPath(bookPath: string): string {
		const normalized = this.normalize(bookPath);
		const slash = normalized.lastIndexOf("/");
		const dot = normalized.lastIndexOf(".");
		const base = dot > slash + 1 ? normalized.slice(0, dot) : normalized;
		return `${base}${this.suffix}.json`;
	}

	/**
	 * v2 路径：`<书名含扩展名><suffix>.json`。
	 * 无扩展名的书（`MyBook`）会与 v1 路径重合，此时退化为 `<name><suffix>.v2.json`，
	 * 保证 v2 永远不落在 v1 路径上（不覆盖旧文件）。
	 */
	sidecarPath(bookPath: string): string {
		const normalized = this.normalize(bookPath);
		const candidate = `${normalized}${this.suffix}.json`;
		if (candidate === this.legacySidecarPath(bookPath)) return `${normalized}${this.suffix}.v2.json`;
		return candidate;
	}

	/** 解析任意版本的侧车文件内容（缺锚点的条目在内存里升级）。 */
	private parseFile(raw: string, bookFingerprint: string): { annotations: Annotation[]; migrated: number } {
		const parsed = JSON.parse(raw) as Partial<SidecarFileV2 & { annotations?: unknown }>;
		if (!parsed || !Array.isArray(parsed.annotations)) return { annotations: [], migrated: 0 };
		const annotations: Annotation[] = [];
		let migrated = 0;
		for (const entry of parsed.annotations) {
			const entryObj = entry && typeof entry === "object" ? (entry as { anchor?: unknown }) : null;
			const hasAnchor = parseAnchor(entryObj?.anchor) !== null;
			const annotation = migrateV1Annotation(entry, bookFingerprint);
			if (!annotation) continue;
			if (!hasAnchor) migrated++;
			annotations.push(annotation);
		}
		return { annotations, migrated };
	}

	/**
	 * 主存储路径（**指纹优先，与书路径解耦**）。
	 *
	 * 为什么：旧实现把侧车存在书旁边，而书架"移动书/换书库"只 rename 了书本身，
	 * 没搬侧车 → 单本书一移动，批注就读不到了。
	 * 指纹来自**文件内容**，移动/重命名/换书库都不变，因此主存储改为
	 * `nyareader/annotations/<fingerprint><suffix>.json`。
	 *
	 * 指纹不可用（占位 `pending-…`/缺失/非法）时**退回书旁 v2 路径**（与旧行为一致），
	 * 保证任何情况下都能正常读写，不会因为拿不到指纹就丢功能。
	 */
	primaryPath(bookPath: string, bookFingerprint = ""): string {
		if (isValidFingerprint(bookFingerprint)) return fingerprintSidecarPath(bookFingerprint, this.suffix);
		return this.sidecarPath(bookPath);
	}

	/** 读取候选（主存储优先，其次书旁 v2 / v1；去重）。 */
	readCandidates(bookPath: string, bookFingerprint = ""): string[] {
		const out: string[] = [];
		const primary = this.primaryPath(bookPath, bookFingerprint);
		out.push(primary);
		for (const p of [this.sidecarPath(bookPath), this.legacySidecarPath(bookPath)]) {
			if (!out.includes(p)) out.push(p);
		}
		return out;
	}

	/** 读取侧车（指纹主存储 → 书旁 v2 → 书旁 v1；缺锚点条目在内存里升级）。**不会写任何文件**。 */
	async readWithReport(bookPath: string, bookFingerprint = ""): Promise<SidecarReadResult> {
		const v2Path = this.primaryPath(bookPath, bookFingerprint);
		const v1Path = this.legacySidecarPath(bookPath);
		const candidates: Array<{ path: string; source: SidecarReadResult["source"] }> = [
			{ path: v2Path, source: "v2" },
			{ path: this.sidecarPath(bookPath), source: "v2" },
			{ path: v1Path, source: "v1-migrated" },
		];
		const seen = new Set<string>();
		for (const cand of candidates) {
			if (seen.has(cand.path)) continue;
			seen.add(cand.path);
			try {
				if (!(await this.adapter.exists(cand.path))) continue;
				const raw = await this.adapter.read(cand.path);
				const { annotations, migrated } = this.parseFile(raw, bookFingerprint);
				if (!annotations.length && migrated === 0) continue;
				return {
					annotations,
					source: cand.source,
					migrated: cand.source === "v1-migrated" ? annotations.length : migrated,
					v2Path,
					v1Path,
				};
			} catch {
				// 解析失败：只读不写。返回空列表（宁可这批批注不显示，也不能写坏用户数据）
				return { annotations: [], source: "none", migrated: 0, v2Path, v1Path };
			}
		}
		return { annotations: [], source: "none", migrated: 0, v2Path, v1Path };
	}

	/** 直接按书路径读取侧车内容（Controller 使用）。 */
	async readForBook(bookPath: string, bookFingerprint = ""): Promise<Annotation[]> {
		return (await this.readWithReport(bookPath, bookFingerprint)).annotations;
	}

	/**
	 * 读到 v1 后**显式**把迁移结果落成 v2 新文件（旧文件原样保留）。
	 * 已存在 v2 时返回 false（不覆盖）。
	 */
	async ensureV2(bookPath: string, annotations: Annotation[], bookFingerprint = ""): Promise<boolean> {
		const v2Path = this.primaryPath(bookPath, bookFingerprint);
		if (await this.adapter.exists(v2Path)) return false;
		await this.writeForBook(bookPath, annotations, bookFingerprint);
		return true;
	}

	async addForBook(
		bookPath: string,
		input: Omit<Annotation, "id" | "createdAt" | "updatedAt">,
		bookFingerprint = ""
	): Promise<Annotation> {
		const annotation: Annotation = {
			...normalizeForWrite(input as Annotation, input.bookFingerprint ?? bookFingerprint),
			id: annotationId(),
			createdAt: Date.now(),
			updatedAt: Date.now(),
			source: "sidecar-v2",
		};
		// 读取时自动带上 v1 迁移出来的条目：第一次写入就把旧批注一起带到 v2（旧文件不动）
		const all = await this.readForBook(bookPath, annotation.bookFingerprint);
		all.push(annotation);
		await this.writeForBook(bookPath, all, annotation.bookFingerprint);
		return annotation;
	}

	async updateForBook(bookPath: string, id: string, patch: Partial<Pick<Annotation, "note" | "color">>, bookFingerprint = ""): Promise<void> {
		const all = await this.readForBook(bookPath, bookFingerprint);
		const idx = all.findIndex((a) => a.id === id);
		if (idx < 0) return;
		const next: Annotation = { ...all[idx], ...patch, updatedAt: Date.now() };
		if (patch.color !== undefined) next.color = normalizeHighlightColor(patch.color);
		all[idx] = next;
		await this.writeForBook(bookPath, all, next.bookFingerprint);
	}

	async removeForBook(bookPath: string, id: string, bookFingerprint = ""): Promise<void> {
		const all = await this.readForBook(bookPath, bookFingerprint);
		const next = all.filter((a) => a.id !== id);
		await this.writeForBook(bookPath, next, bookFingerprint);
	}

	/** 写入 v2（**永远不写 v1 路径**）。 */
	async writeForBook(bookPath: string, annotations: Annotation[], bookFingerprint = ""): Promise<void> {
		const path = this.primaryPath(bookPath, bookFingerprint);
		if (path === this.legacySidecarPath(bookPath)) {
			throw new Error("拒绝写入 v1 旧侧车路径：旧批注文件必须保持原样");
		}
		const dir = path.substring(0, path.lastIndexOf("/"));
		if (dir) await this.adapter.mkdir(dir).catch(() => undefined);
		const data: SidecarFileV2 = {
			version: SIDECAR_VERSION,
			bookFingerprint: bookFingerprint || annotations[0]?.bookFingerprint || undefined,
			updatedAt: Date.now(),
			annotations: annotations.map((a) => normalizeForWrite(a, bookFingerprint)),
		};
		await this.adapter.write(path, JSON.stringify(data, null, 2));
	}

	/** 导出为 JSON 文本（供 UI 复制/下载；`exportJson` 接口方法见下）。 */
	async exportForBook(bookPath: string, bookFingerprint = ""): Promise<string> {
		const resolved = await this.readWithReport(bookPath, bookFingerprint);
		return JSON.stringify(
			{ version: SIDECAR_VERSION, book: bookPath, exportedAt: Date.now(), annotations: resolved.annotations },
			null,
			2
		);
	}

	// ---------- IAnnotationStore 接口（按指纹查询的部分仍交给 Controller 适配） ----------
	async list(bookFingerprint: string): Promise<Annotation[]> {
		// 侧车按文件位置存储，接口按指纹查询；Controller 需在打开书籍时把指纹与侧车内容建立映射。
		return [];
	}

	async add(input: Omit<Annotation, "id" | "createdAt" | "updatedAt">): Promise<Annotation> {
		throw new Error("请使用 addForBook(bookPath, ...)");
	}
	async update(id: string, patch: Partial<Pick<Annotation, "note" | "color">>): Promise<void> {
		throw new Error("请使用 updateForBook(bookPath, ...)");
	}
	async remove(bookFingerprint: string, id: string): Promise<void> {
		throw new Error("请使用 removeForBook(bookPath, ...)");
	}
	async exportJson(bookFingerprint: string): Promise<string> {
		throw new Error("请使用 exportForBook(bookPath, ...)");
	}
}
