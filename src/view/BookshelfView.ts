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
import { BOOKSHELF_MODE_LABEL, BookshelfDisplayMode, DEFAULT_BOOKSHELF_DIR } from "../settings";
import readerIcon from "../assets/reader.png";
import { parseVaultDropPaths, opensInNativeEditor } from "../utils/drop-paths";

const SORT_OPTIONS: Array<{ value: BookshelfSort; label: string }> = [
	{ value: "recent", label: "最近阅读" },
	{ value: "title", label: "书名" },
	{ value: "progress", label: "阅读进度" },
];

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
	/** 刚刚结束了一次拖动：用于吞掉浏览器补发的那次 click（否则松手就会打开书） */
	private dragJustEnded = false;

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

	/** 当前书架根目录（可在设置里迁移），默认 nyareader/library。 */
	private get shelfDir(): string {
		return this.plugin.settings.bookshelfDir || DEFAULT_BOOKSHELF_DIR;
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
			this.shelfDir,
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
		// 阅读页写进度后，书架常常已经打开着（只是不可见）。切回书架时**就地刷新进度**，
		// 避免"两边进度不一样"（数据本身是同步的，缺的是视图刷新）。
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view === this) this.syncProgressFromIndex();
			})
		);
		this.registerEvent(this.app.workspace.on("layout-change", () => this.syncProgressFromIndex()));
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
			const root = this.plugin.app.vault.getAbstractFileByPath(this.shelfDir);
			if (root instanceof TFolder) {
				const legacyFolders = root.children.filter((c): c is TFolder => c instanceof TFolder && c.name !== DEFAULT_LIBRARY);
				const legacyFiles = root.children.filter((c): c is TFile => c instanceof TFile);
				if (legacyFolders.length || legacyFiles.length) {
					const defLibPath = `${this.shelfDir}/${DEFAULT_LIBRARY}`;
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
						if (!p.startsWith(`${this.shelfDir}/`)) continue;
						const rest = p.slice(this.shelfDir.length + 1);
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

	/**
	 * 从 bookIndex 就地刷新已渲染卡片的进度（不重建 DOM）。
	 *
	 * 为什么需要：`render()` 只在打开视图/切换排序时执行，而进度是阅读页在**另一个视图**里
	 * 持续写入 index 的；书架保持打开但不可见时不会自动重画，于是"两边进度不一样"。
	 * 这里只改进度条宽度与百分比文字，不动其它 DOM，因此不会丢滚动位置、不闪烁。
	 */
	private syncProgressFromIndex(): void {
		if (!this.rootEl?.isConnected) return;
		const progressOf = (path: string): number | undefined =>
			this.plugin.bookIndex.list().find((e) => e.path === path)?.progress?.percentage;
		// 卡片视图（full / compact）：进度条 + 元信息百分比
		for (const card of Array.from(this.rootEl.querySelectorAll<HTMLElement>(".nyareader-shelf-card[data-path]"))) {
			const path = card.dataset.path;
			if (!path) continue;
			const pct = progressOf(path);
			if (pct === undefined) continue;
			const width = `${Math.round(pct * 100)}%`;
			const bar = card.querySelector<HTMLElement>(".nyareader-shelf-progress-bar");
			if (bar) bar.style.width = width;
			const metaText = card.querySelector<HTMLElement>(".nyareader-shelf-card-meta-text");
			if (metaText) {
				const entry = this.plugin.bookIndex.list().find((e) => e.path === path);
				metaText.setText(`${Math.round(pct * 100)}%${entry?.lastOpenedAt ? ` · ${this.fmtTime(entry.lastOpenedAt)}` : ""}`);
			}
		}
		// 列表视图：右侧百分比
		for (const row of Array.from(this.rootEl.querySelectorAll<HTMLElement>(".nyareader-shelf-list-row[data-path]"))) {
			const path = row.dataset.path;
			if (!path) continue;
			const pct = progressOf(path);
			if (pct === undefined) continue;
			const span = row.querySelector<HTMLElement>(".nyareader-shelf-list-pct");
			if (span) span.setText(`${Math.round(pct * 100)}%`);
		}
	}

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
		// 排序控件放在"当前书库"这一行：它作用于书库内的书，与书库区对齐（用户要求从顶部挪下来）
		// 排序与「＋新建文件夹」包成**一组**并整体靠右：若两者各自用 auto margin，
		// 浏览器的 flex 会把剩余空间**平分**，排序控件就停在中间（用户反馈"没有靠右"）。
		const rightGroup = bar.createDiv({ cls: "nyareader-shelf-main-actions" });
		const sortWrap = rightGroup.createEl("label", { cls: "nyareader-shelf-sort-wrap" });
		sortWrap.createSpan({ cls: "nyareader-shelf-sort-label", text: "排序" });
		const sel = sortWrap.createEl("select", { cls: "nyareader-shelf-sort", attr: { "aria-label": "书架排序方式" } });
		for (const o of SORT_OPTIONS) sel.createEl("option", { value: o.value, text: o.label });
		sel.value = this.sort;
		sel.addEventListener("change", () => {
			this.sort = sel.value as BookshelfSort;
			void this.render();
		});
		rightGroup
			.createEl("button", { text: "＋ 新建文件夹", cls: "nyareader-shelf-btn" })
			.addEventListener("click", () => void this.createFolder());

		// 只有文件夹区域滚动，标题行与新建按钮固定
		const scroll = main.createDiv({ cls: "nyareader-shelf-main-scroll" });
		const folders = this.orderedFolders(this.currentLibrary);
		if (!folders.length) {
			scroll.createDiv({ cls: "nyareader-shelf-empty", text: "这个书库还没有文件夹。\n点「＋ 新建文件夹」，再把电子书拖进去。" });
			return;
		}
		const grid = scroll.createDiv({ cls: "nyareader-shelf-grid" });
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
		// 供 syncProgressFromIndex() 就地刷新进度（不重建 DOM）
		card.setAttribute("data-path", path);
		card.addEventListener("click", () => {
			// 拖动后浏览器可能仍补一次 click → 会"松手就打开书"。拖动过就忽略这次 click。
			if (this.dragJustEnded) {
				this.dragJustEnded = false;
				return;
			}
			void this.openBook(path);
		});
		card.setAttribute("draggable", "true");
		card.addEventListener("dragstart", (e) => {
			this.draggingBookPath = path;
			this.dragJustEnded = false;
			const dt = e.dataTransfer;
			if (dt) {
				// 内部拖动：我们自己的 MIME（书架内移动）
				dt.setData("application/x-nyareader-book", path);
				// **拖出到 Obsidian 左侧文件列表**：Obsidian 的文件树按"vault 路径"
				// 处理外部拖入，所以这里必须给纯路径（text/plain），不要包 JSON。
				dt.setData("text/plain", path);
				// 常见编辑器/文件树还认 uri-list（同样给相对路径，避免被当成外部 URL）
				try {
					dt.setData("text/uri-list", path);
				} catch {
					/* 某些环境不支持该类型，忽略 */
				}
				dt.effectAllowed = "copyMove";
			}
			card.addClass("is-dragging");
		});
		card.addEventListener("dragend", (e) => {
			card.removeClass("is-dragging");
			// 标记"刚拖动过"，让紧随其后的 click 不打开书（拖出去移动/拖回书架都不该打开）
			this.dragJustEnded = true;
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
			row.setAttribute("data-path", path);
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
				void this.plugin.cover
					.getCoverUrl(file, entry?.fingerprint)
					.then((url) => {
						if (!url || !cover.isConnected) return;
						placeholder.remove();
						// 不加 loading="lazy"：卡片是一次性渲染的，某些布局/虚拟滚动下
						// 懒加载可能永远不触发，表现就是"封面随机不显示"。
						const img = cover.createEl("img", { attr: { src: url, alt: "" } });
						img.addClass("nyareader-shelf-cover-img");
						// 兜底：万一 URL 失效/解码失败，恢复占位而不是留白
						img.addEventListener(
							"error",
							() => {
								img.remove();
								if (!cover.querySelector(".nyareader-shelf-cover-placeholder")) {
									const fallback = cover.createDiv({ cls: "nyareader-shelf-cover-placeholder" });
									setIcon(fallback, "book-open");
								}
							},
							{ once: true }
						);
					})
					.catch((e) => {
						// 封面失败不能影响书架渲染：记录并保留占位
						console.warn("NyaReader: 封面加载失败", path, e);
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
			const dt = e.dataTransfer;
			// 我们自己的内部拖动（文件夹排序 / 书移动）：优先，语义是"移动"，不走收书
			const folderDrag = dt?.getData("application/x-nyareader-folder") || this.draggingFolder || "";
			if (folderDrag) {
				this.draggingFolder = null;
				this.dropHandled = true;
				if (folderDrag !== folderRel && libraryRel === this.currentLibrary) void this.reorderFolders(folderDrag, folderRel);
				return;
			}
			const bookPath = dt?.getData("application/x-nyareader-book") || this.draggingBookPath || "";
			if (bookPath) {
				this.draggingBookPath = null;
				this.dropHandled = true;
				void this.moveBook(bookPath, libraryRel, folderRel);
				return;
			}
			// 系统文件管理器拖入：有 files，按二进制导入
			if (dt?.files?.length) {
				void this.importDropped(dt.files, libraryRel, folderRel);
				return;
			}
			// Obsidian 文件栏拖入：**不通过 files**，要把 vault 里已有的书收进书库
			void this.importFromVaultDrop(dt, libraryRel, folderRel);
		});
	}

	/**
	 * 从 Obsidian 文件栏拖进来的书 → 收进书库（**移动**语义）。
	 *
	 * Obsidian 没有公开它内部拖放的载荷格式，所以用 {@link parseVaultDropPaths}
	 * 兼容多种形态（text/plain 路径、JSON、自定义 MIME），并用 vault 校验兜底 ——
	 * 只有"确实存在且是电子书"的候选才会被处理，绝不会误搬无关文件。
	 */
	private async importFromVaultDrop(dt: DataTransfer | null, libraryRel: string, folderRel: string): Promise<void> {
		if (!dt) return;
		const byType: Record<string, string | undefined> = {};
		const types = Array.from(dt.types ?? []);
		for (const type of types) {
			try {
				byType[type] = dt.getData(type);
			} catch {
				byType[type] = undefined;
			}
		}
		// 真实载荷打进控制台：万一遇到没覆盖的格式，一眼就能看出它长什么样
		console.debug("[NyaReader] 拖放载荷", { types, byType });
		const vault = this.plugin.app.vault;
		const candidates = parseVaultDropPaths({ byType, types }, (p) => vault.getAbstractFileByPath(p) instanceof TFile);
		if (!candidates.length) {
			new Notice("NyaReader：没识别到可导入的电子书（支持 epub/pdf/mobi/azw3/txt）。", 5000);
			return;
		}
		const { imported, results } = await this.service.importVaultBooks(candidates, libraryRel, folderRel, "move");
		if (!imported) {
			const why = results.find((r) => r.error)?.error;
			new Notice(`NyaReader：没有导入任何书${why ? `（${why}）` : ""}。`, 5000);
			return;
		}
		void this.render();
		new Notice(`NyaReader：已收进书库 ${imported} 本。`, 4000);
	}

	private attachRootDragFallback(): void {
		// 书架根节点：拖到空白处不做事，但要 preventDefault 才能收到 drop（避免浏览器直接打开文件）
		this.rootEl.addEventListener("dragover", (e) => e.preventDefault());
		this.rootEl.addEventListener("drop", (e) => {
			e.preventDefault();
			const dt = e.dataTransfer;
			// 空白处放下：落到当前书库的「未分类」文件夹（这是最符合直觉的默认去处）
			if (this.draggingBookPath || dt?.getData("application/x-nyareader-book")) {
				const book = dt?.getData("application/x-nyareader-book") || this.draggingBookPath || "";
				this.draggingBookPath = null;
				if (book && !this.dropHandled) {
					void this.moveBook(book, this.currentLibrary, this.defaultFolderFor(this.currentLibrary));
				}
				return;
			}
			if (dt?.files?.length) {
				void this.importDropped(dt.files, this.currentLibrary, this.defaultFolderFor(this.currentLibrary));
				return;
			}
			void this.importFromVaultDrop(dt, this.currentLibrary, this.defaultFolderFor(this.currentLibrary));
		});
	}

	/** 空白处放下时的默认文件夹：优先「未分类」，否则第一个文件夹，都没有就新建一个。 */
	private defaultFolderFor(libraryRel: string): string {
		const folders = this.orderedFolders(libraryRel);
		const existing = folders.find((f) => f.relPath === "未分类") ?? folders[0];
		return existing?.relPath ?? "未分类";
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
				const oldPrefix = `${this.shelfDir}/${rel}/`;
				const newPrefix = `${this.shelfDir}/${newRel}/`;
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
				const prefix = `${this.shelfDir}/${lib}/${folderRel}/`;
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

	/**
	 * 点开书架上的条目。
	 *
	 * **Markdown 走 Obsidian 原生页面**（用户明确要求）：不进阅读器，
	 * 用原生笔记视图打开，编辑体验与平时完全一致。
	 * 其它格式仍走阅读器。
	 */
	private async openBook(path: string): Promise<void> {
		const f = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) {
			new Notice("NyaReader：文件不存在或已被移动。");
			return;
		}
		if (opensInNativeEditor(path)) {
			const leaf = this.app.workspace.getLeaf("tab");
			await leaf.openFile(f);
			this.app.workspace.revealLeaf(leaf);
			return;
		}
		await this.plugin.openBookFile(f);	}

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