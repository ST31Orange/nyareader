/**
 * HTML 文档引擎：渲染单个 HTML 字符串（EPUB/MOBI/AZW3 提取结果）到 iframe。
 *
 * 两种阅读模式：
 * - 滚动模式（scrollMode=true）：正文连续单栏滚动。
 * - 分页模式（scrollMode=false）：真正的按页排版——
 *   把正文放进 CSS 多栏容器（固定栏宽=页宽、栏高=页高、column-fill:auto），
 *   每一栏就是一页，页号按内容先后严格连续（第 1 页排满才进第 2 页）。
 *   阅读窗口只显示当前一页（单页模式）或两页对开（双页模式：1|2 → 3|4 → …），
 *   通过水平位移把对应栏移入窗口。
 *
 * v0.5 重构要点（大文件下"单双页/滚动/翻页失灵"的根因修复）：
 * 1. 页数测量从 O(子元素数) 降为 O(1)：在栏容器末尾放一个零宽标记元素，
 *    用它的 offsetLeft 反推最后一列的列号。旧实现遍历所有子元素并逐个
 *    getBoundingClientRect()，一本大书（数万块）每次测量都触发整篇同步布局，
 *    正是"打开大书后翻页/切单双页失灵"的直接原因。
 * 2. 版式计算全部走 paging-layout.ts 的纯函数，常量与算术不再散落在引擎里。
 * 3. 注入样式只更新同一个 <style> 的 textContent，内容不变则完全不写
 *    （旧实现每次 applySettings 都 remove + create，整篇文档重排）。
 * 4. ResizeObserver 触发的重排用 rAF 合并，且尺寸未变化时直接返回，
 *    避免静止状态下的抖动把页码/位移冲掉。
 * 5. mount 只在 iframe 真正 load 后测量；不再保留"800ms 兜底"后测量，
 *    杜绝在文档未就绪时算出错误的页数。
 * 6. capabilities 恒定声明本引擎支持的能力（不再随模式变化），
 *    避免切换瞬间视图层读到错误能力而隐藏/失灵按钮。
 * 7. 图片：不隐藏、不裁切；max-height 用真实页高变量推导，
 *    并支持把 data-nyar-asset 登记的 zip 资源按需解析为 blob: URL 后回填。
 */
import type { AnnotationTarget, IReaderEngine, ReaderEngineEvents, ReaderEngineCapabilities, ZoomMode } from "../../IReaderEngine";
import { SimpleReaderEmitter } from "../../IReaderEngine";
import type { BookModel, ReaderSettings } from "../../../../types";
import { normalizeSelectionText } from "../../../../utils/text";
import {
	IMAGE_HEIGHT_RESERVE,
	alignSpreadPage,
	clampPage,
	columnOffsetPx,
	computePageLayout,
	pageCountFromMarker,
	pageFromPercent,
	pageStep,
	percentFromPage,
	type PageLayout,
} from "../html/paging-layout";

export interface HtmlDocEngineOptions {
	book: BookModel;
	html: string;
	/** 实际格式标识（epub/mobi/azw3）；默认 "html" */
	formatLabel?: string;
	/**
	 * zip 内资源解析器：把 data-nyar-asset 登记的路径解析成可用的 URL（通常是 blob:）。
	 * 由 ReaderController/EpubDocument 注入；未提供时只清理占位、不报错。
	 */
	resolveAsset?: (path: string) => Promise<string | null>;
}

const THEME_CSS: Record<ReaderSettings["theme"], string> = {
	light: "html { background:#f2f2f2; } body { color:#1f1f1f; }",
	dark: "html { background:#141416; } body { color:#cfcfcf; } a { color:#8ab4f8; }",
	sepia: "html { background:#e9e0cd; } body { color:#5b4636; }",
};

/**
 * 多栏容器的最大列数（上限）与固定宽度。
 *
 * 关键约束（踩坑记录）：必须远大于"容器宽 ÷ 最小页宽"能产生的实际栏数。
 * 若实际栏数触及 column-count 上限，Chromium 会把容器宽度摊到上限栏数上，
 * 实际列距变成 容器宽÷栏数，与 pageWidth+gap 不符，导致翻页位移漂移、
 * 窄窗双页显示约 1.7 页并出现三栏错位。
 */
