/**
 * EPUB 阅读引擎：基于 epub.js Rendition。
 * 职责：渲染（分页/滚动）、翻页、CFI 定位、版式设置（主题/字号/行距/单双栏）、
 * 文本选区与批注定位。
 * epub.js 为老库，类型用 any 桥接（复用优先、类型降级）。
 */
import Epub from "epubjs";
import type { AnnotationTarget, IReaderEngine, ReaderEngineEvents } from "../../IReaderEngine";
import { SimpleReaderEmitter } from "../../IReaderEngine";
import type { BookModel, ReaderSettings } from "../../../../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBook = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRendition = any;

export interface EpubEngineOptions {
	book: BookModel;
	buffer: ArrayBuffer;
}

const THEME_CSS: Record<ReaderSettings["theme"], string> = {
	light: "body { background: #fff; color: #1f1f1f; }",
	dark: "body { background: #1e1e1e; color: #cfcfcf; }",
	sepia: "body { background: #f4ecd8; color: #5b4636; }",
};

export class EpubEngine implements IReaderEngine {
	readonly format = "epub";
	private emitter = new SimpleReaderEmitter();
	private container!: HTMLElement;
	private epub: AnyBook | null = null;
	private rendition: AnyRendition | null = null;
	private settings: ReaderSettings = { fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24, theme: "light", layout: "single", scrollMode: false, pageWidth: 420 };
	private resizeObserver: ResizeObserver | null = null;
	private selectionHandlerAttached = false;
	private destroyed = false;

	constructor(private opts: EpubEngineOptions) {}

	on<E extends keyof ReaderEngineEvents>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		this.emitter.on(event, handler as never);
	}
	off<E extends keyof ReaderEngineEvents>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		this.emitter.off(event, handler as never);
	}

	async mount(container: HTMLElement): Promise<void> {
		this.container = container;
		try {
			this.epub = Epub(this.opts.buffer);
			await this.epub.ready;
			// 生成位置索引（供百分比进度）
			await this.epub.locations.generate(1600).catch(() => undefined);

			this.rendition = this.epub.renderTo(container, {
				width: Math.max(container.clientWidth, 300),
				height: Math.max(container.clientHeight, 400),
				flow: this.settings.scrollMode ? "scrolled-doc" : "paginated",
				spread: this.settings.layout === "double" ? "auto" : "none",
				allowScriptedContent: false,
			});

			this.rendition.on("relocated", (location: { start: { cfi: string; percentage?: number } }) => {
				const cfi = location.start.cfi;
				const pct = this.epub.locations.percentageFromCfi(cfi);
				this.emitter.emit("locationChanged", { location: cfi, percentage: pct || 0 });
			});
			this.rendition.on("selected", (_cfi: string, contents: { window?: Window }) => {
				// 选区由 getSelection 主动读取，这里仅标记
				void contents;
			});

			await this.rendition.display();
			this.applySettings(this.settings);
			this.attachSelectionHandler();

			// 容器尺寸变化时重排
			if (typeof ResizeObserver !== "undefined") {
				this.resizeObserver = new ResizeObserver(() => {
					if (this.rendition && !this.destroyed) {
						this.rendition.resize(Math.max(this.container.clientWidth, 300), Math.max(this.container.clientHeight, 400));
					}
				});
				this.resizeObserver.observe(container);
			}
		} catch (e) {
			this.emitter.emit("error", { message: `EPUB 加载失败：${e instanceof Error ? e.message : String(e)}` });
		}
	}

	unmount(): void {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.rendition) {
			try {
				this.rendition.destroy();
			} catch {
				/* ignore */
			}
		}
		this.rendition = null;
		this.epub = null;
	}

	async goTo(location: string): Promise<void> {
		if (!this.rendition) return;
		await this.rendition.display(location).catch(() => undefined);
	}

	async nextPage(): Promise<void> {
		await this.rendition?.next().catch(() => undefined);
	}

	async prevPage(): Promise<void> {
		await this.rendition?.prev().catch(() => undefined);
	}

	currentLocation(): string {
		if (!this.rendition) return "";
		const loc = this.rendition.currentLocation();
		return loc?.start?.cfi ?? "";
	}

	currentPercentage(): number {
		if (!this.epub || !this.rendition) return 0;
		try {
			const cfi = this.currentLocation();
			return cfi ? this.epub.locations.percentageFromCfi(cfi) || 0 : 0;
		} catch {
			return 0;
		}
	}

	applySettings(settings: ReaderSettings): void {
		this.settings = { ...settings };
		if (!this.rendition) return;
		try {
			this.rendition.themes.fontSize(`${settings.fontSize}px`);
			this.rendition.themes.override("line-height", `${settings.lineHeight}`);
			this.rendition.themes.override("margin-left", `${settings.margin}px`);
			this.rendition.themes.override("margin-right", `${settings.margin}px`);
			this.rendition.themes.override("font-family", settings.fontFamily);
			this.rendition.themes.register("nyareader-theme", THEME_CSS[settings.theme]);
			this.rendition.themes.select("nyareader-theme");
			this.rendition.flow(settings.scrollMode ? "scrolled-doc" : "paginated");
			this.rendition.spread(settings.layout === "double" ? "auto" : "none");
			this.rendition.resize(Math.max(this.container.clientWidth, 300), Math.max(this.container.clientHeight, 400));
		} catch {
			/* 主题热更新失败不致命 */
		}
	}

	getSelection(): { text: string; target?: AnnotationTarget } | null {
		if (!this.rendition) return null;
		const win = this.getIframeWindow();
		if (!win) return null;
		const sel = win.getSelection();
		if (!sel || sel.isCollapsed) return null;
		const text = sel.toString().trim();
		if (!text) return null;

		// 计算页内矩形（iframe 内坐标）
		const rects: AnnotationTarget["rects"] = [];
		for (let i = 0; i < sel.rangeCount; i++) {
			const range = sel.getRangeAt(i);
			for (const r of Array.from(range.getClientRects())) {
				if (r.width === 0 && r.height === 0) continue;
				rects.push({ left: r.left, top: r.top, width: r.width, height: r.height });
			}
		}
		return {
			text,
			target: {
				location: this.currentLocation(),
				rects,
				selectedText: text,
			},
		};
	}

	async showAnnotation(target: AnnotationTarget): Promise<void> {
		// 跳转到批注所在位置；高亮渲染由视图层 overlay 处理（EPUB 用侧车存储）
		await this.goTo(target.location);
	}

	private getIframeWindow(): Window | null {
		if (!this.rendition) return null;
		const iframe = this.container.querySelector("iframe");
		return iframe?.contentWindow ?? null;
	}

	private attachSelectionHandler(): void {
		if (this.selectionHandlerAttached) return;
		this.selectionHandlerAttached = true;
		const win = this.getIframeWindow();
		if (!win) return;
		win.addEventListener?.("mouseup", () => {
			const sel = this.getSelection();
			if (sel) this.emitter.emit("selection", { text: sel.text });
		});
	}

	destroy(): void {
		this.destroyed = true;
		this.unmount();
		this.emitter.clear();
	}
}

