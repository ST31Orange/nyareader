/**
 * NyaReader 阅读视图（ItemView）。
 *
 * 布局（v0.3.1）：所有阅读控件集中在 Obsidian 视图标题栏一行，正文区零占用。
 * - 标题栏：书架 / 打开 / 目录 / 翻译 / [页码 · 缩放] / 高亮 / 笔记 / 更多；
 * - 右侧翻译面板默认 320px，可拖拽左边缘调宽，宽度写入设置；
 * - 键盘：←/→/PageUp/PageDown 翻页，Home/End 首末页，Ctrl·⌘ ± 与 Ctrl+0 缩放。
 *   键盘直接监听视图容器的 keydown（不依赖 Obsidian scope 的激活时序），
 *   因此只要焦点在阅读视图内就会生效。
 *
 * 只与 ReaderController 交互；引擎能力通过 IReaderEngine.capabilities 查询。
 */
import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type NyaReaderPlugin from "../main";
import { TranslationPanel } from "./TranslationPanel";
import { ReaderController } from "./ReaderController";
import { AnnotationListModal } from "./AnnotationListModal";
import { PromptModal } from "./components/PromptModal";
import type { ZoomMode } from "../services/books/IReaderEngine";
import type { BookModel } from "../types";
import { debounce } from "../utils/debounce";
import { displayPageFromLocation } from "../utils/paging";

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
	private headerInfoEl!: HTMLElement;
	private pageIndicatorEl!: HTMLElement;
	/** 标题栏"滚动/分页"模式切换按钮（仅文档式格式显示） */
	private modeToggleEl: HTMLElement | null = null;
	/** 标题栏"单页/双页"布局切换按钮（仅 HTML 文档式格式显示） */
	private layoutToggleEl: HTMLElement | null = null;
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
	/** 标题栏信息条的宿主与插入锚点（用于宿主被重建时重新注入） */
	private headerRowEl: HTMLElement | null = null;
	private headerAnchorEl: HTMLElement | null = null;
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

	/** 当前阅读窗口是否已经在看书（主插件据此决定"再打开一本"时是否新建窗口）。 */
	hasBook(): boolean {
		return !!this.currentFile && !!this.controller?.currentBook;
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("nyareader-root");

		this.buildTitlebarActions();

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
			// 打开 NyaLingo 真正的设置面板（旧版本降级到安装向导）
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

		this.registerKeydown();
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
		this.syncPagingUi();
		this.focusReadingArea();
	}

	private focusReadingArea(): void {
		try {
			this.readingArea.focus({ preventScroll: true });
		} catch {
			/* 忽略焦点失败 */
		}
	}

	private onBookOpened(book: BookModel): void {
		this.renderToc(book);
	}

	/** 监听引擎事件：位置（更新页码/进度）、选区（划词翻译）与缩放。 */
	private attachEngineListeners(): void {
		const engine = this.controller?.currentEngine;
		if (!engine || !this.transPanel) return;
		engine.on("locationChanged", (payload) => this.updatePageIndicator(payload.location));
		engine.on("selection", (payload) => {
			if (this.transPanel?.isVisible() && payload.text?.trim()) this.transPanel.translateSelection(payload.text);
		});
		engine.on("zoomChanged", (payload) => this.syncZoomUi(payload.mode, payload.percent));
		const zoom = engine.getZoom?.();
		if (zoom) this.syncZoomUi(zoom.mode, zoom.percent);
	}

	private syncHeaderControls(): void {
		this.ensureHeaderInfo();
		const engine = this.controller?.currentEngine;
		const caps = engine?.capabilities;
		const show = Boolean(caps?.pageNav || caps?.zoom);
		this.headerInfoEl?.toggleClass("is-hidden", !show);
		if (!show) return;
		this.pageIndicatorEl?.toggleClass("is-hidden", !caps?.pageNav);
		// 滚动式格式没有"适应宽度/适应高度"（字号缩放），隐藏这两个档位
		this.zoomSelectEl.toggleClass("is-scroll-format", caps?.pageNav !== true);
		this.updatePageIndicator(engine?.currentLocation?.() ?? "1");
	}

	/**
	 * 同步分页相关 UI（打开书 / 切换滚动分页模式后调用）：
	 * - 模式切换按钮是否显示（仅文档式格式）
	 * - 页码条是否显示（分页模式下显示）
	 * - 总页数（分页模式按引擎估算，PDF 用 spine 数量）
	 */
	private syncPagingUi(): void {
		const engine = this.controller?.currentEngine;
		const caps = engine?.capabilities;
		const book = this.controller?.currentBook;
		this.modeToggleEl?.toggleClass("is-hidden", !caps?.modeSwitch);
		if (caps?.modeSwitch) this.syncModeToggleIcon();
		this.layoutToggleEl?.toggleClass("is-hidden", !caps?.layoutSwitch);
		if (caps?.layoutSwitch) this.syncLayoutToggleIcon();
		this.totalPages = 0;
		if (caps?.pageNav) {
			const total = engine?.getTotalPages?.() ?? 0;
			if (total > 0) this.totalPages = total;
			else if (book?.format === "pdf") this.totalPages = book.spine.length;
		}
		this.syncHeaderControls();
	}

	/** 模式切换按钮图标/标题：滚动模式显示"分页"入口，分页模式显示"滚动"入口。 */
	private syncModeToggleIcon(): void {
		const el = this.modeToggleEl;
		if (!el) return;
		const scrolling = this.plugin.settings.reader.scrollMode === true;
		el.empty();
		el.toggleClass("is-active", !scrolling);
		el.setAttribute("title", scrolling ? "切换为分页模式" : "切换为滚动模式");
		el.setAttribute("aria-label", scrolling ? "切换为分页模式" : "切换为滚动模式");
		trySetIcon(el, scrolling ? "book-open" : "scroll", scrolling ? "book-open" : "list");
	}

	/** 单页/双页切换按钮图标/标题：单页显示"双页"入口，双页显示"单页"入口。 */
	private syncLayoutToggleIcon(): void {
		const el = this.layoutToggleEl;
		if (!el) return;
		const double = this.plugin.settings.reader.layout === "double";
		el.empty();
		el.toggleClass("is-active", double);
		el.setAttribute("title", double ? "切换为单页" : "切换为双页（双栏）");
		el.setAttribute("aria-label", double ? "切换为单页" : "切换为双页（双栏）");
		trySetIcon(el, double ? "file-text" : "columns", double ? "file-text" : "book-open");
	}

	private updatePageIndicator(location: string): void {
		if (!this.pageIndicatorEl) return;
		const engine = this.controller?.currentEngine;
		const book = this.controller?.currentBook;
		// PDF 的 location 就是页码；HTML/TXT 分页模式的 location 是 0~10000 百分比
		const isPct = Boolean(engine?.capabilities?.pageNav) && book?.format !== "pdf";
		const page = displayPageFromLocation(location, this.totalPages, isPct);
		if (!Number.isFinite(page)) {
			this.pageIndicatorEl.setText("— / —");
			return;
		}
		this.pageIndicatorEl.setText(this.totalPages > 0 ? `${page} / ${this.totalPages} 页` : `${page} 页`);
	}

	/** 切换滚动/分页模式：写全局设置 + 当前书的覆盖，引擎同步保持位置。 */
	private async toggleReadingMode(): Promise<void> {
		const engine = this.controller?.currentEngine;
		const book = this.controller?.currentBook;
		if (!engine || !book || !engine.capabilities?.modeSwitch) return;
		const next = this.plugin.settings.reader.scrollMode !== true;
		this.plugin.settings.reader.scrollMode = next;
		// 写入当前书的覆盖，重开这本书时保持本次选择的模式
		const override = { ...(this.plugin.settings.bookOverrides[book.fingerprint] ?? {}) };
		override.scrollMode = next;
		this.plugin.settings.bookOverrides[book.fingerprint] = override;
		await this.plugin.saveSettings();
		// 引擎内部按百分比还原位置，语义一致，不丢进度
		engine.switchMode?.(next);
		this.syncPagingUi();
		this.updatePageIndicator(engine.currentLocation?.() ?? "1");
	}

	/** 切换单页/双页布局：写全局设置 + 当前书覆盖，引擎按百分比原位刷新。 */
	private async toggleLayout(): Promise<void> {
		const engine = this.controller?.currentEngine;
		const book = this.controller?.currentBook;
		if (!engine || !book || !engine.capabilities?.layoutSwitch) return;
		const next = this.plugin.settings.reader.layout === "double" ? "single" : "double";
		this.plugin.settings.reader.layout = next;
		const override = { ...(this.plugin.settings.bookOverrides[book.fingerprint] ?? {}) };
		override.layout = next;
		this.plugin.settings.bookOverrides[book.fingerprint] = override;
		await this.plugin.saveSettings();
		// 布局切换会改变内容高度：按百分比还原位置，并刷新分页 UI（总页数/页码）。
		// PDF 的 goTo 用页码而非百分比，applySettings 已按锚点保持位置，跳过百分比定位。
		const pct = engine.currentPercentage();
		engine.applySettings(this.controller?.currentReaderSettings() ?? this.plugin.settings.reader);
		if (engine.capabilities?.pageNav && this.controller?.currentBook?.format !== "pdf") {
			void engine.goTo(String(Math.round(pct * 10000)));
		}
		this.syncPagingUi();
		this.updatePageIndicator(engine.currentLocation?.() ?? "1");
	}

	private applyPanelWidth(): void {
		const w = Math.min(760, Math.max(240, this.plugin.settings.ui.translationPanelWidth || 320));
		this.transHost?.style.setProperty("--nyareader-trans-width", `${w}px`);
	}

	// ---------- 视图标题栏 ----------

	/** 标题栏按钮与信息条（公开 API addAction）。 */
	private buildTitlebarActions(): void {
		this.addAction("library", "书架", () => void this.openBookshelf());
		this.addAction("folder-open", "打开电子书…", () => void this.plugin.pickAndOpenBook());
		this.addAction("list-tree", "目录", () => this.toggleToc());
		this.translateActionEl = this.addAction("languages", "翻译（开/关）", () => this.toggleTranslate());
		this.translateActionEl.addClass("nyareader-titlebar-action");
		const highlightBtn = this.addAction("highlighter", "高亮选中文本", () => void this.addHighlight());
		const noteBtn = this.addAction("pencil", "添加笔记", () => void this.addNote());
		this.addAction("bookmark", "管理批注", () => this.openAnnotations());
		const moreBtn = this.addAction("ellipsis-horizontal", "更多操作", (evt) => this.openMoreMenu(evt));

		// 用 addAction 返回元素的父节点定位标题栏动作区，避免硬编码内部类名
		const row = moreBtn.parentElement;
		if (!row) return;
		this.headerRowEl = row;
		this.headerAnchorEl = highlightBtn;
		this.ensureHeaderInfo();
		void noteBtn;
	}

	/** 确保信息条挂在标题栏上（宿主被 Obsidian 重建时可自动补回）。 */
	private ensureHeaderInfo(): void {
		if (this.headerInfoEl?.isConnected) return;
		const row = this.headerRowEl;
		const anchor = this.headerAnchorEl;
		if (!row?.isConnected || !anchor?.isConnected) return;
		if (!this.headerInfoEl) {
			this.headerInfoEl = document.createElement("div");
			this.headerInfoEl.className = "nyareader-header-info";
			this.buildHeaderInfo(this.headerInfoEl);
		}
		row.insertBefore(this.headerInfoEl, anchor);
	}

	/** 标题栏内的"页码 · 缩放"信息条。 */
	private buildHeaderInfo(container: HTMLElement): void {
		// 滚动/分页模式切换（EPUB/MOBI/AZW3/TXT 显示，PDF 隐藏）
		this.modeToggleEl = container.createEl("button", {
			cls: "nyareader-header-btn nyareader-mode-toggle",
			attr: { title: "切换阅读模式" },
		});
		this.modeToggleEl.addClass("is-hidden");
		this.modeToggleEl.addEventListener("click", () => void this.toggleReadingMode());
		this.syncModeToggleIcon();

		// 单页/双页（双栏）布局切换（EPUB/MOBI/AZW3 显示，PDF/TXT 隐藏）
		this.layoutToggleEl = container.createEl("button", {
			cls: "nyareader-header-btn nyareader-layout-toggle",
			attr: { title: "切换单页/双页" },
		});
		this.layoutToggleEl.addClass("is-hidden");
		this.layoutToggleEl.addEventListener("click", () => void this.toggleLayout());
		this.syncLayoutToggleIcon();

		this.pageIndicatorEl = container.createSpan({ cls: "nyareader-page-indicator", text: "— / —" });

		const zoomOut = container.createEl("button", { cls: "nyareader-header-btn", attr: { title: "缩小", "aria-label": "缩小" } });
		setIcon(zoomOut, "minus");
		zoomOut.addEventListener("click", () => this.nudgeZoom(1 / ZOOM_STEP));

		this.zoomSelectEl = container.createEl("select", { cls: "nyareader-zoom-select" });
		this.zoomSelectEl.createEl("option", { value: "fit-width", text: "适应宽度" });
		this.zoomSelectEl.createEl("option", { value: "fit-height", text: "适应高度" });
		for (const p of FIXED_ZOOM_PERCENTS) this.zoomSelectEl.createEl("option", { value: String(p), text: `${p}%` });
		this.customZoomOption = this.zoomSelectEl.createEl("option", { value: "custom", text: "自定义" });
		this.customZoomOption.hide();
		this.zoomSelectEl.addEventListener("change", () => this.onZoomSelectChange());

		const zoomIn = container.createEl("button", { cls: "nyareader-header-btn", attr: { title: "放大", "aria-label": "放大" } });
		setIcon(zoomIn, "plus");
		zoomIn.addEventListener("click", () => this.nudgeZoom(ZOOM_STEP));

		this.zoomPercentEl = container.createSpan({ cls: "nyareader-zoom-percent", text: "100%" });
		container.toggleClass("is-hidden", true);
	}

	private onZoomSelectChange(): void {
		const engine = this.controller?.currentEngine;
		if (!engine?.setZoom) return;
		const v = this.zoomSelectEl.value;
		if (v === "fit-width" || v === "fit-height") {
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
		if (mode === "fit-width" || mode === "fit-height") {
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
		menu.addItem((i) => i.setTitle("高亮选中文本").setIcon("highlighter").onClick(() => void this.addHighlight()));
		menu.addItem((i) => i.setTitle("添加笔记").setIcon("pencil").onClick(() => void this.addNote()));
		menu.addItem((i) => i.setTitle("管理批注…").setIcon("bookmark").onClick(() => this.openAnnotations()));
		menu.addSeparator();
		menu.addItem((i) =>
			i.setTitle("适应宽度").setIcon("move-horizontal").onClick(() => this.controller?.currentEngine?.setZoom?.("fit-width"))
		);
		menu.addItem((i) => i.setTitle("适应高度").setIcon("maximize").onClick(() => this.controller?.currentEngine?.setZoom?.("fit-height")));
		if (this.controller?.currentEngine?.capabilities?.layoutSwitch) {
			menu.addItem((i) =>
				i
					.setTitle(this.plugin.settings.reader.layout === "double" ? "切换为单页" : "切换为双页（双栏）")
					.setIcon(this.plugin.settings.reader.layout === "double" ? "file-text" : "columns")
					.onClick(() => void this.toggleLayout())
			);
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("打开翻译设置（NyaLingo）").setIcon("settings").onClick(() => this.plugin.lingo.openSettingsOrWizard()));
		menu.showAtMouseEvent(evt);
	}

	/** 打开批注管理弹窗（列表 / 跳转 / 编辑笔记 / 删除）。 */
	private openAnnotations(): void {
		const controller = this.controller;
		if (!controller) return;
		new AnnotationListModal(this.app, {
			getAnnotations: () => controller.listAnnotations(),
			onJump: (a) => void controller.currentEngine?.goTo(a.location),
			onEditNote: (a) => controller.updateAnnotationNote(a.id, a.note),
			onDelete: (a) => controller.removeAnnotation(a.id),
		}).open();
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

	private registerKeydown(): void {
		this.registerDomEvent(this.containerEl, "keydown", (evt) => this.onKeydown(evt));
	}

	private onKeydown(evt: KeyboardEvent): void {
		if (isEditableTarget(evt.target)) return;
		const engine = this.controller?.currentEngine;
		if (!engine) return;
		const mod = evt.ctrlKey || evt.metaKey;
		if (mod) {
			if (evt.key === "=" || evt.key === "+") {
				evt.preventDefault();
				this.nudgeZoom(ZOOM_STEP);
			} else if (evt.key === "-" || evt.key === "_") {
				evt.preventDefault();
				this.nudgeZoom(1 / ZOOM_STEP);
			} else if (evt.key === "0") {
				evt.preventDefault();
				engine.setZoom?.("fit-width");
			}
			return;
		}
		// 滚动式引擎（EPUB/MOBI/AZW3/TXT）：↑/↓=逐行滚动（原生手感），
		// ←/→=翻页、PgUp/PgDn=翻页，Home/End=首/末
		if (!engine.capabilities?.pageNav) {
			switch (evt.key) {
				case "ArrowUp":
					evt.preventDefault();
					engine.scrollStep?.(-1);
					break;
				case "ArrowDown":
					evt.preventDefault();
					engine.scrollStep?.(1);
					break;
				case "ArrowLeft":
				case "PageUp":
					evt.preventDefault();
					void engine.prevPage();
					break;
				case "ArrowRight":
				case "PageDown":
					evt.preventDefault();
					void engine.nextPage();
					break;
				case "Home":
					evt.preventDefault();
					void engine.goTo("0");
					break;
				case "End":
					evt.preventDefault();
					void engine.goTo("10000");
					break;
			}
			return;
		}
		// PDF 分页引擎
		switch (evt.key) {
			case "ArrowLeft":
			case "PageUp":
				evt.preventDefault();
				void engine.prevPage();
				break;
			case "ArrowRight":
			case "PageDown":
				evt.preventDefault();
				void engine.nextPage();
				break;
			case "Home": {
				evt.preventDefault();
				// PDF: 页码 "1"；HTML/TXT 分页: 百分比 "0"
				void engine.goTo(this.controller?.currentBook?.format === "pdf" ? "1" : "0");
				break;
			}
			case "End": {
				evt.preventDefault();
				// PDF: 末页页码；HTML/TXT 分页: 100%
				void engine.goTo(
					this.controller?.currentBook?.format === "pdf" ? String(this.totalPages || 1) : "10000"
				);
				break;
			}
			default:
				break;
		}
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

	private addNote(): void {
		const controller = this.controller;
		if (!controller) return;
		new PromptModal(this.app, {
			title: "添加笔记",
			multiline: true,
			placeholder: "笔记内容",
			submitText: "添加",
			onSubmit: async (note) => {
				await controller.addAnnotation("note", note);
			},
		}).open();
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

/** 设置图标；Obsidian 图标名因版本而异，失败时回退到更通用的图标。 */
function trySetIcon(el: HTMLElement, name: string, fallback: string): void {
	try {
		setIcon(el, name);
	} catch {
		try {
			setIcon(el, fallback);
		} catch {
			/* 两个图标都不可用时忽略（按钮仍有 title 提示） */
		}
	}
}
