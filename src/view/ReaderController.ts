/**
 * ReaderController：阅读器编排层。
 * 职责：
 * - 打开书籍（解析 -> 构建 BookModel -> 按格式创建引擎 -> 恢复进度）
 * - 转发用户操作（翻页/跳转/主题/版式）到引擎
 * - 划词 -> 翻译（委托 NyaLingo）
 * - 划词 -> 批注（PDF 写文件+备份，其余写侧车）
 * - 进度持久化（BookIndexService）
 * 视图层只与本 Controller 通信。
 */
import type { TFile } from "obsidian";
import type NyaReaderPlugin from "../main";
import type { BookModel, ReaderSettings } from "../types";
import { formatFromExtension, sniffFormat, IBookParser } from "../services/books/Parser";
import type { AnnotationTarget, IReaderEngine } from "../services/books/IReaderEngine";
import { PdfParser } from "../services/books/formats/pdf/PdfParser";
import { PdfEngine } from "../services/books/formats/pdf/PdfEngine";
import { initPdfWorker } from "../services/books/formats/pdf/pdfWorker";
import { EpubParser } from "../services/books/formats/epub/EpubParser";
import { TxtParser } from "../services/books/formats/txt/TxtParser";
import { TxtEngine } from "../services/books/formats/txt/TxtEngine";
import { MobiParser } from "../services/books/formats/mobi/MobiParser";
import { HtmlDocEngine } from "../services/books/formats/mobi/HtmlDocEngine";
import { PdfInlineAnnotationStore } from "../services/annotations/PdfInlineAnnotationStore";
import { PdfBackupService } from "../services/annotations/PdfBackupService";
import { SidecarAnnotationStore } from "../services/annotations/SidecarAnnotationStore";
import { sha256Hex } from "../utils/hash";
import { debounce } from "../utils/debounce";
import { domRectToPdfRect, isWithinPage, mergeDomRects } from "../utils/pdf-coords";
import type { ViewportLike } from "../utils/pdf-coords";
import type { Annotation, AnnotationKind } from "../services/annotations/AnnotationModel";

export interface ReaderControllerEvents {
	onBookOpened: (book: BookModel) => void;
	onError: (message: string) => void;
	onProgress: (percentage: number) => void;
}

export class ReaderController {
	/** 最近一次划词（鼠标划出后点标题栏按钮时选区常已被点击清空，用它兜底） */
	private lastSelection: { text: string; target?: AnnotationTarget } | null = null;
	private book: BookModel | null = null;
	private buffer: ArrayBuffer | null = null;
	private engine: IReaderEngine | null = null;
	private file: TFile | null = null;
	private pdfInline: PdfInlineAnnotationStore | null = null;
	private sidecar: SidecarAnnotationStore;

	private onEngineError = (payload: { message: string }): void => {
		this.events.onError(payload.message);
	};

	/** 进度持久化防抖：滚动时 locationChanged 高频触发，直接写盘会卡界面 */
	private pendingProgress: { location: string; percentage: number } | null = null;
	private saveProgressDebounced = debounce((location: string, percentage: number) => {
		this.pendingProgress = null;
		void this.saveProgress(location, percentage);
	}, 1200);

	private queueProgress(location: string, percentage: number): void {
		this.pendingProgress = { location, percentage };
		this.saveProgressDebounced(location, percentage);
	}

	/** 切书/关窗前把未落盘的进度立即写入，避免防抖期间丢失。 */
	private flushProgress(): void {
		if (!this.pendingProgress) return;
		const p = this.pendingProgress;
		this.pendingProgress = null;
		void this.saveProgress(p.location, p.percentage);
	}

	constructor(private plugin: NyaReaderPlugin, private events: ReaderControllerEvents) {
		this.sidecar = new SidecarAnnotationStore(
			{
				read: (p) => this.plugin.app.vault.adapter.read(p),
				write: (p, d) => this.plugin.app.vault.adapter.write(p, d),
				exists: (p) => this.plugin.app.vault.adapter.exists(p),
				mkdir: (p) => this.plugin.app.vault.adapter.mkdir(p),
			},
			this.plugin.settings.annotationSidecarSuffix
		);
	}

	get currentBook(): BookModel | null {
		return this.book;
	}

	get currentEngine(): IReaderEngine | null {
		return this.engine;
	}