const MAX_COLUMNS = 20_000;
const COLS_WIDTH = 2_000_000;
/** 栏容器末尾的零宽测量标记的类名 */
const END_MARKER_ID = "nyareader-end-marker";
/** iframe 加载的兜底等待（仅用于极端情况下不永久挂起，不用于测量时机判断） */
const LOAD_FAILSAFE_MS = 15_000;

export class HtmlDocEngine implements IReaderEngine {
	get format(): string {
		return this.opts.formatLabel ?? "html";
	}
	/**
	 * 能力恒定：分页/滚动/单双页切换是本引擎的内建能力，与当前模式无关。
	 * （旧实现让 pageNav 跟随 isPaged()，切换瞬间视图层会读到 false 而隐藏按钮。）
	 */
	get capabilities(): ReaderEngineCapabilities {
		return { zoom: true, pageNav: true, modeSwitch: true, layoutSwitch: true };
	}
	private emitter = new SimpleReaderEmitter();
	private container!: HTMLElement;
	private iframe!: HTMLIFrameElement;
	private settings: ReaderSettings = {
		fontFamily: "system-ui",
		fontSize: 18,
		lineHeight: 1.8,
		margin: 24,
		theme: "light",
		layout: "single",
		scrollMode: false,
		pageWidth: 420,
	};
	private doc: Document | null = null;
	private destroyed = false;
	/** iframe 是否已完成 load（未完成前不测量、不重排） */
	private docReady = false;
	/** 文本缩放系数（叠加在设置字号上），默认 100% */
	private zoomScale = 1;

	// ---------- 分页状态 ----------
	/** 阅读窗口（可见页容器，overflow hidden，居中） */
	private paged: HTMLElement | null = null;
	/** 多栏容器（一栏一页） */
	private columnsEl: HTMLElement | null = null;
	/** 栏容器末尾的零宽测量标记（O(1) 测页数） */
	private endMarker: HTMLElement | null = null;
	/** 已注入样式元素（缓存，避免反复重建） */
	private styleEl: HTMLStyleElement | null = null;
	/** 上一次写入的样式文本，用于跳过无变化写入 */
	private lastStyleText = "";
	/** 当前版式（由 paging-layout 纯函数算出） */
	private layout: PageLayout = computePageLayout({ viewWidth: 800, viewHeight: 600, double: false });
	private pages = 0;
	/** 当前第几页（双页模式下恒为奇数，表示对开的左页） */
	private currentPage = 1;
	/** 监听 iframe 元素尺寸变化（父文档实测，比 iframe 内部 resize 更可靠） */
	private iframeObserver: ResizeObserver | null = null;
	/** 重排 rAF 句柄（合并连续 resize 抖动） */
	private relayoutRaf = 0;
	/** 强制下一次重排（内容追加/图片就绪后页数会变） */
	private pendingForceRelayout = false;
	/** 已解析/正在解析的资源，避免重复请求 */
	private assetTasks = new Map<string, Promise<string | null>>();

	private resizeBound = (): void => {
		this.scheduleRelayout();
	};

	constructor(private opts: HtmlDocEngineOptions) {}

