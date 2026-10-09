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

		// ---------- 书库管理（删除书库放在设置里） ----------
		containerEl.createEl("h3", { text: "书库管理" });
		const shelfDir = this.plugin.settings.bookshelfDir || DEFAULT_BOOKSHELF_DIR;
		new Setting(containerEl)
			.setName("书架位置")
			.setDesc(`当前：${shelfDir}。迁移会把整个书架目录（含所有书库/文件夹/书）移动到新的位置。`)
			.addButton((b) =>
				b.setButtonText("迁移…").onClick(() => {
					new PromptModal(this.app, {
						title: "迁移书架位置",
						placeholder: "新的书架目录（vault 相对路径）",
						initialValue: shelfDir,
						submitText: "迁移",
						onSubmit: async (value) => {
							const target = value.trim().replace(/^\/+|\/+$/g, "");
							if (!target || target === shelfDir) return;
							if (target.startsWith(`${shelfDir}/`)) {
								new Notice("NyaReader：不能把书架迁移到它自己的子目录里。");
								return;
							}
							const src = this.plugin.app.vault.getAbstractFileByPath(shelfDir);
							if (!(src instanceof TFolder)) {
								new Notice("NyaReader：找不到当前书架目录，无法迁移。");
								return;
							}
							if (this.plugin.app.vault.getAbstractFileByPath(target)) {
								new Notice("NyaReader：目标位置已存在，请换一个路径。");
								return;
							}
							const idx = target.lastIndexOf("/");
							if (idx > 0) await this.mkdirpVault(target.slice(0, idx));
							await this.plugin.app.vault.rename(src, target);
							const oldPrefix = `${shelfDir}/`;
							const newPrefix = `${target}/`;
							for (const e of this.plugin.bookIndex.list()) {
								if (e.path.startsWith(oldPrefix)) await this.plugin.bookIndex.upsert({ ...e, path: e.path.replace(oldPrefix, newPrefix) });
							}
							this.plugin.settings.bookshelfDir = target;
							await this.plugin.saveSettings();
							new Notice(`NyaReader：书架已迁移到「${target}」。`);
							this.display();
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
}
