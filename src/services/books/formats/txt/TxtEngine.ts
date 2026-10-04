/**
 * TXT 阅读引擎：虚拟滚动渲染长文档。
 * - 滚动模式：整篇连续滚动，窗口化渲染可见段落（虚拟滚动，避免巨量 DOM）
 * - 分页模式：按段落估算分页（后续可升级为精确度量）
 * - 进度按字符/段落累计
 * 支持选中文本（划词翻译）与批注定位。
 */
import type { AnnotationTarget, IReaderEngine, ReaderEngineEvents } from "../../IReaderEngine";
import { SimpleReaderEmitter } from "../../IReaderEngine";
import type { BookModel, ReaderSettings } from "../../../../types";
import type { TxtContent } from "./TxtParser";
import { splitParagraphs } from "./TxtParser";

export interface TxtEngineOptions {
	book: BookModel;
	content: TxtContent;
}

export class TxtEngine implements IReaderEngine {
	readonly format = "txt";
	private emitter = new SimpleReaderEmitter();
	private container!: HTMLElement;
	private scrollEl!: HTMLElement;
	private spacerEl!: HTMLElement;
	private windowEl!: HTMLElement;
	private settings: ReaderSettings = { fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24, theme: "light", layout: "single", scrollMode: false, pageWidth: 420 };

	private paragraphs: string[] = [];
	private chapters: TxtContent["chapters"] = [];
	/** 每段估算高度（px），用于虚拟滚动布局 */
	private heights: number[] = [];
	private totalHeight = 0;
	private rowHeight = 26;
	private currentScrollTop = 0;
	private destroyed = false;
	private observer: IntersectionObserver | null = null;

	constructor(private opts: TxtEngineOptions) {
		this.paragraphs = opts.content.paragraphs;
		this.chapters = opts.content.chapters;
	}

