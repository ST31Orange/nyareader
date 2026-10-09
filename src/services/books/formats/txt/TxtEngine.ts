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
 *
 * v0.5 大文件重构（50 万段 TXT 打开时内存/GC 高峰的根因）：
 * - heights/prefix/measured 从"每段一个 JS 元素"的普通数组改成
 *   Float64Array / Float64Array / Uint8Array：不再产生 150 万个堆元素与等量 GC 压力；
 * - 前缀和增量重建（只从第一个被测量修正的段落往后累加），布局数学抽到 TxtLayout.ts 纯函数。
 */
import type {
	AnnotationTarget,
	EngineHighlight,
	EngineHighlightPlacement,
	IReaderEngine,
	ReaderEngineCapabilities,
	ReaderEngineEvents,
	SelectionAnchorDraft,
	ZoomMode,
} from "../../IReaderEngine";
import { SimpleReaderEmitter } from "../../IReaderEngine";
import type { BookModel, ReaderSettings } from "../../../../types";
import { DEFAULT_READER_SETTINGS } from "../../../../types";
import type { TxtContent } from "./TxtParser";
import { normalizeSelectionText } from "../../../../utils/text";
import { buildTextQuote, quoteFromText } from "../../../annotations/AnnotationAnchor";
import { HighlightLayer, type HighlightRegion } from "../html/HighlightLayer";
import {
	clampParagraphIndex,
	createHeights,
	createMeasured,
	createPrefix,
	fillEstimatedHeights,
	indexAtOffset,
	measureCharWidthRatio,
	rebuildPrefixFrom,
	totalHeight,
} from "./TxtLayout";

export interface TxtEngineOptions {
	book: BookModel;
	content: TxtContent;
}

/** 视口外预渲染缓冲（倍数，1 = 上下各一屏） */
const WINDOW_BUFFER_SCALE = 1;
/** 段落下间距（em），需与 CSS .nyareader-txt-para 的 padding-bottom 保持一致 */
const PARAGRAPH_SPACING_EM = 0.6;
/** 正文上下留白（px），同时计入滚动总高度 */
const TOP_PAD = 16;

export class TxtEngine implements IReaderEngine {
	readonly format = "txt";
	get capabilities(): ReaderEngineCapabilities {
		return { zoom: true, pageNav: this.isPaged(), modeSwitch: true };
	}
	private emitter = new SimpleReaderEmitter();
	private container!: HTMLElement;
	private scrollEl!: HTMLElement;
	private spacerEl!: HTMLElement;
	private windowEl!: HTMLElement;
	// 默认值统一从 DEFAULT_READER_SETTINGS 派生（TXT 默认滚动模式），避免各处字面量漂移
	private settings: ReaderSettings = { ...DEFAULT_READER_SETTINGS, scrollMode: true };
	/** 文本缩放系数（叠加在设置字号上） */
	private zoomScale = 1;

	/** 分页模式 = 设置里未开启滚动模式 */
	private isPaged(): boolean {
		return this.settings.scrollMode === false;
	}

	/** 对外：当前是否分页模式（键盘路由用：滚动模式下 ↑/↓ 是小格滚动）。 */
	isPagedMode(): boolean {
		return this.isPaged();
	}

	/**
	 * **精确的当前页号**（1 起）+ 全书页数。
	 *
	 * 视图不能从 `currentLocation()`（百分比）反推页号，否则大书上会跳页。
	 * TXT 的页数按"段落总高 / 视口高"算出（等高、无插值），所以由进度直接换算即精确。
	 */
	getCurrentPageInfo(): { page: number; total: number; exact: boolean } {
		if (!this.isPaged()) return { page: 0, total: 0, exact: true };
		const total = this.getTotalPages();
		if (total <= 0) return { page: 1, total: 0, exact: true };
		const page = Math.max(1, Math.min(total, Math.round(this.currentPercentage() * total) || 1));
		return { page, total, exact: true };
	}

