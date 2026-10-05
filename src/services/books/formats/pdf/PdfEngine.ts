/**
 * PDF 阅读引擎：基于 pdf.js 渲染单页到 canvas，
 * 叠加文本层供选中、叠加 overlay 显示批注高亮。
 * 实现 IReaderEngine 接口，视图层不直接接触 pdf.js。
 */
import type { AnnotationTarget, IReaderEngine, ReaderEngineEvents } from "../../IReaderEngine";
import { SimpleReaderEmitter } from "../../IReaderEngine";
import type { BookModel, ReaderSettings } from "../../../../types";
import { pdfjs, initPdfWorker } from "./pdfWorker";
import type { Plugin } from "obsidian";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";

export interface PdfEngineOptions {
	plugin: Plugin;
	book: BookModel;
	buffer: ArrayBuffer;
}

export class PdfEngine implements IReaderEngine {
	readonly format = "pdf";
	private emitter = new SimpleReaderEmitter();
	private container!: HTMLElement;
	private canvasHost!: HTMLElement;
	private textLayerHost!: HTMLElement;
	private overlayHost!: HTMLElement;
	private pageLabelEl!: HTMLElement;

	private doc: PDFDocumentProxy | null = null;
	private currentPage = 1;
	private viewport: PageViewport | null = null;
	private zoom = 1;
	private settings: ReaderSettings = { fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24, theme: "light", layout: "single", scrollMode: false, pageWidth: 420 };
	private pendingAnnotation: AnnotationTarget | null = null;
	private destroyed = false;
	private renderToken = 0;

	constructor(private opts: PdfEngineOptions) {}