	on<E extends keyof ReaderEngineEvents>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		this.emitter.on(event, handler as never);
	}
	off<E extends keyof ReaderEngineEvents>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		this.emitter.off(event, handler as never);
	}

	async mount(container: HTMLElement): Promise<void> {
		this.container = container;
		this.scrollEl = container.createDiv({ cls: "nyareader-txt-scroll" });
		this.spacerEl = this.scrollEl.createDiv({ cls: "nyareader-txt-spacer" });
		this.windowEl = this.scrollEl.createDiv({ cls: "nyareader-txt-window" });

		this.scrollEl.addEventListener("scroll", () => {
			this.currentScrollTop = this.scrollEl.scrollTop;
			this.renderWindow();
			this.emitProgress();
		}, { passive: true });

		this.applySettings(this.settings);
		this.renderWindow();

		// 选中事件（mouseup 后读取选区）
		this.scrollEl.addEventListener("mouseup", () => {
			const sel = this.getSelection();
			if (sel) this.emitter.emit("selection", { text: sel.text });
		});
	}

	unmount(): void {
		this.destroyed = true;
		this.windowEl?.empty();
	}

	async goTo(location: string): Promise<void> {
		const idx = parseInt(location, 10);
		if (Number.isNaN(idx)) return;
		const top = this.heightUpTo(idx);
		this.scrollEl.scrollTop = Math.max(0, top - 80);
		this.renderWindow();
		this.emitProgress();
	}

	async nextPage(): Promise<void> {
		this.scrollEl.scrollBy({ top: this.scrollEl.clientHeight * 0.9, behavior: "smooth" });
	}

	async prevPage(): Promise<void> {
		this.scrollEl.scrollBy({ top: -this.scrollEl.clientHeight * 0.9, behavior: "smooth" });
	}

	currentLocation(): string {
		// 定位为当前顶部所在段落索引
		return String(this.paragraphIndexAt(this.currentScrollTop));
	}

	currentPercentage(): number {
		if (this.totalHeight <= 0) return 0;
		const max = Math.max(1, this.scrollEl.scrollHeight - this.scrollEl.clientHeight);
		return Math.min(1, Math.max(0, this.scrollEl.scrollTop / max));
	}

	applySettings(settings: ReaderSettings): void {
		this.settings = { ...settings };
		if (this.scrollEl) {
			this.scrollEl.classList.toggle("nyareader-theme-dark", settings.theme === "dark");
			this.scrollEl.classList.toggle("nyareader-theme-sepia", settings.theme === "sepia");
			this.scrollEl.style.fontFamily = settings.fontFamily;
			this.scrollEl.style.fontSize = `${settings.fontSize}px`;
			this.scrollEl.style.lineHeight = `${settings.lineHeight}`;
			this.scrollEl.style.paddingLeft = `${settings.margin}px`;
			this.scrollEl.style.paddingRight = `${settings.margin}px`;
			// 单双栏：双栏用 CSS 多列（每栏 pageWidth）
			if (settings.layout === "double") {
				this.scrollEl.style.columnWidth = `${settings.pageWidth}px`;
				this.scrollEl.style.columnGap = "48px";
				this.scrollEl.style.columnRule = "1px solid rgba(0,0,0,0.08)";
				this.scrollEl.style.height = `${Math.max(this.scrollEl.clientHeight, 400)}px`;
			} else {
				this.scrollEl.style.columnWidth = "auto";
				this.scrollEl.style.columnGap = "0px";
				this.scrollEl.style.columnRule = "none";
				this.scrollEl.style.height = "";
			}
		}
	}

	getSelection(): { text: string; target?: AnnotationTarget } | null {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed) return null;
		const text = sel.toString().trim();
		if (!text) return null;
		const rects: AnnotationTarget["rects"] = [];
		for (let i = 0; i < sel.rangeCount; i++) {
			for (const r of Array.from(sel.getRangeAt(i).getClientRects())) {
				if (r.width && r.height) rects.push({ left: r.left, top: r.top, width: r.width, height: r.height });
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
		await this.goTo(target.location);
	}

	/** 渲染当前可见窗口内的段落（虚拟滚动核心）。 */
	private renderWindow(): void {
		if (this.destroyed) return;
		const viewportTop = this.scrollEl.scrollTop;
		const viewportBottom = viewportTop + this.scrollEl.clientHeight;
		const padding = this.scrollEl.clientHeight; // 上下各一屏缓冲
		const startIdx = this.paragraphIndexAt(Math.max(0, viewportTop - padding));
		const endIdx = this.paragraphIndexAt(viewportBottom + padding);

		this.windowEl.empty();
		this.windowEl.style.position = "relative";
		this.windowEl.style.top = `${this.heightUpTo(startIdx)}px`;
		this.windowEl.style.height = `${this.heightUpTo(endIdx) - this.heightUpTo(startIdx)}px`;

		const frag = document.createDocumentFragment();
		for (let i = startIdx; i < endIdx && i < this.paragraphs.length; i++) {
			const p = frag.createEl("p", { cls: "nyareader-txt-para", text: this.paragraphs[i] });
			p.dataset.index = String(i);
			p.style.margin = `0 0 ${this.rowHeight * 0.45}px`;
		}
		this.windowEl.appendChild(frag);
	}

	private heightUpTo(index: number): number {
		// 估算：行数 = 字符数 / 每行容量近似（用平均行高与字号粗估）
		let h = 0;
		const charsPerLine = Math.max(10, Math.floor((this.scrollEl?.clientWidth ?? 600) / (this.settings.fontSize * 0.6)));
		for (let i = 0; i < index && i < this.paragraphs.length; i++) {
			const lines = Math.max(1, Math.ceil(this.paragraphs[i].length / charsPerLine));
			h += lines * this.rowHeight * this.settings.lineHeight * 0.6;
		}
		return h;
	}

	private paragraphIndexAt(top: number): number {
		// 二分查找高度对应的段落
		let lo = 0;
		let hi = this.paragraphs.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.heightUpTo(mid) <= top) lo = mid + 1;
			else hi = mid;
		}
		return Math.max(0, lo - 1);
	}

	private emitProgress(): void {
		this.emitter.emit("locationChanged", { location: this.currentLocation(), percentage: this.currentPercentage() });
	}

	destroy(): void {
		this.destroyed = true;
		this.unmount();
		this.emitter.clear();
	}
}
