/**
 * NyaReader 书架主页（ItemView）。
 *
 * 布局：左侧「书库」列（可新建 / 选择 / 双击改名 / 拖动排序）+ 右侧当前书库的文件夹区域。
 * 数据模型：nyareader/library/<书库>/<文件夹>/<书>（书必须放在文件夹里）。
 *
 * 书架根目录为 vault 可见路径 nyareader/library（非 .obsidian），保证文件被 vault 索引。
 */
import { ItemView, Notice, TFile, TFolder, WorkspaceLeaf, setIcon } from "obsidian";
import type NyaReaderPlugin from "../main";
import { BookshelfService, BookshelfSort, splitPath } from "../services/storage/BookshelfService";
import type { BookshelfFolder, BookshelfLibrary } from "../services/storage/BookshelfService";
import { BOOKSHELF_VIEW_TYPE } from "./BookshelfViewTypes";
import { PromptModal } from "./components/PromptModal";
import { ConfirmModal } from "./components/ConfirmModal";
import { BOOKSHELF_MODE_LABEL, BookshelfDisplayMode } from "../settings";
import readerIcon from "../assets/reader.png";

const SORT_OPTIONS: Array<{ value: BookshelfSort; label: string }> = [
	{ value: "recent", label: "最近阅读" },
	{ value: "title", label: "书名" },
	{ value: "progress", label: "阅读进度" },
];

/** 书架根目录（vault 相对路径）。 */
export const BOOKSHELF_LIBRARY_DIR = "nyareader/library";
/** 迁移时的默认书库名。 */
const DEFAULT_LIBRARY = "我的书库";
/** 迁移书库根目录散书时归入的文件夹名。 */
const UNCATEGORIZED = "未分类";

