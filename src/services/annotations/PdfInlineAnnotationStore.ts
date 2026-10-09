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
import { writePdfAnnotation, removePdfAnnotation, expectedSubtype } from "./PdfAnnotationWriter";
import type { WriteAnnotationInput } from "./PdfAnnotationWriter";
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

	/**
	 * 批量写回 + 一次写盘（批注 P0 的节流合并用）。
	 *
	 * 与 {@link applyToFile} 的区别：整批只备份一次、只读一次文件、只写一次盘。
	 * 逐条在同一份内存字节上追加注释，最后**统一回读校验**；任何一步失败都不写盘
	 * （加密 PDF 会在 `PDFDocument.load` 抛 `EncryptedPDFError`，由调用方兜底）。
	 */
	async applyBatchAndWrite(pdfPath: string, inputs: WriteAnnotationInput[]): Promise<{ backupPath?: string; bytes: Uint8Array }> {
		if (!inputs.length) throw new Error("applyBatchAndWrite：批次为空");
		const backup = await this.backup.ensureBackup(pdfPath);
		const original = await this.plugin.app.vault.adapter.readBinary(pdfPath);
		// 用 `Uint8Array`（ArrayBufferLike）显式声明：pdf-lib 的 save() 返回的是宽泛的
		// Uint8Array<ArrayBufferLike>，直接让 TS 推断成 Uint8Array<ArrayBuffer> 会赋值失败。
		let bytes: Uint8Array = new Uint8Array(original);
		for (const input of inputs) {
			bytes = await writePdfAnnotation(bytes.slice().buffer as ArrayBuffer, input);
		}
		// 回读校验：pdf.js 能解析 + 每条都能在目标页找到预期 Subtype
		await this.verify(pdfPath, bytes, inputs[0].pageIndex, inputs[0].kind);
		for (const input of inputs.slice(1)) {
			await this.verifyWithPdfLib(bytes, input.pageIndex, input.kind);
		}
		await this.plugin.app.vault.adapter.writeBinary(pdfPath, bytes.slice().buffer as ArrayBuffer);
		return { backupPath: backup.backupPath, bytes };
	}

	/**
	 * 删除一条 NyaReader 写入的 PDF 批注：先从文件本体移除注释，
	 * 再更新元数据索引，最后做回读校验确认注释已消失。
	 */
	async deleteInPlace(pdfPath: string, annotation: Annotation): Promise<void> {
		const backup = await this.backup.ensureBackup(pdfPath);
		const original = await this.plugin.app.vault.adapter.readBinary(pdfPath);
		const pageIndex = (parseInt(annotation.location, 10) || 1) - 1;
		const bytes = await removePdfAnnotation(original, pageIndex, annotation.id);
		await this.verifyRemoved(bytes, pageIndex, annotation.id);
		await this.plugin.app.vault.adapter.writeBinary(pdfPath, bytes.slice().buffer as ArrayBuffer);
		await this.remove(annotation.bookFingerprint, annotation.id);
		void backup;
	}

	private async verifyRemoved(bytes: Uint8Array, pageIndex: number, id: string): Promise<void> {
		const { PDFDocument, PDFArray, PDFDict, PDFName, PDFString } = await import("pdf-lib");
		const doc = await PDFDocument.load(bytes.slice().buffer as ArrayBuffer);
		if (doc.getPageCount() <= pageIndex) throw new Error("删除校验失败：页码越界");
		const annots = doc.getPage(pageIndex).node.Annots();
		if (!annots) return;
		const arr = await doc.context.lookup(annots);
		if (!(arr instanceof PDFArray)) return;
		for (const ref of arr.asArray()) {
			const dict = doc.context.lookup(ref);
			const marker = dict instanceof PDFDict ? dict.get(PDFName.of("NyaReader")) : undefined;
			if (marker instanceof PDFString && marker.asString() === id) {
				throw new Error("删除校验失败：批注仍存在于 PDF 文件中");
			}
		}
		await doc.save({ useObjectStreams: true });
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




