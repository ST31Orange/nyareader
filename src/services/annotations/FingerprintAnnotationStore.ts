/**
 * 按**内容指纹**存储批注的侧车 store（与书路径解耦）。
 *
 * ## 解决什么问题
 * 旧侧车存在书旁边，而书架"移动书/换书库"只重命名了书文件本身 →
 * 单本书一移动，批注就读不到。指纹与路径无关，所以改成按指纹存之后：
 * **移动、重命名、换书库、整库搬家，批注都跟着走**（PDF 本来就是按指纹存的）。
 *
 * ## 兼容策略（硬约束）
 * 读取顺序：指纹主存储 → 书旁 v2 → 书旁 v1。
 * - 命中旧位置时：在内存里升级成当前模型，并**写一份到指纹路径**；
 * - **旧文件永不删除、永不改写**（用户数据优先）。
 *
 * 写入只写指纹路径；指纹非法（占位 `pending-…` 或缺席）时**拒绝落盘**，
 * 而不是写到一个会串书的路径上。
 */
import type { Annotation, IAnnotationStore } from "./AnnotationModel";
import { annotationId, normalizeHighlightColor } from "./AnnotationModel";
import type { AnnotationTarget } from "../books/IReaderEngine";
import { clamp01, createAnchor, parseAnchor, quoteFromText, type AnnotationAnchor } from "./AnnotationAnchor";
import {
	fingerprintSidecarPath,
	isValidFingerprint,
	planSidecarMigration,
	legacySidecarPaths,
} from "../../utils/annotation-sidecar-path";

export const FINGERPRINT_SIDECAR_VERSION = 2;

export interface FingerprintSidecarFile {
	version: 2;
	/** 内容指纹（主键） */
	bookFingerprint: string;
	/** 最近一次已知的书路径（仅诊断；读取不依赖它） */
	lastKnownPath?: string;
	updatedAt?: number;
	annotations: Annotation[];
}

/** 读写所需的 vault 适配器（与 Obsidian DataAdapter 子集同形，便于单测）。 */
export interface FingerprintSidecarAdapter {
	read: (path: string) => Promise<string>;
	write: (path: string, data: string) => Promise<void>;
	exists: (path: string) => Promise<boolean>;
	mkdir: (path: string) => Promise<void>;
	remove?: (path: string) => Promise<void>;
}

export interface FingerprintReadResult {
	annotations: Annotation[];
	/** 内容来自哪里（便于 UI 提示） */
	source: "fingerprint" | "legacy-migrated" | "none";
	/** 实际读取到的路径 */
	readPath: string | null;
	/** 是否已把内容落到指纹主存储 */
	migrated: boolean;
}

/** 缺锚点的旧条目 → 当前模型（与 SidecarAnnotationStore 的升级口径保持一致）。 */
function upgradeEntry(raw: unknown, fingerprint: string): Annotation | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const text = typeof o.text === "string" ? o.text : "";
	const location = typeof o.location === "string" ? o.location : String(o.location ?? "");
	const anchor = parseAnchor(o.anchor) ?? createAnchor({
		kind: "chapter",
		primary: location,
		quote: quoteFromText(text),
		progression: Number.isFinite(parseInt(location, 10)) ? clamp01(parseInt(location, 10) / 10000) : 0,
	});
	if (!anchor.quote.exact && !location) return null;
	const now = Date.now();
	const createdAt = typeof o.createdAt === "number" ? o.createdAt : now;
	const updatedAt = typeof o.updatedAt === "number" ? o.updatedAt : createdAt;
	const rects = Array.isArray(o.target) ? undefined : (o.target as { rects?: unknown })?.rects;
	const target: AnnotationTarget = {
		location,
		selectedText: text,
	};
	if (Array.isArray(rects)) {
		const parsed = (rects as unknown[]).flatMap((r) => {
			const rect = r as Record<string, unknown> | null;
			if (!rect) return [];
			const left = Number(rect.left);
			const top = Number(rect.top);
			const width = Number(rect.width);
			const height = Number(rect.height);
			return [left, top, width, height].every((n) => Number.isFinite(n)) ? [{ left, top, width, height }] : [];
		});
		if (parsed.length) target.rects = parsed;
	}
	const annotation: Annotation = {
		id: typeof o.id === "string" && o.id ? o.id : annotationId(),
		kind: o.kind === "note" || o.kind === "underline" ? o.kind : "highlight",
		bookFingerprint: fingerprint,
		location,
		target,
		text: text || anchor.quote.exact,
		color: normalizeHighlightColor(o.color),
		createdAt,
		updatedAt,
		anchor,
	};
	if (typeof o.note === "string") annotation.note = o.note;
	if (typeof o.approximate === "boolean") annotation.approximate = o.approximate;
	if (typeof o.anchorResolvedBy === "string") annotation.anchorResolvedBy = o.anchorResolvedBy;
	return annotation;
}

export class FingerprintAnnotationStore {
	constructor(private adapter: FingerprintSidecarAdapter, private suffix = ".annotations") {}

	/** 主存储路径；指纹非法时返回 null。 */
	primaryPath(fingerprint: string): string | null {
		return isValidFingerprint(fingerprint) ? fingerprintSidecarPath(fingerprint, this.suffix) : null;
	}