	/** 打开一本书：解析 -> 建引擎 -> 挂载 -> 恢复进度。 */
	async openBook(file: TFile, mountContainer: HTMLElement): Promise<void> {
		try {
			this.flushProgress();
			this.lastSelection = null;
			// 先销毁旧引擎再解析新书：PDF 开着时解析 EPUB/TXT 会明显卡顿
			this.teardownEngine();
			this.book = null;
			this.buffer = null;
			this.file = null;
			const buffer = await this.plugin.app.vault.adapter.readBinary(file.path);
			const fingerprint = await sha256Hex(buffer);
			const format = this.detectFormat(file.name, buffer);
			if (format === "unknown") {
				this.events.onError("不支持的电子书格式。");
				return;
			}
			// PDF 解析（PdfParser.parse）也会调用 pdfjs.getDocument，必须先初始化
			// workerSrc，否则会抛 "No GlobalWorkerOptions.workerSrc specified"。
			if (format === "pdf") {
				await initPdfWorker(this.plugin);
			}
			const parser = this.parserFor(format);
			if (!parser) {
				this.events.onError(`格式 ${format} 的解析器尚未实现（规划中）。`);
				return;
			}
			// pdf.js 会把传入的 ArrayBuffer 转移（detach）给 worker，解析后原
			// buffer 字节被清空；渲染引擎还要复用同一 buffer，所以解析时传副本，
			// 否则 PdfEngine 二次 getDocument 会抛 "detached ArrayBuffer"。
			const book = await parser.parse({ fingerprint, path: file.path, format, buffer: buffer.slice(0) });
			// 记录/更新索引
			const entry = this.plugin.bookIndex.get(fingerprint);
			await this.plugin.bookIndex.upsert({
				fingerprint,
				path: file.path,
				format,
				title: book.title,
				author: book.author,
				lastOpenedAt: Date.now(),
				progress: entry?.progress,
			});

			this.book = book;
			this.buffer = buffer;
			this.file = file;
			this.events.onBookOpened(book);

			// 创建并挂载引擎
			await this.mountEngine(format, file.path, mountContainer);

			// 恢复进度
			const saved = this.plugin.bookIndex.get(fingerprint)?.progress;
			if (saved?.location) {
				this.engine?.goTo(saved.location);
			}
		} catch (e) {
			this.events.onError(e instanceof Error ? e.message : String(e));
		}
	}

	private teardownEngine(): void {
		this.engine?.destroy();
		this.engine = null;
		this.pdfInline = null;
	}

	private detectFormat(name: string, buffer: ArrayBuffer): BookModel["format"] {
		const sniffed = sniffFormat(buffer);
		if (sniffed) return sniffed;
		return formatFromExtension(name);
	}

	private parserFor(format: BookModel["format"]): IBookParser | null {
		switch (format) {
			case "pdf":
				return new PdfParser();
			case "epub":
				return new EpubParser();
			case "txt":
				return new TxtParser();
			case "mobi":
			case "azw3":
				return new MobiParser();
			default:
				return null;
		}
	}

	private async mountEngine(format: BookModel["format"], filePath: string, container: HTMLElement): Promise<void> {
		if (this.engine) {
			this.engine.destroy();
			this.engine = null;
		}
		if (!this.book || !this.buffer) return;
		const attach = (engine: IReaderEngine): void => {
			engine.on("error", this.onEngineError);
			engine.on("locationChanged", (payload) => {
				this.events.onProgress(payload.percentage);
				this.queueProgress(payload.location, payload.percentage);
			});
			engine.on("selection", (payload) => {
				// 划词自动翻译由视图层完成；这里缓存选区，供标题栏「高亮/笔记」在
				// 鼠标点击按钮清空 DOM 选区后仍然可用。
				if (payload.text?.trim()) this.lastSelection = payload;
			});
		};
		switch (format) {
			case "pdf": {
				this.pdfInline = new PdfInlineAnnotationStore(this.plugin, new PdfBackupService(this.plugin));
				await this.pdfInline.load();
				const engine = new PdfEngine({ plugin: this.plugin, book: this.book, buffer: this.buffer });
				attach(engine);
				this.engine = engine;
				await engine.mount(container);
				engine.applySettings(this.currentReaderSettings());
				const annotations = await this.pdfInline.list(this.book.fingerprint);
				for (const a of annotations) {
					void engine.showAnnotation(a.target);
				}
				break;
			}
			case "epub": {
				const html = await this.parseEpubHtml();
				if (!html) throw new Error("EPUB 解析失败，请检查文件是否完整。");
				const engine = new HtmlDocEngine({ book: this.book, html, formatLabel: "epub" });
				attach(engine);
				this.engine = engine;
				await engine.mount(container);
				engine.applySettings(this.currentReaderSettings());
				break;
			}
			case "txt": {
				const content = await this.parseTxt();
				if (!content) throw new Error("TXT 解析失败。");
				const engine = new TxtEngine({ book: this.book, content });
				attach(engine);
				this.engine = engine;
				await engine.mount(container);
				engine.applySettings(this.currentReaderSettings());
				break;
			}
			case "mobi":
			case "azw3": {
				const html = await this.parseMobiHtml();
				if (!html) throw new Error("MOBI/AZW3 解析失败，请用 Calibre 转换为 EPUB 后导入。");
				const engine = new HtmlDocEngine({ book: this.book, html });
				attach(engine);
				this.engine = engine;
				await engine.mount(container);
				engine.applySettings(this.currentReaderSettings());
				break;
			}
			default:
				throw new Error(`格式 ${format} 暂不支持。`);
		}
	}

