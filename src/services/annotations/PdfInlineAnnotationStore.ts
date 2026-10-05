/**
 * PDF 内联批注存储：批注写入 PDF 文件本身（标准注释）。
 * - 写入前自动备份（PdfBackupService）；
 * - 本地侧车文件同步记录批注元数据（用于列表展示/跳转），
 *   因为从 PDF 注释回读位置信息较繁琐；
 * - 提供"写回校验"：写入后重新加载 PDF 确认未损坏。
 */
import type { Plugin } from "obsidian";
import type { Annotation, AnnotationKind, IAnnotationStore } from "./AnnotationModel";
import { annotationId } from "./AnnotationModel";
import { writePdfAnnotation, expectedSubtype } from "./PdfAnnotationWriter";
import type { PdfBackupService } from "./PdfBackupService";
import { pdfjs } from "../books/formats/pdf/pdfWorker";

interface PdfInlineStoreData {
	version: 1;
	/** bookFingerprint -> 已写入的批注（含页码、quad、kind） */
	books: Record<string, Annotation[]>;
}

export class PdfInlineAnnotationStore implements IAnnotationStore {
	private data: PdfInlineStoreData = { version: 1, books: {} };

	constructor(private plugin: Plugin, private backup: PdfBackupService) {}

	private indexFile(): string {
		return `${this.plugin.manifest.dir ?? ""}nyareader-pdf-annotations.json`.replace(/\/+/g, "/").replace(/^\//, "");
	}

	async load(): Promise<void> {
		try {
			const raw = await this.plugin.app.vault.adapter.read(this.indexFile());
			this.data = JSON.parse(raw) as PdfInlineStoreData;
			if (!this.data.books) this.data.books = {};
		} catch {
			this.data = { version: 1, books: {} };
		}
	}

	private async persist(): Promise<void> {
		const dir = this.plugin.manifest.dir ?? "";
		if (dir) await this.plugin.app.vault.adapter.mkdir(dir).catch(() => undefined);
		await this.plugin.app.vault.adapter.write(this.indexFile(), JSON.stringify(this.data, null, 2));
	}

	async list(bookFingerprint: string): Promise<Annotation[]> {
		return [...(this.data.books[bookFingerprint] ?? [])];
	}

	async add(input: Omit<Annotation, "id" | "createdAt" | "updatedAt">): Promise<Annotation> {
		const annotation: Annotation = { ...input, id: annotationId(), createdAt: Date.now(), updatedAt: Date.now() };
		const arr = (this.data.books[input.bookFingerprint] ??= []);
		arr.push(annotation);

		// 说明：真正的 PDF 文件写入由 Controller 调用 applyToFile() 完成，
		// 本 add() 只记录批注元数据（供列表展示与跳转）。
		await this.persist();
		return annotation;
	}

	async update(id: string, patch: Partial<Pick<Annotation, "note" | "color">>): Promise<void> {
		for (const key of Object.keys(this.data.books)) {
			const arr = this.data.books[key];
			const idx = arr.findIndex((a) => a.id === id);
			if (idx >= 0) {
				arr[idx] = { ...arr[idx], ...patch, updatedAt: Date.now() };
				break;
			}
		}
		await this.persist();
	}

	async remove(bookFingerprint: string, id: string): Promise<void> {
		const arr = this.data.books[bookFingerprint];
		if (!arr) return;
		this.data.books[bookFingerprint] = arr.filter((a) => a.id !== id);
		await this.persist();
	}

	async exportJson(bookFingerprint: string): Promise<string> {
		const list = await this.list(bookFingerprint);
		return JSON.stringify({ bookFingerprint, exportedAt: Date.now(), annotations: list }, null, 2);
	}

	/**
	 * 真正向 PDF 文件写入批注并做回读校验（由 Controller 在 add 时调用）。
	 * 返回新文件二进制；写回前确保已备份。
	 */
	async applyToFile(pdfPath: string, input: Parameters<typeof writePdfAnnotation>[1]): Promise<{ backupPath?: string; bytes: Uint8Array }> {
		const backup = await this.backup.ensureBackup(pdfPath);
		const original = await this.plugin.app.vault.adapter.readBinary(pdfPath);
		const bytes = await writePdfAnnotation(original, input);
		// 回读校验：确认新文件可被 pdf.js 解析且含预期注释
		await this.verify(pdfPath, bytes, input.pageIndex, input.kind);
		return { backupPath: backup.backupPath, bytes };
	}

	private async verify(pdfPath: string, bytes: Uint8Array, pageIndex: number, kind: AnnotationKind): Promise<void> {
		const task = pdfjs.getDocument({ data: bytes.slice().buffer as ArrayBuffer });
		const doc = await task.promise;
		try {
			if (doc.numPages <= pageIndex) throw new Error("写回校验失败：页码越界");
		} finally {
			await doc.destroy();
		}
		// 注释类型校验交给 pdf-lib 回读
		await this.verifyWithPdfLib(bytes, pageIndex, kind);
	}

	private async verifyWithPdfLib(bytes: Uint8Array, pageIndex: number, kind: AnnotationKind): Promise<void> {
		const { PDFDocument, PDFArray, PDFDict, PDFName } = await import("pdf-lib");
		const doc = await PDFDocument.load(bytes.slice().buffer as ArrayBuffer);
		const page = doc.getPage(pageIndex);
		const annots = page.node.Annots();
		if (!annots) throw new Error("写回校验失败：页面无注释");
		const arr = await doc.context.lookup(annots);
		if (!(arr instanceof PDFArray)) throw new Error("写回校验失败：Annots 非数组");
		let found = false;
		for (const ref of arr.asArray()) {
			const dict = doc.context.lookup(ref);
			if (!(dict instanceof PDFDict)) continue;
			const subtype = dict.get(PDFName.of("Subtype"));
			if (subtype?.toString() === `/${expectedSubtype(kind)}`) {
				found = true;
				break;
			}
		}
		if (!found) throw new Error(`写回校验失败：未找到 ${expectedSubtype(kind)} 注释`);
	}
}




