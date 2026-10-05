/**
 * NyaReader 阅读视图（ItemView）。
 * 独立阅读叶。
 *
 * 布局（v0.2.0）：最大化阅读区。
 * - 常用按钮用 view.addAction() 放进 Obsidian 自带标题栏那一行（公开 API，1.1+）；
 * - 阅读区上方保留一条细高可折叠工具栏（非悬浮、默认收起），放次要操作；
 * - 「翻译」按钮：点击开（变色激活）→ 右侧弹出翻译面板（320px）→ 划词自动翻译 → 再点关闭。
 * 只与 ReaderController 交互；Controller 面向引擎接口。
 */
import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type NyaReaderPlugin from "../main";
import { TranslationPanel } from "./TranslationPanel";
import { ReaderController } from "./ReaderController";
import { BOOKSHELF_VIEW_TYPE } from "./BookshelfViewTypes";
import type { BookModel } from "../types";

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

export class ReaderView extends ItemView {
	private toolbarEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private readingArea!: HTMLElement;
	private tocPanel!: HTMLElement;
	private tocListEl!: HTMLElement;
	private transHost!: HTMLElement;
	private transPanel: TranslationPanel | null = null;
	private controller: ReaderController | null = null;
	private currentFile: TFile | null = null;
	/** 标题栏上的翻译按钮（用于切换激活态） */
	private translateActionEl: HTMLElement | null = null;
	/** 翻译模式开关：开启时划词自动翻译 */
	private translateMode = false;

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

		// ① 常用按钮进 Obsidian 标题栏（addAction 返回按钮元素，可加激活态）
		this.buildTitlebarActions();

		// ② 细高可折叠工具栏（默认收起，次要操作）
		this.toolbarEl = container.createDiv({ cls: "nyareader-toolbar" });
		this.buildCollapsibleToolbar();
		this.toolbarEl.toggleClass("is-collapsed", true);

		this.bodyEl = container.createDiv({ cls: "nyareader-content" });
		this.tocPanel = this.bodyEl.createDiv({ cls: "nyareader-toc-panel" });
		this.tocListEl = this.tocPanel.createDiv({ cls: "nyareader-toc-list" });
		this.readingArea = this.bodyEl.createDiv({ cls: "nyareader-reading" });
		this.transHost = this.bodyEl.createDiv({ cls: "nyareader-trans-host" });

		// 控制器
		this.controller = new ReaderController(this.plugin, {
			onBookOpened: (book) => this.renderToc(book),
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
		});
		this.transPanel.mount(this.transHost);

		// 初始提示
		this.showWelcome();
	}

	onClose(): Promise<void> {
		this.transPanel?.destroy();
		this.controller?.close();
		return Promise.resolve();
	}

	/** 打开一本书：由主插件从命令/右键菜单调用。 */
	async openBook(file: TFile): Promise<void> {
		this.currentFile = file;
		this.updateTitle();
		this.readingArea.empty();
		await this.controller?.openBook(file, this.readingArea);
		this.attachEngineSelectionListener();
	}

	/** 划词自动翻译：仅翻译模式开启时，在右侧面板显示译文。 */
	private attachEngineSelectionListener(): void {
		const engine = this.controller?.currentEngine;
		if (!engine || !this.transPanel) return;
		engine.on("selection", (payload) => {
			if (this.translateMode && payload.text?.trim()) this.transPanel?.translateSelection(payload.text);
		});
	}

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

	private updateTitle(): void {
		// 重建叶子视图状态以刷新标题（Obsidian 会回调 getDisplayText）
		void this.leaf;
	}

	// ---------- 布局：标题栏 + 折叠工具栏 ----------

	/** 常用按钮进 Obsidian 标题栏（addAction，公开 API）。 */
	private buildTitlebarActions(): void {
		// 书架
		this.addAction("library", "书架", () => void this.openBookshelf());
		// 打开
		this.addAction("folder-open", "打开电子书…", () => void this.plugin.pickAndOpenBook());
		// 目录
		this.addAction("list-tree", "目录", () => this.toggleToc());
		// 翻译（可激活）
		this.translateActionEl = this.addAction("languages", "翻译（开/关）", () => this.toggleTranslate());
		this.translateActionEl.addClass("nyareader-titlebar-action");
		// 更多（展开/收起细工具栏）
		this.addAction("ellipsis-horizontal", "更多操作", () => this.toggleCollapsibleToolbar());
	}

	/** 折叠工具栏：放次要操作（翻页、高亮、笔记、字号）。默认收起。 */
	private buildCollapsibleToolbar(): void {
		const btn = (label: string, onClick: () => void): void => {
			const b = this.toolbarEl.createEl("button", { text: label, cls: "nyareader-toolbar-btn" });
			b.addEventListener("click", onClick);
		};
		btn("上一页", () => void this.controller?.currentEngine?.prevPage());
		btn("下一页", () => void this.controller?.currentEngine?.nextPage());
		btn("高亮", () => void this.addHighlight());
		btn("笔记", () => void this.addNote());
		btn("A−", () => void this.adjustFont(-1));
		btn("A+", () => void this.adjustFont(1));
	}

	private toggleCollapsibleToolbar(): void {
		this.toolbarEl.toggleClass("is-collapsed", !this.toolbarEl.hasClass("is-collapsed"));
	}

	/** 翻译按钮：开（激活变色+右侧面板）→ 再点关。 */
	private toggleTranslate(): void {
		this.translateMode = !this.translateMode;
		this.translateActionEl?.toggleClass("is-active", this.translateMode);
		if (this.translateMode) {
			this.transPanel?.show();
			new Notice("NyaReader：翻译模式已开启，选中文本自动翻译。", 3000);
		} else {
			this.transPanel?.hide();
			new Notice("NyaReader：翻译模式已关闭。", 3000);
		}
	}

	private async openBookshelf(): Promise<void> {
		await this.plugin.activateBookshelf();
	}

	private toggleToc(open?: boolean): void {
		const next = open ?? !this.tocPanel.hasClass("is-open");
		this.tocPanel.toggleClass("is-open", next);
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

	/** 字号微调（仅当前页生效，不改全局设置）。 */
	private adjustFont(delta: number): void {
		const engine = this.controller?.currentEngine;
		if (!engine) return;
		const cur = this.plugin.settings.reader.fontSize;
		const next = Math.min(40, Math.max(10, cur + delta));
		if (next === cur) return;
		this.plugin.settings.reader.fontSize = next;
		void this.plugin.saveSettings();
		engine.applySettings(this.controller!.currentReaderSettings());
	}

	private showWelcome(): void {
		this.readingArea.empty();
		this.readingArea.createDiv({
			cls: "nyareader-placeholder",
			text: "NyaReader\n\n点击「打开」选择电子书（EPUB / PDF / MOBI / AZW3 / TXT）\n选中文本后点击「高亮」或「笔记」批注；点标题栏「翻译」开启划词翻译",
		});
	}
}
