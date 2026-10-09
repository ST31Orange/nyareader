/**
 * NyaReader 主入口：插件生命周期、命令、视图注册、设置面板。
 * 只使用 Obsidian 公开稳定 API（个别非公开 API 均做了降级处理）。
 *
 * 翻译：v0.2.0 起委托独立插件 NyaLingo（getPlugin("nyalingo")），
 * 本插件不再内置 Provider / 缓存 / 离线引擎探测，只保留 UI 级目标语言。
 */
import { Notice, Plugin, TFile } from "obsidian";
import { NyaReaderSettings, normalizeSettings } from "./settings";
import { NyaReaderSettingTab } from "./settings-tab";
import { ReaderView, READER_VIEW_TYPE } from "./view/ReaderView";
import { BookshelfView } from "./view/BookshelfView";
import { BOOKSHELF_VIEW_TYPE } from "./view/BookshelfViewTypes";
import { BookIndexService } from "./services/storage/BookIndexService";
import { HistoryStore } from "./services/history/HistoryStore";
import { NyaLingoClient } from "./services/lingo/NyaLingoClient";
import { NyaLingoInstaller } from "./services/lingo/NyaLingoInstaller";
import { BookCoverService } from "./services/books/BookCoverService";
import { formatFromExtension, sniffFormat } from "./services/books/Parser";
import type { BookFormat } from "./types";

const SUPPORTED_EXT = new Set(["epub", "pdf", "mobi", "azw3", "azw", "txt"]);

export default class NyaReaderPlugin extends Plugin {
	settings!: NyaReaderSettings;
	bookIndex!: BookIndexService;
	history!: HistoryStore;
	/** 翻译客户端：委托 NyaLingo 共享翻译服务。 */
	lingo!: NyaLingoClient;
	/** NyaLingo 自动"捎带安装"器。 */
	lingoInstaller!: NyaLingoInstaller;
	/** 书架封面提取与缓存。 */
	cover!: BookCoverService;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.bookIndex = new BookIndexService(this);
		await this.bookIndex.load();
		this.history = new HistoryStore(
			{
				read: (p) => this.app.vault.adapter.read(p),
				write: (p, d) => this.app.vault.adapter.write(p, d),
				mkdir: (p) => this.app.vault.adapter.mkdir(p),
			},
			this.manifest.dir ? `${this.manifest.dir}/` : ""
		);
		await this.history.load();

		this.cover = new BookCoverService(this);

		this.lingoInstaller = new NyaLingoInstaller(this.app);

		this.lingo = new NyaLingoClient({
			app: this.app,
			onMissing: () => new Notice("NyaReader：未检测到 NyaLingo 翻译插件，翻译功能不可用。可运行命令「安装 / 修复 NyaLingo 翻译插件」。", 6000),
		});

		this.registerView(READER_VIEW_TYPE, (leaf) => new ReaderView(leaf, this));
		this.registerView(BOOKSHELF_VIEW_TYPE, (leaf) => new BookshelfView(leaf, this));

		this.addCommand({
			id: "open-bookshelf",
			name: "打开书架…",
			callback: () => void this.activateBookshelf(),
		});

		this.addCommand({
			id: "open-ebook",
			name: "打开电子书…",
			callback: () => void this.pickAndOpenBook(),
		});

		this.addCommand({
			id: "open-lingo-settings",
			name: "打开翻译服务设置…",
			callback: () => this.lingo.openSettingsOrWizard(),
		});

		this.addCommand({
			id: "install-lingo",
			name: "安装 / 修复 NyaLingo 翻译插件",
			callback: () => void this.installLingo(),
		});

