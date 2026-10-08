/**
 * NyaReader 阅读视图（ItemView）。
 *
 * 布局（v0.3.0）：把尽可能多的空间留给正文。
 * - 常用功能放进 Obsidian 视图标题栏（addAction，公开 API）：书架 / 打开 / 目录 / 翻译 / 更多；
 * - 标题栏下方一条紧凑的常驻工具栏（非悬浮）：翻页 + 缩放，仅在当前引擎声明支持时出现；
 * - 右侧翻译面板默认 320px，可拖拽左边缘调宽，宽度写入设置；
 * - 键盘：←/→/PageUp/PageDown 翻页，Home/End 首末页，Ctrl/Cmd ± 缩放（视图 scope，公开 API）。
 *
 * 只与 ReaderController 交互；引擎能力通过 IReaderEngine.capabilities 查询。
 */
import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type NyaReaderPlugin from "../main";
import { TranslationPanel } from "./TranslationPanel";
import { ReaderController } from "./ReaderController";
import type { ZoomMode } from "../services/books/IReaderEngine";
import type { BookModel } from "../types";
import { debounce } from "../utils/debounce";

export { READER_VIEW_TYPE } from "./ReaderViewTypes";

const LANGUAGE_OPTIONS = [
	{ value: "zh-Hans", label: "简体中文" },
	{ value: "zh-Hant", label: "繁體中文" },
	{ value: "en", label: "English" },
	{ value: "ja", label: "日本語" },
	{ value: "ko", label: "한국어" },
	{ value: "fr", label: "Français" },
	{ value: "de", label: "Deutsch" },
	{ value: "es", label: "Español" },
	{ value: "ru", label: "Русский" },
];

/** 缩放下拉里的固定百分比档位。 */
const FIXED_ZOOM_PERCENTS = [50, 75, 100, 125, 150, 200, 300];
const ZOOM_STEP = 1.15;

export class ReaderView extends ItemView {
	private topbarEl!: HTMLElement;
	private pageIndicatorEl!: HTMLElement;
	private zoomSelectEl!: HTMLSelectElement;
	private zoomPercentEl!: HTMLElement;
	private customZoomOption: HTMLOptionElement | null = null;
	private bodyEl!: HTMLElement;
	private readingArea!: HTMLElement;
	private tocPanel!: HTMLElement;
	private tocListEl!: HTMLElement;
	private transHost!: HTMLElement;
	private transPanel: TranslationPanel | null = null;
	private controller: ReaderController | null = null;
	private currentFile: TFile | null = null;
	/** 标题栏翻译按钮（切换激活态） */
	private translateActionEl: HTMLElement | null = null;
	/** 当前书总页数（分页格式用于页码指示） */
	private totalPages = 0;

	private saveUiDebounced = debounce(() => void this.plugin.saveSettings(), 400);

	constructor(leaf: WorkspaceLeaf, private plugin: NyaReaderPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return "nyareader-reader-view";
	}

	getDisplayText(): string {
		return this.currentFile ? `NyaReader — ${this.currentFile.basename}` : "NyaReader";
	}

	getIcon(): string {
		return "book-open";
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("nyareader-root");

		this.buildTitlebarActions();

		// 紧凑常驻工具栏（翻页 + 缩放），未打开书时隐藏
		this.topbarEl = container.createDiv({ cls: "nyareader-topbar" });
		this.buildTopbar();
		this.topbarEl.toggleClass("is-hidden", true);

		this.bodyEl = container.createDiv({ cls: "nyareader-content" });
		this.tocPanel = this.bodyEl.createDiv({ cls: "nyareader-toc-panel" });
		this.tocListEl = this.tocPanel.createDiv({ cls: "nyareader-toc-list" });
		this.readingArea = this.bodyEl.createDiv({ cls: "nyareader-reading" });
		this.readingArea.setAttribute("tabindex", "0");
		this.transHost = this.bodyEl.createDiv({ cls: "nyareader-trans-host" });
		this.applyPanelWidth();

		this.controller = new ReaderController(this.plugin, {
			onBookOpened: (book) => this.onBookOpened(book),
			onError: (message) => new Notice(`NyaReader：${message}`, 6000),
			onProgress: () => undefined,
		});

		// 右侧翻译面板（引擎配置在 NyaLingo，此处只负责目标语言与展示）
		this.transPanel = new TranslationPanel({
			onTranslate: (text, to) => this.controller?.translateSelection(text, to) ?? Promise.reject(new Error("控制器未就绪")),
			getLanguages: () => LANGUAGE_OPTIONS,
			getTarget: () => this.plugin.settings.translation.targetLanguage,
			setTarget: async (lang) => {
				this.plugin.settings.translation.targetLanguage = lang;
				await this.plugin.saveSettings();
			},
			onOpenSettings: () => this.plugin.lingo.openSettingsOrWizard(),
			getWidth: () => this.plugin.settings.ui.translationPanelWidth,
			setWidth: (px) => {
				this.plugin.settings.ui.translationPanelWidth = px;
				this.applyPanelWidth();
				this.saveUiDebounced();
			},
			onVisibilityChange: (visible) => {
				this.transHost.toggleClass("is-open", visible);
				this.translateActionEl?.toggleClass("is-active", visible);
			},
		});
		this.transPanel.mount(this.transHost);

		this.registerKeymap();
		this.showWelcome();
	}