	on<E extends keyof ReaderEngineEvents>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		this.emitter.on(event, handler as never);
	}
	off<E extends keyof ReaderEngineEvents>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		this.emitter.off(event, handler as never);
	}

	async mount(container: HTMLElement): Promise<void> {
		this.container = container;
		this.canvasHost = container.createDiv({ cls: "nyareader-pdf-canvas-host" });
		this.overlayHost = container.createDiv({ cls: "nyareader-pdf-overlay" });
		this.textLayerHost = container.createDiv({ cls: "nyareader-pdf-textlayer" });
		this.pageLabelEl = container.createDiv({ cls: "nyareader-pdf-page-label" });

		try {
			await initPdfWorker(this.opts.plugin);
			const loadingTask = pdfjs.getDocument({
				data: this.opts.buffer,
				isEvalSupported: false,
				useSystemFonts: true,
			});
			this.doc = await loadingTask.promise;
			this.attachSelectionHandler();
			await this.renderPage(this.currentPage);
		} catch (e) {
			this.emitter.emit("error", { message: e instanceof Error ? e.message : String(e) });
		}
	}

	unmount(): void {
		this.destroyed = true;
		this.textLayerHost?.empty();
		this.canvasHost?.empty();
		this.overlayHost?.empty();
	}

	async goTo(location: string): Promise<void> {
		const page = Math.min(this.doc?.numPages ?? 1, Math.max(1, parseInt(location, 10) || 1));
		await this.renderPage(page);
	}

	async nextPage(): Promise<void> {
		if (!this.doc || this.currentPage >= this.doc.numPages) return;
		await this.renderPage(this.currentPage + 1);
	}

	async prevPage(): Promise<void> {
		if (!this.doc || this.currentPage <= 1) return;
		await this.renderPage(this.currentPage - 1);
	}

	currentLocation(): string {
		return String(this.currentPage);
	}

	currentPercentage(): number {
		if (!this.doc) return 0;
		return this.doc.numPages === 0 ? 0 : this.currentPage / this.doc.numPages;
	}

	applySettings(settings: ReaderSettings): void {
		this.settings = { ...settings };
		if (this.doc) void this.renderPage(this.currentPage);
	}

	/** 暴露当前页 viewport（含 convertToPdfPoint），供 Controller 坐标换算。 */
	getViewport(): PageViewport | null {
		return this.viewport;
	}

	/** 当前页 PDF 用户空间尺寸（pt），由 viewport 反推。 */
	getPageSizePt(): { width: number; height: number } | null {
		if (!this.viewport) return null;
		const [w, h] = this.viewport.convertToPdfPoint(this.viewport.width, this.viewport.height);
		return { width: w, height: h };
	}

	getSelection(): { text: string; target?: AnnotationTarget } | null {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed) return null;
		const text = sel.toString().trim();
		if (!text || !this.viewport) return null;

		// 收集选中 range 在容器内的 rect
		const containerRect = this.textLayerHost.getBoundingClientRect();
		const rects: AnnotationTarget["rects"] = [];
		for (let i = 0; i < sel.rangeCount; i++) {
			const range = sel.getRangeAt(i);
			const clientRects = range.getClientRects();
			for (let j = 0; j < clientRects.length; j++) {
				const r = clientRects[j];
				if (r.width === 0 && r.height === 0) continue;
				// 换算到容器坐标
				rects.push({
					left: r.left - containerRect.left,
					top: r.top - containerRect.top,
					width: r.width,
					height: r.height,
				});
			}
		}
		if (rects.length === 0) return null;
		return {
			text,
			target: {
				location: String(this.currentPage),
				rects,
				selectedText: text,
			},
		};
	}

	async showAnnotation(target: AnnotationTarget): Promise<void> {
		this.pendingAnnotation = target;
		await this.goTo(target.location);
		this.paintOverlay();
	}

	private attachSelectionHandler(): void {
		// 文本层文字可选中，选中变化由视图层轮询 getSelection 即可
		// 此处仅监听点击清除（后续扩展）
		this.textLayerHost.addEventListener("click", () => {
			// 保持选中以支持划词翻译，不做清除
		});
	}

	private async renderPage(pageNumber: number): Promise<void> {
		if (!this.doc || this.destroyed) return;
		const token = ++this.renderToken;
		const page: PDFPageProxy = await this.doc.getPage(pageNumber);
		const containerWidth = Math.max(this.container.clientWidth - 40, 200);
		// 缩放以适配容器宽度；同时叠加用户 zoom
		const base = (page.view[2] / page.view[3]) * containerWidth; // width/height ratio -> scale
		const scale = Math.min(2, (containerWidth / page.view[2]) * this.zoom);
		this.viewport = page.getViewport({ scale });

		const canvas = this.canvasHost.createEl("canvas");
		canvas.width = Math.floor(this.viewport.width);
		canvas.height = Math.floor(this.viewport.height);
		this.canvasHost.empty();
		this.canvasHost.appendChild(canvas);

		const renderContext = {
			canvasContext: canvas.getContext("2d") as CanvasRenderingContext2D,
			viewport: this.viewport,
		};
		try {
			await page.render(renderContext).promise;
		} catch (e) {
			if (this.destroyed || token !== this.renderToken) return;
			this.emitter.emit("error", { message: `第 ${pageNumber} 页渲染失败：${e instanceof Error ? e.message : String(e)}` });
			return;
		}
		if (token !== this.renderToken || this.destroyed) return;

		// 文本层
		this.textLayerHost.empty();
		const textLayer = new pdfjs.TextLayer({
			textContentSource: page.streamTextContent(),
			container: this.textLayerHost,
			viewport: this.viewport,
		});
		this.textLayerHost.style.width = `${Math.floor(this.viewport.width)}px`;
		this.textLayerHost.style.height = `${Math.floor(this.viewport.height)}px`;
		await textLayer.render();

		// 清理页标签并更新
		this.pageLabelEl.setText(`第 ${pageNumber} / ${this.doc.numPages} 页`);
		this.currentPage = pageNumber;
		this.paintOverlay();
		this.emitter.emit("locationChanged", { location: String(pageNumber), percentage: this.currentPercentage() });
	}


	private paintOverlay(): void {
		this.overlayHost.empty();
		if (!this.pendingAnnotation || !this.viewport) return;
		const target = this.pendingAnnotation;
		if (target.location !== String(this.currentPage)) return;
		for (const r of target.rects ?? []) {
			const div = this.overlayHost.createDiv({ cls: "nyareader-pdf-annotation-marker" });
			div.style.left = `${r.left}px`;
			div.style.top = `${r.top}px`;
			div.style.width = `${r.width}px`;
			div.style.height = `${r.height}px`;
		}
	}

	destroy(): void {
		this.destroyed = true;
		this.unmount();
		void this.doc?.destroy();
		this.emitter.clear();
	}
}