export class BookshelfView extends ItemView {
	private rootEl!: HTMLElement;
	private sort: BookshelfSort = "recent";
	private service!: BookshelfService;
	private libraries: BookshelfLibrary[] = [];
	private folders: BookshelfFolder[] = [];
	/** 当前选中的书库（相对路径） */
	private currentLibrary = "";
	/** 拖动中的书路径（dragstart 记录、dragend 清空） */
	private draggingBookPath: string | null = null;
	/** 拖动中的书库（排序用） */
	private draggingLibrary: string | null = null;
	/** 拖动中的文件夹（同书库内排序用） */
	private draggingFolder: string | null = null;
	/** 原生 drop 是否已处理本次拖动（避免 dragend 兜底重复处理） */
	private dropHandled = false;

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
					await this.vaultMkdirp(p);
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
					// 文件夹必须 force:true（Obsidian 对非空目录会走非递归 rm 而报 EISDIR）
					if (f instanceof TFolder) await this.plugin.app.vault.delete(f, true);
					else if (f) await this.plugin.app.vault.delete(f);
				},
				rename: async (oldPath, newPath) => {
					const f = this.plugin.app.vault.getAbstractFileByPath(oldPath);
					if (!f) throw new Error(`源不存在: ${oldPath}`);
					await this.mkdirpParent(newPath);
					await this.plugin.app.vault.rename(f, newPath);
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

		await this.migrateIfNeeded();
		await this.render();
		this.attachRootDragFallback();
	}

	async onClose(): Promise<void> {
		this.plugin.cover.clear();
		this.rootEl?.empty();
		return Promise.resolve();
	}

	// ---------- 一次性迁移：旧「文件夹」结构 -> 默认书库 ----------

	private async migrateIfNeeded(): Promise<void> {
		if (this.plugin.settings.bookshelfMigrated) return;
		try {
			const root = this.plugin.app.vault.getAbstractFileByPath(BOOKSHELF_LIBRARY_DIR);
			if (root instanceof TFolder) {
				const legacyFolders = root.children.filter((c): c is TFolder => c instanceof TFolder && c.name !== DEFAULT_LIBRARY);
				const legacyFiles = root.children.filter((c): c is TFile => c instanceof TFile);
				if (legacyFolders.length || legacyFiles.length) {
					const defLibPath = `${BOOKSHELF_LIBRARY_DIR}/${DEFAULT_LIBRARY}`;
					await this.vaultMkdirp(defLibPath);
					const folderNames = legacyFolders.map((f) => f.name);
					for (const f of legacyFolders) {
						const dest = await this.uniqueVaultPath(`${defLibPath}/${f.name}`);
						await this.plugin.app.vault.rename(f, dest);
					}
					if (legacyFiles.length) {
						const unPath = `${defLibPath}/${UNCATEGORIZED}`;
						await this.vaultMkdirp(unPath);
						for (const f of legacyFiles) {
							const dest = await this.uniqueVaultPath(`${unPath}/${f.name}`);
							await this.plugin.app.vault.rename(f, dest);
						}
					}
					// 迁移索引路径
					const legacyFolderSet = new Set(folderNames);
					for (const entry of this.plugin.bookIndex.list()) {
						const p = entry.path;
						if (!p.startsWith(`${BOOKSHELF_LIBRARY_DIR}/`)) continue;
						const rest = p.slice(BOOKSHELF_LIBRARY_DIR.length + 1);
						const seg = rest.split("/");
						let newPath: string | null = null;
						if (seg.length === 1) {
							// 根目录散书 -> 我的书库/未分类/
							newPath = `${defLibPath}/${UNCATEGORIZED}/${rest}`;
						} else if (legacyFolderSet.has(seg[0])) {
							newPath = `${defLibPath}/${rest}`;
						}
						if (newPath && newPath !== p) await this.plugin.bookIndex.upsert({ ...entry, path: newPath });
					}
					// 迁移 modes / collapsed 键：<文件夹> -> 我的书库/<文件夹>；"" -> 我的书库/未分类
					const remap = (rec: Record<string, unknown>): Record<string, unknown> => {
						const out: Record<string, unknown> = {};
						for (const [k, v] of Object.entries(rec)) {
							if (!k) out[`${DEFAULT_LIBRARY}/${UNCATEGORIZED}`] = v;
							else out[`${DEFAULT_LIBRARY}/${k}`] = v;
						}
						return out;
					};
					this.plugin.settings.bookshelfModes = remap(this.plugin.settings.bookshelfModes) as typeof this.plugin.settings.bookshelfModes;
					this.plugin.settings.bookshelfCollapsed = remap(this.plugin.settings.bookshelfCollapsed) as typeof this.plugin.settings.bookshelfCollapsed;
					this.plugin.settings.bookshelfLibraryOrder = [DEFAULT_LIBRARY];
				}
			}
		} catch (e) {
			console.warn("NyaReader: 书架迁移失败", e);
		}
		this.plugin.settings.bookshelfMigrated = true;
		await this.plugin.saveSettings();
	}

	// ---------- 渲染 ----------

	private async render(): Promise<void> {
		this.rootEl.empty();
		this.libraries = await this.service.loadLibraries();
		const orderedRels = this.orderedLibraries().map((l) => l.relPath);
		const saved = this.plugin.settings.bookshelfSelectedLibrary;
		this.currentLibrary = orderedRels.includes(saved) ? saved : (orderedRels[0] ?? "");
		this.folders = this.currentLibrary ? await this.service.loadFolders(this.currentLibrary) : [];
		if (this.plugin.settings.bookshelfSelectedLibrary !== this.currentLibrary) {
			this.plugin.settings.bookshelfSelectedLibrary = this.currentLibrary;
			void this.plugin.saveSettings();
		}

		// 顶部栏
		const header = this.rootEl.createDiv({ cls: "nyareader-shelf-header" });
		const title = header.createDiv({ cls: "nyareader-shelf-title" });
		const titleRow = title.createDiv({ cls: "nyareader-shelf-title-row" });
		const settingsBtn = titleRow.createEl("button", { cls: "nyareader-shelf-settings-btn", attr: { title: "NyaReader 设置", "aria-label": "NyaReader 设置" } });
		settingsBtn.createEl("img", { attr: { src: readerIcon, alt: "" } });
		settingsBtn.addEventListener("click", () => this.plugin.openSettings());
		titleRow.createEl("h2", { text: "我的书架" });
		const totalBooks = this.libraries.length;
		void totalBooks;
		title.createEl("span", {
			cls: "nyareader-shelf-sub",
			text: `${this.libraries.length} 个书库${this.currentLibrary ? ` · 当前：${this.currentLibrary}` : ""}`,
		});
		const actions = header.createDiv({ cls: "nyareader-shelf-actions" });
		actions.createEl("button", { text: "＋ 新建书库", cls: "nyareader-shelf-btn" }).addEventListener("click", () => void this.createLibrary());
		const sel = actions.createEl("select", { cls: "nyareader-shelf-sort" });
		for (const o of SORT_OPTIONS) sel.createEl("option", { value: o.value, text: o.label });
		sel.value = this.sort;
		sel.addEventListener("change", () => {
			this.sort = sel.value as BookshelfSort;
			void this.render();
		});

		// 主体：左书库列 + 右文件夹区
		const body = this.rootEl.createDiv({ cls: "nyareader-shelf-body" });
		this.renderLibraryColumn(body);
		this.renderFolders(body);
	}

	/** 左侧书库列。 */
	private renderLibraryColumn(body: HTMLElement): void {
		const col = body.createDiv({ cls: "nyareader-library-col" });
		col.createDiv({ cls: "nyareader-library-col-title", text: "书库" });
		const libs = this.orderedLibraries();
		if (!libs.length) {
			col.createDiv({ cls: "nyareader-library-empty", text: "还没有书库\n点上方「＋ 新建书库」" });
			return;
		}
		const list = col.createDiv({ cls: "nyareader-library-list" });
		for (const lib of libs) {
			const item = list.createDiv({ cls: "nyareader-library-item" });
			if (lib.relPath === this.currentLibrary) item.addClass("is-active");
			item.setAttribute("data-lib", lib.relPath);
			item.setAttribute("title", "点击打开；双击重命名；拖动排序");
			item.createDiv({ cls: "nyareader-library-name", text: lib.name });
			item.addEventListener("click", () => void this.selectLibrary(lib.relPath));
			item.addEventListener("dblclick", () => this.renameLibrary(lib.relPath));
			item.setAttribute("draggable", "true");
			item.addEventListener("dragstart", (e) => {
				this.draggingLibrary = lib.relPath;
				e.dataTransfer?.setData("application/x-nyareader-library", lib.relPath);
				if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
				item.addClass("is-dragging");
			});
			item.addEventListener("dragend", (e) => {
				item.removeClass("is-dragging");
				const drag = this.draggingLibrary;
				this.draggingLibrary = null;
				if (drag) {
					const target = this.libraryAt(e.clientX, e.clientY);
					if (target) void this.reorderLibraries(drag, target);
				}
			});
		}
	}

	/** 右侧当前书库的文件夹区域。 */
	private renderFolders(body: HTMLElement): void {
		const main = body.createDiv({ cls: "nyareader-shelf-main" });
		if (!this.currentLibrary) {
			main.createDiv({ cls: "nyareader-shelf-empty", text: "选择左侧的书库，或点「＋ 新建书库」创建第一个书库。" });
			return;
		}
		const bar = main.createDiv({ cls: "nyareader-shelf-main-bar" });
		const h3 = bar.createEl("h3", { text: this.currentLibrary });
		void h3;
		const span = bar.createEl("span", { cls: "nyareader-shelf-sub", text: `${this.folders.length} 个文件夹` });
		void span;
		bar.createEl("button", { text: "＋ 新建文件夹", cls: "nyareader-shelf-btn" }).addEventListener("click", () => void this.createFolder());

		const folders = this.orderedFolders(this.currentLibrary);
		if (!folders.length) {
			main.createDiv({ cls: "nyareader-shelf-empty", text: "这个书库还没有文件夹。\n点「＋ 新建文件夹」，再把电子书拖进去。" });
			return;
		}
		const grid = main.createDiv({ cls: "nyareader-shelf-grid" });
		for (const folder of folders) {
			const collapsed = this.isCollapsed(this.folderKey(folder.relPath));
			const zone = grid.createDiv({ cls: "nyareader-shelf-zone" });
			if (collapsed) zone.addClass("is-collapsed");
			zone.setAttribute("data-lib", this.currentLibrary);
			zone.setAttribute("data-folder", folder.relPath);
			const zoneHeader = zone.createDiv({ cls: "nyareader-shelf-zone-header" });
			// 拖动排序手柄
			const grip = zoneHeader.createDiv({ cls: "nyareader-folder-grip", attr: { title: "拖动调整文件夹顺序", draggable: "true" } });
			setIcon(grip, "grip-vertical");
			grip.addEventListener("dragstart", (e) => {
				this.draggingFolder = folder.relPath;
				e.dataTransfer?.setData("application/x-nyareader-folder", folder.relPath);
				if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
				zone.addClass("is-dragging");
			});
			grip.addEventListener("dragend", (e) => {
				zone.removeClass("is-dragging");
				const drag = this.draggingFolder;
				this.draggingFolder = null;
				if (drag) {
					const target = this.folderAt(e.clientX, e.clientY);
					if (target && target.lib === this.currentLibrary) void this.reorderFolders(drag, target.folder);
				}
			});
			// 标题 + 折叠
			const titleWrap = zoneHeader.createDiv({ cls: "nyareader-shelf-zone-title" });
			titleWrap.createEl("h3", { text: folder.name });
			const collapseBtn = titleWrap.createEl("button", { cls: "nyareader-shelf-collapse", attr: { title: collapsed ? "展开文件夹" : "折叠文件夹" } });
			setIcon(collapseBtn, collapsed ? "chevron-right" : "chevron-down");
			collapseBtn.addEventListener("click", () => void this.toggleCollapse(this.folderKey(folder.relPath)));
			const mode = this.modeFor(this.folderKey(folder.relPath));
			zoneHeader.createEl("button", {
				text: `显示：${BOOKSHELF_MODE_LABEL[mode]}`,
				cls: "nyareader-shelf-mode-btn",
				attr: { title: "切换卡片显示模式（完整 / 紧凑 / 列表），仅对本文件夹生效" },
			}).addEventListener("click", () => void this.cycleMode(this.folderKey(folder.relPath)));
			// 右上角删除文件夹
			zone.createEl("button", { text: "✕", cls: "nyareader-shelf-zone-del", attr: { title: "删除文件夹" } }).addEventListener("click", () => void this.deleteFolder(folder.relPath));

			const cards = zone.createDiv({ cls: "nyareader-shelf-cards" });
			if (mode === "list") cards.addClass("is-list");
			const books = this.service.sortBooks(folder.books, this.sort);
			if (!books.length) cards.createDiv({ cls: "nyareader-shelf-zone-empty", text: "（空文件夹，拖拽电子书到此处）" });
			for (const book of books) cards.appendChild(this.buildCard(book.path, mode));
			this.makeDropTarget(zone, this.currentLibrary, folder.relPath);
		}
	}

	// ---------- 卡片 ----------

	private buildCard(path: string, mode: BookshelfDisplayMode): HTMLElement {
		const { base, ext } = splitPath(path);
		const entry = this.plugin.bookIndex.list().find((e) => e.path === path);
		const card = document.createElement("div");
		card.className = `nyareader-shelf-card is-${mode}`;
		card.addEventListener("click", () => void this.openBook(path));
		card.setAttribute("draggable", "true");
		card.addEventListener("dragstart", (e) => {
			this.draggingBookPath = path;
			e.dataTransfer?.setData("application/x-nyareader-book", path);
			e.dataTransfer?.setData("text/plain", path);
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
			card.addClass("is-dragging");
		});
		card.addEventListener("dragend", (e) => {
			card.removeClass("is-dragging");
			const wasHandled = this.dropHandled;
			this.dropHandled = false;
			const dragged = this.draggingBookPath;
			this.draggingBookPath = null;
			if (!wasHandled && dragged) {
				const target = this.folderAt(e.clientX, e.clientY);
				if (target) void this.moveBook(dragged, target.lib, target.folder);
			}
		});

		if (mode === "list") {
			const row = card.createDiv({ cls: "nyareader-shelf-list-row" });
			row.createSpan({ cls: "nyareader-shelf-list-title", text: entry?.title ?? base });
			row.createSpan({ cls: "nyareader-shelf-cover-ext is-mini", text: ext.toUpperCase() });
			row.createSpan({ cls: "nyareader-shelf-list-pct", text: `${Math.round((entry?.progress?.percentage ?? 0) * 100)}%` });
			const del = card.createEl("button", { text: "✕", cls: "nyareader-shelf-card-del" });
			del.addEventListener("click", (e) => { e.stopPropagation(); void this.deleteBook(path); });
			return card;
		}

		if (mode !== "compact") {
			const cover = card.createDiv({ cls: "nyareader-shelf-cover" });
			const placeholder = cover.createDiv({ cls: "nyareader-shelf-cover-placeholder" });
			setIcon(placeholder, "book-open");
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				void this.plugin.cover.getCoverUrl(file, entry?.fingerprint).then((url) => {
					if (!url || !cover.isConnected) return;
					placeholder.remove();
					const img = cover.createEl("img", { attr: { src: url, alt: "", loading: "lazy" } });
					img.addClass("nyareader-shelf-cover-img");
				});
			}
		}

		const info = card.createDiv({ cls: "nyareader-shelf-card-info" });
		info.createDiv({ cls: "nyareader-shelf-card-title", text: entry?.title ?? base });
		const progress = entry?.progress?.percentage ?? 0;
		if (mode === "compact") {
			const authorRow = info.createDiv({ cls: "nyareader-shelf-compact-author" });
			authorRow.createSpan({ cls: "nyareader-shelf-card-author", text: entry?.author ?? "未知作者" });
			authorRow.createSpan({ cls: "nyareader-shelf-cover-ext is-mini", text: ext.toUpperCase() });
			const barWrap = info.createDiv({ cls: "nyareader-shelf-progress" });
			const bar = barWrap.createDiv({ cls: "nyareader-shelf-progress-bar" });
			bar.style.width = `${Math.round(progress * 100)}%`;
		} else {
			info.createDiv({ cls: "nyareader-shelf-card-author", text: entry?.author ? `作者：${entry.author}` : "未知作者" });
			const barWrap = info.createDiv({ cls: "nyareader-shelf-progress" });
			const bar = barWrap.createDiv({ cls: "nyareader-shelf-progress-bar" });
			bar.style.width = `${Math.round(progress * 100)}%`;
			const meta = info.createDiv({ cls: "nyareader-shelf-card-meta" });
			meta.createSpan({ cls: "nyareader-shelf-cover-ext is-mini", text: ext.toUpperCase() });
			meta.createSpan({ cls: "nyareader-shelf-card-meta-text", text: `${Math.round(progress * 100)}%${entry?.lastOpenedAt ? ` · ${this.fmtTime(entry.lastOpenedAt)}` : ""}` });
		}

		const del = card.createEl("button", { text: "✕", cls: "nyareader-shelf-card-del" });
		del.addEventListener("click", (e) => { e.stopPropagation(); void this.deleteBook(path); });
		return card;
	}

	// ---------- 拖放 ----------

	/** 拖动落点：书卡 -> 文件夹/跨库移动；文件夹 -> 排序；外部文件 -> 导入。 */
	private makeDropTarget(zone: HTMLElement, libraryRel: string, folderRel: string): void {
		zone.addEventListener("dragover", (e) => {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
			zone.addClass("nyareader-drag-over");
		});
		zone.addEventListener("dragleave", () => zone.removeClass("nyareader-drag-over"));
		zone.addEventListener("drop", (e) => {
			e.preventDefault();
			e.stopPropagation();
			zone.removeClass("nyareader-drag-over");
			const folderDrag = e.dataTransfer?.getData("application/x-nyareader-folder") || this.draggingFolder || "";
			if (folderDrag) {
				this.draggingFolder = null;
				this.dropHandled = true;
				if (folderDrag !== folderRel && libraryRel === this.currentLibrary) void this.reorderFolders(folderDrag, folderRel);
				return;
			}
			const bookPath = e.dataTransfer?.getData("application/x-nyareader-book") || this.draggingBookPath || "";
			if (bookPath) {
				this.draggingBookPath = null;
				this.dropHandled = true;
				void this.moveBook(bookPath, libraryRel, folderRel);
				return;
			}
			void this.importDropped(e.dataTransfer?.files, libraryRel, folderRel);
		});
	}

	private attachRootDragFallback(): void {
		this.rootEl.addEventListener("dragover", (e) => e.preventDefault());
		this.rootEl.addEventListener("drop", (e) => e.preventDefault());
	}

	private async importDropped(files: FileList | undefined, libraryRel: string, folderRel: string): Promise<void> {
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
		const ok = await this.service.importFiles(items, libraryRel, folderRel);
		new Notice(`NyaReader：已导入 ${ok} 本书。`);
		void this.render();
	}

	/** 松手坐标落在哪个文件夹区域。 */
	private folderAt(x: number, y: number): { lib: string; folder: string } | null {
		const el = document.elementFromPoint(x, y);
		const zone = el?.closest?.(".nyareader-shelf-zone") as HTMLElement | null;
		if (!zone) return null;
		const lib = zone.getAttribute("data-lib");
		const folder = zone.getAttribute("data-folder");
		return lib && folder ? { lib, folder } : null;
	}

	/** 松手坐标落在哪个书库项。 */
	private libraryAt(x: number, y: number): string | null {
		const el = document.elementFromPoint(x, y);
		const item = el?.closest?.(".nyareader-library-item") as HTMLElement | null;
		return item?.getAttribute("data-lib") ?? null;
	}

	// ---------- 操作 ----------

	private async selectLibrary(rel: string): Promise<void> {
		if (rel === this.currentLibrary) return;
		this.plugin.settings.bookshelfSelectedLibrary = rel;
		await this.plugin.saveSettings();
		this.currentLibrary = rel;
		void this.render();
	}

	private async createLibrary(): Promise<void> {
		new PromptModal(this.app, {
			title: "新建书库",
			placeholder: "书库名称",
			submitText: "创建",
			onSubmit: async (name) => {
				const ok = await this.service.createLibrary(name);
				if (ok) {
					const order = this.plugin.settings.bookshelfLibraryOrder.filter((x) => x !== name);
					order.push(name);
					this.plugin.settings.bookshelfLibraryOrder = order;
					this.plugin.settings.bookshelfSelectedLibrary = name;
					await this.plugin.saveSettings();
					new Notice(`NyaReader：已创建书库「${name}」。`);
				} else {
					new Notice("NyaReader：创建失败（名称非法或已存在）。");
				}
				void this.render();
			},
		}).open();
	}

	private renameLibrary(rel: string): void {
		new PromptModal(this.app, {
			title: "重命名书库",
			placeholder: "新名称",
			initialValue: rel,
			submitText: "重命名",
			onSubmit: async (name) => {
				const newRel = await this.service.renameLibrary(rel, name);
				if (!newRel) {
					new Notice("NyaReader：重命名失败（名称为空或已存在）。");
					return;
				}
				// 更新索引路径前缀
				const oldPrefix = `${BOOKSHELF_LIBRARY_DIR}/${rel}/`;
				const newPrefix = `${BOOKSHELF_LIBRARY_DIR}/${newRel}/`;
				for (const entry of this.plugin.bookIndex.list()) {
					if (entry.path.startsWith(oldPrefix)) await this.plugin.bookIndex.upsert({ ...entry, path: entry.path.replace(oldPrefix, newPrefix) });
				}
				// 更新顺序 / 覆盖 / 折叠键
				const s = this.plugin.settings;
				s.bookshelfLibraryOrder = s.bookshelfLibraryOrder.map((x) => (x === rel ? newRel : x));
				if (s.bookshelfSelectedLibrary === rel) s.bookshelfSelectedLibrary = newRel;
				const remapKeys = (rec: Record<string, unknown>, out: Record<string, unknown>): void => {
					for (const [k, v] of Object.entries(rec)) out[k.startsWith(`${rel}/`) ? `${newRel}/${k.slice(rel.length + 1)}` : k] = v;
				};
				const modes: Record<string, unknown> = {};
				remapKeys(s.bookshelfModes as unknown as Record<string, unknown>, modes);
				s.bookshelfModes = modes as typeof s.bookshelfModes;
				const collapsed: Record<string, unknown> = {};
				remapKeys(s.bookshelfCollapsed as unknown as Record<string, unknown>, collapsed);
				s.bookshelfCollapsed = collapsed as typeof s.bookshelfCollapsed;
				if (s.bookshelfFolderOrder[rel]) {
					s.bookshelfFolderOrder[newRel] = s.bookshelfFolderOrder[rel];
					delete s.bookshelfFolderOrder[rel];
				}
				await this.plugin.saveSettings();
				new Notice(`NyaReader：书库已重命名为「${newRel}」。`);
				void this.render();
			},
		}).open();
	}

	private async createFolder(): Promise<void> {
		const lib = this.currentLibrary;
		if (!lib) return;
		new PromptModal(this.app, {
			title: "新建文件夹",
			placeholder: "文件夹名称",
			submitText: "创建",
			onSubmit: async (name) => {
				const ok = await this.service.createFolder(lib, name);
				if (ok) {
					const order = (this.plugin.settings.bookshelfFolderOrder[lib] ?? []).filter((x) => x !== name);
					order.push(name);
					this.plugin.settings.bookshelfFolderOrder[lib] = order;
					await this.plugin.saveSettings();
					new Notice(`NyaReader：已创建文件夹「${name}」。`);
				} else {
					new Notice("NyaReader：创建失败（名称非法或已存在）。");
				}
				void this.render();
			},
		}).open();
	}

	private deleteFolder(folderRel: string): void {
		const lib = this.currentLibrary;
		new ConfirmModal(this.app, {
			title: "删除文件夹",
			message: `删除文件夹「${folderRel}」及其中的所有书籍？此操作不可恢复。`,
			confirmText: "删除",
			onConfirm: async () => {
				await this.service.deleteFolder(lib, folderRel);
				const prefix = `${BOOKSHELF_LIBRARY_DIR}/${lib}/${folderRel}/`;
				for (const e of this.plugin.bookIndex.list()) if (e.path.startsWith(prefix)) await this.plugin.bookIndex.remove(e.fingerprint);
				new Notice("NyaReader：已删除文件夹。");
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
				const entry = this.plugin.bookIndex.list().find((e) => e.path === path);
				if (entry) await this.plugin.bookIndex.remove(entry.fingerprint);
				new Notice("NyaReader：已删除。");
				void this.render();
			},
		}).open();
	}

	/** 移动一本书到目标书库/文件夹（含跨库）。 */
	private async moveBook(sourcePath: string, targetLib: string, targetFolder: string): Promise<void> {
		if (!targetLib || !targetFolder) return;
		// 同库同文件夹：无操作
		const parts = sourcePath.split("/");
		if (parts.length >= 5 && parts[2] === targetLib && parts[3] === targetFolder) return;
		try {
			const dest = await this.service.moveBook(sourcePath, targetLib, targetFolder);
			if (!dest) return;
			const entry = this.plugin.bookIndex.list().find((e) => e.path === sourcePath);
			if (entry) await this.plugin.bookIndex.upsert({ ...entry, path: dest });
			new Notice(`NyaReader：已移动。`, 2500);
			void this.render();
		} catch (e) {
			new Notice(`NyaReader：移动失败：${e instanceof Error ? e.message : String(e)}`, 6000);
		}
	}

	// ---------- 排序 ----------

	private orderedLibraries(): BookshelfLibrary[] {
		const order = this.plugin.settings.bookshelfLibraryOrder;
		const byRel = new Map(this.libraries.map((l) => [l.relPath, l]));
		const out: BookshelfLibrary[] = [];
		for (const rel of order) {
			const l = byRel.get(rel);
			if (l) {
				out.push(l);
				byRel.delete(rel);
			}
		}
		const rest = [...byRel.values()].sort((a, b) => a.name.localeCompare(b.name));
		return [...out, ...rest];
	}

	private orderedFolders(lib: string): BookshelfFolder[] {
		const order = this.plugin.settings.bookshelfFolderOrder[lib] ?? [];
		const byRel = new Map(this.folders.map((f) => [f.relPath, f]));
		const out: BookshelfFolder[] = [];
		for (const rel of order) {
			const f = byRel.get(rel);
			if (f) {
				out.push(f);
				byRel.delete(rel);
			}
		}
		const rest = [...byRel.values()].sort((a, b) => a.name.localeCompare(b.name));
		return [...out, ...rest];
	}

	private async reorderLibraries(dragRel: string, targetRel: string): Promise<void> {
		if (dragRel === targetRel) return;
		const list = this.orderedLibraries().map((l) => l.relPath);
		const from = list.indexOf(dragRel);
		const to = list.indexOf(targetRel);
		if (from < 0 || to < 0) return;
		list.splice(from, 1);
		list.splice(to, 0, dragRel);
		this.plugin.settings.bookshelfLibraryOrder = list;
		await this.plugin.saveSettings();
		void this.render();
	}

	private async reorderFolders(dragRel: string, targetRel: string): Promise<void> {
		if (dragRel === targetRel) return;
		const lib = this.currentLibrary;
		const list = this.orderedFolders(lib).map((f) => f.relPath);
		const from = list.indexOf(dragRel);
		const to = list.indexOf(targetRel);
		if (from < 0 || to < 0) return;
		list.splice(from, 1);
		list.splice(to, 0, dragRel);
		this.plugin.settings.bookshelfFolderOrder[lib] = list;
		await this.plugin.saveSettings();
		void this.render();
	}

	// ---------- 模式 / 折叠 ----------

	private folderKey(folderRel: string): string {
		return `${this.currentLibrary}/${folderRel}`;
	}

	private modeFor(key: string): BookshelfDisplayMode {
		return this.plugin.settings.bookshelfModes[key] ?? "full";
	}

	private isCollapsed(key: string): boolean {
		return this.plugin.settings.bookshelfCollapsed[key] === true;
	}

	private async cycleMode(key: string): Promise<void> {
		const order: BookshelfDisplayMode[] = ["full", "compact", "list"];
		const current = this.modeFor(key);
		this.plugin.settings.bookshelfModes[key] = order[(order.indexOf(current) + 1) % order.length];
		await this.plugin.saveSettings();
		void this.render();
	}

	private async toggleCollapse(key: string): Promise<void> {
		this.plugin.settings.bookshelfCollapsed[key] = !this.isCollapsed(key);
		await this.plugin.saveSettings();
		void this.render();
	}

	// ---------- 工具 ----------

	private async openBook(path: string): Promise<void> {
		const f = this.plugin.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.plugin.openBookFile(f);
		else new Notice("NyaReader：文件不存在或已被移动。");
	}

	private async mkdirpParent(filePath: string): Promise<void> {
		const idx = filePath.lastIndexOf("/");
		if (idx <= 0) return;
		await this.vaultMkdirp(filePath.slice(0, idx));
	}

	private async vaultMkdirp(dir: string): Promise<void> {
		const parts = dir.replace(/\/+$/, "").split("/").filter(Boolean);
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			if (!this.plugin.app.vault.getAbstractFileByPath(cur)) {
				await this.plugin.app.vault.createFolder(cur).catch(() => undefined);
			}
		}
	}

	private async uniqueVaultPath(path: string): Promise<string> {
		const { dir, base, ext } = splitPath(path);
		let candidate = path;
		let i = 1;
		while (this.plugin.app.vault.getAbstractFileByPath(candidate)) {
			candidate = `${dir}/${base} (${i})${ext ? `.${ext}` : ""}`;
			i++;
		}
		return candidate;
	}

	private fmtTime(ts: number): string {
		const d = new Date(ts);
		return `${d.getMonth() + 1}月${d.getDate()}日`;
	}
}