	private async parseTxt(): Promise<{ title: string; paragraphs: string[]; chapters: Array<{ title: string; startParagraph: number }> } | null> {
		const { decodeBuffer, splitParagraphs } = await import("../services/books/formats/txt/TxtParser");
		if (!this.buffer) return null;
		const { content } = decodeBuffer(this.buffer);
		const { paragraphs, chapters } = splitParagraphs(content);
		return { title: this.book?.title ?? "", paragraphs, chapters };
	}

	private async parseMobiHtml(): Promise<string | null> {
		const { extractMobiContent } = await import("../services/books/formats/mobi/MobiParser");
		if (!this.buffer) return null;
		const result = extractMobiContent(new Uint8Array(this.buffer));
		return result?.html ?? null;
	}

	private async parseEpubHtml(): Promise<string | null> {
		if (!this.buffer) return null;
		try {
			const { buildEpubHtml } = await import("../services/books/formats/epub/EpubDocument");
			return await buildEpubHtml(this.buffer);
		} catch (e) {
			console.error("NyaReader: EPUB 渲染文档构建失败", e);
			return null;
		}
	}

	currentReaderSettings(): ReaderSettings {
		const base = this.plugin.settings.reader;
		if (this.book && this.plugin.settings.bookOverrides[this.book.fingerprint]) {
			return { ...base, ...this.plugin.settings.bookOverrides[this.book.fingerprint] };
		}
		return base;
	}

	/** 划词翻译：委托 NyaLingo 共享翻译服务，并记录翻译历史。 */
	async translateSelection(text: string, to?: string): Promise<string> {
		const result = await this.plugin.lingo.translate(text, { to });
		try {
			await this.plugin.history.add({
				sourceText: text,
				translatedText: result,
				from: this.plugin.settings.translation.sourceLanguage,
				to: to ?? this.plugin.settings.translation.targetLanguage,
				provider: "nyalingo",
				bookFingerprint: this.book?.fingerprint,
			});
		} catch {
			// 历史写入失败不影响翻译结果
		}
		return result;
	}

	/** 划词批注：PDF 写文件本体；其他格式写侧车。 */
	async addAnnotation(kind: AnnotationKind, note?: string): Promise<Annotation | null> {
		if (!this.engine || !this.book || !this.file) return null;
		const sel = this.engine.getSelection() ?? this.lastSelection;
		if (!sel || !sel.text.trim()) {
			this.events.onError("请先选中要批注的文本。");
			return null;
		}
		const color = "yellow";
		if (this.book.format === "pdf" && this.pdfInline && this.buffer) {
			return this.addPdfAnnotation(kind, note, sel.target, sel.text, color);
		}
		// 侧车（EPUB/TXT/MOBI/AZW3，后续阶段完善引擎支持）
		const file = this.file;
		if (!file) return null;
		const annotation = await this.sidecar!.addForBook(file.path, {
			bookFingerprint: this.book.fingerprint,
			location: this.engine.currentLocation(),
			target: sel.target ?? { location: this.engine.currentLocation(), rects: [], selectedText: sel.text },
			text: sel.text,
			kind,
			note,
			color,
		});
		return annotation;
	}