	on<E extends keyof ReaderEngineEvents>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		this.emitter.on(event, handler as never);
	}
	off<E extends keyof ReaderEngineEvents>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		this.emitter.off(event, handler as never);
	}

	/** 注入（或替换）zip 资源解析器；注入后立即回填当前文档中待解析的图片。 */
	setAssetResolver(resolve: (path: string) => Promise<string | null>): void {
		this.opts.resolveAsset = resolve;
		void this.resolvePendingAssets();
	}

	async mount(container: HTMLElement): Promise<void> {
		this.container = container;
		this.iframe = container.createEl("iframe", {
			cls: "nyareader-html-iframe",
			attr: { sandbox: "allow-same-origin", title: "NyaReader" },
		});
		this.iframe.style.width = "100%";
		this.iframe.style.height = "100%";
		this.iframe.style.border = "none";
		this.iframe.style.display = "block";

		await new Promise<void>((resolve) => {
			let settled = false;
			const done = (): void => {
				if (settled) return;
				settled = true;
				resolve();
			};
			// 只认 load：srcdoc 解析完成后 contentDocument 才是完整的。
			// 兜底计时器只是为了让极端情况下不永久挂起，它不改变测量时机（见 docReady 守卫）。
			this.iframe.addEventListener("load", done, { once: true });
			window.setTimeout(done, LOAD_FAILSAFE_MS);
			this.iframe.srcdoc = this.opts.html;
		});
		if (this.destroyed) return;

		this.doc = this.iframe.contentDocument;
		if (!this.doc) {
			this.emitter.emit("error", { message: "HTML 文档无法访问（CSP 限制）。" });
			return;
		}
		this.docReady = true;

		this.applyBaseStyle();
		if (this.isPaged()) {
			this.wrapPaged();
			// 等两帧：让 iframe 完成首次布局，避免在尺寸为 0 时测量
			await this.nextFrame();
			await this.nextFrame();
			if (this.destroyed) return;
			this.relayoutPages(true, true);
		} else {
			this.unwrapPaged();
		}
		this.attachContentListeners();
		void this.resolvePendingAssets();
	}

	private nextFrame(): Promise<void> {
		return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
	}

	/** iframe 内容窗口上的交互监听（滚轮、按键、选区、滚动进度）。 */
	private attachContentListeners(): void {
		const win = this.iframe.contentWindow;
		if (!win) return;
		win.addEventListener?.("mouseup", () => {
			const sel = this.getSelection();
			if (sel) this.emitter.emit("selection", { text: sel.text });
		});
		win.addEventListener?.(
			"wheel",
			(e: WheelEvent) => {
				if (e.ctrlKey || e.metaKey) {
					e.preventDefault();
					this.nudgeZoom(e.deltaY > 0 ? 1 / 1.1 : 1.1);
					return;
				}
				if (this.isPaged()) {
					// 分页模式：滚轮即翻页
					e.preventDefault();
					if (e.deltaY !== 0) void (e.deltaY > 0 ? this.nextPage() : this.prevPage());
				}
			},
			{ passive: false }
		);
		win.addEventListener?.("keydown", (e: KeyboardEvent) => this.onContentKeydown(e));
		win.addEventListener?.(
			"scroll",
			() => {
				if (this.isPaged()) return;
				this.emitter.emit("locationChanged", { location: this.currentLocation(), percentage: this.currentPercentage() });
			},
			{ passive: true }
		);
		if (typeof ResizeObserver !== "undefined") {
			this.iframeObserver = new ResizeObserver(() => this.scheduleRelayout());
			this.iframeObserver.observe(this.iframe);
		} else {
			win.addEventListener?.("resize", this.resizeBound);
		}
	}

	/** 分页模式 = 设置里未开启滚动模式。 */
	private isPaged(): boolean {
		return this.settings.scrollMode === false;
	}

	/** 双页对开 = 分页模式 + layout==="double"（是否真正生效见 layout.double）。 */
	private isDouble(): boolean {
		return this.settings.layout === "double";
	}

	// ---------- 键盘（iframe 内容窗口内） ----------

	private onContentKeydown(e: KeyboardEvent): void {
		const mod = e.ctrlKey || e.metaKey;
		if (mod) {
			if (e.key === "=" || e.key === "+") {
				e.preventDefault();
				this.nudgeZoom(1.15);
			} else if (e.key === "-" || e.key === "_") {
				e.preventDefault();
				this.nudgeZoom(1 / 1.15);
			} else if (e.key === "0") {
				e.preventDefault();
				this.setZoom("custom", 1);
			}
			return;
		}
		switch (e.key) {
			case "ArrowUp":
			case "ArrowDown":
				e.preventDefault();
				if (this.isPaged()) {
					void (e.key === "ArrowDown" ? this.nextPage() : this.prevPage());
				} else {
					this.scrollStep(e.key === "ArrowDown" ? 1 : -1);
				}
				break;
			case "ArrowLeft":
			case "PageUp":
				e.preventDefault();
				void this.prevPage();
				break;
			case "ArrowRight":
			case "PageDown":
				e.preventDefault();
				void this.nextPage();
				break;
			case "Home":
				e.preventDefault();
				if (this.isPaged()) this.showPage(1);
				else this.iframe.contentWindow?.scrollTo(0, 0);
				this.emitProgress();
				break;
			case "End":
				e.preventDefault();
				if (this.isPaged()) this.showPage(this.pages || 1);
				else {
					const win = this.iframe.contentWindow;
					if (win) win.scrollTo(0, win.document.documentElement.scrollHeight);
				}
				this.emitProgress();
				break;
		}
	}

	// ---------- 缩放（字号放大缩小，重排分页） ----------

	setZoom(mode: ZoomMode, value?: number): void {
		if (mode === "fit-width" || mode === "fit-height") {
			this.zoomScale = 1;
		} else if (typeof value === "number" && value >= 0.4 && value <= 4) {
			this.zoomScale = value;
		}
		if (!this.doc) return;
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

	unmount(): void {
		this.destroyed = true;
		if (this.relayoutRaf) cancelAnimationFrame(this.relayoutRaf);
		this.relayoutRaf = 0;
		this.iframeObserver?.disconnect();
		this.iframeObserver = null;
		this.iframe?.remove();
		this.doc = null;
		this.docReady = false;
	}

	// ---------- 内容追加（大文件分章懒加载） ----------

	/**
	 * 追加一段新的正文 HTML（EPUB 后台补章用）。
	 *
	 * 分页模式下会把内容搬进多栏容器并"尽力保持当前阅读位置"：
	 * 由于新内容总是追加在末尾，已排好的前置页不会移动，因此只需强制重排一次。
	 * @param html 追加的 HTML 片段（应自带章节锚点）
	 */
	notifyContentAppended(html: string): void {
		if (this.destroyed || !this.doc?.body) return;
		const host = this.columnsEl ?? this.doc.body;
		const endAnchor = this.endMarker;
		host.insertAdjacentHTML("beforeend", html);
		if (this.isPaged()) {
			// 标记元素必须始终在最后，才能测到真正的末列
			if (endAnchor && endAnchor.parentElement === host) host.appendChild(endAnchor);
			this.relayoutPages(true, true);
		}
		void this.resolvePendingAssets();
	}

	// ---------- 跳转 ----------

	async goTo(location: string): Promise<void> {
		// 目录锚点（EPUB/MOBI 内部跳转统一改写为 #nyareader-epub-NNN）
		if (location.startsWith("#")) {
			const doc = this.iframe?.contentDocument;
			const target = doc?.getElementById(location.slice(1));
			if (target && "getBoundingClientRect" in target) {
				if (this.isPaged()) this.showPage(this.pageOfElement(target as HTMLElement));
				else (target as HTMLElement).scrollIntoView({ block: "start" });
			}
			this.emitProgress();
			return;
		}
		const pct = parseInt(location, 10);
		if (Number.isNaN(pct)) return;
		if (this.isPaged()) {
			this.showPage(pageFromPercent(pct, this.pages));
			return;
		}
		const win = this.iframe.contentWindow;
		if (!win) return;
		const d = win.document;
		const max = Math.max(1, d.documentElement.scrollHeight - win.innerHeight);
		win.scrollTo(0, (pct / 10000) * max);
		this.emitProgress();
	}

	/** 锚点元素在第几页（分页模式）：按元素相对阅读窗口的横坐标反推列号。 */
	private pageOfElement(el: HTMLElement): number {
		const bookRect = this.paged?.getBoundingClientRect();
		const elRect = el.getBoundingClientRect();
		if (!bookRect || this.layout.columnStride <= 0) return this.currentPage;
		const x = elRect.left - bookRect.left - this.layout.pageMarginX;
		const col = Math.round(x / this.layout.columnStride);
		return clampPage(this.currentPage - 1 + col + 1, this.pages);
	}

	async nextPage(): Promise<void> {
		if (this.isPaged()) {
			this.showPage(this.currentPage + pageStep(this.layout.double));
			return;
		}
		this.iframe.contentWindow?.scrollBy({ top: this.iframe.clientHeight * 0.9, behavior: "smooth" });
	}

	async prevPage(): Promise<void> {
		if (this.isPaged()) {
			this.showPage(this.currentPage - pageStep(this.layout.double));
			return;
		}
		this.iframe.contentWindow?.scrollBy({ top: -this.iframe.clientHeight * 0.9, behavior: "smooth" });
	}

	/** 分页总页数（滚动模式返回 0）。 */
	getTotalPages(): number {
		return this.isPaged() ? this.pages : 0;
	}

	currentLocation(): string {
		if (this.isPaged()) return String(percentFromPage(this.currentPage, this.pages));
		return String(Math.round(this.currentPercentage() * 10000));
	}

	currentPercentage(): number {
		if (this.isPaged()) {
			if (this.pages <= 1) return 0;
			return Math.min(1, Math.max(0, (this.currentPage - 0.5) / this.pages));
		}
		const win = this.iframe.contentWindow;
		if (!win) return 0;
		const doc = win.document;
		const max = Math.max(1, doc.documentElement.scrollHeight - win.innerHeight);
		return Math.min(1, Math.max(0, win.scrollY / max));
	}

	// ---------- 版式应用 / 分页结构 ----------

	applySettings(settings: ReaderSettings): void {
		this.settings = { ...settings };
		if (!this.doc) return;
		this.applyBaseStyle();
		if (this.isPaged()) {
			this.wrapPaged();
			this.relayoutPages(false, true);
		} else {
			this.unwrapPaged();
		}
		void this.resolvePendingAssets();
	}

	/** 切换滚动/分页模式并保持当前阅读位置。 */
	switchMode(scrollMode: boolean): void {
		const pct = this.currentPercentage();
		this.settings = { ...this.settings, scrollMode };
		if (!this.doc) return;
		this.applySettings(this.settings);
		if (this.isPaged()) {
			this.showPage(pageFromPercent(Math.round(pct * 10000), this.pages || 1), false);
		} else {
			const win = this.iframe.contentWindow;
			if (win) {
				const d = win.document;
				const max = Math.max(1, d.documentElement.scrollHeight - win.innerHeight);
				win.scrollTo(0, pct * max);
			}
		}
		this.emitProgress();
	}

	/** 把 body 内容搬进"阅读窗口 > 多栏容器"，进入分页模式。 */
	private wrapPaged(): void {
		if (this.paged && this.paged.isConnected) return;
		const doc = this.doc;
		const body = doc?.body;
		if (!doc || !body) return;
		this.paged = doc.createElement("div");
		this.paged.className = "nyareader-book";
		this.columnsEl = doc.createElement("div");
		this.columnsEl.className = "nyareader-columns";
		while (body.firstChild) this.columnsEl.appendChild(body.firstChild);
		this.endMarker = doc.createElement("span");
		this.endMarker.id = END_MARKER_ID;
		this.endMarker.className = "nyareader-end-marker";
		this.columnsEl.appendChild(this.endMarker);
		this.paged.appendChild(this.columnsEl);
		body.appendChild(this.paged);
	}

	/** 把内容搬回 body 正常流，退出分页模式。 */
	private unwrapPaged(): void {
		const body = this.doc?.body;
		if (!body || !this.paged) return;
		if (this.columnsEl) {
			while (this.columnsEl.firstChild) body.appendChild(this.columnsEl.firstChild);
		}
		this.paged.remove();
		this.paged = null;
		this.columnsEl = null;
		this.endMarker = null;
	}

	/**
	 * 注入基础样式：主题/字号/行距 + 分页版式。
	 *
	 * 只维护同一个 <style> 元素：文本内容未变化时完全不写 DOM，
	 * 避免旧实现"每次 remove + create"引发的整篇文档重排。
	 */
	private applyBaseStyle(): void {
		const doc = this.doc;
		if (!doc) return;
		const css = this.buildBaseCss();
		if (css === this.lastStyleText && this.styleEl?.isConnected) return;
		if (!this.styleEl?.isConnected) {
			this.styleEl = doc.createElement("style");
			this.styleEl.id = "nyareader-style";
			doc.head.appendChild(this.styleEl);
		}
		this.styleEl.textContent = css;
		this.lastStyleText = css;
	}

	/** 生成渲染文档的基础样式表（纯字符串，便于对比与审查）。 */
	private buildBaseCss(): string {
		const paged = this.isPaged();
		const dark = this.settings.theme === "dark";
		const m = this.settings.margin;
		const lh = this.settings.lineHeight;
		// 版式变量：滚动模式用设置里的 margin；分页模式由 relayoutPages 写入实测页宽/页高
		return `
			${THEME_CSS[this.settings.theme]}
			:root {
				--nyar-page-w: ${this.layout.pageWidth}px;
				--nyar-page-h: ${this.layout.pageHeight}px;
				--nyar-gutter: ${this.layout.gutter}px;
				--nyar-page-margin-x: ${this.layout.pageMarginX}px;
				--nyar-measure: ${this.settings.pageWidth}px;
				--nyar-img-max-h: calc(var(--nyar-page-h) - var(--nyar-page-margin-y) * 2 - ${IMAGE_HEIGHT_RESERVE}px);
				--nyar-page-margin-y: 14px;
			}
			html { font-size: ${this.effectiveFontSize()}px; overflow: ${paged ? "hidden" : "auto"}; }
			body {
				font-family: ${this.settings.fontFamily};
				line-height: ${lh};
				color: inherit;
				margin: ${paged ? 0 : `${m}px auto`};
				padding: 0;
				max-width: ${this.settings.pageWidth}px;
				overflow: ${paged ? "hidden" : "auto"};
				/* 长单词/URL 不撑破行宽（排版溢出的直接原因之一） */
				overflow-wrap: break-word;
				word-break: break-word;
			}
			p { margin: 0 0 0.8em 0; }
			h1, h2, h3, h4 { break-after: avoid; }
			/* KF8 内嵌资源（kindle:embed:/flow:）无法在浏览器解析，隐藏避免破图 */
			img[src^="kindle:"], image[src^="kindle:"] { display: none; }
			a[href^="kindle:"] { pointer-events: none; }
			* { user-select: text; }
			/* 图片：等比缩放，既不溢出页宽也不超出页高；不再有"超限即隐藏"的策略 */
			img, svg, video, picture > img {
				max-width: 100% !important;
				height: auto !important;
				object-fit: contain;
			}
			/* 缺失资源：给可见占位而不是清空 src 造成空洞 */
			img.nyareader-img-missing {
				display: inline-block;
				min-width: 96px;
				min-height: 72px;
				background: ${dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)"};
				border: 1px dashed ${dark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.18)"};
			}
			/* 分页版式：阅读窗口 + 多栏（一栏一页） */
			.nyareader-book {
				position: absolute;
				left: 50%; top: 50%;
				transform: translate(-50%, -50%);
				overflow: hidden;
				background: ${dark ? "#212124" : "#ffffff"};
				box-shadow: 0 1px 10px rgba(0,0,0,${dark ? 0.4 : 0.12});
				padding: var(--nyar-page-margin-y) var(--nyar-page-margin-x);
				box-sizing: border-box;
			}
			.nyareader-columns {
				position: relative;
				width: ${COLS_WIDTH}px;
				height: 100%;
				column-width: var(--nyar-page-w);
				column-count: ${MAX_COLUMNS};
				column-gap: var(--nyar-gutter);
				column-fill: auto;
				overflow-wrap: break-word;
				word-break: break-word;
			}
			/* 顶层元素不能超出页宽：避免 width:100% 被多栏容器(极宽)撑爆 */
			.nyareader-columns > * {
				max-width: var(--nyar-page-w) !important;
				box-sizing: border-box;
			}
			/* 零宽测量标记：必须完全不参与排版，只保留 offsetLeft 语义 */
			.nyareader-end-marker {
				display: block;
				width: 0;
				height: 0;
				max-width: 0 !important;
				margin: 0 !important;
				padding: 0 !important;
				border: 0;
				overflow: hidden;
			}
			/* 分页页内图片：用真实页高变量限高，避免固定 44px 余量算错导致裁切 */
			.nyareader-columns img {
				max-height: var(--nyar-img-max-h) !important;
				width: auto;
			}
			/* 超长内容不把页面顶出边界：pre 强制换行、表格限宽 */
			.nyareader-columns pre {
				white-space: pre-wrap;
				word-break: break-word;
			}
			.nyareader-columns table {
				max-width: 100% !important;
			}
			/* 避免页中断造成的"半行/孤行"难看断点 */
			.nyareader-columns p, .nyareader-columns li, .nyareader-columns blockquote,
			.nyareader-columns h1, .nyareader-columns h2, .nyareader-columns h3,
			.nyareader-columns h4, .nyareader-columns figure {
				break-inside: avoid;
			}
			.nyareader-columns img, .nyareader-columns figure, .nyareader-columns table {
				break-inside: avoid;
			}
		`;
	}

	// ---------- 分页重排 ----------

	/** 合并连续 resize 抖动；尺寸未变化时 relayoutPages 内部会直接返回。 */
	private scheduleRelayout(): void {
		if (!this.isPaged() || this.destroyed || !this.docReady) return;
		if (this.relayoutRaf) return;
		this.relayoutRaf = window.requestAnimationFrame(() => {
			this.relayoutRaf = 0;
			this.relayoutPages(true, this.pendingForceRelayout);
			this.pendingForceRelayout = false;
		});
	}

	/**
	 * 分页重排：更新页尺寸、测量页数、按进度还原当前页并定位。
	 *
	 * @param emit 是否广播进度变化
	 * @param force 尺寸未变化时也强制重新测量（内容追加/图片加载后需要）
	 */
	private relayoutPages(emit: boolean, force = false): void {
		if (!this.isPaged() || !this.doc || !this.docReady || !this.paged || !this.columnsEl) return;
		const vw = this.iframe?.clientWidth ?? 0;
		const vh = this.iframe?.clientHeight ?? 0;
		// 尺寸未就绪：不测量（旧实现在这里算出 pages=1，之后所有翻页都坏掉）
		if (vw < 40 || vh < 40) return;

		const next = computePageLayout({ viewWidth: vw, viewHeight: vh, double: this.isDouble() });
		const sameLayout =
			next.pageWidth === this.layout.pageWidth &&
			next.pageHeight === this.layout.pageHeight &&
			next.gutter === this.layout.gutter &&
			next.pageMarginX === this.layout.pageMarginX &&
			next.double === this.layout.double;
		if (sameLayout && !force && this.pages > 0) return;

		this.layout = next;
		const root = this.doc.documentElement;
		root.style.setProperty("--nyar-page-w", `${next.pageWidth}px`);
		root.style.setProperty("--nyar-page-h", `${next.pageHeight}px`);
		root.style.setProperty("--nyar-gutter", `${next.gutter}px`);
		root.style.setProperty("--nyar-page-margin-x", `${next.pageMarginX}px`);
		this.paged.style.width = `${next.bookWidth + next.pageMarginX * 2}px`;
		this.paged.style.height = `${next.bookHeight}px`;

		const prevPct = this.pages > 0 ? (this.currentPage - 0.5) / this.pages : 0;
		this.pages = this.measurePages();
		this.currentPage = this.pages > 0 ? clampPage(Math.round(prevPct * this.pages) || 1, this.pages) : 1;
		this.currentPage = alignSpreadPage(this.currentPage, next.double);
		this.positionColumns();
		if (emit) this.emitProgress();
	}

	/**
	 * 测量总页数：O(1)。
	 *
	 * 末尾零宽标记落在最后一列，它的 offsetLeft 除以"页宽+槽宽"即最后一列的序号。
	 * 注意：offsetLeft 是相对 offsetParent（.nyareader-columns，position:relative）的，
	 * 不受父级 transform 影响，所以不需要像旧实现那样"把 transform 置空再还原"。
	 * offsetParent 缺失时用 getBoundingClientRect 兜底（等价算术）。
	 */
	private measurePages(): number {
		const cols = this.columnsEl;
		const marker = this.endMarker;
		if (!cols || !marker) return 1;
		let markerLeft: number;
		if (marker.offsetParent === cols) {
			markerLeft = marker.offsetLeft;
		} else {
			markerLeft = marker.getBoundingClientRect().left - cols.getBoundingClientRect().left;
		}
		// 标记位于内容末尾之后：若内容正好排满整列，标记会落到下一列，
		// 此时它自身所在列就是内容占用后的"下一页"。因此用 round 而非 floor，
		// 并把"标记恰好落在列首"的情况也算作该列（见 paging-layout 单测）。
		return pageCountFromMarker(markerLeft, this.layout);
	}

	/** 按当前页把对应列移入阅读窗口。 */
	private positionColumns(): void {
		if (!this.columnsEl) return;
		this.columnsEl.style.transform = `translateX(${columnOffsetPx(this.currentPage, this.layout)}px)`;
	}

	/** 定位到某页（翻页/跳转共用）。双页模式下左页恒为奇数。 */
	private showPage(page: number, emit = true): void {
		if (this.pages < 1 || !this.columnsEl) {
			this.currentPage = Math.max(1, page);
			return;
		}
		this.currentPage = alignSpreadPage(clampPage(page, this.pages), this.layout.double);
		this.positionColumns();
		if (emit) this.emitProgress();
	}

	/** 滚动模式：↑/↓ 方向键按行滚动（保持原生文档手感，不整页翻）。 */
	scrollStep(direction: 1 | -1): void {
		const win = this.iframe.contentWindow;
		if (!win) return;
		const linePx = Math.max(1, this.effectiveFontSize() * this.settings.lineHeight);
		win.scrollBy({ top: direction * linePx, behavior: "auto" });
	}

	getSelection(): { text: string; target?: AnnotationTarget } | null {
		const win = this.iframe.contentWindow;
		if (!win) return null;
		const sel = win.getSelection();
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

	// ---------- 资源（zip 图片）按需解析 ----------

	/**
	 * 把文档里 data-nyar-asset 登记的图片解析为 blob: URL 并回填 src。
	 * 解析完成后强制重排一次（图片有了真实尺寸，页数可能变化）。
	 */
	private async resolvePendingAssets(): Promise<void> {
		const doc = this.doc;
		const resolve = this.opts.resolveAsset;
		if (!doc || !resolve) return;
		const pending = Array.from(doc.querySelectorAll<HTMLImageElement>("img[data-nyar-asset]"));
		if (!pending.length) return;
		let applied = false;
		for (const img of pending) {
			const path = img.dataset.nyarAsset;
			if (!path) continue;
			img.removeAttribute("data-nyar-asset");
			const url = await this.resolveAssetOnce(path);
			if (this.destroyed) return;
			if (url) {
				img.src = url;
				img.classList.remove("nyareader-img-missing");
				applied = true;
			} else {
				img.classList.add("nyareader-img-missing");
			}
		}
		if (applied) this.pendingForceRelayout = true;
		if (this.isPaged()) this.scheduleRelayout();
	}

	private resolveAssetOnce(path: string): Promise<string | null> {
		const cached = this.assetTasks.get(path);
		if (cached) return cached;
		const task = (async () => {
			try {
				return (await this.opts.resolveAsset?.(path)) ?? null;
			} catch {
				return null;
			}
		})();
		this.assetTasks.set(path, task);
		return task;
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
