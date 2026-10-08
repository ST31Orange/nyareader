/**
 * NyaReader 书架主页（ItemView）。
 * 工作模式 A：从书架入口进入 -> 点书 -> 阅读模式。
 * 功能：新建区域（文件夹）、拖拽/导入电子书、删除、排序、卡片（标题+作者+进度+最近读）。
 *
 * 书架目录：vault 可见路径 nyareader/library（非 .obsidian），保证文件被 vault 索引、
 * 可经 getAbstractFileByPath 打开；mkdir 递归创建父目录。
 */
import { ItemView, Notice, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import type NyaReaderPlugin from "../main";
import { BookshelfService, BookshelfSort, splitPath } from "../services/storage/BookshelfService";
import type { BookshelfFolder } from "../services/storage/BookshelfService";
import { BOOKSHELF_VIEW_TYPE } from "./BookshelfViewTypes";
import { PromptModal } from "./components/PromptModal";
import { ConfirmModal } from "./components/ConfirmModal";
import { BOOKSHELF_MODE_LABEL, BookshelfDisplayMode } from "../settings";

const SORT_OPTIONS: Array<{ value: BookshelfSort; label: string }> = [
	{ value: "recent", label: "最近阅读" },
	{ value: "title", label: "书名" },
	{ value: "progress", label: "阅读进度" },
];

/** 书架根目录（vault 相对路径）。 */
export const BOOKSHELF_LIBRARY_DIR = "nyareader/library";

export class BookshelfView extends ItemView {
	private rootEl!: HTMLElement;
	private sort: BookshelfSort = "recent";
	private service!: BookshelfService;
	private folders: BookshelfFolder[] = [];

	constructor(leaf: WorkspaceLeaf, private plugin: NyaReaderPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return BOOKSHELF_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "NyaReader 书架";
	}

	getIcon(): string {
		return "library";
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("nyareader-bookshelf");
		this.rootEl = container;

		this.service = new BookshelfService(
			{
				list: async (p) => {
					const prefix = p.replace(/\/+$/, "") + "/";
					const files = this.plugin.app.vault.getFiles().filter((f) => f.path.startsWith(prefix)).map((f) => f.path);
					const folders = this.plugin.app.vault
						.getAllLoadedFiles()
						.filter((f) => f instanceof TFolder && f.path.startsWith(prefix))
						.map((f) => f.path);
					return { files, folders };
				},
				mkdir: async (p) => {
					const parts = p.replace(/\/+$/, "").split("/").filter(Boolean);
					let cur = "";
					for (const part of parts) {
						cur = cur ? `${cur}/${part}` : part;
						if (!this.plugin.app.vault.getAbstractFileByPath(cur)) {
							await this.plugin.app.vault.createFolder(cur).catch(() => undefined);
						}
					}
				},
				exists: async (p) => !!this.plugin.app.vault.getAbstractFileByPath(p),
				readBinary: async (p) => {
					const f = this.plugin.app.vault.getAbstractFileByPath(p);
					if (f instanceof TFile) return await this.plugin.app.vault.readBinary(f);
					throw new Error(`文件不存在: ${p}`);
				},
				writeBinary: async (p, d) => {
					await this.mkdirpParent(p);
					await this.plugin.app.vault.createBinary(p, d);
				},
				remove: async (p) => {
					const f = this.plugin.app.vault.getAbstractFileByPath(p);
					if (f) await this.plugin.app.vault.delete(f);
				},
			},
			BOOKSHELF_LIBRARY_DIR,
			(path) => {
				const entry = this.plugin.bookIndex.list().find((e) => e.path === path);
				if (!entry) return undefined;
				return {
					title: entry.title,
					author: entry.author,
					progress: entry.progress?.percentage,
					lastOpenedAt: entry.lastOpenedAt,
				};
			}
		);

		this.render();
		this.attachDragDrop();
	}

	async onClose(): Promise<void> {
		this.rootEl?.empty();
		return Promise.resolve();
	}

	/** 确保父目录存在（递归）。 */
	private async mkdirpParent(filePath: string): Promise<void> {
		const idx = filePath.lastIndexOf("/");
		if (idx <= 0) return;
		const parent = filePath.slice(0, idx);
		const parts = parent.split("/").filter(Boolean);
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			if (!this.plugin.app.vault.getAbstractFileByPath(cur)) {
				await this.plugin.app.vault.createFolder(cur).catch(() => undefined);
			}
		}
	}

	private async render(): Promise<void> {
		this.rootEl.empty();
		this.folders = await this.service.loadBooks();

		// 顶部栏
		const header = this.rootEl.createDiv({ cls: "nyareader-shelf-header" });
		const title = header.createDiv({ cls: "nyareader-shelf-title" });
		title.createEl("h2", { text: "我的书架" });
		title.createEl("span", { cls: "nyareader-shelf-sub", text: `${this.folders.reduce((n, f) => n + f.books.length, 0)} 本书` });

		const actions = header.createDiv({ cls: "nyareader-shelf-actions" });
		actions.createEl("button", { text: "＋ 新建区域", cls: "nyareader-shelf-btn" }).addEventListener("click", () => void this.createFolder());
		actions.createEl("button", { text: "导入…", cls: "nyareader-shelf-btn" }).addEventListener("click", () => void this.plugin.pickAndOpenBook());
		const sel = actions.createEl("select", { cls: "nyareader-shelf-sort" });
		for (const o of SORT_OPTIONS) sel.createEl("option", { value: o.value, text: o.label });
		sel.value = this.sort;
		sel.addEventListener("change", () => {
			this.sort = sel.value as BookshelfSort;
			void this.render();
		});

		if (!this.folders.length) {
			this.rootEl.createDiv({
				cls: "nyareader-shelf-empty",
				text: "书架还是空的。\n点击「导入…」选择电子书，或把 EPUB/PDF/MOBI/AZW3/TXT 文件直接拖到下方区域。",
			});
			this.renderDropZone("");
			return;
		}

		// 区域网格
		const grid = this.rootEl.createDiv({ cls: "nyareader-shelf-grid" });
		for (const folder of this.folders) {
			const zone = grid.createDiv({ cls: "nyareader-shelf-zone" });
			zone.setAttribute("data-rel", folder.relPath);
			const zoneHeader = zone.createDiv({ cls: "nyareader-shelf-zone-header" });
			zoneHeader.createEl("h3", { text: folder.name });
			const mode = this.modeFor(folder.relPath);
			zoneHeader.createEl("button", {
				text: `显示：${BOOKSHELF_MODE_LABEL[mode]}`,
				cls: "nyareader-shelf-mode-btn",
				attr: { title: "切换卡片显示模式（完整 / 紧凑 / 列表），仅对本区域生效" },
			}).addEventListener("click", () => void this.cycleMode(folder.relPath));
			const zoneActions = zone.createDiv({ cls: "nyareader-shelf-zone-actions" });
			if (folder.relPath) {
				zoneActions.createEl("button", { text: "删除区域", cls: "nyareader-shelf-link" }).addEventListener("click", () => void this.deleteFolder(folder.relPath));
			}
			const cards = zone.createDiv({ cls: "nyareader-shelf-cards" });
			if (mode === "list") cards.addClass("is-list");
			const books = this.service.sortBooks(folder.books, this.sort);
			if (!books.length) {
				cards.createDiv({ cls: "nyareader-shelf-zone-empty", text: "（空区域，拖拽电子书到此处）" });
			}
			for (const book of books) {
				cards.appendChild(this.buildCard(book.path, mode));
			}
			this.makeDropTarget(zone, folder.relPath);
		}
	}

	/** 当前区域显示模式（默认完整卡片）。 */
	private modeFor(relPath: string): BookshelfDisplayMode {
		return this.plugin.settings.bookshelfModes[relPath] ?? "full";
	}

	/** 循环切换模式并持久化到设置。 */
	private async cycleMode(relPath: string): Promise<void> {
		const order: BookshelfDisplayMode[] = ["full", "compact", "list"];
		const current = this.modeFor(relPath);
		const next = order[(order.indexOf(current) + 1) % order.length];
		this.plugin.settings.bookshelfModes[relPath] = next;
		await this.plugin.saveSettings();
		void this.render();
	}

	private buildCard(path: string, mode: BookshelfDisplayMode): HTMLElement {
		const { base, ext } = splitPath(path);
		const entry = this.plugin.bookIndex.list().find((e) => e.path === path);
		const card = document.createElement("div");
		card.className = `nyareader-shelf-card is-${mode}`;
		card.addEventListener("click", () => void this.openBook(path));

		if (mode === "list") {
			// 列表式：一行显示书名 + 进度（网格三列）
			const row = card.createDiv({ cls: "nyareader-shelf-list-row" });
			row.createSpan({ cls: "nyareader-shelf-list-title", text: entry?.title ?? base });
			row.createSpan({ cls: "nyareader-shelf-list-pct", text: `${Math.round((entry?.progress?.percentage ?? 0) * 100)}%` });
			const del = card.createEl("button", { text: "✕", cls: "nyareader-shelf-card-del" });
			del.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.deleteBook(path);
			});
			return card;
		}

		if (mode !== "compact") {
			const cover = card.createDiv({ cls: "nyareader-shelf-cover" });
			cover.createSpan({ cls: "nyareader-shelf-cover-ext", text: ext.toUpperCase() });
		}

		const info = card.createDiv({ cls: "nyareader-shelf-card-info" });
		info.createDiv({ cls: "nyareader-shelf-card-title", text: entry?.title ?? base });
		if (mode !== "compact") {
			info.createDiv({ cls: "nyareader-shelf-card-author", text: entry?.author ? `作者：${entry.author}` : "未知作者" });
		}

		// 进度条
		const progress = entry?.progress?.percentage ?? 0;
		const barWrap = info.createDiv({ cls: "nyareader-shelf-progress" });
		if (mode === "compact") {
			// 紧凑模式：格式标识放在进度条右下角
			barWrap.addClass("is-with-ext");
			const bar = barWrap.createDiv({ cls: "nyareader-shelf-progress-bar" });
			bar.style.width = `${Math.round(progress * 100)}%`;
			barWrap.createSpan({ cls: "nyareader-shelf-cover-ext is-mini", text: ext.toUpperCase() });
		} else {
			const bar = barWrap.createDiv({ cls: "nyareader-shelf-progress-bar" });
			bar.style.width = `${Math.round(progress * 100)}%`;
		}
		info.createDiv({
			cls: "nyareader-shelf-card-meta",
			text: mode === "compact" ? `${Math.round(progress * 100)}%` : `${Math.round(progress * 100)}%${entry?.lastOpenedAt ? ` · ${this.fmtTime(entry.lastOpenedAt)}` : ""}`,
		});

		// 删除按钮
		const del = card.createEl("button", { text: "✕", cls: "nyareader-shelf-card-del" });
		del.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.deleteBook(path);
		});
		return card;
	}

	private async openBook(path: string): Promise<void> {
		const f = this.plugin.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.plugin.openBookFile(f);
		else new Notice("NyaReader：文件不存在或已被移动。");
	}

	private async createFolder(): Promise<void> {
		new PromptModal(this.app, {
			title: "新建区域",
			placeholder: "区域名称（将作为书架文件夹名）",
			submitText: "创建",
			onSubmit: async (name) => {
				const ok = await this.service.createFolder(name);
				new Notice(ok ? `NyaReader：已创建区域「${name}」。` : "NyaReader：创建失败（名称非法或已存在）。");
				void this.render();
			},
		}).open();
	}

	private async deleteBook(path: string): Promise<void> {
		const name = splitPath(path).base;
		new ConfirmModal(this.app, {
			title: "删除书籍",
			message: `删除《${name}》？文件将从书架中移除。`,
			confirmText: "删除",
			onConfirm: async () => {
				await this.service.deleteBook(path);
				// 从索引移除
				const entry = this.plugin.bookIndex.list().find((e) => e.path === path);
				if (entry) await this.plugin.bookIndex.remove(entry.fingerprint);
				new Notice("NyaReader：已删除。");
				void this.render();
			},
		}).open();
	}

	private deleteFolder(relPath: string): void {
		const name = relPath.split("/").pop() ?? relPath;
		new ConfirmModal(this.app, {
			title: "删除区域",
			message: `删除区域「${name}」及其中的所有书籍？此操作不可恢复。`,
			confirmText: "删除",
			onConfirm: async () => {
				await this.service.deleteFolder(relPath);
				new Notice("NyaReader：已删除区域。");
				void this.render();
			},
		}).open();
	}

	/** 渲染可拖拽的空书架落点（书架为空时）。 */
	private renderDropZone(relPath: string): void {
		const zone = this.rootEl.createDiv({ cls: "nyareader-shelf-zone nyareader-shelf-zone-empty-drop" });
		zone.setAttribute("data-rel", relPath);
		zone.setText("把电子书拖到这里");
		this.makeDropTarget(zone, relPath);
	}

	/** 拖拽导入：把系统文件复制到对应区域文件夹。 */
	private makeDropTarget(el: HTMLElement, relPath: string): void {
		el.addEventListener("dragover", (e) => {
			e.preventDefault();
			e.dataTransfer!.dropEffect = "copy";
			el.addClass("nyareader-drag-over");
		});
		el.addEventListener("dragleave", () => el.removeClass("nyareader-drag-over"));
		el.addEventListener("drop", (e) => {
			e.preventDefault();
			el.removeClass("nyareader-drag-over");
			void this.importDropped(e.dataTransfer?.files, relPath);
		});
	}

	private attachDragDrop(): void {
		// 整页兜底：拖到空白处导入到根目录
		this.rootEl.addEventListener("dragover", (e) => {
			e.preventDefault();
		});
		this.rootEl.addEventListener("drop", (e) => {
			e.preventDefault();
		});
	}

	private async importDropped(files: FileList | undefined, relPath: string): Promise<void> {
		if (!files || !files.length) return;
		const items: Array<{ name: string; data: ArrayBuffer }> = [];
		for (const f of Array.from(files)) {
			const { ext } = splitPath(f.name);
			if (!["epub", "pdf", "mobi", "azw3", "azw", "txt"].includes(ext)) continue;
			items.push({ name: f.name, data: await f.arrayBuffer() });
		}
		if (!items.length) {
			new Notice("NyaReader：没有支持的电子书格式。");
			return;
		}
		const ok = await this.service.importFiles(items, relPath);
		new Notice(`NyaReader：已导入 ${ok} 本书。`);
		void this.render();
	}

	private fmtTime(ts: number): string {
		const d = new Date(ts);
		return `${d.getMonth() + 1}月${d.getDate()}日`;
	}
}