	/** 列出当前书籍的全部批注（PDF 用内联索引，其余用侧车文件）。 */
	async listAnnotations(): Promise<Annotation[]> {
		const { book, file } = this;
		if (!book || !file) return [];
		if (book.format === "pdf" && this.pdfInline) {
			return this.pdfInline.list(book.fingerprint);
		}
		return this.sidecar.readForBook(file.path);
	}

	/** 删除批注：PDF 从文件本体移除并隐藏高亮；侧车格式从 JSON 移除。 */
	async removeAnnotation(id: string): Promise<void> {
		const { book, file } = this;
		if (!book || !file) return;
		if (book.format === "pdf" && this.pdfInline) {
			const ann = (await this.pdfInline.list(book.fingerprint)).find((a) => a.id === id);
			if (!ann) return;
			await this.pdfInline.deleteInPlace(file.path, ann);
			this.engine?.hideAnnotation?.(ann.target);
			return;
		}
		await this.sidecar.removeForBook(file.path, id);
	}

	/** 修改笔记内容。 */
	async updateAnnotationNote(id: string, note?: string): Promise<void> {
		const { book, file } = this;
		if (!book || !file) return;
		if (book.format === "pdf" && this.pdfInline) {
			await this.pdfInline.update(id, { note });
			return;
		}
		await this.sidecar.updateForBook(file.path, id, { note });
	}

	private async addPdfAnnotation(kind: AnnotationKind, note: string | undefined, target: NonNullable<ReturnType<IReaderEngine["getSelection"]>>["target"], text: string, color: string): Promise<Annotation | null> {
		if (!target) {
			this.events.onError("无法定位批注位置。");
			return null;
		}
		const id = `nyar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const pageIndex = (parseInt(target.location, 10) || 1) - 1;
		// 使用引擎已渲染的 viewport 与页尺寸（避免重复解析 PDF）
		const geo = this.engineGeometry();
		if (!geo) {
			this.events.onError("无法获取页面几何信息。");
			return null;
		}
		const { viewport, pageSize } = geo;
		const merged = mergeDomRects(target.rects ?? []);
		const { quad, rect } = domRectToPdfRect(merged, viewport);
		if (!isWithinPage(rect, pageSize.width, pageSize.height)) {
			this.events.onError("选中区域超出页面范围。");
			return null;
		}
		const result = await this.pdfInline!.applyToFile(this.file!.path, {
			id,
			pageIndex,
			kind,
			quad,
			pageWidth: pageSize.width,
			pageHeight: pageSize.height,
			text,
			note,
			color,
			author: "NyaReader",
		});
		// 写回文件
		await this.plugin.app.vault.adapter.writeBinary(this.file!.path, result.bytes.slice().buffer as ArrayBuffer);
		const annotation: Annotation = {
			id,
			bookFingerprint: this.book!.fingerprint,
			location: target.location,
			target,
			text,
			kind,
			note,
			color,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		// 记录元数据 + 在引擎 overlay 显示
		await this.pdfInline!.add(annotation);
		this.engine?.showAnnotation(annotation.target);
		return annotation;
	}

	/** 依赖 PdfEngine 已渲染当前页，直接取其 viewport 与页尺寸（pt）。 */
	private engineGeometry(): { viewport: ViewportLike; pageSize: { width: number; height: number } } | null {
		const engine = this.engine as PdfEngine | null;
		if (!engine) return null;
		const viewport = engine.getViewport();
		const pageSize = engine.getPageSizePt();
		if (!viewport || !pageSize) return null;
		return { viewport: viewport as unknown as ViewportLike, pageSize };
	}

	private async saveProgress(location: string, percentage: number): Promise<void> {
		if (!this.book) return;
		const existing = this.plugin.bookIndex.get(this.book.fingerprint);
		// 位置没变不写盘：滚动产生的重复事件不再触发磁盘写入
		if (existing?.progress?.location === location) return;
		await this.plugin.bookIndex.updateProgress(this.book.fingerprint, {
			fingerprint: this.book.fingerprint,
			format: this.book.format,
			location,
			percentage,
			updatedAt: Date.now(),
		});
	}

	async close(): Promise<void> {
		this.flushProgress();
		this.engine?.destroy();
		this.engine = null;
		this.book = null;
		this.buffer = null;
	}
}






