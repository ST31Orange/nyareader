/**
 * NyaReader 阅读视图（ItemView）。
 * 独立阅读叶，内嵌工具栏、阅读区、右侧翻译面板、左侧目录面板。
 * 只与 ReaderController 交互；Controller 面向引擎接口。
 */
import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type NyaReaderPlugin from "../main";
import { TranslationPanel } from "./TranslationPanel";
import { ReaderController } from "./ReaderController";
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

		this.toolbarEl = container.createDiv({ cls: "nyareader-toolbar" });
		this.buildToolbar();

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

		// 右侧翻译面板
		this.transPanel = new TranslationPanel({
			onTranslate: (text, to) => this.controller?.translateSelection(text, to) ?? Promise.reject(new Error("控制器未就绪")),
			getLanguages: () => LANGUAGE_OPTIONS,
			getTarget: () => this.plugin.settings.translation.targetLanguage,
			setTarget: async (lang) => {
				this.plugin.settings.translation.targetLanguage = lang;
				await this.plugin.saveSettings();
			},
			onOpenSettings: () => openSettingsTab(this.plugin.app),
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

	/** 划词自动翻译：监听引擎 selection 事件，在右侧面板显示译文。 */
	private attachEngineSelectionListener(): void {
		const engine = this.controller?.currentEngine;
		if (!engine || !this.transPanel) return;
		engine.on("selection", (payload) => {
			if (payload.text?.trim()) this.transPanel?.translateSelection(payload.text);
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

	private buildToolbar(): void {
		const btn = (label: string, onClick: () => void): void => {
			const b = this.toolbarEl.createEl("button", { text: label, cls: "nyareader-toolbar-btn" });
			b.addEventListener("click", onClick);
		};
		btn("打开…", () => void this.plugin.pickAndOpenBook());
		btn("目录", () => this.toggleToc());
		btn("翻译", () => this.transPanel?.toggle());
		btn("上一页", () => void this.controller?.currentEngine?.prevPage());
		btn("下一页", () => void this.controller?.currentEngine?.nextPage());
		btn("高亮", () => void this.addHighlight());
		btn("笔记", () => void this.addNote());
		btn("主题", () => this.cycleTheme());
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

	private cycleTheme(): void {
		const themes = ["light", "dark", "sepia"] as const;
		const cur = this.plugin.settings.reader.theme;
		const next = themes[(themes.indexOf(cur) + 1) % themes.length];
		this.plugin.settings.reader.theme = next;
		void this.plugin.saveSettings();
		this.readingArea.toggleClass("nyareader-theme-dark", next === "dark");
		this.readingArea.toggleClass("nyareader-theme-sepia", next === "sepia");
		this.controller?.currentEngine?.applySettings(this.controller.currentReaderSettings());
	}

	private showWelcome(): void {
		this.readingArea.empty();
		this.readingArea.createDiv({
			cls: "nyareader-placeholder",
			text: "NyaReader\n\n点击「打开…」选择电子书（EPUB / PDF / MOBI / AZW3 / TXT）\n选中文本后点击「高亮」或「笔记」批注，划词后在右侧翻译",
		});
	}
}

/** 打开 Obsidian 设置面板（非公开 API 需降级处理）。 */
function openSettingsTab(app: import("obsidian").App): void {
	try {
		const setting = (app as unknown as { setting?: { open(): void } }).setting;
		setting?.open();
	} catch {
		new Notice("NyaReader：请在「设置 -> 第三方插件 -> NyaReader」中完成配置。");
	}
}