	onClose(): Promise<void> {
		this.transPanel?.destroy();
		this.controller?.close();
		return Promise.resolve();
	}

	// ---------- 打开书籍 ----------

	/** 打开一本书：由主插件从命令/右键菜单调用。 */
	async openBook(file: TFile): Promise<void> {
		this.currentFile = file;
		this.updateTitle();
		this.readingArea.empty();
		await this.controller?.openBook(file, this.readingArea);
		this.attachEngineListeners();
		this.syncToolbar();
		// 让阅读区获得焦点，↑/↓ 等原生滚动才有响应
		try {
			this.readingArea.focus({ preventScroll: true });
		} catch {
			/* 忽略焦点失败 */
		}
	}

	private onBookOpened(book: BookModel): void {
		this.totalPages = book.format === "pdf" ? book.spine.length : 0;
		this.renderToc(book);
	}

	/** 监听引擎事件：位置（更新页码/进度）与选区（划词翻译）。 */
	private attachEngineListeners(): void {
		const engine = this.controller?.currentEngine;
		if (!engine || !this.transPanel) return;
		engine.on("locationChanged", (payload) => this.updatePageIndicator(payload.location));
		engine.on("selection", (payload) => {
			if (this.transPanel?.isVisible() && payload.text?.trim()) this.transPanel.translateSelection(payload.text);
		});
		engine.on("zoomChanged", (payload) => this.syncZoomUi(payload.mode, payload.percent));
		this.syncZoomUiFromEngine();
	}

	private syncToolbar(): void {
		const engine = this.controller?.currentEngine;
		const caps = engine?.capabilities;
		const show = Boolean(caps?.pageNav || caps?.zoom);
		this.topbarEl.toggleClass("is-hidden", !show);
		if (!show) return;
		const paged = Boolean(caps?.pageNav);
		this.pageIndicatorEl.toggleClass("is-hidden", !paged);
		this.updatePageIndicator(engine?.currentLocation?.() ?? "1");
	}

	private updatePageIndicator(location: string): void {
		if (!this.pageIndicatorEl) return;
		const cur = parseInt(location, 10);
		if (!Number.isFinite(cur)) return;
		this.pageIndicatorEl.setText(this.totalPages > 0 ? `第 ${cur} / ${this.totalPages} 页` : `第 ${cur} 页`);
	}

	private syncZoomUiFromEngine(): void {
		const zoom = this.controller?.currentEngine?.getZoom?.();
		if (zoom) this.syncZoomUi(zoom.mode, zoom.percent);
	}

	private applyPanelWidth(): void {
		const w = Math.min(760, Math.max(240, this.plugin.settings.ui.translationPanelWidth || 320));
		this.transHost?.style.setProperty("--nyareader-trans-width", `${w}px`);
	}

	// ---------- 工具栏 ----------

	/** 视图标题栏按钮（公开 API addAction）。 */
	private buildTitlebarActions(): void {
		this.addAction("library", "书架", () => void this.openBookshelf());
		this.addAction("folder-open", "打开电子书…", () => void this.plugin.pickAndOpenBook());
		this.addAction("list-tree", "目录", () => this.toggleToc());
		this.translateActionEl = this.addAction("languages", "翻译（开/关）", () => this.toggleTranslate());
		this.translateActionEl.addClass("nyareader-titlebar-action");
		this.addAction("ellipsis-horizontal", "更多操作", (evt) => this.openMoreMenu(evt));
	}

