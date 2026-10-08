/**
 * TXT 阅读引擎：测量修正型虚拟滚动。
 *
 * 为什么重写（v0.3.2）：
 * - 旧实现依赖 .nyareader-txt-scroll/spacer/window 的 CSS，但样式表里根本没有这些类，
 *   滚动容器没有高度、spacer 没有高度，window 又被内联改成 position:relative；
 * - 更致命的是 mount 时容器 clientHeight 仍为 0，endIdx 与 startIdx 相等，
 *   一个段落都不渲染 —— 表现就是"打开 TXT 完全空白"。
 *
 * 现在的做法：
 * - 滚动容器自带高度（CSS），并挂 ResizeObserver，容器拿到尺寸后立刻重排；
 * - 每段先按字号/行高/宽度估算高度，渲染后测量真实高度并修正前缀和（prefix sum），
 *   因此进度、跳转与滚动位置都基于真实布局；
 * - 只渲染视口上下各一屏范围内的段落，超大 TXT 也不会造成巨量 DOM。
 */
import type { AnnotationTarget, IReaderEngine, ReaderEngineEvents } from "../../IReaderEngine";
import { SimpleReaderEmitter } from "../../IReaderEngine";
import type { BookModel, ReaderSettings } from "../../../../types";
import type { TxtContent } from "./TxtParser";

export interface TxtEngineOptions {
	book: BookModel;
	content: TxtContent;
}

/** 视口外预渲染缓冲（倍数，1 = 上下各一屏） */
const WINDOW_BUFFER_SCALE = 1;
/** 段落下间距（em），需与 CSS .nyareader-txt-para 的 padding-bottom 保持一致 */
const PARAGRAPH_SPACING_EM = 0.6;
/** 每行平均字符宽度估算（相对字号） */
const CHAR_WIDTH_RATIO = 0.62;
/** 正文上下留白（px），同时计入滚动总高度 */
const TOP_PAD = 16;

export class TxtEngine implements IReaderEngine {
	readonly format = "txt";
	private emitter = new SimpleReaderEmitter();
	private container!: HTMLElement;
	private scrollEl!: HTMLElement;
	private spacerEl!: HTMLElement;
	private windowEl!: HTMLElement;
	private settings: ReaderSettings = { fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24, theme: "light", layout: "single", scrollMode: true, pageWidth: 420 };

	private paragraphs: string[] = [];
	private chapters: TxtContent["chapters"] = [];
	/** 每段高度（估算 -> 测量修正） */
	private heights: number[] = [];
	/** prefix[i] = 前 i 段累计高度 */
	private prefix: number[] = [];
	private measured: boolean[] = [];

	private destroyed = false;
	private resizeObserver: ResizeObserver | null = null;
	private renderRaf = 0;

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

		this.scrollEl.addEventListener("scroll", () => this.scheduleRender(), { passive: true });
		this.scrollEl.addEventListener("mouseup", () => {
			const sel = this.getSelection();
			if (sel) this.emitter.emit("selection", { text: sel.text });
		});

		this.applySettings(this.settings);

		if (typeof ResizeObserver !== "undefined") {
			this.resizeObserver = new ResizeObserver(() => {
				// 宽度变化会改变每行字符数，需要重新估算并重排
				this.rebuildLayout();
				this.scheduleRender();
			});
			this.resizeObserver.observe(this.scrollEl);
		}

