/**
 * PDF 阅读引擎（v0.3.0）：连续滚动 + 多页懒渲染，对齐 Obsidian 自带 PDF 阅读器。
 *
 * 设计要点：
 * - 垂直连续滚动，滚轮 / 触控板即"翻页"，不再是一张孤立画布；
 * - 每页一个占位 slot，只渲染视口附近 ±RENDER_MARGIN 的页面（大文件懒加载），
 *   离开视口很远的页面释放 canvas 以控制内存；
 * - 缩放三档：适应宽度 / 适应页面 / 自定义百分比；Ctrl+滚轮由本引擎处理，
 *   快捷键（Ctrl +/-）由视图层转发到 setZoom；
 * - 文本层按 pdf.js 4.x 规范设置 --scale-factor，保证划选 / 划词翻译 / 批注坐标准确；
 * - 当前页由视口中线决定，用于进度记忆与目录跳转；
 * - 批注 overlay 记录生成时的 viewport 缩放，缩放后按比例还原，避免错位。
 *
 * 通过 IReaderEngine 接口与视图层通信，视图层不直接接触 pdf.js。
 */
import type { AnnotationTarget, IReaderEngine, ReaderEngineEvents, ReaderEngineCapabilities, ZoomMode } from "../../IReaderEngine";
import { SimpleReaderEmitter } from "../../IReaderEngine";
import type { ReaderSettings } from "../../../../types";
import { pdfjs, initPdfWorker } from "./pdfWorker";
import type { Plugin } from "obsidian";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import type { PageMetrics } from "../../../../utils/pdf-viewport";
import { findVisibleRange, pageIndexAtMidpoint, pageSizeFromViewport, scrollTopForPage } from "../../../../utils/pdf-viewport";

export interface PdfEngineOptions {
	plugin: Plugin;
	book: unknown;
	buffer: ArrayBuffer;
}

/** pdf.js 链接注释（只取用得到的字段）。 */
interface PdfLinkAnnotation {
	subtype?: string;
	rect?: number[];
	url?: string;
	dest?: string | unknown[] | null;
}

/** 单页占位与渲染状态。 */
interface PageSlot {
	pageNumber: number;
	el: HTMLElement;
	canvas: HTMLCanvasElement | null;
	textLayerHost: HTMLElement | null;
	overlayHost: HTMLElement | null;
	/** 链接注释层（PDF 内/外超链接） */
	linkHost: HTMLElement | null;
	viewport: PageViewport | null;
	/** scale=1（已含旋转）时的页面 CSS 尺寸 */
	baseW: number;
	baseH: number;
	/** 当前布局尺寸与纵向偏移（相对滚动内容，CSS px） */
	cssW: number;
	cssH: number;
	top: number;
	rendered: boolean;
	rendering: boolean;
	/** 当前正在跑的渲染代际，用于避免过期渲染误清 rendering 标记 */
	renderGen: number;
}

const PAGE_GAP = 18;
/** 视口外预渲染范围（px） */
const RENDER_MARGIN = 1400;
/** 超过该纵向距离的已渲染页面会被释放（px） */
const UNRENDER_MARGIN = 9000;
const MIN_SCALE = 0.15;
const MAX_SCALE = 6;
const WHEEL_ZOOM_STEP = 1.12;
/**
 * "适应高度"的放大系数：纯适应高度在宽屏下会留出很多空白显得偏小，
 * 这里放大 8%，并用"适应宽度"封顶，保证不会出现横向溢出。
 */
const FIT_HEIGHT_BOOST = 1.08;

export class PdfEngine implements IReaderEngine {
	readonly format = "pdf";
	readonly capabilities: ReaderEngineCapabilities = { zoom: true, pageNav: true };

	private emitter = new SimpleReaderEmitter();
	private container!: HTMLElement;
	private pagesEl!: HTMLElement;
	private slots: PageSlot[] = [];
	/** 与 slots 同序的滚动布局指标（供纯函数计算可见范围/当前页）。 */
	private metrics: PageMetrics[] = [];
	private doc: PDFDocumentProxy | null = null;
	private destroyed = false;
	private settings: ReaderSettings = { fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24, theme: "light", layout: "single", scrollMode: true, pageWidth: 420 };

	private scale = 1;
	private zoomMode: ZoomMode = "fit-width";
	private zoomValue = 1.25;
	private baseW = 612;
	private baseH = 792;