	/** 紧凑工具栏：翻页 + 缩放。 */
	private buildTopbar(): void {
		const mkIconBtn = (icon: string, title: string, onClick: () => void): HTMLElement => {
			const b = this.topbarEl.createEl("button", { cls: "nyareader-icon-btn", attr: { "aria-label": title, title } });
			setIcon(b, icon);
			b.addEventListener("click", onClick);
			return b;
		};

		mkIconBtn("chevron-left", "上一页", () => void this.controller?.currentEngine?.prevPage());
		this.pageIndicatorEl = this.topbarEl.createSpan({ cls: "nyareader-page-indicator", text: "— / —" });
		mkIconBtn("chevron-right", "下一页", () => void this.controller?.currentEngine?.nextPage());

		this.topbarEl.createDiv({ cls: "nyareader-topbar-spacer" });

		mkIconBtn("minus", "缩小", () => this.nudgeZoom(1 / ZOOM_STEP));
		this.zoomSelectEl = this.topbarEl.createEl("select", { cls: "nyareader-zoom-select" });
		this.zoomSelectEl.createEl("option", { value: "fit-width", text: "适应宽度" });
		this.zoomSelectEl.createEl("option", { value: "fit-page", text: "适应页面" });
		for (const p of FIXED_ZOOM_PERCENTS) this.zoomSelectEl.createEl("option", { value: String(p), text: `${p}%` });
		this.customZoomOption = this.zoomSelectEl.createEl("option", { value: "custom", text: "自定义" });
		this.customZoomOption.hide();
		this.zoomSelectEl.addEventListener("change", () => this.onZoomSelectChange());
		mkIconBtn("plus", "放大", () => this.nudgeZoom(ZOOM_STEP));
		this.zoomPercentEl = this.topbarEl.createSpan({ cls: "nyareader-zoom-percent", text: "100%" });
	}

	private onZoomSelectChange(): void {
		const engine = this.controller?.currentEngine;
		if (!engine?.setZoom) return;
		const v = this.zoomSelectEl.value;
		if (v === "fit-width" || v === "fit-page") {
			engine.setZoom(v);
			return;
		}
		if (v === "custom") return;
		const percent = Number(v);
		if (Number.isFinite(percent)) engine.setZoom("custom", percent / 100);
	}

	private nudgeZoom(factor: number): void {
		const engine = this.controller?.currentEngine;
		if (!engine?.setZoom || !engine.getZoom) return;
		engine.setZoom("custom", engine.getZoom().scale * factor);
	}

	private syncZoomUi(mode: ZoomMode, percent: number): void {
		if (this.zoomPercentEl) this.zoomPercentEl.setText(`${percent}%`);
		if (!this.zoomSelectEl) return;
		if (mode === "fit-width" || mode === "fit-page") {
			this.zoomSelectEl.value = mode;
			return;
		}
		const fixed = FIXED_ZOOM_PERCENTS.find((p) => Math.abs(p - percent) < 0.6);
		if (fixed != null) {
			this.zoomSelectEl.value = String(fixed);
			return;
		}
		if (this.customZoomOption) {
			this.customZoomOption.show();
			this.customZoomOption.setText(`${percent}%`);
		}
		this.zoomSelectEl.value = "custom";
	}