		// 容器刚插入时 clientHeight 可能还是 0，下一帧与 ResizeObserver 都会补一次
		this.rebuildLayout();
		this.renderWindow();
		requestAnimationFrame(() => this.renderWindow());
	}

	unmount(): void {
		this.destroyed = true;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.renderRaf) cancelAnimationFrame(this.renderRaf);
		this.renderRaf = 0;
		this.windowEl?.empty();
	}

	async goTo(location: string): Promise<void> {
		const idx = parseInt(location, 10);
		if (Number.isNaN(idx)) return;
		const clamped = Math.max(0, Math.min(this.paragraphs.length - 1, idx));
		this.scrollEl.scrollTop = Math.max(0, (this.prefix[clamped] ?? 0) + TOP_PAD);
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
		return String(this.indexAtOffset(Math.max(0, (this.scrollEl?.scrollTop ?? 0) - TOP_PAD)));
	}

	currentPercentage(): number {
		const contentHeight = (this.prefix[this.paragraphs.length] ?? 0) + TOP_PAD * 2;
		if (contentHeight <= 0) return 0;
		const offset = Math.min(contentHeight, Math.max(0, this.scrollEl?.scrollTop ?? 0));
		return offset / contentHeight;
	}

	applySettings(settings: ReaderSettings): void {
		this.settings = { ...settings };
		if (!this.scrollEl) return;
		this.scrollEl.toggleClass("nyareader-theme-dark", settings.theme === "dark");
		this.scrollEl.toggleClass("nyareader-theme-sepia", settings.theme === "sepia");
		this.scrollEl.style.fontFamily = settings.fontFamily;
		this.scrollEl.style.fontSize = `${settings.fontSize}px`;
		this.scrollEl.style.lineHeight = `${settings.lineHeight}`;
		this.scrollEl.style.setProperty("--nyareader-txt-margin", `${settings.margin}px`);
		this.rebuildLayout();
		this.scheduleRender();
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
			target: { location: this.currentLocation(), rects, selectedText: text },
		};
	}

	async showAnnotation(target: AnnotationTarget): Promise<void> {
		await this.goTo(target.location);
	}

	// ---------- 虚拟滚动核心 ----------

	private scheduleRender(): void {
		if (this.renderRaf) return;
		this.renderRaf = requestAnimationFrame(() => {
			this.renderRaf = 0;
			this.renderWindow();
		});
	}

	/** 重建高度估算与前缀和（字号/宽度变化时调用）。 */
	private rebuildLayout(): void {
		if (!this.paragraphs.length) return;
		const charsPerLine = this.charsPerLine();
		const lineHeightPx = this.settings.fontSize * this.settings.lineHeight;
		const spacingPx = this.settings.fontSize * PARAGRAPH_SPACING_EM;
		this.heights = this.paragraphs.map((p) => {
			const lines = Math.max(1, Math.ceil(p.length / charsPerLine));
			return lines * lineHeightPx + spacingPx;
		});
		this.measured = this.paragraphs.map(() => false);
		this.prefix = new Array(this.paragraphs.length + 1).fill(0);
		this.rebuildPrefix(0);
	}

	private charsPerLine(): number {
		const width = this.contentWidth();
		return Math.max(8, Math.floor(width / (this.settings.fontSize * CHAR_WIDTH_RATIO)));
	}

	private contentWidth(): number {
		if (!this.scrollEl) return 600;
		const cs = window.getComputedStyle(this.scrollEl);
		const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
		return Math.max(120, this.scrollEl.clientWidth - padX);
	}

	private rebuildPrefix(from: number): void {
		for (let i = Math.max(0, from); i < this.paragraphs.length; i++) {
			this.prefix[i + 1] = this.prefix[i] + this.heights[i];
		}
	}

	/** 返回 offset 落在的段落索引（最后一个 start <= offset 的段落）。 */
	private indexAtOffset(offset: number): number {
		const n = this.paragraphs.length;
		if (n === 0) return 0;
		let lo = 0;
		let hi = n - 1;
		let ans = 0;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if ((this.prefix[mid] ?? 0) <= offset) {
				ans = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		return ans;
	}

	private renderWindow(): void {
		if (this.destroyed || !this.scrollEl) return;
		const total = this.paragraphs.length;
		if (total === 0) return;
		const viewH = this.scrollEl.clientHeight;
		if (viewH <= 0) {
			// 容器还没拿到高度：下一帧再试一次
			requestAnimationFrame(() => this.renderWindow());
			return;
		}

		const scrollTop = this.scrollEl.scrollTop;
		const contentTop = Math.max(0, scrollTop - TOP_PAD);
		const buffer = viewH * WINDOW_BUFFER_SCALE;
		const start = this.indexAtOffset(Math.max(0, contentTop - buffer));
		const end = Math.min(total, this.indexAtOffset(contentTop + viewH + buffer) + 1);
		const anchorOffset = contentTop - (this.prefix[start] ?? 0);

		this.renderRange(start, Math.max(start + 1, end));
		this.measureRange(start, Math.max(start + 1, end));

		const anchorTop = this.prefix[start] ?? 0;
		this.windowEl.style.top = `${anchorTop + TOP_PAD}px`;
		this.spacerEl.style.height = `${Math.max(0, (this.prefix[total] ?? 0) + TOP_PAD * 2)}px`;
		// 测量修正后按锚点还原滚动位置，避免边读边跳
		const restored = Math.max(0, Math.round(anchorTop + TOP_PAD + anchorOffset));
		if (Math.abs(restored - scrollTop) > 1) this.scrollEl.scrollTop = restored;

		this.emitProgress();
	}

	private renderRange(start: number, end: number): void {
		this.windowEl.empty();
		const frag = document.createDocumentFragment();
		for (let i = start; i < end && i < this.paragraphs.length; i++) {
			const p = document.createElement("p");
			p.className = "nyareader-txt-para";
			p.dataset.index = String(i);
			p.textContent = this.paragraphs[i];
			frag.appendChild(p);
		}
		this.windowEl.appendChild(frag);
	}

	/** 用真实渲染高度替换估算值，并修正前缀和。 */
	private measureRange(start: number, end: number): void {
		const children = Array.from(this.windowEl.children) as HTMLElement[];
		let firstChanged = -1;
		for (let k = 0; k < children.length; k++) {
			const idx = start + k;
			if (idx >= this.paragraphs.length) break;
			const h = children[k].offsetHeight;
			if (!(h > 0)) continue;
			if (this.measured[idx] && Math.abs(this.heights[idx] - h) < 0.5) continue;
			this.heights[idx] = h;
			this.measured[idx] = true;
			if (firstChanged < 0 || idx < firstChanged) firstChanged = idx;
		}
		if (firstChanged >= 0) this.rebuildPrefix(firstChanged);
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