	/** 读取（含旧位置兼容与迁移）。`bookPath` 只用于查找旧位置，不决定主存储。 */
	async readWithReport(fingerprint: string, bookPath = ""): Promise<FingerprintReadResult> {
		const plan = await planSidecarMigration({
			fingerprint,
			bookPath,
			suffix: this.suffix,
			exists: (p) => this.adapter.exists(p).catch(() => false),
		});
		for (const path of plan.readCandidates) {
			let raw: string;
			try {
				raw = await this.adapter.read(path);
			} catch {
				continue;
			}
			const annotations = this.parse(raw, fingerprint);
			if (!annotations.length) continue;
			const isPrimary = plan.primaryPath !== null && path === plan.primaryPath;
			if (isPrimary) return { annotations, source: "fingerprint", readPath: path, migrated: false };
			// 命中旧位置：迁移到主存储（旧文件保持原样）
			let migrated = false;
			if (plan.primaryPath) {
				try {
					await this.write(fingerprint, annotations, bookPath);
					migrated = true;
				} catch {
					/* 迁移失败不影响本次读取 */
				}
			}
			return { annotations, source: "legacy-migrated", readPath: path, migrated };
		}
		return { annotations: [], source: "none", readPath: null, migrated: false };
	}

	async read(fingerprint: string, bookPath = ""): Promise<Annotation[]> {
		return (await this.readWithReport(fingerprint, bookPath)).annotations;
	}

	/** 写入主存储（只写指纹路径；指纹非法时抛错，绝不写到会串书的位置）。 */
	async write(fingerprint: string, annotations: Annotation[], bookPath = ""): Promise<void> {
		const path = this.primaryPath(fingerprint);
		if (!path) {
			throw new Error(`NyaReader：指纹非法，拒绝写入批注侧车（fingerprint=${String(fingerprint).slice(0, 24)}）`);
		}
		const dir = path.substring(0, path.lastIndexOf("/"));
		if (dir) await this.adapter.mkdir(dir).catch(() => undefined);
		const data: FingerprintSidecarFile = {
			version: FINGERPRINT_SIDECAR_VERSION,
			bookFingerprint: fingerprint,
			lastKnownPath: bookPath || undefined,
			updatedAt: Date.now(),
			annotations: annotations.map((a) => this.normalizeForWrite(a, fingerprint)),
		};
		await this.adapter.write(path, JSON.stringify(data, null, 2));
	}

	async addForBook(fingerprint: string, bookPath: string, input: Omit<Annotation, "id" | "createdAt" | "updatedAt">): Promise<Annotation> {
		const all = await this.read(fingerprint, bookPath);
		const annotation: Annotation = {
			...this.normalizeForWrite(input as Annotation, fingerprint),
			id: annotationId(),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		all.push(annotation);
		await this.write(fingerprint, all, bookPath);
		return annotation;
	}

	async updateForBook(
		fingerprint: string,
		bookPath: string,
		id: string,
		patch: Partial<Pick<Annotation, "note" | "color">>
	): Promise<void> {
		const all = await this.read(fingerprint, bookPath);
		const idx = all.findIndex((a) => a.id === id);
		if (idx < 0) return;
		const next: Annotation = { ...all[idx], ...patch, updatedAt: Date.now() };
		if (patch.color !== undefined) next.color = normalizeHighlightColor(patch.color);
		all[idx] = next;
		await this.write(fingerprint, all, bookPath);
	}

	async removeForBook(fingerprint: string, bookPath: string, id: string): Promise<void> {
		const all = await this.read(fingerprint, bookPath);
		await this.write(fingerprint, all.filter((a) => a.id !== id), bookPath);
	}

	/** 旧位置列表（供"清理旧文件"这类显式操作使用；本 store 自身从不删除旧文件）。 */
	legacyPaths(bookPath: string): string[] {
		return legacySidecarPaths(bookPath, this.suffix);
	}

	private parse(raw: string, fingerprint: string): Annotation[] {
		try {
			const parsed = JSON.parse(raw) as { annotations?: unknown };
			if (!parsed || !Array.isArray(parsed.annotations)) return [];
			const out: Annotation[] = [];
			for (const entry of parsed.annotations) {
				const a = upgradeEntry(entry, fingerprint);
				if (a) out.push(a);
			}
			return out;
		} catch {
			// 解析失败：只读不写（宁可这批不显示，也不能把用户数据写坏）
			return [];
		}
	}

	private normalizeForWrite(annotation: Annotation, fingerprint: string): Annotation {
		const anchor = parseAnchor(annotation.anchor) ?? createAnchor({
			kind: "chapter",
			primary: annotation.location ?? "",
			quote: quoteFromText(annotation.text ?? ""),
			progression: 0,
		});
		return {
			...annotation,
			bookFingerprint: fingerprint,
			color: normalizeHighlightColor(annotation.color),
			anchor,
		};
	}

	// ---------- 兼容 IAnnotationStore 形状的薄封装（供统一 store 适配层使用） ----------

	/** 兼容旧接口：按指纹列出（不带书路径 → 只读主存储，不触发旧位置迁移）。 */
	async list(bookFingerprint: string): Promise<Annotation[]> {
		return this.read(bookFingerprint);
	}

	/** 兼容旧接口：按指纹 + 路径新增。 */
	async add(input: Omit<Annotation, "id" | "createdAt" | "updatedAt">): Promise<Annotation> {
		const fp = input.bookFingerprint;
		return this.addForBook(fp, "", input);
	}

	async update(id: string, patch: Partial<Pick<Annotation, "note" | "color">>): Promise<void> {
		throw new Error("FingerprintAnnotationStore.update 需要指纹与书路径，请使用 updateForBook(fingerprint, bookPath, id, patch)");
	}

	async remove(bookFingerprint: string, id: string): Promise<void> {
		return this.removeForBook(bookFingerprint, "", id);
	}

	async exportJson(bookFingerprint: string): Promise<string> {
		const annotations = await this.read(bookFingerprint);
		return JSON.stringify({ version: FINGERPRINT_SIDECAR_VERSION, fingerprint: bookFingerprint, annotations }, null, 2);
	}
}