	private currentPage = 1;
	/** 最近一次选区所在页码（批注几何换算取该页，而非"当前页"）。 */
	private selectionPage: number | null = null;

	/** 渲染代际：缩放/重排后自增，用于丢弃过期的异步渲染结果。 */
	private generation = 0;
	private pendingWheelFactor = 1;
	private wheelRaf = 0;
	private scrollRaf = 0;
	private resizeTimer: number | null = null;
	private annotations: AnnotationTarget[] = [];

	private resizeObserver: ResizeObserver | null = null;

	private onWheelBound = (evt: WheelEvent): void => this.onWheel(evt);
	private onScrollBound = (): void => this.scheduleScroll();
	private onSelectionBound = (): void => this.emitSelection();

	constructor(private opts: PdfEngineOptions) {}

	on<E extends keyof ReaderEngineEvents>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		this.emitter.on(event, handler as never);
	}
	off<E extends keyof ReaderEngineEvents>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		this.emitter.off(event, handler as never);
	}

	async mount(container: HTMLElement): Promise<void> {
		this.container = container;
		container.addClass("nyareader-pdf-root");
		this.pagesEl = container.createDiv({ cls: "nyareader-pdf-pages" });
		this.pagesEl.style.gap = `${PAGE_GAP}px`;
		try {
			await initPdfWorker(this.opts.plugin);
			const loadingTask = pdfjs.getDocument({
				data: this.opts.buffer,
				isEvalSupported: false,
				useSystemFonts: true,
			});
			this.doc = await loadingTask.promise;
			if (this.destroyed) return;
			await this.buildSlots();
			if (this.destroyed) return;
			this.attachListeners();
			this.applyThemeClass();
			this.relayout(false);
			await this.renderWindow();
			if (this.destroyed) return;
			this.emitLocation(true);
		} catch (e) {
			this.emitter.emit("error", { message: e instanceof Error ? e.message : String(e) });
		}
	}

	unmount(): void {
		this.teardown();
	}

	private teardown(): void {
		this.destroyed = true;
		this.detachListeners();
		if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
		this.resizeTimer = null;
		if (this.wheelRaf) cancelAnimationFrame(this.wheelRaf);
		this.wheelRaf = 0;
		if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
		this.scrollRaf = 0;
		this.slots = [];
		this.pagesEl?.empty();
		this.container?.removeClass("nyareader-pdf-root");
		this.container?.removeClass("is-theme-dark");
		this.container?.removeClass("is-theme-sepia");
	}

	// ---------- 缩放 ----------

	setZoom(mode: ZoomMode, value?: number): void {
		if (mode === "custom" && typeof value === "number" && Number.isFinite(value)) {
			this.zoomValue = clamp(value, MIN_SCALE, MAX_SCALE);
		}
		this.zoomMode = mode;
		this.relayout(true);
		this.emitZoom();
		void this.renderWindow();
	}

	getZoom(): { mode: ZoomMode; scale: number; percent: number } {
		return { mode: this.zoomMode, scale: this.scale, percent: Math.round(this.scale * 100) };
	}

	/** Ctrl/⌘ + 滚轮缩放（以当前阅读位置为锚点）。 */
	private onWheel(evt: WheelEvent): void {
		if (!(evt.ctrlKey || evt.metaKey)) return; // 普通滚轮交给浏览器原生滚动
		evt.preventDefault();
		this.pendingWheelFactor *= evt.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
		if (this.wheelRaf) return;
		this.wheelRaf = requestAnimationFrame(() => {
			this.wheelRaf = 0;
			const factor = this.pendingWheelFactor;
			this.pendingWheelFactor = 1;
			const next = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
			this.setZoom("custom", next);
		});
	}

	private emitZoom(): void {
		this.emitter.emit("zoomChanged", { mode: this.zoomMode, percent: Math.round(this.scale * 100) });
	}

	// ---------- 页面导航 ----------

	async goTo(location: string): Promise<void> {
		const n = clamp(pageNumber(location), 1, Math.max(1, this.slots.length));
		const slot = this.slots[n - 1];
		if (!slot) return;
		this.currentPage = n;
		this.scrollToSlot(slot);
		await this.renderWindow();
		this.emitLocation(true);
	}

	async nextPage(): Promise<void> {
		await this.goTo(String(this.currentPage + 1));
	}

	async prevPage(): Promise<void> {
		await this.goTo(String(this.currentPage - 1));
	}

	currentLocation(): string {
		return String(this.currentPage);
	}

	currentPercentage(): number {
		const total = this.slots.length;
		return total === 0 ? 0 : this.currentPage / total;
	}

	/** 视口中线所在页。 */
	private pageAtMidpoint(): number {
		if (this.slots.length === 0) return 1;
		const index = pageIndexAtMidpoint(this.metrics, this.container.scrollTop, this.container.clientHeight);
		return this.slots[index]?.pageNumber ?? 1;
	}

	private emitLocation(force = false): void {
		const p = this.pageAtMidpoint();
		if (!force && p === this.currentPage) return;
		const changed = p !== this.currentPage;
		this.currentPage = p;
		this.emitter.emit("locationChanged", { location: String(p), percentage: this.currentPercentage() });
		if (changed) this.releaseFarSlots();
	}

	private scheduleScroll(): void {
		if (this.scrollRaf) return;
		this.scrollRaf = requestAnimationFrame(() => {
			this.scrollRaf = 0;
			this.emitLocation();
			void this.renderWindow();
		});
	}

	private scrollToSlot(slot: PageSlot): void {
		const metric = this.metrics[slot.pageNumber - 1];
		if (!metric) return;
		this.container.scrollTo({ top: scrollTopForPage(metric, this.container.clientHeight), behavior: "auto" });
	}

	// ---------- 布局 ----------

	private async buildSlots(): Promise<void> {
		const doc = this.doc;
		if (!doc) return;
		// 用第一页尺寸作为所有占位的初始尺寸，渲染时按各页实际尺寸修正。
		const first = await doc.getPage(1);
		const v1 = first.getViewport({ scale: 1 });
		this.baseW = v1.width || 612;
		this.baseH = v1.height || 792;
		this.slots = [];
		const frag = document.createDocumentFragment();
		for (let i = 1; i <= doc.numPages; i++) {
			const el = document.createElement("div");
			el.className = "nyareader-pdf-slot";
			el.dataset.page = String(i);
			const slot: PageSlot = {
				pageNumber: i,
				el,
				canvas: null,
				textLayerHost: null,
				overlayHost: null,
				linkHost: null,
				viewport: null,
				baseW: this.baseW,
				baseH: this.baseH,
				cssW: this.baseW,
				cssH: this.baseH,
				top: 0,
				rendered: false,
				rendering: false,
				renderGen: -1,
			};
			this.slots.push(slot);
			frag.appendChild(el);
		}
		this.pagesEl.appendChild(frag);
	}

	/** 计算当前缩放比（按模式）。 */
	private computeScale(): number {
		const availW = this.availableWidth();
		const availH = this.availableHeight();
		switch (this.zoomMode) {
			case "fit-height":
				// 适应高度并略微放大；用适应宽度封顶避免横向滚动
				return clamp(Math.min(availW / this.baseW, (availH / this.baseH) * FIT_HEIGHT_BOOST), MIN_SCALE, MAX_SCALE);
			case "custom":
				return clamp(this.zoomValue, MIN_SCALE, MAX_SCALE);
			case "fit-width":
			default:
				return clamp(availW / this.baseW, MIN_SCALE, MAX_SCALE);
		}
	}

	private availableWidth(): number {
		const cs = window.getComputedStyle(this.pagesEl);
		const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
		// clientWidth 已排除竖直滚动条（配合 CSS scrollbar-gutter: stable 保持稳定），
		// 不要再额外减一次滚动条宽度，否则"适应宽度"会偏窄。
		return Math.max(this.container.clientWidth - padX - 2, 120);
	}

	private availableHeight(): number {
		const cs = window.getComputedStyle(this.pagesEl);
		const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
		return Math.max(this.container.clientHeight - padY - 4, 120);
	}

	/**
	 * 重排所有页面：更新缩放、清空渲染、尺寸与纵向偏移。
	 * keepAnchor=true 时保持当前阅读位置在缩放前后视觉上不跳。
	 */
	private relayout(keepAnchor: boolean): void {
		if (!this.container || this.slots.length === 0) return;
		const anchor = keepAnchor ? this.captureAnchor() : null;
		this.generation++;
		this.scale = this.computeScale();
		for (const slot of this.slots) this.clearSlot(slot);
		for (const slot of this.slots) {
			slot.cssW = Math.max(1, Math.round(slot.baseW * this.scale));
			slot.cssH = Math.max(1, Math.round(slot.baseH * this.scale));
			slot.el.style.width = `${slot.cssW}px`;
			slot.el.style.height = `${slot.cssH}px`;
		}
		// 读取一次真实布局，缓存每页在滚动内容内的偏移。
		for (const slot of this.slots) slot.top = slot.el.offsetTop;
		this.metrics = this.slots.map((s) => ({ top: s.top, height: s.cssH }));
		if (anchor) this.restoreAnchor(anchor);
	}

	/** 单页尺寸与占位不一致时（混合尺寸 PDF）就地修正并重算偏移。 */
	private fixSlotSize(slot: PageSlot, cssW: number, cssH: number): void {
		if (slot.cssW === cssW && slot.cssH === cssH) return;
		const anchor = this.captureAnchor();
		slot.cssW = cssW;
		slot.cssH = cssH;
		slot.el.style.width = `${cssW}px`;
		slot.el.style.height = `${cssH}px`;
		for (const s of this.slots) s.top = s.el.offsetTop;
		this.metrics = this.slots.map((s) => ({ top: s.top, height: s.cssH }));
		this.restoreAnchor(anchor);
	}

	private captureAnchor(): { page: number; ratio: number } | null {
		const slot = this.slots[this.currentPage - 1];
		if (!slot || slot.cssH <= 0) return null;
		const ratio = clamp((this.container.scrollTop - slot.top) / slot.cssH, 0, 1);
		return { page: this.currentPage, ratio };
	}

	private restoreAnchor(anchor: { page: number; ratio: number } | null): void {
		if (!anchor) return;
		const slot = this.slots[anchor.page - 1];
		if (!slot) return;
		this.container.scrollTop = Math.max(0, Math.round(slot.top + anchor.ratio * slot.cssH));
	}

	// ---------- 渲染 ----------

	private async renderWindow(): Promise<void> {
		if (!this.doc || this.destroyed) return;
		const [from, to] = this.visibleRange(RENDER_MARGIN);
		const jobs: Array<Promise<void>> = [];
		for (let i = from; i <= to; i++) jobs.push(this.renderSlot(this.slots[i]));
		await Promise.all(jobs);
	}

	/** 返回与视口（上下各留 margin）相交的页面索引区间。 */
	private visibleRange(margin: number): [number, number] {
		return findVisibleRange(this.metrics, this.container.scrollTop, this.container.clientHeight, margin);
	}

	private async renderSlot(slot: PageSlot): Promise<void> {
		if (!this.doc || this.destroyed || slot.rendered || slot.rendering) return;
		slot.rendering = true;
		const gen = this.generation;
		slot.renderGen = gen;
		try {
			const page = await this.doc.getPage(slot.pageNumber);
			if (this.destroyed || gen !== this.generation) return;
			const viewport = page.getViewport({ scale: this.scale });
			const cssW = Math.max(1, Math.round(viewport.width));
			const cssH = Math.max(1, Math.round(viewport.height));
			this.fixSlotSize(slot, cssW, cssH);

			slot.el.empty();
			const canvas = slot.el.createEl("canvas", { cls: "nyareader-pdf-canvas" });
			const textLayerHost = slot.el.createDiv({ cls: "nyareader-pdf-textlayer" });
			const overlayHost = slot.el.createDiv({ cls: "nyareader-pdf-overlay" });
			const linkHost = slot.el.createDiv({ cls: "nyareader-pdf-links" });
			slot.canvas = canvas;
			slot.textLayerHost = textLayerHost;
			slot.overlayHost = overlayHost;
			slot.linkHost = linkHost;
			slot.viewport = viewport;

			// 高分屏：canvas 物理尺寸 = viewport × dpr，CSS 尺寸 = viewport。
			const dpr = window.devicePixelRatio || 1;
			canvas.width = Math.floor(viewport.width * dpr);
			canvas.height = Math.floor(viewport.height * dpr);
			canvas.style.width = `${cssW}px`;
			canvas.style.height = `${cssH}px`;

			const renderContext = {
				canvasContext: canvas.getContext("2d") as CanvasRenderingContext2D,
				viewport,
				transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
			};
			await page.render(renderContext).promise;
			if (this.destroyed || gen !== this.generation || canvas.parentElement !== slot.el) return;

			await this.renderTextLayer(slot, textLayerHost, page, viewport, cssW, cssH, gen);
			if (this.destroyed || gen !== this.generation) return;

			// 链接注释层（PDF 内/外超链接可点击）
			try {
				await this.renderLinkLayer(slot, linkHost, page, viewport);
			} catch {
				/* 链接层失败不影响阅读 */
			}
			if (this.destroyed || gen !== this.generation) return;

			slot.rendered = true;
			this.paintOverlay(slot);
		} catch (e) {
			if (!this.destroyed) {
				this.emitter.emit("error", { message: `第 ${slot.pageNumber} 页渲染失败：${e instanceof Error ? e.message : String(e)}` });
			}
		} finally {
			// 仅当这一轮渲染仍是最新一轮时才清除标记，避免过期渲染干扰新渲染
			if (slot.renderGen === gen) slot.rendering = false;
		}
	}

	private clearSlot(slot: PageSlot): void {
		slot.el.empty();
		slot.canvas = null;
		slot.textLayerHost = null;
		slot.overlayHost = null;
		slot.linkHost = null;
		slot.viewport = null;
		slot.rendered = false;
		slot.rendering = false;
		slot.renderGen = -1;
	}

	/**
	 * 渲染文本层。
	 *
	 * 关键：必须设置 --scale-factor。pdf.js 4.x 用 calc(var(--scale-factor) * Npx)
	 * 计算 span 字号，缺这个变量会让透明文字盒与画布文字错位，表现为"选不中/选不准"。
	 * 同时用 getTextContent() 判断该页是否存在可选中文本（扫描版 PDF 没有）。
	 */
	private async renderTextLayer(
		slot: PageSlot,
		host: HTMLElement,
		page: PDFPageProxy,
		viewport: PageViewport,
		cssW: number,
		cssH: number,
		gen: number
	): Promise<void> {
		host.style.setProperty("--scale-factor", String(viewport.scale));
		host.style.width = `${cssW}px`;
		host.style.height = `${cssH}px`;
		const textContent = await page.getTextContent();
		if (this.destroyed || gen !== this.generation) return;
		const hasText = textContent.items.some((item) => {
			const str = (item as { str?: unknown }).str;
			return typeof str === "string" && str.trim() !== "";
		});
		// 扫描版页面：无文本层，提示由 CSS 处理（不报错）
		slot.el.toggleClass("is-image-only", !hasText);
		if (!hasText) return;
		const textLayer = new pdfjs.TextLayer({
			textContentSource: textContent,
			container: host,
			viewport,
		});
		await textLayer.render();
		if (this.destroyed || gen !== this.generation) return;
		// 诊断：有文本却没生成任何 span，说明文本层构建失败（划选/复制会不可用）
		if (host.childElementCount === 0) {
			this.emitter.emit("error", { message: `第 ${slot.pageNumber} 页文本层为空，划选/复制可能不可用。` });
		}
	}

	/**
	 * 渲染超链接注释层：外链在新窗口打开，PDF 内部链接跳转到目标页。
	 * 只有链接矩形本身接收点击（层本身 pointer-events:none），不影响其他区域划选。
	 */
	private async renderLinkLayer(slot: PageSlot, host: HTMLElement, page: PDFPageProxy, viewport: PageViewport): Promise<void> {
		const annotations = (await page.getAnnotations()) as PdfLinkAnnotation[];
		host.empty();
		for (const a of annotations) {
			if (a.subtype !== "Link") continue;
			const rect = a.rect;
			if (!Array.isArray(rect) || rect.length < 4) continue;
			const converted = viewport.convertToViewportRectangle(rect) as number[];
			const x1 = converted[0];
			const y1 = converted[1];
			const x2 = converted[2];
			const y2 = converted[3];
			const left = Math.min(x1, x2);
			const top = Math.min(y1, y2);
			const width = Math.abs(x2 - x1);
			const height = Math.abs(y2 - y1);
			if (!(width > 0) || !(height > 0)) continue;
			const link = document.createElement("a");
			link.className = "nyareader-pdf-link";
			link.style.left = `${left}px`;
			link.style.top = `${top}px`;
			link.style.width = `${width}px`;
			link.style.height = `${height}px`;
			if (typeof a.url === "string" && a.url) {
				link.href = a.url;
				link.target = "_blank";
				link.rel = "noopener noreferrer";
				link.title = a.url;
			} else if (a.dest) {
				const dest = a.dest;
				link.href = "#";
				link.addClass("nyareader-pdf-link-internal");
				link.title = "跳转到该位置";
				link.addEventListener("click", (evt) => {
					evt.preventDefault();
					evt.stopPropagation();
					void this.navigateToDest(dest);
				});
			} else {
				continue;
			}
			host.appendChild(link);
		}
	}

	/** 解析 PDF 目标（命名/内联）为页码并跳转。 */
	private async navigateToDest(dest: string | unknown[] | null): Promise<void> {
		const page = await this.resolveDestPage(dest);
		if (page) await this.goTo(String(page));
	}

	private async resolveDestPage(dest: string | unknown[] | null): Promise<number | null> {
		const doc = this.doc;
		if (!doc || !dest) return null;
		try {
			let resolved: unknown = dest;
			if (typeof resolved === "string") resolved = await doc.getDestination(resolved);
			if (!Array.isArray(resolved) || resolved.length === 0) return null;
			const target = resolved[0];
			if (target && typeof target === "object" && "num" in (target as Record<string, unknown>)) {
				const index = await doc.getPageIndex(target as { num: number; gen: number }).catch(() => -1);
				return index >= 0 ? index + 1 : null;
			}
			if (typeof target === "number" && Number.isFinite(target)) return Math.max(1, Math.floor(target) + 1);
		} catch {
			/* 目标解析失败忽略 */
		}
		return null;
	}

	/** 释放离视口很远的页面，控制大文件内存占用。 */
	private releaseFarSlots(): void {
		const top = this.container.scrollTop;
		const bottom = top + this.container.clientHeight;
		for (const slot of this.slots) {
			if (!slot.rendered) continue;
			const distance = slot.top + slot.cssH < top ? top - (slot.top + slot.cssH) : slot.top - bottom;
			if (distance > UNRENDER_MARGIN) this.clearSlot(slot);
		}
	}

	private applyThemeClass(): void {
		if (!this.container) return;
		this.container.toggleClass("is-theme-dark", this.settings.theme === "dark");
		this.container.toggleClass("is-theme-sepia", this.settings.theme === "sepia");
	}

	// ---------- 设置 ----------

	applySettings(settings: ReaderSettings): void {
		this.settings = { ...settings };
		this.applyThemeClass();
		if (!this.doc || this.slots.length === 0) return;
		// 仅当缩放模式随容器变化时才重排，避免无谓重渲染。
		if (this.zoomMode === "fit-width" || this.zoomMode === "fit-height") {
			const next = this.computeScale();
			if (Math.abs(next - this.scale) > 0.0005) {
				this.relayout(true);
				this.emitZoom();
				void this.renderWindow();
			}
		}
	}

	// ---------- 选区与批注 ----------

	/** 暴露当前（或选区所在）页 viewport，供 Controller 做批注坐标换算。 */
	getViewport(): PageViewport | null {
		const n = this.selectionPage ?? this.currentPage;
		return this.slots[n - 1]?.viewport ?? null;
	}

	/** 当前页 PDF 用户空间尺寸（pt），由 viewport 反推（兼容旋转）。 */
	getPageSizePt(): { width: number; height: number } | null {
		const vp = this.getViewport();
		if (!vp) return null;
		return pageSizeFromViewport(vp, vp.width, vp.height);
	}

	getSelection(): { text: string; target?: AnnotationTarget } | null {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed) return null;
		const text = sel.toString().trim();
		if (!text) return null;
		const rects: NonNullable<AnnotationTarget["rects"]> = [];
		let targetSlot: PageSlot | null = null;
		for (let i = 0; i < sel.rangeCount; i++) {
			const range = sel.getRangeAt(i);
			const clientRects = range.getClientRects();
			for (let j = 0; j < clientRects.length; j++) {
				const r = clientRects[j];
				if (r.width === 0 && r.height === 0) continue;
				const slot = this.slotFromClientPoint(r.left + r.width / 2, r.top + r.height / 2);
				if (!slot) continue;
				if (!targetSlot) targetSlot = slot;
				// 跨页选择只取第一页，保证批注落在单页内。
				if (slot !== targetSlot) continue;
				const base = slot.el.getBoundingClientRect();
				rects.push({ left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height });
			}
		}
		if (!targetSlot || rects.length === 0) return null;
		this.selectionPage = targetSlot.pageNumber;
		return {
			text,
			target: {
				location: String(targetSlot.pageNumber),
				rects,
				selectedText: text,
				scale: targetSlot.viewport?.scale,
			},
		};
	}

	private slotFromClientPoint(x: number, y: number): PageSlot | null {
		const hit = document.elementFromPoint(x, y) as HTMLElement | null;
		const host = hit?.closest?.(".nyareader-pdf-slot") as HTMLElement | null;
		if (host?.dataset.page) {
			const slot = this.slots[parseInt(host.dataset.page, 10) - 1];
			if (slot) return slot;
		}
		for (const slot of this.slots) {
			const r = slot.el.getBoundingClientRect();
			if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return slot;
		}
		return null;
	}

	/** 注册批注并在已渲染页面上绘制高亮（不改变滚动位置）。 */
	showAnnotation(target: AnnotationTarget): void {
		if (!target) return;
		const key = this.annotationKey(target);
		if (!this.annotations.some((a) => this.annotationKey(a) === key)) this.annotations.push(target);
		for (const slot of this.slots) if (slot.rendered) this.paintOverlay(slot);
	}

	/** 隐藏指定批注的高亮（与存储删除同步调用）。 */
	hideAnnotation(target: AnnotationTarget): void {
		if (!target) return;
		const key = this.annotationKey(target);
		this.annotations = this.annotations.filter((a) => this.annotationKey(a) !== key);
		for (const slot of this.slots) if (slot.rendered) this.paintOverlay(slot);
	}

	private annotationKey(target: AnnotationTarget): string {
		const r = target.rects?.[0];
		return `${target.location}|${target.selectedText ?? ""}|${r ? `${r.left.toFixed(1)},${r.top.toFixed(1)},${r.width.toFixed(1)}` : ""}`;
	}

	private paintOverlay(slot: PageSlot): void {
		const host = slot.overlayHost;
		if (!host) return;
		host.empty();
		const page = String(slot.pageNumber);
		const current = slot.viewport?.scale ?? this.scale;
		for (const ann of this.annotations) {
			if (ann.location !== page) continue;
			// 记录生成时的缩放；缩放后按比例放大/缩小高亮，保持与文字对齐。
			const ratio = ann.scale && ann.scale > 0 ? current / ann.scale : 1;
			for (const r of ann.rects ?? []) {
				const div = host.createDiv({ cls: "nyareader-pdf-annotation-marker" });
				div.style.left = `${r.left * ratio}px`;
				div.style.top = `${r.top * ratio}px`;
				div.style.width = `${r.width * ratio}px`;
				div.style.height = `${r.height * ratio}px`;
			}
		}
	}

	// ---------- 事件 ----------

	private attachListeners(): void {
		this.container.addEventListener("scroll", this.onScrollBound, { passive: true });
		this.container.addEventListener("wheel", this.onWheelBound, { passive: false });
		this.pagesEl.addEventListener("mouseup", this.onSelectionBound);
		this.pagesEl.addEventListener("touchend", this.onSelectionBound);
		this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
		this.resizeObserver.observe(this.container);
	}

	private detachListeners(): void {
		this.container?.removeEventListener("scroll", this.onScrollBound);
		this.container?.removeEventListener("wheel", this.onWheelBound);
		this.pagesEl?.removeEventListener("mouseup", this.onSelectionBound);
		this.pagesEl?.removeEventListener("touchend", this.onSelectionBound);
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
	}

	private scheduleResize(): void {
		if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
		this.resizeTimer = window.setTimeout(() => {
			this.resizeTimer = null;
			this.handleResize();
		}, 140);
	}

	private handleResize(): void {
		if (this.destroyed || !this.doc) return;
		if (this.zoomMode !== "fit-width" && this.zoomMode !== "fit-height") return;
		const next = this.computeScale();
		if (Math.abs(next - this.scale) < 0.0005) return;
		this.relayout(true);
		this.emitZoom();
		void this.renderWindow();
	}

	private emitSelection(): void {
		const sel = this.getSelection();
		if (sel && sel.text) this.emitter.emit("selection", { text: sel.text });
	}

	destroy(): void {
		this.teardown();
		void this.doc?.destroy();
		this.doc = null;
		this.annotations = [];
		this.emitter.clear();
	}
}

function clamp(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min;
	return Math.min(max, Math.max(min, n));
}

function pageNumber(location: string): number {
	const n = parseInt(location, 10);
	return Number.isFinite(n) ? n : 1;
}
