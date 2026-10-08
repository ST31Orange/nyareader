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
 * 关键实现点：
 * 1. 多栏容器宽度设为极大值以容纳大量"页"，column-fill:auto 保证每栏排满才换栏；
 * 2. 顶层元素一律 max-width = 页宽，避免 EPUB 里 width:100% 的元素被撑成整页宽度；
 * 3. 页数测量：取最后一个有内容的子元素 offsetLeft / (页宽+栏距)；
 * 4. 翻页 = 换页（translateX），不是滚屏，因此页号严格 1|2、3|4。
 */
import type { AnnotationTarget, IReaderEngine, ReaderEngineEvents, ReaderEngineCapabilities, ZoomMode } from "../../IReaderEngine";
import { SimpleReaderEmitter } from "../../IReaderEngine";
import type { BookModel, ReaderSettings } from "../../../../types";
import { normalizeSelectionText } from "../../../../utils/text";

export interface HtmlDocEngineOptions {
	book: BookModel;
	html: string;
	/** 实际格式标识（epub/mobi/azw3）；默认 "html" */
	formatLabel?: string;
}

const THEME_CSS: Record<ReaderSettings["theme"], string> = {
	light: "html { background:#f2f2f2; } body { color:#1f1f1f; }",
	dark: "html { background:#141416; } body { color:#cfcfcf; } a { color:#8ab4f8; }",
	sepia: "html { background:#e9e0cd; } body { color:#5b4636; }",
};

/** 单页时槽宽（px） */
const GUTTER = 40;
/** 双页对开时的槽宽（px）：更窄，缩小中间留白 */
const GUTTER_DOUBLE = 30;
/** 单页页左右内边距（px）：让正文不贴死页面边缘 */
const PAGE_MARGIN_X = 32;
/** 双页页左右内边距（px）：更窄，配合窄槽宽缩小中间留白 */
const PAGE_MARGIN_X_DOUBLE = 20;
/** 页面上下内边距（px） */
const PAGE_MARGIN_Y = 20;
/** 页面与阅读区边缘的留白（px），页面尽量铺满、避免四周一大圈灰 */
const OUTER_PAD = 20;
/** 书窗在可用空间基础上再收窄的安全边距（px/每侧）：杜绝居中/取整误差让右页贴边被裁 */
const SAFETY = 6;
/** 低于该可用宽度时，即使选择"双页"也自动退回单页（对应 epub.js spread:"auto"） */
const MIN_SPREAD_WIDTH = 640;
/**
 * 多栏容器的最大列数（上限）。
 *
 * 关键约束（踩坑记录）：必须远大于"容器宽 ÷ 最小页宽"能产生的实际栏数。
 * 若实际栏数触及 column-count 上限，Chromium 会把容器宽度摊到上限栏数上，
 * 实际列距变成 容器宽÷栏数（旧值 1200000/2000=600px），与 pageW+gap 不符，
 * 导致翻页位移漂移、窄窗双页显示约 1.7 页并出现三栏错位。
 * 取 2_000_000px 容器 + 20_000 上限：pageW∈[120,900] 时实际栏数恒 < 上限。
 */
const MAX_COLUMNS = 20_000;
/** 多栏容器的固定宽度：足够容纳 MAX_COLUMNS 个页 */
const COLS_WIDTH = 2_000_000;

export class HtmlDocEngine implements IReaderEngine {
	get format(): string {
		return this.opts.formatLabel ?? "html";
	}
	get capabilities(): ReaderEngineCapabilities {
		return { zoom: true, pageNav: this.isPaged(), modeSwitch: true, layoutSwitch: true };
	}
	private emitter = new SimpleReaderEmitter();
	private container!: HTMLElement;
	private iframe!: HTMLIFrameElement;
	private settings: ReaderSettings = { fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24, theme: "light", layout: "single", scrollMode: false, pageWidth: 420 };
	private doc: Document | null = null;
	private destroyed = false;
	/** 文本缩放系数（叠加在设置字号上），默认 100% */
	private zoomScale = 1;

	// ---------- 分页状态 ----------
	/** 阅读窗口（固定大小、overflow hidden，居中） */
	private paged: HTMLElement | null = null;
	/** 多栏容器（一栏一页） */
	private columnsEl: HTMLElement | null = null;
	private pages = 0;
	/** 当前第几页（双页模式下恒为奇数，表示对开的左页） */
	private currentPage = 1;
	private pageW = 480;
	private pageH = 680;
	/** 实际生效的双页对开（窗口太窄时自动退回单页） */
	private effectiveDouble = false;
	/** 监听 iframe 元素尺寸变化（父文档实测，比 iframe 内部 resize 更可靠） */
	private iframeObserver: ResizeObserver | null = null;