		// 桌面端菜单：右键支持格式文件 -> 打开
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile)) return;
				const ext = file.extension.toLowerCase();
				if (SUPPORTED_EXT.has(ext)) {
					menu.addItem((item) =>
						item.setTitle("用 NyaReader 打开").setIcon("book-open").onClick(() => void this.openBookFile(file))
					);
				}
			})
		);

		// 首次使用：若 NyaLingo 未安装则提示一次
		if (!this.settings.translationPromptShown) {
			void this.maybePromptLingo();
		}

		this.addSettingTab(new NyaReaderSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** 弹出系统文件选择器（Obsidian 桌面端公共 API）。 */
	async pickAndOpenBook(): Promise<void> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const adapter = this.app.vault.adapter as any;
		let path = "";
		if (typeof adapter.getFullPath === "function") {
			// 桌面端 DataAdapter 扩展，仅用于预填目录（失败不影响）
			try {
				path = adapter.getFullPath("") as string;
			} catch {
				path = "";
			}
		}
		void path;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const win: any = (this.app as any).workspace.getContainerEl?.().ownerDocument?.defaultView ?? window;
		const input = win.document.createElement("input");
		input.type = "file";
		input.accept = ".epub,.pdf,.mobi,.azw3,.azw,.txt";
		input.multiple = false;
		const file = await new Promise<File | null>((resolve) => {
			input.onchange = () => resolve(input.files?.[0] ?? null);
			input.oncancel = () => resolve(null);
			input.click();
		});
		if (!file) return;
		const buf = await file.arrayBuffer();
		const sniffed = sniffFormat(buf);
		const ext = formatFromExtension(file.name);
		const effective: BookFormat =
			sniffed === "mobi" ? "mobi" : sniffed === "pdf" ? "pdf" : sniffed === "epub" ? "epub" : sniffed === "txt" ? "txt" : ext;
		if (effective === "unknown") {
			new Notice("NyaReader：不支持的电子书格式。");
			return;
		}
		// 复制到当前（或默认）书库的「未分类」文件夹——新模型里书必须放在文件夹里
		const library = this.settings.bookshelfSelectedLibrary || "我的书库";
		const dir = `nyareader/library/${library}/未分类`;
		await this.mkdirpVault(dir);
		const destPath = await this.uniqueBookPath(dir, file.name);
		await this.app.vault.createBinary(destPath, buf);
		const vaultFile = this.app.vault.getAbstractFileByPath(destPath);
		if (vaultFile instanceof TFile) await this.openBookFile(vaultFile);
		else new Notice("NyaReader：文件写入失败。");
	}

	/** 生成不冲突的书架路径：同名文件自动加 (1)、(2)… 后缀，避免覆盖。 */
	private async uniqueBookPath(dir: string, fileName: string): Promise<string> {
		const safe = sanitizeFileName(fileName);
		const dot = safe.lastIndexOf(".");
		const stem = dot > 0 ? safe.slice(0, dot) : safe;
		const ext = dot > 0 ? safe.slice(dot) : "";
		let candidate = `${dir}/${safe}`;
		let i = 1;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = `${dir}/${stem} (${i})${ext}`;
			i++;
		}
		return candidate;
	}

	/** 递归创建 vault 目录。 */
	private async mkdirpVault(dir: string): Promise<void> {
		const parts = dir.split("/").filter(Boolean);
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(cur)) await this.app.vault.createFolder(cur).catch(() => undefined);
		}
	}

	async openBookFile(file: TFile): Promise<void> {
		const ext = file.extension.toLowerCase();
		if (!SUPPORTED_EXT.has(ext)) {
			new Notice("NyaReader：不支持该格式。");
			return;
		}
		// 若已有阅读窗口在看书：新建一个阅读窗口打开，而不是替换原窗口
		const existing = this.app.workspace.getLeavesOfType(READER_VIEW_TYPE);
		const readerWithBook = existing.find((l) => (l.view as ReaderView | undefined)?.hasBook());
		if (readerWithBook) {
			const leaf = this.app.workspace.getLeaf("tab");
			await leaf.setViewState({ type: READER_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
			const view = leaf.view as ReaderView;
			if (view) await view.openBook(file);
			return;
		}
		// 没有阅读窗口或窗口空着：复用/新建一个
		await this.activateReader();
		const view = this.app.workspace.getLeavesOfType(READER_VIEW_TYPE)[0]?.view as ReaderView | undefined;
		if (view) await view.openBook(file);
	}

	/** 打开书架主页（工作模式 A：书架 -> 点书 -> 阅读）。 */
	async activateBookshelf(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(BOOKSHELF_VIEW_TYPE)[0];
		if (existing) {
			this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: BOOKSHELF_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	async activateReader(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(READER_VIEW_TYPE)[0];
		if (existing) {
			this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: READER_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	/** 打开本插件设置界面（书架设置按钮用）。 */
	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
		setting?.open?.();
		window.setTimeout(() => setting?.openTabById?.("nyareader"), 60);
	}

	/** 首次运行：NyaLingo 未安装时自动"捎带安装"（失败则提示手动安装）。 */
	private async maybePromptLingo(): Promise<void> {
		this.settings.translationPromptShown = true;
		await this.saveSettings();
		if (this.lingo.isAvailable()) return;
		await this.installLingo();
	}

	/**
	 * 安装 / 修复 NyaLingo：已加载则打开设置；否则尝试从 GitHub 自动下载安装，
	 * 并登记进 community-plugins.json，重载后自动启用。
	 */
	async installLingo(): Promise<void> {
		if (this.lingo.isAvailable()) {
			this.lingo.openSettingsOrWizard();
			return;
		}
		const result = await this.lingoInstaller.ensureInstalled(false);
		switch (result.status) {
			case "installed-needs-reload":
				new Notice("NyaReader：已自动安装 NyaLingo 翻译插件，请重载 Obsidian（Ctrl+R）后即可使用翻译。", 9000);
				break;
			case "enable-needed":
				new Notice("NyaReader：已检测到 NyaLingo，请在「设置 → 第三方插件」中启用它，然后重载 Obsidian。", 8000);
				break;
			case "failed":
				new Notice(`NyaReader：NyaLingo 自动安装失败（${result.reason}）。可重试本命令，或手动安装（GitHub: ST31Orange/nyalingo）。`, 9000);
				break;
			default:
				break;
		}
	}
}

/** 文件名清理：防止路径穿越。 */
function sanitizeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "_");
}
