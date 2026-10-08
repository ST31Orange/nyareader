/**
 * HTML 文档引擎：渲染单个 HTML 字符串（MOBI/AZW3 提取结果）到 iframe。
 * 支持滚动模式、主题/字号/行距/边距、选中文本、进度（按滚动比例）。
 * 与 epub.js 分离，避免重型依赖；适用于单文档格式。
 */
import type { AnnotationTarget, IReaderEngine, ReaderEngineEvents } from "../../IReaderEngine";
import { SimpleReaderEmitter } from "../../IReaderEngine";
import type { BookModel, ReaderSettings } from "../../../../types";
import { normalizeSelectionText } from "../../../../utils/text";

export interface HtmlDocEngineOptions {
	book: BookModel;
	html: string;
}

const THEME_CSS: Record<ReaderSettings["theme"], string> = {
	light: "html { background:#fff; } body { color:#1f1f1f; }",
	dark: "html { background:#1e1e1e; } body { color:#cfcfcf; } a { color:#8ab4f8; }",
	sepia: "html { background:#f4ecd8; } body { color:#5b4636; }",
};

export class HtmlDocEngine implements IReaderEngine {
	readonly format = "html";
	private emitter = new SimpleReaderEmitter();
	private container!: HTMLElement;
	private iframe!: HTMLIFrameElement;
	private settings: ReaderSettings = { fontFamily: "system-ui", fontSize: 18, lineHeight: 1.8, margin: 24, theme: "light", layout: "single", scrollMode: false, pageWidth: 420 };
	private doc: Document | null = null;
	private destroyed = false;

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
		win?.addEventListener?.("scroll", () => {
			const pct = this.currentPercentage();
			this.emitter.emit("locationChanged", { location: this.currentLocation(), percentage: pct });
		}, { passive: true });
	}

	unmount(): void {
		this.destroyed = true;
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
		this.iframe.contentWindow?.scrollBy({ top: this.iframe.clientHeight * 0.9, behavior: "smooth" });
	}

	async prevPage(): Promise<void> {
		this.iframe.contentWindow?.scrollBy({ top: -this.iframe.clientHeight * 0.9, behavior: "smooth" });
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
		if (!this.doc) return;
		const styleId = "nyareader-style";
		this.doc.getElementById(styleId)?.remove();
		const style = this.doc.createElement("style");
		style.id = styleId;
		style.textContent = `
			${THEME_CSS[settings.theme]}
			html { font-size: ${settings.fontSize}px; }
			body {
				font-family: ${settings.fontFamily};
				line-height: ${settings.lineHeight};
				margin: ${settings.margin}px ${settings.margin * 1.6}px;
				padding: 0;
				overflow-y: auto;
			}
			p { margin: 0 0 0.8em 0; }
			/* KF8 内嵌资源（kindle:embed:/flow:）无法在浏览器解析，隐藏避免破图 */
			img[src^="kindle:"], image[src^="kindle:"] { display: none; }
			a[href^="kindle:"] { pointer-events: none; }
			* { user-select: text; }
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
