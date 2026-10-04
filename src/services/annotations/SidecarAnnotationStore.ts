/**
 * 侧车批注存储：EPUB / MOBI / AZW3 / TXT 的批注写入书籍旁的
 * `<书名><suffix>.json` 文件，与书籍文件关联（由 Controller 保证 bookFingerprint）。
 * 支持导出。
 */
import type { Annotation, IAnnotationStore } from "./AnnotationModel";
import { annotationId } from "./AnnotationModel";

interface SidecarData {
	version: 1;
	annotations: Annotation[];
}

export class SidecarAnnotationStore implements IAnnotationStore {
	constructor(private adapter: {
		read: (p: string) => Promise<string>;
		write: (p: string, d: string) => Promise<void>;
		exists: (p: string) => Promise<boolean>;
		mkdir: (p: string) => Promise<void>;
	}, private suffix = ".annotations") {}

	/** 由书籍文件路径推导侧车文件路径。 */
	sidecarPath(bookPath: string): string {
		const dot = bookPath.lastIndexOf(".");
		const base = dot > 0 ? bookPath.slice(0, dot) : bookPath;
		return `${base}${this.suffix}.json`;
	}

	async list(bookFingerprint: string): Promise<Annotation[]> {
		// 注意：侧车按文件位置存储，但接口按指纹查询；
		// Controller 需在打开书籍时把指纹与侧车内容建立映射。
		return [];
	}

	/** 直接按书路径读取侧车内容（Controller 使用）。 */
	async readForBook(bookPath: string): Promise<Annotation[]> {
		const path = this.sidecarPath(bookPath);
		if (!(await this.adapter.exists(path))) return [];
		try {
			const raw = await this.adapter.read(path);
			const data = JSON.parse(raw) as SidecarData;
			return data.annotations ?? [];
		} catch {
			return [];
		}
	}

	async addForBook(bookPath: string, input: Omit<Annotation, "id" | "createdAt" | "updatedAt">): Promise<Annotation> {
		const annotation: Annotation = { ...input, id: annotationId(), createdAt: Date.now(), updatedAt: Date.now() };
		const all = await this.readForBook(bookPath);
		all.push(annotation);
		await this.writeForBook(bookPath, all);
		return annotation;
	}

	async updateForBook(bookPath: string, id: string, patch: Partial<Pick<Annotation, "note" | "color">>): Promise<void> {
		const all = await this.readForBook(bookPath);
		const idx = all.findIndex((a) => a.id === id);
		if (idx >= 0) {
			all[idx] = { ...all[idx], ...patch, updatedAt: Date.now() };
			await this.writeForBook(bookPath, all);
		}
	}

	async removeForBook(bookPath: string, id: string): Promise<void> {
		const all = await this.readForBook(bookPath);
		const next = all.filter((a) => a.id !== id);
		await this.writeForBook(bookPath, next);
	}

	async writeForBook(bookPath: string, annotations: Annotation[]): Promise<void> {
		const path = this.sidecarPath(bookPath);
		const dir = path.substring(0, path.lastIndexOf("/"));
		if (dir) await this.adapter.mkdir(dir).catch(() => undefined);
		const data: SidecarData = { version: 1, annotations };
		await this.adapter.write(path, JSON.stringify(data, null, 2));
	}

	// IAnnotationStore 接口其余方法（指纹索引方案交给 Controller 适配）
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
		throw new Error("请使用 readForBook + 序列化");
	}
}
