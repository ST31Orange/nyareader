/**
 * HTML 文档引擎：渲染单个 HTML 字符串（MOBI/AZW3 提取结果）到 iframe。
 * 支持滚动模式、主题/字号/行距/边距、选中文本、进度（按滚动比例）。
 * 与 epub.js 分离，避免重型依赖；适用于单文档格式。
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
	light: "html { background:#fff; } body { color:#1f1f1f; }",
	dark: "html { background:#1e1e1e; } body { color:#cfcfcf; } a { color:#8ab4f8; }",
	sepia: "html { background:#f4ecd8; } body { color:#5b4636; }",
};

export class HtmlDocEngine implements IReaderEngine {
	get format(): string {
		return this.opts.formatLabel ?? "html";
	}
	get capabilities(): ReaderEngineCapabilities {
		return { zoom: true, pageNav: this.isPaged(), modeSwitch: true };
	}
	private emitter = new SimpleReaderEmitter();
	private container!: HTMLElement;
	private iframe!: HTMLIFrameElement;
	private settings: ReaderSettings = { fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24, theme: "light", layout: "single", scrollMode: false, pageWidth: 420 };
	private doc: Document | null = null;
	private destroyed = false;
	/** 文本缩放系数（叠加在设置字号上），默认 100% */
	private zoomScale = 1;
	/** 分页模式：按视口一页一页翻（scrollMode=false 时启用） */
	private snapTimer: number | null = null;

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
		// iframe 内的键盘/滚轮事件不会冒泡到父文档，必须在内容窗口内处理
		win?.addEventListener?.("wheel", (e: WheelEvent) => {
			if (e.ctrlKey) {
				e.preventDefault();
				this.nudgeZoom(e.deltaY > 0 ? 1 / 1.1 : 1.1);
				return;
			}
			if (this.isPaged()) {
				// 分页模式：滚轮即翻页
				e.preventDefault();
				if (e.deltaY !== 0) {
					void (e.deltaY > 0 ? this.nextPage() : this.prevPage());
				}
			}
		}, { passive: false });
		win?.addEventListener?.("keydown", (e: KeyboardEvent) => this.onContentKeydown(e));
		win?.addEventListener?.("scroll", () => {
			const pct = this.currentPercentage();
			this.emitter.emit("locationChanged", { location: this.currentLocation(), percentage: pct });
			if (this.isPaged()) this.scheduleSnap();
		}, { passive: true });
	}

	/** 分页模式 = 设置里未开启滚动模式。 */
	private isPaged(): boolean {
		return this.settings.scrollMode === false;
	}

	/** iframe 内容窗口内的键盘：翻页/滚动与 Ctrl 缩放。 */
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
		const win = this.iframe.contentWindow;
		if (!win) return;
		switch (e.key) {
			case "ArrowUp":
				e.preventDefault();
				if (this.isPaged()) void this.prevPage();
				else this.scrollStep(-1);
				break;
			case "ArrowDown":
				e.preventDefault();
				if (this.isPaged()) void this.nextPage();
				else this.scrollStep(1);
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
				win.scrollTo(0, 0);
				this.emitProgress();
				break;
			case "End":
				e.preventDefault();
				win.scrollTo(0, win.document.documentElement.scrollHeight);
				this.emitProgress();
				break;
		}
	}

	setZoom(mode: ZoomMode, value?: number): void {
		if (mode === "fit-width" || mode === "fit-height") {
			this.zoomScale = 1;
		} else if (typeof value === "number" && value >= 0.4 && value <= 4) {
			this.zoomScale = value;
		}
		if (!this.doc) return;
		this.reapplyStyle();
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
		if (this.snapTimer !== null) window.clearTimeout(this.snapTimer);
		this.snapTimer = null;
		this.iframe?.remove();
	}

	async goTo(location: string): Promise<void> {
		// 目录锚点（MOBI 内部跳转统一改写为 #nyareader-fp-NNN）
		if (location.startsWith("#")) {
			const doc = this.iframe?.contentDocument;
			const target = doc?.getElementById(location.slice(1));
			if (target && "scrollIntoView" in target) {
				(target as HTMLElement).scrollIntoView({ block: "start" });
			}
			this.emitProgress();
			return;
		}
		// 定位为滚动比例（0~10000 的整数）
		const pct = parseInt(location, 10);
		if (Number.isNaN(pct)) return;
		const win = this.iframe.contentWindow;
		if (!win) return;
		const doc = win.document;
		const max = Math.max(1, doc.documentElement.scrollHeight - win.innerHeight);
		win.scrollTo(0, (pct / 10000) * max);
		this.emitProgress();
	}

	async nextPage(): Promise<void> {
		if (this.isPaged()) {
			const win = this.iframe.contentWindow;
			if (win) {
				win.scrollBy({ top: win.innerHeight, behavior: "auto" });
				this.snapToPage();
				this.emitProgress();
			}
			return;
		}
		this.iframe.contentWindow?.scrollBy({ top: this.iframe.clientHeight * 0.9, behavior: "smooth" });
	}

	async prevPage(): Promise<void> {
		if (this.isPaged()) {
			const win = this.iframe.contentWindow;
			if (win) {
				win.scrollBy({ top: -win.innerHeight, behavior: "auto" });
				this.snapToPage();
				this.emitProgress();
			}
			return;
		}
		this.iframe.contentWindow?.scrollBy({ top: -this.iframe.clientHeight * 0.9, behavior: "smooth" });
	}

	/** 切换滚动/分页模式并保持当前阅读位置（按百分比还原，两种模式语义一致）。 */
	switchMode(scrollMode: boolean): void {
		const pct = this.currentPercentage();
		this.settings = { ...this.settings, scrollMode };
		this.reapplyStyle();
		const win = this.iframe.contentWindow;
		if (win) {
			const doc = win.document;
			const max = Math.max(1, doc.documentElement.scrollHeight - win.innerHeight);
			win.scrollTo(0, pct * max);
		}
		this.emitProgress();
	}

	/** 滚动模式：↑/↓ 方向键按行滚动（保持原生文档手感，不整页翻）。 */
	scrollStep(direction: 1 | -1): void {
		const win = this.iframe.contentWindow;
		if (!win) return;
		const linePx = Math.max(1, this.effectiveFontSize() * this.settings.lineHeight);
		win.scrollBy({ top: direction * linePx, behavior: "auto" });
	}

	/** 分页总页数（按内容高度/视口高度估算）。 */
	getTotalPages(): number {
		const win = this.iframe?.contentWindow;
		const doc = win?.document?.documentElement;
		if (!win || !doc) return 0;
		const h = doc.scrollHeight;
		const vh = win.innerHeight;
		if (!h || !vh) return 0;
		return Math.max(1, Math.ceil(h / vh));
	}

	/** 滚动结束后吸附到最近的页边界（分页模式）。 */
	private scheduleSnap(): void {
		if (this.snapTimer !== null) window.clearTimeout(this.snapTimer);
		this.snapTimer = window.setTimeout(() => {
			this.snapTimer = null;
			this.snapToPage();
		}, 90);
	}

	private snapToPage(): void {
		const win = this.iframe?.contentWindow;
		if (!win) return;
		const vh = win.innerHeight || 600;
		const page = Math.round(win.scrollY / vh);
		const next = page * vh;
		if (Math.abs(win.scrollY - next) > 1) win.scrollTo(0, next);
	}

	currentLocation(): string {
		return String(Math.round(this.currentPercentage() * 10000));
	}

	currentPercentage(): number {
		const win = this.iframe.contentWindow;
		if (!win) return 0;
		const doc = win.document;
		const max = Math.max(1, doc.documentElement.scrollHeight - win.innerHeight);
		return Math.min(1, Math.max(0, win.scrollY / max));
	}

	applySettings(settings: ReaderSettings): void {
		this.settings = { ...settings };
		this.reapplyStyle();
	}

	/** 重建注入样式（主题/字号/行距/边距/缩放统一入口）。 */
	private reapplyStyle(): void {
		if (!this.doc) return;
		const styleId = "nyareader-style";
		this.doc.getElementById(styleId)?.remove();
		const style = this.doc.createElement("style");
		style.id = styleId;
		style.textContent = `
			${THEME_CSS[this.settings.theme]}
			html { font-size: ${this.effectiveFontSize()}px; }
			body {
				font-family: ${this.settings.fontFamily};
				line-height: ${this.settings.lineHeight};
				margin: ${this.settings.margin}px ${this.settings.margin * 1.6}px;
				padding: 0;
				overflow-y: auto;
			}
			p { margin: 0 0 0.8em 0; }
			/* KF8 内嵌资源（kindle:embed:/flow:）无法在浏览器解析，隐藏避免破图 */
			img[src^="kindle:"], image[src^="kindle:"], img[src=""] { display: none; }
			a[href^="kindle:"] { pointer-events: none; }
			* { user-select: text; }
			${this.isPaged() ? "html, body { scrollbar-width: none; } body::-webkit-scrollbar { display: none; }" : ""}
		`;
		this.doc.head.appendChild(style);
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