	private paragraphs: string[] = [];
	private chapters: TxtContent["chapters"] = [];
	/** 每段高度（估算 -> 测量修正）；类型化数组避免 50 万段的堆分配峰值 */
	private heights: Float64Array = new Float64Array(0);
	/** prefix[i] = 前 i 段累计高度（长度 = 段数 + 1） */
	private prefix: Float64Array = new Float64Array(1);
	/** 该段是否已被真实测量修正（0/1） */
	private measured: Uint8Array = new Uint8Array(0);

	private destroyed = false;
	private resizeObserver: ResizeObserver | null = null;
	private renderRaf = 0;
	/** 当前已渲染的段落区间，避免滚动时无条件重建 DOM */
	private renderedStart = -1;
	private renderedEnd = -1;
	/** 上次发射进度的段索引（滚动不跨段时不必重复发射） */
	private lastEmittedLocation = -1;

	// ---------- 可见高亮（批注 P0） ----------
	/**
	 * 高亮渲染层：**只作用于当前虚拟窗口内的段落**。
	 * 段落被回收（滚出窗口）时其高亮随之消失，滚回来时 `renderRange()` 会重建 DOM，
	 * 我们随后 `refresh()` 一次即可把高亮重新画上 —— 这就是"移出再回来仍能重新应用"。
	 */
	private highlightLayer: HighlightLayer | null = null;
	private highlightClickHandler: ((id: string) => void) | null = null;
	/** 结构版本号：窗口重渲染/布局重建时递增，让高亮层的区域文本缓存失效 */
	private highlightStamp = 0;

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
		this.scrollEl.addEventListener(
			"wheel",
			(e: WheelEvent) => {
				if (e.ctrlKey) {
					e.preventDefault();
					this.nudgeZoom(e.deltaY > 0 ? 1 / 1.1 : 1.1);
					return;
				}
				if (this.isPaged()) {
					e.preventDefault();
					if (e.deltaY !== 0) {
						void (e.deltaY > 0 ? this.nextPage() : this.prevPage());
					}
				}
			},
			{ passive: false }
		);

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
		// 先释放高亮层：它会 unwrap 自己包裹的 span，避免把"批注留下"的 DOM 一起清掉
		this.highlightLayer?.dispose();
		this.highlightLayer = null;
		this.windowEl?.empty();
	}

	async goTo(location: string): Promise<void> {
		if (this.isPaged()) {
			// 分页模式：location 是 0~10000 百分比
			const pct = parseInt(location, 10);
			if (Number.isNaN(pct)) return;
			const max = Math.max(1, totalHeight(this.prefix, this.paragraphs.length) + TOP_PAD * 2 - this.scrollEl.clientHeight);
			this.scrollEl.scrollTop = Math.round((pct / 10000) * max);
			this.renderWindow();
			this.emitProgress();
			return;
		}
		const idx = parseInt(location, 10);
		if (Number.isNaN(idx)) return;
		const clamped = clampParagraphIndex(idx, this.paragraphs.length);
		this.scrollEl.scrollTop = Math.max(0, (this.prefix[clamped] ?? 0) + TOP_PAD);
		this.renderWindow();
		this.emitProgress();
	}

	async nextPage(): Promise<void> {
		if (this.isPaged()) {
			this.scrollEl.scrollBy({ top: this.scrollEl.clientHeight, behavior: "auto" });
			this.emitProgress();
			return;
		}
		this.scrollEl.scrollBy({ top: this.scrollEl.clientHeight * 0.9, behavior: "smooth" });
	}

	async prevPage(): Promise<void> {
		if (this.isPaged()) {
			this.scrollEl.scrollBy({ top: -this.scrollEl.clientHeight, behavior: "auto" });
			this.emitProgress();
			return;
		}
		this.scrollEl.scrollBy({ top: -this.scrollEl.clientHeight * 0.9, behavior: "smooth" });
	}

	/** 切换滚动/分页模式并保持当前位置：底层都是同一个滚动容器，按百分比还原即可。 */
	switchMode(scrollMode: boolean): void {
		const pct = this.currentPercentage();
		this.settings = { ...this.settings, scrollMode };
		this.applySettings(this.settings);
		const content = totalHeight(this.prefix, this.paragraphs.length) + TOP_PAD * 2;
		const max = Math.max(1, content - (this.scrollEl?.clientHeight ?? 0));
		if (this.scrollEl) this.scrollEl.scrollTop = Math.round(pct * max);
		this.renderWindow();
		this.emitProgress();
	}

	/**
	 * 滚动模式：↑/↓ 方向键滚动一个"鼠标滚轮档"（约 3 行），
	 * 与 HtmlDocEngine 保持一致的手感；←/→ 仍是换页（视口 0.9）。
	 */
	scrollStep(direction: 1 | -1): void {
		if (!this.scrollEl) return;
		const linePx = Math.max(1, this.effectiveFontSize() * this.settings.lineHeight);
		this.scrollEl.scrollBy({ top: direction * linePx * 3, behavior: "auto" });
	}

	currentLocation(): string {
		if (this.isPaged()) return String(Math.round(this.currentPercentage() * 10000));
		return String(this.indexAtOffset(Math.max(0, (this.scrollEl?.scrollTop ?? 0) - TOP_PAD)));
	}

	/** 按文档内相对进度跳转（0~1）；TXT 全文常驻，直接用可滚动区间换算。 */
	goToFraction(fraction: number): void {
		if (!this.scrollEl) return;
		const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
		const content = totalHeight(this.prefix, this.paragraphs.length) + TOP_PAD * 2;
		const max = Math.max(0, content - this.scrollEl.clientHeight);
		this.scrollEl.scrollTop = Math.round(f * max);
		this.renderWindow();
		this.emitProgress();
	}

	/** 分页总页数。 */
	getTotalPages(): number {
		const vh = this.scrollEl?.clientHeight;
		const content = totalHeight(this.prefix, this.paragraphs.length) + TOP_PAD * 2;
		if (!vh || !content) return 0;
		return Math.max(1, Math.ceil(content / vh));
	}

	/**
	 * 相对进度 0~1。
	 *
	 * 必须用「可滚动区间」作分母（contentHeight - clientHeight），与 goTo()/switchMode()
	 * 的换算保持**互逆**：旧实现用 contentHeight 作分母，而 scrollTop 最大只能到
	 * contentHeight - clientHeight，于是滚到最底部也只有 ~95%，进度永远到不了 100%，
	 * 也就无法从「已读完」状态正确识别末屏。
	 */
	currentPercentage(): number {
		const contentHeight = totalHeight(this.prefix, this.paragraphs.length) + TOP_PAD * 2;
		if (contentHeight <= 0) return 0;
		const viewH = this.scrollEl?.clientHeight ?? 0;
		const max = contentHeight - viewH;
		if (max <= 0) return 1;
		const offset = Math.min(max, Math.max(0, this.scrollEl?.scrollTop ?? 0));
		return offset / max;
	}

	applySettings(settings: ReaderSettings): void {
		this.settings = { ...settings };
		if (!this.scrollEl) return;
		this.scrollEl.toggleClass("nyareader-theme-dark", settings.theme === "dark");
		this.scrollEl.toggleClass("nyareader-theme-sepia", settings.theme === "sepia");
		this.scrollEl.toggleClass("is-paged", this.isPaged());
		this.scrollEl.style.fontFamily = settings.fontFamily;
		this.scrollEl.style.fontSize = `${this.effectiveFontSize()}px`;
		this.scrollEl.style.lineHeight = `${settings.lineHeight}`;
		this.scrollEl.style.setProperty("--nyareader-txt-margin", `${settings.margin}px`);
		this.rebuildLayout();
		this.scheduleRender();
	}

	getSelection(): { text: string; target?: AnnotationTarget } | null {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed) return null;
		const text = normalizeSelectionText(sel.toString());
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

	// ---------- 可见高亮 API（IReaderEngine 可选方法） ----------

	/**
	 * 全量设置高亮（打开书/重开书/增删改后调用）。
	 * 每条锚点按「段落索引 + 段内字符区间 → 文本指纹 → 进度兜底」解析；
	 * 解析结果通过 {@link getHighlightPlacements} 暴露（含降级原因），不静默失败。
	 */
	setHighlights(list: readonly EngineHighlight[]): void {
		const layer = this.ensureHighlightLayer();
		if (!layer) return;
		layer.setHighlights(list);
	}

	addHighlight(highlight: EngineHighlight): void {
		this.ensureHighlightLayer()?.addHighlight(highlight);
	}

	removeHighlight(id: string): void {
		this.ensureHighlightLayer()?.removeHighlight(id);
	}

	/** 点击高亮 → 交给 UI 打开就地小菜单（span 降级路径用 data 属性，CSS Highlight 路径用坐标命中）。 */
	setHighlightClickHandler(handler: (id: string, click?: { x: number; y: number }) => void): void {
		this.highlightClickHandler = handler;
		this.highlightLayer?.setClickHandler(handler);
	}

	/**
	 * 某条高亮当前的矩形（**父文档视口坐标**）。
	 * TXT 渲染在宿主文档里（无 iframe），坐标天然一致，无需换算。
	 */
	getHighlightRect(id: string): { left: number; top: number; width: number; height: number } | null {
		return this.highlightLayer?.rectOf(id) ?? null;
	}

	/** 最近一次定位结果（含 `exact-range`/`quote-unique`/`quote-first`/`progression-only`）。 */
	getHighlightPlacements(): readonly EngineHighlightPlacement[] {
		return this.highlightLayer?.placements() ?? [];
	}

	/**
	 * 用当前选区生成锚点草稿。
	 * TXT 的结构定位天然是「段落索引 + 段内 UTF-16 偏移」，比旧的百分比可靠得多
	 * （旧实现滚动模式存段索引、分页模式存百分比，切模式必错位）。
	 */
	getSelectionAnchor(): SelectionAnchorDraft | null {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
		const range = sel.getRangeAt(0);
		const text = normalizeSelectionText(sel.toString());
		if (!text) return null;
		const startEl = this.paragraphElOf(range.startContainer);
		const endEl = this.paragraphElOf(range.endContainer) ?? startEl;
		const startIndex = startEl ? Number(startEl.dataset.index) : -1;
		const endIndex = endEl ? Number(endEl.dataset.index) : startIndex;
		const paraIndex = Number.isFinite(startIndex) && startIndex >= 0 ? startIndex : this.currentParagraphIndex();
		const paraText = this.paragraphs[paraIndex] ?? "";
		let charStart: number | undefined;
		let charEnd: number | undefined;
		if (startEl && paraText) {
			const s = this.offsetInElement(startEl, range.startContainer, range.startOffset);
			const sameParagraph = Number.isFinite(endIndex) && endIndex === paraIndex;
			const e = sameParagraph && endEl ? this.offsetInElement(endEl, range.endContainer, range.endOffset) : paraText.length;
			if (s !== null && e !== null && e > s) {
				charStart = s;
				charEnd = Math.min(e, paraText.length);
			}
		}
		const quote =
			paraText && charStart !== undefined && charEnd !== undefined
				? buildTextQuote(paraText, charStart, charEnd)
				: quoteFromText(text);
		return {
			kind: "paragraph",
			primary: String(paraIndex),
			paraIndex,
			...(charStart !== undefined && charEnd !== undefined ? { charStart, charEnd } : {}),
			quote,
			progression: this.currentPercentage(),
			text,
			// 拿不到段落元素（例如选区落在窗口外/占位节点）时自述"结构信息缺失"
			approximate: charStart === undefined,
		};
	}

	/** 当前视口顶部所在的段落索引（选区拿不到段落元素时的兜底）。 */
	private currentParagraphIndex(): number {
		return this.indexAtOffset(Math.max(0, (this.scrollEl?.scrollTop ?? 0) - TOP_PAD));
	}

	/** 向上找到承载某节点的段落元素（`p.nyareader-txt-para[data-index]`）。 */
	private paragraphElOf(node: Node | null): HTMLElement | null {
		let el: Node | null = node;
		while (el && el !== this.windowEl) {
			const candidate = el as HTMLElement;
			if (candidate.dataset?.index !== undefined) return candidate;
			el = el.parentNode;
		}
		return null;
	}

	/** 节点在元素文本里的 UTF-16 偏移（与 Range.startOffset/String.length 同一口径）。 */
	private offsetInElement(root: HTMLElement, node: Node, nodeOffset: number): number | null {
		if (root === node) return nodeOffset;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let acc = 0;
		while (walker.nextNode()) {
			const t = walker.currentNode as Text;
			if (t === node) return acc + nodeOffset;
			acc += t.data.length;
		}
		return null;
	}

	/** 懒建高亮层（mount 之后 `windowEl` 才存在）。 */
	private ensureHighlightLayer(): HighlightLayer | null {
		if (!this.windowEl) return null;
		if (!this.highlightLayer) {
			this.highlightLayer = new HighlightLayer({
				regions: () => this.highlightRegions(),
				documentRoot: () => this.windowEl,
				structureStamp: () => this.highlightStamp,
				goToProgression: (progression) => this.goToFraction(progression),
			});
			if (this.highlightClickHandler) this.highlightLayer.setClickHandler(this.highlightClickHandler);
		}
		return this.highlightLayer;
	}

	/** 当前渲染出来的段落就是可定位区域（虚拟窗口之外没有 DOM，也就没有高亮）。 */
	private highlightRegions(): HighlightRegion[] {
		if (!this.windowEl) return [];
		const regions: HighlightRegion[] = [];
		for (const child of Array.from(this.windowEl.children)) {
			const el = child as HTMLElement;
			const raw = el.dataset?.index;
			if (raw === undefined) continue;
			const index = Number(raw);
			if (!Number.isFinite(index)) continue;
			regions.push({ key: String(index), nodes: [el], paraIndex: index });
		}
		return regions;
	}

	/** 窗口内容重建/布局重建后调用：让高亮层丢掉缓存并重新解析。 */
	refreshHighlights(): void {
		this.highlightStamp++;
		this.highlightLayer?.refresh();
	}

	/** 跳到某条高亮（面板"跳转"用）：能解析就滚到命中处，否则按进度兜底。 */
	focusHighlight(id: string): void {
		this.highlightLayer?.focus(id);
	}

	// ---------- 缩放（字号放大缩小） ----------

	setZoom(mode: ZoomMode, value?: number): void {
		if (mode === "fit-width" || mode === "fit-height") {
			this.zoomScale = 1;
		} else if (typeof value === "number" && value >= 0.4 && value <= 4) {
			this.zoomScale = value;
		}
		this.applySettings(this.settings);
		this.emitter.emit("zoomChanged", { mode: "custom", percent: Math.round(this.zoomScale * 100) });
	}

	getZoom(): { mode: ZoomMode; scale: number; percent: number } {
		return { mode: "custom", scale: this.zoomScale, percent: Math.round(this.zoomScale * 100) };
	}

	private nudgeZoom(factor: number): void {
		const next = Math.min(4, Math.max(0.4, this.getZoom().scale * factor));
		this.setZoom("custom", next);
	}

	private effectiveFontSize(): number {
		return Math.round(this.settings.fontSize * this.zoomScale * 10) / 10;
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
		const count = this.paragraphs.length;
		if (!count) {
			this.heights = createHeights(0);
			this.prefix = createPrefix(0);
			this.measured = createMeasured(0);
			return;
		}
		this.renderedStart = -1;
		this.renderedEnd = -1;
		this.lastEmittedLocation = -1;
		const charsPerLine = this.charsPerLine();
		const lineHeightPx = this.effectiveFontSize() * this.settings.lineHeight;
		const spacingPx = this.effectiveFontSize() * PARAGRAPH_SPACING_EM;
		// 复用类型化数组：只有段数变化才重新分配，避免每次重排都建 3 个长度=段数的数组
		if (this.heights.length !== count) {
			this.heights = createHeights(count);
			this.prefix = createPrefix(count);
			this.measured = createMeasured(count);
		} else {
			this.measured.fill(0);
		}
		fillEstimatedHeights(this.paragraphs, this.heights, charsPerLine, lineHeightPx, spacingPx);
		this.prefix[0] = 0;
		rebuildPrefixFrom(this.heights, this.prefix, count, 0);
	}

	/**
	 * 每行字符数的估算。
	 *
	 * 用 canvas 实测的字符宽度比例（`measureCharWidthRatio`）代替固定 0.62：
	 * 汉字约占 1em，固定 0.62 会明显低估行数 → 段落高度偏小 → 滚动到中段后
	 * 实测修正引发位置跳动。测量结果按「字体族+字号」缓存，避免每次重排都测量。
	 */
	private charsPerLine(): number {
		const width = this.contentWidth();
		const ratio = this.charWidthRatio();
		return Math.max(8, Math.floor(width / (this.effectiveFontSize() * ratio)));
	}

	/** 字符宽度比例（按字体族+字号缓存；测量失败时退回兜底常量）。 */
	private charWidthRatio(): number {
		const family = this.settings.fontFamily || "system-ui";
		const size = this.effectiveFontSize();
		const key = `${family}|${size}`;
		const cached = TxtEngine.charRatioCache.get(key);
		if (cached !== undefined) return cached;
		const ratio = measureCharWidthRatio(family, size);
		TxtEngine.charRatioCache.set(key, ratio);
		return ratio;
	}

	/** 字符宽度比例缓存（静态：同一字体/字号跨实例复用，避免重复测量） */
	private static readonly charRatioCache = new Map<string, number>();

	private contentWidth(): number {
		if (!this.scrollEl) return 600;
		const cs = window.getComputedStyle(this.scrollEl);
		const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
		return Math.max(120, this.scrollEl.clientWidth - padX);
	}

	/** 从 from 段起增量重建前缀和：测量修正后只重算变化点之后的累计值。 */
	private rebuildPrefix(from: number): void {
		rebuildPrefixFrom(this.heights, this.prefix, this.paragraphs.length, from);
	}

	/** 返回 offset 落在的段落索引（最后一个 start <= offset 的段落）。 */
	private indexAtOffset(offset: number): number {
		return indexAtOffset(this.prefix, this.paragraphs.length, offset);
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

		if (start !== this.renderedStart || end !== this.renderedEnd) {
			this.renderedStart = start;
			this.renderedEnd = end;
			this.renderRange(start, Math.max(start + 1, end));
			this.measureRange(start, Math.max(start + 1, end));
			// 段落 DOM 刚被重建：立刻把高亮重新画上（否则"滚出窗口再滚回来高亮丢了"）
			this.refreshHighlights();
		}

		const anchorTop = this.prefix[start] ?? 0;
		this.windowEl.style.top = `${anchorTop + TOP_PAD}px`;
		this.spacerEl.style.height = `${Math.max(0, totalHeight(this.prefix, total) + TOP_PAD * 2)}px`;
		// 测量修正后按锚点还原滚动位置：仅当偏差已大到锚点将要滚出视口时才纠正，
		// 否则每次滚动都微调 scrollTop 会与用户滚动“打架”，造成明显卡顿。
		const restored = Math.max(0, Math.round(anchorTop + TOP_PAD + anchorOffset));
		const drift = Math.abs(restored - scrollTop);
		if (drift > Math.max(24, viewH * 0.35)) this.scrollEl.scrollTop = restored;

		const idx = this.indexAtOffset(Math.max(0, (this.scrollEl?.scrollTop ?? 0) - TOP_PAD));
		if (idx !== this.lastEmittedLocation) {
			this.lastEmittedLocation = idx;
			this.emitProgress();
		}
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
			this.measured[idx] = 1;
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
		this.highlightClickHandler = null;
		// 主动放掉大 TXT 的段落数组与布局数组，关闭书籍后不残留在引擎对象上
		this.paragraphs = [];
		this.chapters = [];
		this.heights = createHeights(0);
		this.prefix = createPrefix(0);
		this.measured = createMeasured(0);
	}
}