	/** 更多操作菜单（公开 Menu API）。 */
	private openMoreMenu(evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("高亮").setIcon("highlighter").onClick(() => void this.addHighlight()));
		menu.addItem((i) => i.setTitle("笔记").setIcon("pencil").onClick(() => void this.addNote()));
		menu.addSeparator();
		menu.addItem((i) =>
			i.setTitle("适应宽度").setIcon("move-horizontal").onClick(() => this.controller?.currentEngine?.setZoom?.("fit-width"))
		);
		menu.addItem((i) => i.setTitle("适应页面").setIcon("maximize").onClick(() => this.controller?.currentEngine?.setZoom?.("fit-page")));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("字号 +").onClick(() => void this.adjustFont(1)));
		menu.addItem((i) => i.setTitle("字号 −").onClick(() => void this.adjustFont(-1)));
		menu.showAtMouseEvent(evt);
	}

	/** 翻译按钮：开（激活变色 + 右侧面板）→ 再点关。 */
	private toggleTranslate(): void {
		const panel = this.transPanel;
		if (!panel) return;
		if (panel.isVisible()) {
			panel.hide();
			new Notice("NyaReader：翻译模式已关闭。", 2500);
		} else {
			panel.show();
			new Notice("NyaReader：翻译模式已开启，选中文本自动翻译。", 3000);
		}
	}

	// ---------- 键盘 ----------

	private registerKeymap(): void {
		// ItemView 自带 scope，仅在视图激活时生效，避免污染全局快捷键。
		if (!this.scope) return;
		this.scope.register([], "ArrowLeft", (evt) => this.onNavKey(evt, "prev"));
		this.scope.register([], "ArrowRight", (evt) => this.onNavKey(evt, "next"));
		this.scope.register([], "PageUp", (evt) => this.onNavKey(evt, "prev"));
		this.scope.register([], "PageDown", (evt) => this.onNavKey(evt, "next"));
		this.scope.register([], "Home", (evt) => this.onNavKey(evt, "first"));
		this.scope.register([], "End", (evt) => this.onNavKey(evt, "last"));
		this.scope.register(["Mod"], "=", (evt) => this.onZoomKey(evt, ZOOM_STEP));
		this.scope.register(["Mod"], "+", (evt) => this.onZoomKey(evt, ZOOM_STEP));
		this.scope.register(["Mod"], "-", (evt) => this.onZoomKey(evt, 1 / ZOOM_STEP));
		this.scope.register(["Mod"], "0", () => {
			this.controller?.currentEngine?.setZoom?.("fit-width");
			return false;
		});
	}

	private onNavKey(evt: KeyboardEvent, action: "prev" | "next" | "first" | "last"): boolean {
		if (isEditableTarget(evt.target)) return true;
		const engine = this.controller?.currentEngine;
		if (!engine?.capabilities?.pageNav) return true;
		switch (action) {
			case "prev":
				void engine.prevPage();
				break;
			case "next":
				void engine.nextPage();
				break;
			case "first":
				void engine.goTo("1");
				break;
			case "last":
				void engine.goTo(String(this.totalPages || 1));
				break;
		}
		return false;
	}

	private onZoomKey(evt: KeyboardEvent, factor: number): boolean {
		if (isEditableTarget(evt.target)) return true;
		const engine = this.controller?.currentEngine;
		if (!engine?.setZoom || !engine.getZoom) return true;
		engine.setZoom("custom", engine.getZoom().scale * factor);
		return false;
	}

	// ---------- 目录 / 批注 / 字号 ----------

	private renderToc(book: BookModel): void {
		this.tocListEl.empty();
		if (!book.toc.length) {
			this.tocListEl.createDiv({ cls: "nyareader-toc-empty", text: "（本书无目录）" });
			return;
		}
		const render = (items: BookModel["toc"], depth: number): void => {
			for (const item of items) {
				const row = this.tocListEl.createDiv({ cls: "nyareader-toc-item" });
				row.style.paddingLeft = `${8 + depth * 14}px`;
				row.setText(item.label);
				row.addEventListener("click", () => {
					this.controller?.currentEngine?.goTo(item.location);
					this.toggleToc(false);
				});
				if (item.children?.length) render(item.children, depth + 1);
			}
		};
		render(book.toc, 0);
	}

	private toggleToc(open?: boolean): void {
		const next = open ?? !this.tocPanel.hasClass("is-open");
		this.tocPanel.toggleClass("is-open", next);
	}

	private updateTitle(): void {
		// 重建叶子视图状态以刷新标题（Obsidian 会回调 getDisplayText）
		void this.leaf;
	}

	private async openBookshelf(): Promise<void> {
		await this.plugin.activateBookshelf();
	}

	private async addHighlight(): Promise<void> {
		await this.controller?.addAnnotation("highlight");
	}

	private async addNote(): Promise<void> {
		const note = await this.promptNote();
		if (note === null) return;
		await this.controller?.addAnnotation("note", note);
	}

	private promptNote(): Promise<string | null> {
		return new Promise((resolve) => {
			const input = window.prompt("笔记内容：");
			resolve(input === null ? null : input.trim() || "");
		});
	}

	/** 字号微调（仅对可重排格式生效；PDF 忽略）。 */
	private async adjustFont(delta: number): Promise<void> {
		const engine = this.controller?.currentEngine;
		if (!engine) return;
		const cur = this.plugin.settings.reader.fontSize;
		const next = Math.min(40, Math.max(10, cur + delta));
		if (next === cur) return;
		this.plugin.settings.reader.fontSize = next;
		await this.plugin.saveSettings();
		engine.applySettings(this.controller!.currentReaderSettings());
	}

	private showWelcome(): void {
		this.readingArea.empty();
		this.readingArea.createDiv({
			cls: "nyareader-placeholder",
			text: "NyaReader\n\n点击「打开」选择电子书（EPUB / PDF / MOBI / AZW3 / TXT）\n选中文本后点标题栏「翻译」开启划词翻译，或用「高亮 / 笔记」批注",
		});
	}
}

/** 焦点在输入控件时不拦截按键。 */
function isEditableTarget(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el) return false;
	const tag = el.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}
