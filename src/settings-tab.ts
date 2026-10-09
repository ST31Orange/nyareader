/**
 * NyaReader 设置面板。
 * 翻译区（v0.2.0）：引擎配置委托独立插件 NyaLingo 一份，
 * 本面板只负责：目标语言（UI 级）、NyaLingo 安装状态、跳转/向导、测试连接、清缓存。
 */
import { App, Notice, PluginSettingTab, Setting, TFolder } from "obsidian";
import type NyaReaderPlugin from "./main";
import { ConfirmModal } from "./view/components/ConfirmModal";
import { PromptModal } from "./view/components/PromptModal";
import alipayIcon from "./assets/donate-alipay.jpg";
import wechatIcon from "./assets/donate-wechat.jpg";

import { DEFAULT_BOOKSHELF_DIR } from "./settings";
import {
	DEFAULT_FINGERPRINT_SIDECAR_DIR,
	annotationDirForBookshelf,
	bookshelfAnchor,
	setAnnotationSidecarDir,
} from "./utils/annotation-sidecar-path";
import { planBookshelfMigration } from "./utils/migration-plan";

export class NyaReaderSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: NyaReaderPlugin
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "NyaReader 设置" });
		containerEl.createEl("p", {
			cls: "nyareader-settings-intro",
			text: "NyaReader 是一个开箱即用的本地电子书阅读器，支持 EPUB / PDF / MOBI / AZW3 / TXT。书架管理、分页/滚动与单页/双页阅读、主题与版式调节、划词翻译（NyaLingo）和高亮批注都包含在内，所有数据都保存在你自己的库里。",
		});

		// ---------- 阅读 ----------
		containerEl.createEl("h3", { text: "阅读" });
		new Setting(containerEl).setName("默认主题").setDesc("日间 / 夜间 / 护眼").addDropdown((d) => {
			d.addOptions({ light: "日间", dark: "夜间", sepia: "护眼" })
				.setValue(this.plugin.settings.reader.theme)
				.onChange(async (v) => {
					this.plugin.settings.reader.theme = v as "light" | "dark" | "sepia";
					await this.plugin.saveSettings();
				});
		});
		new Setting(containerEl).setName("默认字体大小").addSlider((s) => {
			s.setLimits(10, 40, 1)
				.setValue(this.plugin.settings.reader.fontSize)
				.setDynamicTooltip()
				.onChange(async (v) => {
					this.plugin.settings.reader.fontSize = v;
					await this.plugin.saveSettings();
				});
		});
		new Setting(containerEl).setName("默认行距").addSlider((s) => {
			s.setLimits(1.2, 3, 0.1)
				.setValue(this.plugin.settings.reader.lineHeight)
				.setDynamicTooltip()
				.onChange(async (v) => {
					this.plugin.settings.reader.lineHeight = v;
					await this.plugin.saveSettings();
				});
		});
		new Setting(containerEl).setName("默认版式").setDesc("单页 / 双页（对开，适用于 EPUB/MOBI/AZW3）").addDropdown((d) => {
			d.addOptions({ single: "单页", double: "双页" })
				.setValue(this.plugin.settings.reader.layout)
				.onChange(async (v) => {
					this.plugin.settings.reader.layout = v as "single" | "double";
					await this.plugin.saveSettings();
				});
		});

		// 默认翻页方式：滚动（连续滚）还是分页（一页一页翻）
		new Setting(containerEl)
			.setName("默认翻页方式")
			.setDesc(
				"新打开的书的默认阅读方式：滚动 = 连续向下滚；分页 = 一页一页翻。" +
					"（单页/双页只对「分页」生效；阅读时用标题栏按钮切换会记到那一本书上，不受此默认影响）"
			)
			.addDropdown((d) => {
				d.addOptions({ paged: "分页（一页一页翻）", scroll: "滚动（连续向下滚）" })
					.setValue(this.plugin.settings.reader.scrollMode === true ? "scroll" : "paged")
					.onChange(async (v) => {
						this.plugin.settings.reader.scrollMode = v === "scroll";
						await this.plugin.saveSettings();
					});
			});

		// ---------- 书库管理（删除书库放在设置里） ----------
		containerEl.createEl("h3", { text: "书库管理" });
		const shelfDir = this.plugin.settings.bookshelfDir || DEFAULT_BOOKSHELF_DIR;
		const annotationDir = this.plugin.settings.annotationDir || DEFAULT_FINGERPRINT_SIDECAR_DIR;
		// 让用户只输入**上级目录**（如 nyareader），而不是 library/newlib 这种子目录
		const anchor = bookshelfAnchor(shelfDir, annotationDir);
		new Setting(containerEl)
			.setName("迁移位置")
			.setDesc(
				`当前目录：${anchor}（书库在 ${shelfDir}，批注在 ${annotationDir}）。` +
					`迁移时只填**上级目录**，例如 nyareader；程序会把 library 与 annotations 一起搬过去。` +
					`目标目录可以是空文件夹，也可以不存在（会自动创建）。`
			)
			.addButton((b) =>
				b.setButtonText("迁移…").onClick(() => {
					new PromptModal(this.app, {
						title: "迁移 NyaReader 目录",
						placeholder: "上级目录，例如 nyareader",
						initialValue: anchor,
						submitText: "迁移",
						onSubmit: async (value) => {
							await this.migrateBookshelf(value);
						},
					}).open();
				})
			);
		const shelfRoot = this.plugin.app.vault.getAbstractFileByPath(shelfDir);
		const libraries = shelfRoot instanceof TFolder ? shelfRoot.children.filter((c): c is TFolder => c instanceof TFolder) : [];
		if (!libraries.length) {
			containerEl.createEl("p", { cls: "nyareader-hint", text: "还没有书库。可在书架页用「＋ 新建书库」创建。" });
		}
		for (const lib of libraries) {
			new Setting(containerEl)
				.setName(lib.name)
				.setDesc("删除该书库及其中的所有文件夹与书（不可恢复）")
				.addButton((b) =>
					b.setButtonText("删除").setWarning().onClick(() => {
						new ConfirmModal(this.app, {
							title: "删除书库",
							message: `删除书库「${lib.name}」及其中的所有文件夹与书籍？此操作不可恢复。`,
							confirmText: "删除",
							onConfirm: async () => {
								await this.plugin.app.vault.delete(lib, true);
								const prefix = `${lib.path}/`;
								for (const e of this.plugin.bookIndex.list()) {
									if (e.path.startsWith(prefix)) await this.plugin.bookIndex.remove(e.fingerprint);
								}
								const st = this.plugin.settings;
								st.bookshelfLibraryOrder = st.bookshelfLibraryOrder.filter((x) => x !== lib.name);
								delete st.bookshelfFolderOrder[lib.name];
								if (st.bookshelfSelectedLibrary === lib.name) st.bookshelfSelectedLibrary = "";
								await this.plugin.saveSettings();
								new Notice(`NyaReader：已删除书库「${lib.name}」。`);
								this.display();
							},
						}).open();
					})
				);
		}

		// ---------- 翻译（委托 NyaLingo） ----------
		containerEl.createEl("h3", { text: "翻译" });
		containerEl.createEl("p", {
			cls: "nyareader-hint",
			text: "翻译引擎由独立插件 NyaLingo 提供（离线 MTranServer / 在线 OpenAI·DeepL），这里只设置阅读器侧的目标语言与入口。",
		});

		new Setting(containerEl).setName("目标语言").setDesc("默认中英互译（译文语言）").addDropdown((d) => {
			d.addOptions({
				"zh-Hans": "简体中文",
				"zh-Hant": "繁體中文",
				en: "English",
				ja: "日本語",
				ko: "한국어",
				fr: "Français",
				de: "Deutsch",
				es: "Español",
				ru: "Русский",
			})
				.setValue(this.plugin.settings.translation.targetLanguage)
				.onChange(async (v) => {
					this.plugin.settings.translation.targetLanguage = v;
					await this.plugin.saveSettings();
				});
		});

		// 状态：NyaLingo 是否已安装启用
		const available = this.plugin.lingo.isAvailable();
		new Setting(containerEl)
			.setName("NyaLingo 翻译服务")
			.setDesc(available ? "已安装并启用 ✅" : "未检测到 NyaLingo 插件，翻译不可用。点击右侧自动下载安装 NyaLingo（需网络，装好后重载）。")
			.addButton((b) =>
				b.setButtonText(available ? "打开 NyaLingo 设置" : "安装 / 修复 NyaLingo").setCta().onClick(() => {
					void this.plugin.installLingo();
				})
			);

		if (available) {
			new Setting(containerEl)
				.setName("测试翻译连接")
				.setDesc("发送一条测试请求验证引擎可用")
				.addButton((b) =>
					b.setButtonText("测试").onClick(async () => {
						b.setDisabled(true);
						b.setButtonText("测试中…");
						const r = await this.plugin.lingo.testConnection();
						b.setDisabled(false);
						b.setButtonText("测试");
						new Notice(r.ok ? "NyaReader：翻译连接正常 ✅" : `NyaReader：${r.detail ?? "连接失败"}`, 6000);
					})
				);
			new Setting(containerEl)
				.setName("清空翻译缓存")
				.addButton((b) =>
					b.setButtonText("清空").setWarning().onClick(async () => {
						await this.plugin.lingo.clearCache();
						new Notice("NyaReader：翻译缓存已清空。");
					})
				);
		}

		// ---------- 支持与反馈 ----------
		containerEl.createEl("h3", { text: "支持我们" });
		containerEl.createEl("p", { cls: "nyareader-hint", text: "如果 NyaReader 对你有帮助，欢迎打赏支持作者；你的支持会用于后续维护、修 bug 和适配新功能。" });
		const donateRow = containerEl.createDiv({ cls: "nyareader-donate-row" });
		const mkDonate = (img: string, label: string): void => {
			const box = donateRow.createDiv({ cls: "nyareader-donate-box" });
			box.createEl("img", { attr: { src: img, alt: label } });
			box.createEl("span", { text: label });
		};
		mkDonate(alipayIcon, "支付宝");
		mkDonate(wechatIcon, "微信");

		containerEl.createEl("h3", { text: "反馈" });
		const feedback = containerEl.createDiv({ cls: "nyareader-feedback" });
		feedback.innerHTML = `如果您在使用过程中遇到任何问题，或有任何意见与建议，欢迎发送邮件至 <a href="mailto:nyaspace@163.com">nyaspace@163.com</a> 进行反馈。请在邮件中尽量附上问题描述、复现步骤及相关截图，以便我们更快定位和处理。感谢您的支持与反馈！`;
	}

	/** 递归创建 vault 目录（迁移书架位置用）。 */
	private async mkdirpVault(dir: string): Promise<void> {
		const parts = dir.split("/").filter(Boolean);
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			if (!this.plugin.app.vault.getAbstractFileByPath(cur)) await this.plugin.app.vault.createFolder(cur).catch(() => undefined);
		}
	}

	/**
	 * 迁移 NyaReader 目录。
	 *
	 * **用户期望的语义**：只填/选一个**上级目录**（如 `nyareader`），
	 * 程序把 `library` 与 `annotations` 一起搬进它。
	 *
	 * 之前两个问题（用户实测）：
	 * 1. 只搬 `library`，`annotations` 留在原地 → 批注"消失"；
	 * 2. **先把目标目录建出来、再往里 rename 整个上级目录** → Obsidian 直接报
	 *    `Destination file already exists`（目标已存在就无法整体改名）。
	 *
	 * 现在的做法：
	 * - 目标上级目录**已存在** → 把 `library` / `annotations` 两个子目录**分别移进去**
	 *   （走 DataAdapter.rename，绕开"目标必须不存在"的限制）；
	 * - 目标上级目录**不存在** → 直接整体重命名上级目录（一次搬完，最快）；
	 * - 只允许"目标本身为空或不存在"，避免与已有文件混住。
	 */
	private async migrateBookshelf(rawTarget: string): Promise<void> {
		const app = this.plugin.app;
		const adapter = app.vault.adapter;
		const oldShelf = this.plugin.settings.bookshelfDir || DEFAULT_BOOKSHELF_DIR;
		const oldAnnotations = this.plugin.settings.annotationDir || annotationDirForBookshelf(oldShelf);
		const oldParent = bookshelfAnchor(oldShelf, oldAnnotations);

		// 决策交给纯函数（可单测）：错误原因、目标路径、采用哪种搬法
		const plan = planBookshelfMigration({
			bookshelfDir: oldShelf,
			annotationDir: oldAnnotations,
			rawTarget,
			targetState: this.describeTarget(rawTarget.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/(library|annotations)$/i, "")),
			shelfExists: app.vault.getAbstractFileByPath(oldShelf) instanceof TFolder,
		});
		if (plan.error || !plan.anchor || !plan.newShelfDir || !plan.newAnnDir) {
			if (plan.error) new Notice(`NyaReader：${plan.error}`, 8000);
			return;
		}
		const { anchor, newShelfDir, newAnnDir } = plan;

		try {
			await this.mkdirpVault(anchor);
			// 路径 A：整体重命名上级目录（只有目标**原本不存在**时才可行；
			// 先建目录再 rename 就是用户遇到的 Destination file already exists）
			if (plan.strategy === "whole-parent") {
				const parentFolder = app.vault.getAbstractFileByPath(oldParent);
				if (parentFolder instanceof TFolder) {
					await app.vault.rename(parentFolder, anchor);
					await this.finishMigration(oldShelf, newShelfDir, oldAnnotations, newAnnDir, true, anchor);
					return;
				}
			}
			// 路径 B：把 library / annotations 分别移进目标目录
			// （走 DataAdapter.rename，绕开 vault.rename "目标必须不存在"的限制）
			const shelfFolder = app.vault.getAbstractFileByPath(oldShelf);
			if (!(shelfFolder instanceof TFolder)) {
				new Notice("NyaReader：找不到当前书库目录，未做任何改动。");
				return;
			}
			await adapter.rename(oldShelf, newShelfDir);
			let annotationsMoved = true;
			const annFolder = app.vault.getAbstractFileByPath(oldAnnotations);
			if (annFolder instanceof TFolder) {
				try {
					await adapter.rename(oldAnnotations, newAnnDir);
				} catch {
					annotationsMoved = false;
				}
			}
			await this.finishMigration(oldShelf, newShelfDir, oldAnnotations, newAnnDir, annotationsMoved, anchor);
		} catch (e) {
			new Notice(`NyaReader：迁移失败：${e instanceof Error ? e.message : String(e)}`, 8000);
		}
	}

	/** 目标目录的当前状态（供迁移决策使用）。 */
	private describeTarget(dir: string): "missing" | "empty-folder" | "non-empty-folder" | "file" {
		const cleaned = dir.replace(/\/+$/, "");
		if (!cleaned) return "missing";
		const f = this.plugin.app.vault.getAbstractFileByPath(cleaned);
		if (!f) return "missing";
		if (!(f instanceof TFolder)) return "file";
		return f.children.length === 0 ? "empty-folder" : "non-empty-folder";
	}

	/**
	 * 迁移收尾：更新设置 + 阅读进度索引路径 + 批注目录注入。
	 *
	 * @param annotationsMoved 批注目录是否确实搬走了（没搬走就保持原路径，批注仍可用）
	 */
	private async finishMigration(
		oldShelf: string,
		newShelf: string,
		oldAnnotations: string,
		newAnnotations: string,
		annotationsMoved: boolean,
		anchorDir: string
	): Promise<void> {
		// 阅读进度索引里的书路径也要跟着改，否则"进度全部丢失"
		const oldPrefix = `${oldShelf}/`;
		const newPrefix = `${newShelf}/`;
		for (const e of this.plugin.bookIndex.list()) {
			if (e.path.startsWith(oldPrefix)) await this.plugin.bookIndex.upsert({ ...e, path: e.path.replace(oldPrefix, newPrefix) });
		}
		this.plugin.settings.bookshelfDir = newShelf;
		this.plugin.settings.annotationDir = annotationsMoved ? newAnnotations : oldAnnotations;
		setAnnotationSidecarDir(this.plugin.settings.annotationDir);
		await this.plugin.saveSettings();
		new Notice(
			annotationsMoved
				? `NyaReader：已迁移到「${anchorDir}」（library 与 annotations 一并搬走）。`
				: `NyaReader：书库已迁移到「${newShelf}」，但批注目录未能搬迁，仍留在「${oldAnnotations}」。`,
			8000
		);
		this.display();
	}
}
