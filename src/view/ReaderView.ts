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
import type { ReaderControllerEvents } from "./ReaderController";
import { AnnotationListModal } from "./AnnotationListModal";
import { PromptModal } from "./components/PromptModal";
import type { ZoomMode } from "../services/books/IReaderEngine";
import type { BookModel, RelayoutState } from "../types";
import { debounce } from "../utils/debounce";
import { displayPageFromLocation } from "../utils/paging";
import { formatPageIndicator, formatSeekPercent, ratioFromClientX, stepSeekPercent } from "../utils/transport";
import { HIGHLIGHT_COLORS, HIGHLIGHT_COLOR_LABEL, type HighlightColor } from "../services/annotations/AnnotationModel";
import type { Annotation } from "../services/annotations/AnnotationModel";
import { annotationExportFileName, annotationsToMarkdown } from "../utils/annotation-markdown";

export { READER_VIEW_TYPE } from "./ReaderViewTypes";

/** 引擎上报的打开阶段 -> 用户可读文案（未知阶段原样显示，不抛异常）。 */
const STAGE_LABELS: Record<string, string> = {
	read: "正在读取文件",
	reading: "正在读取文件",
	load: "正在读取文件",
	parse: "正在解析内容",
	parsing: "正在解析内容",
	decompress: "正在解压内容",
	render: "正在排版渲染",
	rendering: "正在排版渲染",
	mount: "正在准备阅读界面",
	mounting: "正在准备阅读界面",
	index: "正在建立索引",
	toc: "正在生成目录",
	done: "即将完成",
};

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
	// ---------- 底部进度条（transport） ----------
	/** 底部条容器 */
	private transportEl: HTMLElement | null = null;
	/** 可拖动进度条轨道 */
	private seekTrackEl: HTMLElement | null = null;
	/** 进度条已填充部分 */
	private seekFillEl: HTMLElement | null = null;
	/** 进度条滑块 */
	private seekThumbEl: HTMLElement | null = null;
	/** 进度百分比文字（脚注内） */
	private transportPercentEl: HTMLElement | null = null;
	/** "正在重新排版…"提示（大文件改字号时） */
	private relayoutHintEl: HTMLElement | null = null;
	/** 重排提示的淡出定时器 */
	private relayoutHintTimer: number | null = null;
	/** 拖动中：期间忽略引擎的 locationChanged，避免与手指位置打架 */
	private seeking = false;
	/** seek 目标（0~1，整本书进度） */
	private seekPercent = 0;
	/**
	 * 整本内容是否已全部排入文档。
	 * 懒加载大书期间引擎只知道"已加载部分"的页数，此时不能把它当总页数显示
	 * （否则用户会看到 6k 页的书显示成 2k 页，以为内容被截断）。
	 */
	private contentFullyLoaded = true;
	/** 当前页码（1 起；未知时为 NaN），供进度条 aria 文本使用 */
	private currentPageNumber = Number.NaN;
	// ---------- 划词浮层 ----------
	/** 划词浮层元素 */
	private selectionPopupEl: HTMLElement | null = null;
	/** 当前选中文本（浮层操作用） */
	private selectionText = "";
	/** 最后使用的高亮颜色（下次"高亮"按钮沿用） */
	private lastHighlightColor: HighlightColor = "yellow";
	/**
	 * 打开流程进行中（大文件读取/解析/排版）：此期间忽略模式/布局切换、翻页快捷键与
	 * 批注类操作，并在 UI 上禁用相关控件，避免"点了没反应"被当成按钮失灵。
	 */
	private busy = false;
	/** 引擎已挂载且可用（打开成功后置位）；引擎/capabilities 缺失时全部读取安全降级。 */
	private ready = false;
	/** 加载遮罩（复用 .nyareader-engine-loading），打开完成或出错后必定移除。 */
	private loadingEl: HTMLElement | null = null;
	private loadingTextEl: HTMLElement | null = null;
	/** 打开期间需要视觉禁用的控件（表单控件会被真正 disabled） */
	private busyControls: HTMLElement[] = [];
	/** 打开期间用户又选了一本书：等当前流程收尾后补开，避免并发挂载引擎 */
	private pendingFile: TFile | null = null;

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
		// 底部进度条（页码 + 可拖动 seek）：放在内容区之外，不占用正文宽度
		this.buildTransport(container);
		this.applyPanelWidth();

		// 用变量（非内联字面量）传入，兼容 onStage 尚未落地到 ReaderControllerEvents 的情况
		const events: ReaderControllerEvents = {
			onBookOpened: (book) => this.onBookOpened(book),
			onError: (message) => this.onOpenError(message),
			onProgress: () => undefined,
			// 打开阶段（reading/parsing/index/rendering/done）→ 加载遮罩文案与百分比
			onStage: (stage, detail) => this.onStage(stage, detail),
			onRelayoutState: (state) => this.onRelayoutState(state),
			// 点击正文里的高亮 → 打开批注面板并定位到该条
			onAnnotationClick: () => this.openAnnotations(),
		};
		this.controller = new ReaderController(this.plugin, events);
		// 打开阶段回调是控制器事件的可选字段：老版本/未落地时静默降级（不抛异常）

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

	/**
	 * 打开一本书：由主插件从命令/右键菜单调用。
	 * 打开期间进入 busy 态：显示加载遮罩（阶段+百分比）、禁用相关控件、忽略切换/翻页操作；
	 * 打开完成或出错后必定移除遮罩并解除 busy（失败时给出 Notice）。
	 */
	async openBook(file: TFile): Promise<void> {
		// 已有打开流程在跑：排队等它收尾，避免并发挂载引擎导致状态错乱
		if (this.busy) {
			this.pendingFile = file;
			return;
		}
		this.setBusy(true);
		this.ready = false;
		// 新书默认"未全部排完"：懒加载格式会由 onStage 逐步纠正为 true
		this.contentFullyLoaded = true;
		this.currentFile = file;
		this.updateTitle();
		this.readingArea.empty();
		this.showLoading("正在打开…");
		try {
			await this.controller?.openBook(file, this.readingArea);
		} catch (e) {
			// 控制器内部已捕获解析/挂载异常，这里兜底保证 UI 不会卡在加载态
			console.error("NyaReader: 打开书籍失败", e);
			new Notice(`NyaReader：${e instanceof Error ? e.message : String(e)}`, 6000);
		} finally {
			this.hideLoading();
			this.setBusy(false);
			this.ready = Boolean(this.controller?.currentEngine);
			this.attachEngineListeners();
			this.syncPagingUi();
			this.focusReadingArea();
			const next = this.pendingFile;
			this.pendingFile = null;
			if (next && next !== file) void this.openBook(next);
		}
	}

	/** 打开失败（解析/渲染异常）：移除加载遮罩并提示。 */
	private onOpenError(message: string): void {
		this.hideLoading();
		new Notice(`NyaReader：${message}`, 6000);
	}

	// ---------- 加载态 / 忙态 ----------

	/** 读取门槛：打开进行中或引擎未就绪时，阅读交互一律忽略。 */
	private isReaderInteractive(): boolean {
		return this.ready && !this.busy && Boolean(this.controller?.currentEngine);
	}

	/** 显示（或更新）加载遮罩文案。readingArea 被清空后会自动重建。 */
	private showLoading(text: string): void {
		if (!this.loadingEl?.isConnected) {
			this.loadingEl = this.readingArea.createDiv({ cls: "nyareader-engine-loading" });
			this.loadingTextEl = this.loadingEl.createDiv({ cls: "nyareader-engine-loading-text" });
		}
		this.loadingTextEl?.setText(text);
	}

	/** 移除加载遮罩（打开完成/出错/视图关闭都要调用）。 */
	private hideLoading(): void {
		this.loadingEl?.remove();
		this.loadingEl = null;
		this.loadingTextEl = null;
	}

	/**
	 * 控制器上报的打开阶段：文案含阶段与百分比（total 为 0 时只显示阶段）。
	 *
	 * 另外承担一个重要职责：**大文件懒加载期间不把"已加载页数"当总页数显示**。
	 * 用户在 6k 页的书里看到 "2k 页" 会以为内容被截断了；这里只在章节全部加载完
	 * （loaded >= total）后才把引擎页数当作权威总页数。
	 */
	private onStage(stage: string, detail?: { loaded: number; total: number }): void {
		const key = typeof stage === "string" ? stage.trim() : "";
		const total = Number(detail?.total ?? 0);
		const loaded = Number(detail?.loaded ?? 0);
		if (Number.isFinite(total) && total > 0 && Number.isFinite(loaded)) {
			// 懒加载进度：据此判断"整本是否已排完"
			const fullyLoaded = loaded >= total;
			if (fullyLoaded !== this.contentFullyLoaded) {
				this.contentFullyLoaded = fullyLoaded;
				this.syncPagingUi();
			}
		}
		if (!this.busy) return; // 打开已结束，迟到的阶段消息只用于上面的状态同步
		const label = STAGE_LABELS[key.toLowerCase()] ?? (key || "正在打开");
		if (Number.isFinite(total) && total > 0 && Number.isFinite(loaded)) {
			const percent = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
			this.showLoading(`${label}… ${percent}%`);
			return;
		}
		this.showLoading(`${label}…`);
	}

	/** busy 态切换：禁用相关控件 + 阅读区加载光标。 */
	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.readingArea?.toggleClass("is-loading", busy);
		for (const el of this.busyControls) {
			if (!el?.isConnected) continue;
			el.toggleClass("nyareader-control-disabled", busy);
			el.setAttribute("aria-disabled", busy ? "true" : "false");
			if (el instanceof HTMLButtonElement || el instanceof HTMLSelectElement) el.disabled = busy;
		}
	}

	private focusReadingArea(): void {
		try {
			this.readingArea.focus({ preventScroll: true });
		} catch {
			/* 忽略焦点失败 */
		}
	}

	// ---------- 划词浮层（高亮 / 笔记 / 复制 / 翻译） ----------

	/**
	 * 在选区上方显示操作浮层。
	 *
	 * 定位：从**焦点所在文档**（可能是 iframe 内部）取选区矩形，再换算到本视图坐标系。
	 * 这样 EPUB/MOBI（iframe）与 TXT（宿主 DOM）用同一套逻辑。
	 */
	private showSelectionPopup(text: string): void {
		if (!this.isReaderInteractive()) return;
		const el = this.selectionPopupEl ?? this.buildSelectionPopup();
		if (!el) return;
		this.selectionText = text;
		el.removeClass("is-hidden");
		this.positionSelectionPopup();
	}

	private hideSelectionPopup(): void {
		this.selectionPopupEl?.addClass("is-hidden");
		this.selectionText = "";
	}

	/** 构造浮层 DOM（只构造一次，之后复用）。 */
	private buildSelectionPopup(): HTMLElement | null {
		const host = this.readingArea;
		if (!host) return null;
		const popup = host.createDiv({ cls: "nyareader-sel-popup is-hidden" });
		popup.setAttribute("role", "toolbar");
		popup.setAttribute("aria-label", "选中文本操作");

		// 六色高亮：点色块直接以该颜色高亮
		const swatches = popup.createDiv({ cls: "nyareader-sel-colors" });
		for (const color of HIGHLIGHT_COLORS) {
			const sw = swatches.createEl("button", {
				cls: `nyareader-sel-color is-${color}`,
				attr: { title: `高亮（${HIGHLIGHT_COLOR_LABEL[color]}）`, "aria-label": `用${HIGHLIGHT_COLOR_LABEL[color]}色高亮`, type: "button" },
			});
			sw.addEventListener("mousedown", (e) => e.preventDefault()); // 保住选区
			sw.addEventListener("click", () => void this.addHighlightWithColor(color));
		}

		const main = popup.createDiv({ cls: "nyareader-sel-actions" });
		const mk = (label: string, title: string, fn: () => void): HTMLButtonElement => {
			const b = main.createEl("button", { cls: "nyareader-sel-btn", text: label, attr: { title, type: "button" } });
			b.addEventListener("mousedown", (e) => e.preventDefault());
			b.addEventListener("click", fn);
			return b;
		};
		mk("高亮", "用当前颜色高亮", () => void this.addHighlightWithColor(this.lastHighlightColor));
		mk("笔记", "添加笔记", () => this.noteSelection());
		mk("复制", "复制选中文本", () => void this.copySelection());
		mk("翻译", "翻译选中文本（打开翻译面板）", () => this.translateSelectionFromPopup());

		// 点击浮层之外/滚动/按键都收起
		this.registerDomEvent(document, "mousedown", (evt) => {
			const t = evt.target as Node | null;
			if (t && !popup.contains(t)) this.hideSelectionPopup();
		});
		this.registerDomEvent(document, "keydown", (evt) => {
			if (evt.key === "Escape") this.hideSelectionPopup();
		});
		this.registerDomEvent(this.readingArea, "scroll", () => this.hideSelectionPopup());

		this.selectionPopupEl = popup;
		return popup;
	}

	/** 把浮层放到选区正上方（越界时翻到下方），并做左右夹取。 */
	private positionSelectionPopup(): void {
		const popup = this.selectionPopupEl;
		if (!popup) return;
		const rect = this.currentSelectionRect();
		if (!rect) return;
		const host = this.readingArea.getBoundingClientRect();
		const pw = popup.offsetWidth;
		const ph = popup.offsetHeight;
		// 相对宿主阅读区的坐标
		let left = rect.left - host.left + rect.width / 2 - pw / 2;
		let top = rect.top - host.top - ph - 8;
		if (top < 0) top = rect.bottom - host.top + 8; // 上方放不下 → 放下方
		left = Math.max(4, Math.min(left, Math.max(4, host.width - pw - 4)));
		top = Math.max(2, Math.min(top, Math.max(2, host.height - ph - 2)));
		popup.style.left = `${Math.round(left)}px`;
		popup.style.top = `${Math.round(top)}px`;
	}

	/**
	 * 当前选区在**本视图坐标系**下的矩形。
	 * 选区可能落在 iframe 内（EPUB/MOBI），此时加上 iframe 自身的偏移。
	 */
	private currentSelectionRect(): DOMRect | null {
		const iframe = this.readingArea.querySelector("iframe");
		const doc = iframe?.contentDocument ?? document;
		const win = doc.defaultView ?? window;
		const sel = win.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
		const r = sel.getRangeAt(0).getBoundingClientRect();
		if (!r || (r.width === 0 && r.height === 0)) return null;
		if (!iframe) return r;
		const fr = iframe.getBoundingClientRect();
		// iframe 内坐标 → 宿主坐标
		return new DOMRect(fr.left + r.left, fr.top + r.top, r.width, r.height);
	}

	/** 以指定颜色高亮当前选区（颜色选择即写入最后使用的颜色）。 */
	private async addHighlightWithColor(color: HighlightColor): Promise<void> {
		this.lastHighlightColor = color;
		this.hideSelectionPopup();
		await this.addHighlight(color);
	}

	/** 给当前选区加笔记（高亮 + 笔记一起存）。 */
	private noteSelection(): void {
		const controller = this.controller;
		if (!controller) return;
		this.hideSelectionPopup();
		new PromptModal(this.app, {
			title: "添加笔记",
			multiline: true,
			placeholder: "笔记内容",
			submitText: "保存",
			onSubmit: async (note) => {
				await this.addAnnotationWithNote(note);
			},
		}).open();
	}

	private async copySelection(): Promise<void> {
		const text = this.selectionText;
		this.hideSelectionPopup();
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			new Notice("NyaReader：已复制选中文本。", 2000);
		} catch {
			new Notice("NyaReader：复制失败（剪贴板不可用）。", 3000);
		}
	}

	private translateSelectionFromPopup(): void {
		const text = this.selectionText;
		this.hideSelectionPopup();
		if (!text) return;
		void this.controller?.translateSelection(text, this.plugin.settings.translation.targetLanguage).catch(() => {
			new Notice("NyaReader：翻译失败，请检查 NyaLingo 是否可用。", 4000);
		});
	}

	/** 新增批注（颜色/笔记由调用方决定）。 */
	private async addHighlight(color: HighlightColor, note?: string): Promise<void> {
		const controller = this.controller;
		if (!controller) return;
		try {
			// 兼容：color 由 Controller 透传到锚点/侧车（stream-i 落地后签名变为 addAnnotation(kind, note, color)）
			const fn = controller.addAnnotation as (kind: "highlight" | "note", note?: string, color?: HighlightColor) => Promise<unknown>;
			await fn.call(controller, note ? "note" : "highlight", note, color);
		} catch (e) {
			new Notice(`NyaReader：添加批注失败（${e instanceof Error ? e.message : String(e)}）`, 5000);
		}
	}

	private async addAnnotationWithNote(note: string): Promise<void> {
		await this.addHighlight(this.lastHighlightColor, note);
	}

	private onBookOpened(book: BookModel): void {
		this.renderToc(book);
	}

	/** 监听引擎事件：位置（更新页码/进度）、选区（划词翻译）与缩放。 */
	private attachEngineListeners(): void {
		try {
			const engine = this.controller?.currentEngine;
			if (!engine || !this.transPanel) return;
			engine.on("locationChanged", (payload) => {
				this.updatePageIndicator(payload.location);
				// 底部进度条跟随引擎位置；拖动中不覆盖用户手势
				this.syncSeekBar();
			});
			engine.on("selection", (payload) => {
				if (!payload.text?.trim()) {
					this.hideSelectionPopup();
					return;
				}
				// 划词翻译（翻译面板打开时）
				if (this.transPanel?.isVisible()) this.transPanel.translateSelection(payload.text);
				// 划词浮层（高亮/笔记/复制/翻译）
				this.showSelectionPopup(payload.text);
			});
			engine.on("zoomChanged", (payload) => this.syncZoomUi(payload.mode, payload.percent));
			const zoom = engine.getZoom?.();
			if (zoom) this.syncZoomUi(zoom.mode, zoom.percent);
		} catch (e) {
			// 引擎半初始化（capabilities/事件缺失）时不阻断阅读视图：降级为无事件监听
			console.warn("NyaReader: 引擎事件挂载失败，已降级", e);
		}
	}

	private syncHeaderControls(): void {
		this.ensureHeaderInfo();
		const engine = this.controller?.currentEngine;
		const caps = engine?.capabilities;
		const show = Boolean(caps?.pageNav || caps?.zoom);
		this.headerInfoEl?.toggleClass("is-hidden", !show);
		if (!show) return;
		// 滚动式格式没有"适应宽度/适应高度"（字号缩放），隐藏这两个档位
		this.zoomSelectEl.toggleClass("is-scroll-format", caps?.pageNav !== true);
		this.updatePageIndicator(engine?.currentLocation?.() ?? "1");
	}

	/**
	 * 同步分页相关 UI（打开书 / 切换滚动分页模式后调用）：
	 * - 模式切换按钮是否显示（仅文档式格式）
	 * - 底部进度条是否显示、页码是否可用
	 * - 总页数（分页模式按引擎估算，PDF 用 spine 数量）
	 */
	private syncPagingUi(): void {
		const engine = this.controller?.currentEngine;
		const caps = engine?.capabilities;
		const book = this.controller?.currentBook;
		this.modeToggleEl?.toggleClass("is-hidden", !caps?.modeSwitch);
		if (caps?.modeSwitch) this.syncModeToggleIcon();
		this.layoutToggleEl?.toggleClass("is-hidden", !caps?.layoutSwitch);
		if (caps?.layoutSwitch) {
			this.syncLayoutToggleIcon();
			this.syncLayoutToggleAvailability();
		}
		this.totalPages = 0;
		if (caps?.pageNav) {
			const total = engine?.getTotalPages?.() ?? 0;
			if (total > 0) this.totalPages = total;
			else if (book?.format === "pdf") this.totalPages = book.spine.length;
		}
		// 页码可用性：分页格式显示 "x / y 页"，滚动式只显示当前页/百分比
		this.pageIndicatorEl?.toggleClass("is-hidden", !caps?.pageNav);
		this.syncHeaderControls();
		this.syncSeekBar();
		this.syncTransportVisibility();
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
		this.currentPageNumber = Number.isFinite(page) ? page : Number.NaN;
		// 大文件懒加载期间：总页数还只是"已加载部分的页数"，显示为 "N / — 页"；
		// 按章独立分页时总页数是插值估计（实测偏差约 +6%），加 ≈ 标明。
		const estimated = engine?.isPageCountEstimated?.() === true;
		this.pageIndicatorEl.setText(formatPageIndicator(page, this.totalPages, this.contentFullyLoaded, estimated));
	}

	/**
	 * 切换滚动/分页模式：写全局设置 + 当前书的覆盖，引擎同步保持位置。
	 * @param target 指定目标模式（true=滚动）；省略则取反
	 */
	private async toggleReadingMode(target?: boolean): Promise<void> {
		if (!this.isReaderInteractive()) return; // 打开中/引擎未就绪：忽略，避免无效操作
		const engine = this.controller?.currentEngine;
		const book = this.controller?.currentBook;
		if (!engine || !book || !engine.capabilities?.modeSwitch) return;
		const next = target ?? this.plugin.settings.reader.scrollMode !== true;
		if (next === (this.plugin.settings.reader.scrollMode === true)) return; // 已是目标模式
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

	/** 切到"滚动模式"（true）或"分页模式"（false）的语义化入口。 */
	private toggleReadingModeTo(scrollMode: boolean): Promise<void> {
		return this.toggleReadingMode(scrollMode);
	}

	/** 切换单页/双页布局：写全局设置 + 当前书覆盖，引擎按百分比原位刷新。 */
	private async toggleLayout(): Promise<void> {
		if (!this.isReaderInteractive()) return; // 打开中/引擎未就绪：忽略
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

	/**
	 * 「单页/双页」按钮只在**分页模式**下有效：滚动模式下没有"页"的概念，点了不会有任何变化。
	 *
	 * 旧实现让这个按钮在滚动模式下仍可点、却什么都不做（也不报错），用户会以为按钮失灵、
	 * 或以为它和"滚动/分页"是同一个开关 —— 这正是"两个按钮耦合"的观感来源。
	 * 现在：滚动模式下置灰 + 文案说明；点它时自动切到分页模式并生效（一次点击完成预期操作）。
	 */
	private isLayoutToggleEffective(): boolean {
		const caps = this.controller?.currentEngine?.capabilities;
		if (!caps?.layoutSwitch) return false;
		return this.plugin.settings.reader.scrollMode !== true;
	}

	private syncLayoutToggleAvailability(): void {
		const el = this.layoutToggleEl;
		if (!el) return;
		const effective = this.isLayoutToggleEffective();
		const show = Boolean(this.controller?.currentEngine?.capabilities?.layoutSwitch);
		el.toggleClass("is-hidden", !show);
		el.toggleClass("nyareader-control-disabled", show && !effective);
		el.setAttribute("aria-disabled", show && !effective ? "true" : "false");
		if (!show) return;
		if (effective) {
			const double = this.plugin.settings.reader.layout === "double";
			el.setAttribute("title", double ? "切换为单页" : "切换为双页（双栏）");
			el.setAttribute("aria-label", double ? "切换为单页" : "切换为双页（双栏）");
			return;
		}
		el.setAttribute("title", "双页对开只在分页模式下有效：点击会切到分页模式并启用双页");
		el.setAttribute("aria-label", "当前为滚动模式，点击将切换到分页模式并启用双页");
	}

	/** 点「单页/双页」时若当前是滚动模式：先切到分页模式，再应用布局。 */
	private async toggleLayoutRequested(): Promise<void> {
		if (!this.isReaderInteractive()) return;
		if (!this.isLayoutToggleEffective() && this.controller?.currentEngine?.capabilities?.layoutSwitch) {
			await this.toggleReadingModeTo(false);
		}
		await this.toggleLayout();
	}

	private applyPanelWidth(): void {
		const w = Math.min(760, Math.max(240, this.plugin.settings.ui.translationPanelWidth || 320));
		this.transHost?.style.setProperty("--nyareader-trans-width", `${w}px`);
	}

	// ---------- 视图标题栏 ----------

	/** 标题栏按钮与信息条（公开 API addAction）。 */
	private buildTitlebarActions(): void {
		this.addAction("library", "书架", () => void this.openBookshelf());
		const openBtn = this.addAction("folder-open", "打开电子书…", () => void this.plugin.pickAndOpenBook());
		this.addAction("list-tree", "目录", () => this.toggleToc());
		this.translateActionEl = this.addAction("languages", "翻译（开/关）", () => this.toggleTranslate());
		this.translateActionEl.addClass("nyareader-titlebar-action");
		const highlightBtn = this.addAction("highlighter", "高亮选中文本", () => void this.addHighlightWithColor(this.lastHighlightColor));
		const noteBtn = this.addAction("pencil", "添加笔记", () => void this.addNote());
		const annotBtn = this.addAction("bookmark", "管理批注", () => this.openAnnotations());
		const moreBtn = this.addAction("ellipsis-horizontal", "更多操作", (evt) => this.openMoreMenu(evt));

		// 打开期间这些操作依赖已挂载的引擎：视觉禁用 + 逻辑侧拦截
		this.busyControls.push(openBtn, highlightBtn, noteBtn, annotBtn, moreBtn);

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
		this.layoutToggleEl.addEventListener("click", () => void this.toggleLayoutRequested());
		this.syncLayoutToggleIcon();
		this.syncLayoutToggleAvailability();

		// 页码指示已移至底部脚注（见 buildTransport），此处不再创建

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

		// 打开期间禁用：模式/布局切换与缩放控件（nudgeZoom 逻辑侧同时拦截）
		this.busyControls.push(this.modeToggleEl, this.layoutToggleEl, zoomOut, this.zoomSelectEl, zoomIn);
	}

	// ---------- 底部进度条（页码 + 可拖动 seek） ----------

	/**
	 * 底部 transport：左侧 `当前 / 总页数 · 百分比`，右侧一条可点击/可拖动的进度条。
	 *
	 * 职责边界：本组件只负责"显示 + 手势"，跳转一律交给 `Controller.seekToBookPercent`
	 * （它会按需补章，因此拖到未加载区域也能定位）。
	 */
	private buildTransport(container: HTMLElement): void {
		const bar = container.createDiv({ cls: "nyareader-transport" });
		const info = bar.createDiv({ cls: "nyareader-transport-info" });
		// 页码指示放在脚注（用户要求：不要挤在顶部标题栏）
		this.pageIndicatorEl = info.createSpan({ cls: "nyareader-page-indicator", text: "— / —" });
		const percentEl = info.createSpan({ cls: "nyareader-transport-percent", text: "0%" });
		this.transportPercentEl = percentEl;
		// 重排提示：大文件改字号/版式时显示，避免被误认为卡死（引擎重排开始前先画出来）
		this.relayoutHintEl = info.createSpan({ cls: "nyareader-relayout-hint is-hidden", text: "正在重新排版…" });

		const track = bar.createDiv({ cls: "nyareader-seek" });
		track.setAttribute("role", "slider");
		track.setAttribute("aria-label", "阅读进度");
		track.setAttribute("aria-valuemin", "0");
		track.setAttribute("aria-valuemax", "100");
		track.setAttribute("aria-valuenow", "0");
		track.setAttribute("tabindex", "0");
		this.seekTrackEl = track;
		this.seekFillEl = track.createDiv({ cls: "nyareader-seek-fill" });
		this.seekThumbEl = track.createDiv({ cls: "nyareader-seek-thumb" });

		const commit = (clientX: number): void => {
			const rect = track.getBoundingClientRect();
			const ratio = ratioFromClientX(clientX, rect.left, rect.width);
			if (ratio === null) return; // 轨道尺寸未就绪（隐藏/未布局）：忽略本次手势
			this.seekPercent = ratio;
			this.applySeekVisual();
			void this.controller?.seekToBookPercent(ratio);
		};

		track.addEventListener("pointerdown", (evt: PointerEvent) => {
			if (!this.isReaderInteractive()) return;
			evt.preventDefault();
			this.seeking = true;
			track.addClass("is-dragging");
			try {
				track.setPointerCapture(evt.pointerId);
			} catch {
				/* 某些环境不支持指针捕获，退化为普通拖动 */
			}
			// 按下即预览位置（不立即跳转，等松手/移动提交）
			const rect = track.getBoundingClientRect();
			const ratio = ratioFromClientX(evt.clientX, rect.left, rect.width);
			if (ratio !== null) {
				this.seekPercent = ratio;
				this.applySeekVisual();
			}
		});
		track.addEventListener("pointermove", (evt: PointerEvent) => {
			if (!this.seeking) return;
			commit(evt.clientX);
		});
		const endDrag = (evt: PointerEvent): void => {
			if (!this.seeking) return;
			this.seeking = false;
			track.removeClass("is-dragging");
			try {
				track.releasePointerCapture(evt.pointerId);
			} catch {
				/* 忽略 */
			}
			commit(evt.clientX);
		};
		track.addEventListener("pointerup", endDrag);
		track.addEventListener("pointercancel", endDrag);

		// 键盘可达：←/→ 微调 2%，Shift 加速到 10%，Home/End 首末
		track.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (!this.isReaderInteractive()) return;
			const next = stepSeekPercent(this.seekPercent, evt.key, evt.shiftKey);
			if (next === null) return;
			evt.preventDefault();
			evt.stopPropagation();
			this.seekPercent = next;
			this.applySeekVisual();
			void this.controller?.seekToBookPercent(this.seekPercent);
		});

		this.transportEl = bar;
		this.busyControls.push(track);
	}

	/**
	 * 重排状态：大文件改字号/版式时显示"正在重新排版…"。
	 *
	 * 引擎会在**阻塞性重排开始前**先把 busy:true 发出来（并把重排推到下一帧），
	 * 因此这句话一定能在界面冻结之前画到屏幕上；结束后 300ms 淡出。
	 */
	private onRelayoutState(state: RelayoutState): void {
		const el = this.relayoutHintEl;
		if (!el) return;
		if (this.relayoutHintTimer !== null) {
			window.clearTimeout(this.relayoutHintTimer);
			this.relayoutHintTimer = null;
		}
		if (state.busy) {
			el.removeClass("is-hidden");
			return;
		}
		// 结束：短暂保留后隐藏（避免闪烁），并可选显示耗时
		if (typeof state.elapsedMs === "number" && state.elapsedMs >= 120) {
			el.setText(`重新排版完成（${Math.round(state.elapsedMs)}ms）`);
		} else {
			el.setText("正在重新排版…");
		}
		this.relayoutHintTimer = window.setTimeout(() => {
			this.relayoutHintTimer = null;
			el.addClass("is-hidden");
			el.setText("正在重新排版…");
		}, 300);
	}

	/** 同步进度条位置/百分比文字（拖动中不覆盖用户手指位置）。 */
	private syncSeekBar(): void {
		if (!this.controller?.currentEngine) {
			this.applySeekVisual();
			return;
		}
		if (!this.seeking) this.seekPercent = this.controller.currentBookPercent();
		this.applySeekVisual();
	}

	/** 把 seekPercent 落到视觉上（填充宽度、滑块位置、百分比文字、aria）。 */
	private applySeekVisual(): void {
		const ratio = Math.min(1, Math.max(0, Number.isFinite(this.seekPercent) ? this.seekPercent : 0));
		const pct = ratio * 100;
		if (this.seekFillEl) this.seekFillEl.style.width = `${pct}%`;
		if (this.seekThumbEl) this.seekThumbEl.style.left = `${pct}%`;
		if (this.transportPercentEl) this.transportPercentEl.setText(formatSeekPercent(ratio));
		if (this.seekTrackEl) {
			this.seekTrackEl.setAttribute("aria-valuenow", String(Math.round(pct)));
			this.seekTrackEl.setAttribute("aria-valuetext", formatPageIndicator(this.currentPageNumber, this.totalPages, this.contentFullyLoaded));
		}
	}

	/** 没有书时隐藏底部条；有书时显示。 */
	private syncTransportVisibility(): void {
		const show = this.ready && !!this.controller?.currentEngine;
		this.transportEl?.toggleClass("is-hidden", !show);
	}

	private onZoomSelectChange(): void {
		if (!this.isReaderInteractive()) return;
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
		if (!this.isReaderInteractive()) return;
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
		if (!this.isReaderInteractive()) return; // 打开中：菜单项大多依赖引擎，直接不开
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("高亮选中文本").setIcon("highlighter").onClick(() => void this.addHighlightWithColor(this.lastHighlightColor)));
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
		if (!this.isReaderInteractive()) return; // 打开中：避免读到旧书/半挂载状态
		const controller = this.controller;
		if (!controller) return;
		new AnnotationListModal(this.app, {
			getAnnotations: () => controller.listAnnotations(),
			// 优先用引擎的 focusHighlight：它按锚点精确解析并滚到位置；不可用时退回 goTo
			onJump: (a) => {
				const engine = controller.currentEngine;
				if (engine?.focusHighlight) engine.focusHighlight(a.id);
				else void engine?.goTo(a.location);
			},
			onEditNote: (a) => controller.updateAnnotation(a.id, { note: a.note }),
			onDelete: (a) => controller.removeAnnotation(a.id),
			// 新增：面板内直接改色（侧车 + 引擎重绘）
			onUpdateColor: (a, color) => controller.updateAnnotation(a.id, { color }),
			// 新增：导出 Markdown 到 vault
			onExport: (list) => this.exportAnnotationsMarkdown(list),
		}).open();
	}

	/**
	 * 导出批注为 Markdown（Obsidian 原生高亮 `==…==` + callout 笔记）。
	 *
	 * 落盘位置：`<插件目录>/annotations/<书名>.批注.md`（用户可直接在 vault 里 grep/同步）；
	 * 同名文件采用**覆盖**而非追加，且每条带 `<!-- nyar:id=… -->`，因此重复导出不会产生重复块。
	 */
	private async exportAnnotationsMarkdown(list: Annotation[]): Promise<void> {
		const book = this.controller?.currentBook;
		if (!book) return;
		const md = annotationsToMarkdown(list, {
			bookTitle: book.title,
			bookPath: book.path,
			bookFingerprint: book.fingerprint,
		});
		const dir = this.plugin.manifest.dir ? `${this.plugin.manifest.dir}/annotations` : "nyareader/annotations";
		try {
			await this.plugin.app.vault.adapter.mkdir(dir).catch(() => undefined);
			const path = `${dir}/${annotationExportFileName(book.title)}`;
			await this.plugin.app.vault.adapter.write(path, md);
			new Notice(`NyaReader：已导出 ${list.length} 条批注 → ${path}`, 6000);
		} catch (e) {
			new Notice(`NyaReader：导出失败：${e instanceof Error ? e.message : String(e)}`, 6000);
		}
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
		// 打开中或引擎未就绪：忽略模式/布局切换、翻页与缩放快捷键（避免"按了没反应"）
		if (!this.isReaderInteractive()) return;
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
					// 用户要求：点目录只负责"跳转"，**不自动关闭**目录面板；
					// 再点标题栏「目录」按钮（或再次点该条目）才收起。这里只更新高亮。
					this.highlightTocItem(row);
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

	/** 标记当前所在目录项（点过的那个高亮），便于用户知道自己在哪一章。 */
	private highlightTocItem(active: HTMLElement): void {
		for (const el of Array.from(this.tocListEl.querySelectorAll<HTMLElement>(".nyareader-toc-item.is-current"))) {
			el.removeClass("is-current");
		}
		active.addClass("is-current");
	}

	private updateTitle(): void {
		// 重建叶子视图状态以刷新标题（Obsidian 会回调 getDisplayText）
		void this.leaf;
	}

	private async openBookshelf(): Promise<void> {
		await this.plugin.activateBookshelf();
	}

	private addNote(): void {
		if (!this.isReaderInteractive()) return;
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
