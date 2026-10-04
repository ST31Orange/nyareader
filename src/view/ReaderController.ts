/**
 * ReaderController：阅读器编排层。
 * 职责：
 * - 打开书籍（解析 -> 构建 BookModel -> 按格式创建引擎 -> 恢复进度）
 * - 转发用户操作（翻页/跳转/主题/版式）到引擎
 * - 划词 -> 翻译（TranslationService）
 * - 划词 -> 批注（PDF 写文件+备份，其余写侧车）
 * - 进度持久化（BookIndexService）
 * 视图层只与本 Controller 通信。
 */
import type { TFile } from "obsidian";
import type NyaReaderPlugin from "../main";
import type { BookModel, ReaderSettings } from "../types";
import { formatFromExtension, sniffFormat, IBookParser } from "../services/books/Parser";
import type { IReaderEngine } from "../services/books/IReaderEngine";
import { PdfParser } from "../services/books/formats/pdf/PdfParser";
import { PdfEngine } from "../services/books/formats/pdf/PdfEngine";
import { EpubParser } from "../services/books/formats/epub/EpubParser";
import { EpubEngine } from "../services/books/formats/epub/EpubEngine";
import { TxtParser } from "../services/books/formats/txt/TxtParser";
import { TxtEngine } from "../services/books/formats/txt/TxtEngine";
import { MobiParser } from "../services/books/formats/mobi/MobiParser";
import { HtmlDocEngine } from "../services/books/formats/mobi/HtmlDocEngine";
import { PdfInlineAnnotationStore } from "../services/annotations/PdfInlineAnnotationStore";
import { PdfBackupService } from "../services/annotations/PdfBackupService";
import { SidecarAnnotationStore } from "../services/annotations/SidecarAnnotationStore";
import { sha256Hex } from "../utils/hash";
import { domRectToPdfRect, isWithinPage, mergeDomRects } from "../utils/pdf-coords";
import type { ViewportLike } from "../utils/pdf-coords";
import type { Annotation, AnnotationKind } from "../services/annotations/AnnotationModel";

export interface ReaderControllerEvents {
	onBookOpened: (book: BookModel) => void;
	onError: (message: string) => void;
	onProgress: (percentage: number) => void;
}

export class ReaderController {
	private book: BookModel | null = null;
	private buffer: ArrayBuffer | null = null;
	private engine: IReaderEngine | null = null;
	private file: TFile | null = null;
	private pdfInline: PdfInlineAnnotationStore | null = null;
	private sidecar: SidecarAnnotationStore | null = null;

	private onEngineError = (payload: { message: string }): void => {
		this.events.onError(payload.message);
	};

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
			const buffer = await this.plugin.app.vault.adapter.readBinary(file.path);
			const fingerprint = await sha256Hex(buffer);
			const format = this.detectFormat(file.name, buffer);
			if (format === "unknown") {
				this.events.onError("不支持的电子书格式。");
				return;
			}
			const parser = this.parserFor(format);
			if (!parser) {
				this.events.onError(`格式 ${format} 的解析器尚未实现（规划中）。`);
				return;
			}
			const book = await parser.parse({ fingerprint, path: file.path, format, buffer });
			// 记录/更新索引
			const entry = this.plugin.bookIndex.get(fingerprint);
			await this.plugin.bookIndex.upsert({
				fingerprint,
				path: file.path,
				format,
				title: book.title,
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
				void this.saveProgress(payload.location, payload.percentage);
			});
			engine.on("selection", (payload) => {
				// 划词自动翻译由视图层监听 engine selection 完成（本控制器暴露 getSelection）
				void payload;
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
				const engine = new EpubEngine({ book: this.book, buffer: this.buffer });
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

	currentReaderSettings(): ReaderSettings {
		const base = this.plugin.settings.reader;
		if (this.book && this.plugin.settings.bookOverrides[this.book.fingerprint]) {
			return { ...base, ...this.plugin.settings.bookOverrides[this.book.fingerprint] };
		}
		return base;
	}

	/** 划词翻译。 */
	async translateSelection(text: string, to?: string): Promise<string> {
		return this.plugin.translation.translateSelection(text, {
			to,
			bookFingerprint: this.book?.fingerprint,
		});
	}

	/** 划词批注：PDF 写文件本体；其他格式写侧车。 */
	async addAnnotation(kind: AnnotationKind, note?: string): Promise<Annotation | null> {
		if (!this.engine || !this.book || !this.file) return null;
		const sel = this.engine.getSelection();
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

	private async addPdfAnnotation(kind: AnnotationKind, note: string | undefined, target: NonNullable<ReturnType<IReaderEngine["getSelection"]>>["target"], text: string, color: string): Promise<Annotation | null> {
		if (!target) {
			this.events.onError("无法定位批注位置。");
			return null;
		}
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
			id: `ann-${Date.now()}`,
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
		await this.plugin.bookIndex.updateProgress(this.book.fingerprint, {
			fingerprint: this.book.fingerprint,
			format: this.book.format,
			location,
			percentage,
			updatedAt: Date.now(),
		});
	}

	async close(): Promise<void> {
		this.engine?.destroy();
		this.engine = null;
		this.book = null;
		this.buffer = null;
	}
}






