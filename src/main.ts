/**
 * NyaReader 主入口：插件生命周期、命令、视图注册、设置面板。
 * 只使用 Obsidian 公开稳定 API（个别非公开 API 均做了降级处理）。
 */
import { Modal, Notice, Plugin, TFile, Setting } from "obsidian";
import { NyaReaderSettings, normalizeSettings } from "./settings";
import { NyaReaderSettingTab } from "./settings-tab";
import { ReaderView, READER_VIEW_TYPE } from "./view/ReaderView";
import { BookIndexService } from "./services/storage/BookIndexService";
import { HistoryStore } from "./services/history/HistoryStore";
import { obsidianHttpTransport } from "./utils/http";
import { isOnline } from "./utils/network";
import { TranslationService } from "./services/translation/TranslationService";
import { formatFromExtension, sniffFormat } from "./services/books/Parser";
import type { BookFormat } from "./types";

const SUPPORTED_EXT = new Set(["epub", "pdf", "mobi", "azw3", "azw", "txt"]);

export default class NyaReaderPlugin extends Plugin {
	settings!: NyaReaderSettings;
	bookIndex!: BookIndexService;
	history!: HistoryStore;
	translation!: TranslationService;

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
			this.manifest.dir ?? ""
		);
		await this.history.load();

		this.translation = new TranslationService({
			config: () => this.settings.translation,
			http: obsidianHttpTransport,
			history: this.history,
			persistentCacheStore: {
				load: async () => {
					try {
						const raw = await this.app.vault.adapter.read(`${this.manifest.dir ?? ""}nyareader-translation-cache.json`.replace(/\/+/g, "/"));
						return JSON.parse(raw) as Record<string, string>;
					} catch {
						return {};
					}
				},
				save: async (data: Record<string, string>) => {
					await this.app.vault.adapter.write(`${this.manifest.dir ?? ""}nyareader-translation-cache.json`.replace(/\/+/g, "/"), JSON.stringify(data));
				},
			},
		});
		await this.translation.initialize();

		this.registerView(READER_VIEW_TYPE, (leaf) => new ReaderView(leaf, this));

		this.addCommand({
			id: "open-ebook",
			name: "打开电子书…",
			callback: () => void this.pickAndOpenBook(),
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

		// 首次使用：翻译离线引擎引导
		if (!this.settings.translationOfflinePromptShown) {
			void this.maybePromptOfflineTranslation();
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
		// 复制到 vault（插件数据目录下的 library），保证后续按 vault 路径读写与批注
		const dir = `${this.manifest.dir ?? ""}library/`;
		const destPath = `${dir}${sanitizeFileName(file.name)}`;
		await this.app.vault.adapter.mkdir(dir).catch(() => undefined);
		await this.app.vault.adapter.writeBinary(destPath, buf);
		const vaultFile = this.app.vault.getAbstractFileByPath(destPath);
		if (vaultFile instanceof TFile) await this.openBookFile(vaultFile);
		else new Notice("NyaReader：文件写入失败。");
	}

	async openBookFile(file: TFile): Promise<void> {
		const ext = file.extension.toLowerCase();
		if (!SUPPORTED_EXT.has(ext)) {
			new Notice("NyaReader：不支持该格式。");
			return;
		}
		await this.activateReader();
		const view = this.app.workspace.getLeavesOfType(READER_VIEW_TYPE)[0]?.view as ReaderView | undefined;
		if (view) await view.openBook(file);
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

	/** 首次运行引导：无离线翻译引擎且有网络时，弹窗提示安装方式。 */
	private async maybePromptOfflineTranslation(): Promise<void> {
		this.settings.translationOfflinePromptShown = true;
		await this.saveSettings();
		if (this.settings.translation.mode === "online") return;
		if (this.settings.translation.offlineEndpoint.trim()) return;
		const online = await isOnline();
		if (online) new OfflineTranslationGuideModal(this.app).open();
	}
}

/** 离线翻译引擎安装引导对话框。 */
class OfflineTranslationGuideModal extends Modal {
	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "NyaReader — 翻译引擎" });
		contentEl.createEl("p", {
			text: "检测到你尚未安装离线翻译引擎（如 MTranServer）。离线翻译可完全本地运行、保护隐私。",
		});
		contentEl.createEl("p", {
			text: "两种方式任选：\n• 前往「设置 → 第三方插件 → NyaReader → 翻译」配置在线翻译（OpenAI 兼容 / DeepL）；\n• 按 MTranServer 官方文档在本机部署离线引擎后，在设置中填写其地址（如 http://127.0.0.1:8989）。",
		});
		new Setting(contentEl).addButton((b) =>
			b.setButtonText("稍后再说").onClick(() => this.close())
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 文件名清理：防止路径穿越。 */
function sanitizeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "_");
}


