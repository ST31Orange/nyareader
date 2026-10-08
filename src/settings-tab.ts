/**
 * NyaReader 设置面板。
 * 翻译区（v0.2.0）：引擎配置委托独立插件 NyaLingo 一份，
 * 本面板只负责：目标语言（UI 级）、NyaLingo 安装状态、跳转/向导、测试连接、清缓存。
 */
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type NyaReaderPlugin from "./main";

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
	}
}