	private resizeBound = (): void => {
		if (this.isPaged()) this.relayoutPages(true);
	};

	constructor(private opts: HtmlDocEngineOptions) {}

	on<E extends keyof ReaderEngineEvents>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		this.emitter.on(event, handler as never);
	}
	off<E extends keyof ReaderEngineEvents>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		this.emitter.off(event, handler as never);
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
		this.iframe.srcdoc = this.opts.html;

		await new Promise<void>((resolve) => {
			this.iframe.addEventListener("load", () => resolve(), { once: true });
			// srcdoc 某些情况下 load 不触发，给个兜底
			setTimeout(resolve, 800);
		});
		this.doc = this.iframe.contentDocument;
		if (!this.doc) {
			this.emitter.emit("error", { message: "HTML 文档无法访问（CSP 限制）。" });
			return;
		}
		this.applySettings(this.settings);

		const win = this.iframe.contentWindow;
		win?.addEventListener?.("mouseup", () => {
			const sel = this.getSelection();
			if (sel) this.emitter.emit("selection", { text: sel.text });
		});
		win?.addEventListener?.("wheel", (e: WheelEvent) => {
			if (e.ctrlKey) {
				e.preventDefault();
				this.nudgeZoom(e.deltaY > 0 ? 1 / 1.1 : 1.1);
				return;
			}
			if (this.isPaged()) {
				// 分页模式：滚轮即翻页
				e.preventDefault();
				if (e.deltaY !== 0) void (e.deltaY > 0 ? this.nextPage() : this.prevPage());
			}
		}, { passive: false });
		win?.addEventListener?.("keydown", (e: KeyboardEvent) => this.onContentKeydown(e));
		win?.addEventListener?.("scroll", () => {
			if (this.isPaged()) return;
			const pct = this.currentPercentage();
			this.emitter.emit("locationChanged", { location: this.currentLocation(), percentage: pct });
		}, { passive: true });
		// 用 ResizeObserver 监听 iframe 元素尺寸（父文档实测的 clientWidth/Height），
		// 窗口缩小后能立即按新尺寸重排分页，避免沿用旧尺寸导致双页被裁/右页显示不全
		if (typeof ResizeObserver !== "undefined") {
			this.iframeObserver = new ResizeObserver(() => {
				if (this.isPaged()) this.relayoutPages(true);
			});
			this.iframeObserver.observe(this.iframe);
		}
	}

	/** 分页模式 = 设置里未开启滚动模式。 */
	private isPaged(): boolean {
		return this.settings.scrollMode === false;
	}

	/** 双页对开 = 分页模式 + layout==="double"。 */
	private isDouble(): boolean {
		return this.settings.layout === "double";
	}

	/** 页左右内边距：双页用更窄的边距缩小中间槽缝，单页保持舒适留白 */
	private pageMarginX(): number {
		return this.isDouble() ? PAGE_MARGIN_X_DOUBLE : PAGE_MARGIN_X;
	}

	/** 栏间距（槽宽）：双页用更窄的槽宽缩小中间留白 */
	private pageGutter(): number {
		return this.isDouble() ? GUTTER_DOUBLE : GUTTER;
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
				this.setZoom?.("custom", 1);
			}
			return;
		}
		switch (e.key) {
			case "ArrowUp":
			case "ArrowDown":
				e.preventDefault();
				if (this.isPaged()) {
					// 分页模式：上下=翻页
					void (e.key === "ArrowDown" ? this.nextPage() : this.prevPage());
				} else {
					// 滚动模式：上下=逐行滚动
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
		this.iframeObserver?.disconnect();
		this.iframeObserver = null;
		this.iframe?.remove();
	}

	// ---------- 跳转 ----------

	async goTo(location: string): Promise<void> {
		// 目录锚点（MOBI 内部跳转统一改写为 #nyareader-fp-NNN）
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
			const page = Math.max(1, Math.round((pct / 10000) * (this.pages || 1)));
			this.showPage(page);
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
		if (!bookRect) return this.currentPage;
		const x = elRect.left - bookRect.left - this.pageMarginX();
		const col = Math.round(x / (this.pageW + this.pageGutter()));
		return Math.max(1, Math.min(this.pages, this.currentPage - 1 + col + 1));
	}

	async nextPage(): Promise<void> {
		if (this.isPaged()) {
			this.showPage(this.currentPage + (this.effectiveDouble ? 2 : 1));
			return;
		}
		this.iframe.contentWindow?.scrollBy({ top: this.iframe.clientHeight * 0.9, behavior: "smooth" });
	}

	async prevPage(): Promise<void> {
		if (this.isPaged()) {
			this.showPage(this.currentPage - (this.effectiveDouble ? 2 : 1));
			return;
		}
		this.iframe.contentWindow?.scrollBy({ top: -this.iframe.clientHeight * 0.9, behavior: "smooth" });
	}

	/** 分页总页数（滚动模式返回 0）。 */
	getTotalPages(): number {
		return this.isPaged() ? this.pages : 0;
	}

	currentLocation(): string {
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
			this.relayoutPages(false);
		} else {
			this.unwrapPaged();
		}
	}

	/** 切换滚动/分页模式并保持当前阅读位置。 */
	switchMode(scrollMode: boolean): void {
		const pct = this.currentPercentage();
		this.settings = { ...this.settings, scrollMode };
		if (!this.doc) return;
		this.applySettings(this.settings);
		if (this.isPaged()) {
			const page = Math.max(1, Math.round(pct * (this.pages || 1)));
			this.showPage(page, false);
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
	}

	/** 注入基础样式：主题/字号/行距 + 分页版式。 */
	private applyBaseStyle(): void {
		if (!this.doc) return;
		const styleId = "nyareader-style";
		this.doc.getElementById(styleId)?.remove();
		const style = this.doc.createElement("style");
		style.id = styleId;
		const paged = this.isPaged();
		const dark = this.settings.theme === "dark";
		const m = this.settings.margin;
		style.textContent = `
			${THEME_CSS[this.settings.theme]}
			:root { --nyar-page-w: 480px; --nyar-page-h: 680px; --nyar-gutter: ${this.pageGutter()}px; }
			html { font-size: ${this.effectiveFontSize()}px; overflow: ${paged ? "hidden" : "auto"}; }
			body {
				font-family: ${this.settings.fontFamily};
				line-height: ${this.settings.lineHeight};
				margin: ${paged ? 0 : `${m}px ${m * 1.6}px`};
				padding: 0;
				overflow: ${paged ? "hidden" : "auto"};
			}
			p { margin: 0 0 0.8em 0; }
			h1, h2, h3, h4 { break-after: avoid; }
			/* KF8 内嵌资源（kindle:embed:/flow:）无法在浏览器解析，隐藏避免破图 */
			img[src^="kindle:"], image[src^="kindle:"], img[src=""] { display: none; }
			a[href^="kindle:"] { pointer-events: none; }
			* { user-select: text; }
			/* 分页版式：阅读窗口 + 多栏（一栏一页） */
			.nyareader-book {
				position: absolute;
				left: 50%; top: 50%;
				transform: translate(-50%, -50%);
				overflow: hidden;
				background: ${dark ? "#212124" : "#ffffff"};
				box-shadow: 0 2px 18px rgba(0,0,0,${dark ? 0.45 : 0.16});
				/* 页内边距：正文不贴死页面边缘 */
				padding: ${PAGE_MARGIN_Y}px ${this.pageMarginX()}px;
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
			/* 图片不超过页高：首页封面等比缩放进页面，超出显示窗口的部分不再被裁掉 */
			.nyareader-columns img, .nyareader-columns picture, .nyareader-columns svg, .nyareader-columns video {
				max-height: calc(var(--nyar-page-h) - 44px) !important;
				object-fit: contain;
			}
			/* 超长内容不把页面顶出边界：pre 强制换行、表格限宽 */
			.nyareader-columns pre {
				white-space: pre-wrap;
				word-break: break-word;
			}
			.nyareader-columns table {
				max-width: 100% !important;
			}
			.nyareader-columns p, .nyareader-columns li, .nyareader-columns blockquote,
			.nyareader-columns h1, .nyareader-columns h2, .nyareader-columns h3,
			.nyareader-columns h4, .nyareader-columns figure {
				break-inside: avoid;
			}
		`;
		this.doc.head.appendChild(style);
	}

	/**
	 * 根据当前布局（单/双页）与视口尺寸计算页宽/页高。
	 * - 页面铺满阅读区（只留 OUTER_PAD 外框），避免白色页面外出现一大圈灰；
	 * - 双页对开：可用宽度低于 MIN_SPREAD_WIDTH 时自动退回单页（epub.js spread:"auto"），
	 *   避免窗口缩小后两页把页面挤出阅读区导致崩版；
	 * - 小窗口安全：页宽/页高绝不超出可用空间，且不小于下限。
	 */
	private computePageDims(): { w: number; h: number } {
		// 用父文档实测的 iframe 元素尺寸（始终实时），避免 contentWindow.innerWidth
		// 在窗口缩放时返回陈旧值，导致书窗过大、双页右页被裁
		const vw = this.iframe?.clientWidth || 800;
		const vh = this.iframe?.clientHeight || 600;
		const availW = Math.max(180, vw - OUTER_PAD * 2 - SAFETY * 2);
		const availH = Math.max(180, vh - OUTER_PAD * 2 - SAFETY * 2);
		const wDouble = Math.round((availW - this.pageGutter() - this.pageMarginX() * 2) / 2);
		// 双页对开：可用宽足够 且 每页宽 ≥ 300px（太窄时退单页，避免两页过窄、
		// 中间大片空白、右页被裁）
		this.effectiveDouble = this.isDouble() && availW >= MIN_SPREAD_WIDTH && wDouble >= 300;
		const w = this.effectiveDouble ? wDouble : Math.round(availW - this.pageMarginX() * 2);
		const h = Math.round(availH);
		return {
			w: Math.max(120, Math.min(w, availW - this.pageMarginX() * 2)),
			h: Math.max(120, Math.min(h, availH)),
		};
	}

	/** 分页重排：更新页尺寸、测量页数、按进度还原当前页并定位。 */
	private relayoutPages(emit: boolean): void {
		if (!this.isPaged() || !this.doc || !this.paged || !this.columnsEl) return;
		const { w, h } = this.computePageDims();
		this.pageW = w;
		this.pageH = h;
		const root = this.doc.documentElement;
		root.style.setProperty("--nyar-page-w", `${w}px`);
		root.style.setProperty("--nyar-page-h", `${h}px`);
		root.style.setProperty("--nyar-gutter", `${this.pageGutter()}px`);
		const bookW = (this.effectiveDouble ? w * 2 + this.pageGutter() : w) + this.pageMarginX() * 2;
		this.paged.style.width = `${bookW}px`;
		this.paged.style.height = `${h}px`;

		const prevPct = this.pages > 0 ? (this.currentPage - 0.5) / this.pages : 0;
		this.pages = this.measurePages();
		this.currentPage = Math.max(1, Math.min(this.pages, Math.round(prevPct * this.pages) || 1));
		if (this.effectiveDouble && this.currentPage % 2 === 0) this.currentPage -= 1;
		const vis = this.currentPage - 1;
		this.columnsEl.style.transform = `translateX(${-vis * (w + this.pageGutter())}px)`;
		if (emit) this.emitProgress();
	}

	/**
	 * 测量总页数：最后一个有内容的子元素所在列号 + 1。
	 *
	 * 必须用 getBoundingClientRect() 的「右缘」而非 offsetLeft/左缘：
	 * CSS 多栏里一个跨多分栏的元素（例如 P&P 的正文被单个无类名 <div> 包住）
	 * 其外接盒 left 恒为最左分片（永远在第 1 栏），offsetLeft 在嵌套定位下也不可靠，
	 * 只有 right（最右分片）能反映真正的最后一页。
	 */
	private measurePages(): number {
		const cols = this.columnsEl;
		const book = this.paged;
		if (!cols || !book) return 1;
		const children = Array.from(cols.children) as HTMLElement[];
		let last: HTMLElement | null = null;
		for (let i = children.length - 1; i >= 0; i--) {
			const el = children[i];
			if (el.getBoundingClientRect().height > 0) {
				last = el;
				break;
			}
		}
		if (!last) return 1;
		// 测量前先把多栏容器归位，避免旧位移/旧页宽干扰列号计算
		const oldTransform = cols.style.transform;
		cols.style.transform = "";
		const bookLeft = book.getBoundingClientRect().left;
		const right = last.getBoundingClientRect().right - bookLeft - this.pageMarginX();
		cols.style.transform = oldTransform;
		const col = Math.max(0, Math.round(right / (this.pageW + this.pageGutter())));
		return Math.max(1, col + 1);
	}

	/** 定位到某页（翻页/跳转共用）。双页模式下左页恒为奇数。 */
	private showPage(page: number, emit = true): void {
		if (this.pages < 1 || !this.columnsEl) {
			this.currentPage = page;
			return;
		}
		this.currentPage = Math.max(1, Math.min(this.pages, page));
		if (this.effectiveDouble && this.currentPage % 2 === 0) this.currentPage -= 1;
		const vis = this.currentPage - 1;
		this.columnsEl.style.transform = `translateX(${-vis * (this.pageW + this.pageGutter())}px)`;
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

	private emitProgress(): void {
		this.emitter.emit("locationChanged", { location: this.currentLocation(), percentage: this.currentPercentage() });
	}

	destroy(): void {
		this.destroyed = true;
		this.unmount();
		this.emitter.clear();
	}
}