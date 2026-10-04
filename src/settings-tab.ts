/**
 * NyaReader 设置面板。
 * 翻译区按"用户最容易理解"组织：默认中英互译、离线翻译与在线翻译两块、
 * 提供"粘贴既有 MTranServer 配置"导入入口。
 */
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type NyaReaderPlugin from "./main";
import type { TranslationProviderType } from "./settings";

export class NyaReaderSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: NyaReaderPlugin) {
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
		new Setting(containerEl).setName("默认版式").setDesc("单栏 / 双栏（适用于 EPUB、TXT）").addDropdown((d) => {
			d.addOptions({ single: "单栏", double: "双栏" })
				.setValue(this.plugin.settings.reader.layout)
				.onChange(async (v) => {
					this.plugin.settings.reader.layout = v as "single" | "double";
					await this.plugin.saveSettings();
				});
		});

		// ---------- 翻译 ----------
		containerEl.createEl("h3", { text: "翻译" });
		new Setting(containerEl)
			.setName("翻译模式")
			.setDesc("离线翻译（本地引擎，如 MTranServer）/ 在线翻译（OpenAI 兼容 / DeepL）")
			.addDropdown((d) => {
				d.addOptions({ offline: "离线翻译（本地引擎）", online: "在线翻译（API）" })
					.setValue(this.plugin.settings.translation.mode)
					.onChange(async (v) => {
						this.plugin.settings.translation.mode = v as "offline" | "online";
						await this.plugin.saveSettings();
						await this.plugin.translation.reloadConfig();
						this.display();
					});
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

		const mode = this.plugin.settings.translation.mode;
		if (mode === "offline") {
			this.renderOfflineSection(containerEl);
		} else {
			this.renderOnlineSection(containerEl);
		}

		// ---------- 翻译高级 ----------
		containerEl.createEl("h4", { text: "翻译高级" });
		new Setting(containerEl).setName("请求超时（毫秒）").addSlider((s) => {
			s.setLimits(1000, 60000, 1000)
				.setValue(this.plugin.settings.translation.timeoutMs)
				.setDynamicTooltip()
				.onChange(async (v) => {
					this.plugin.settings.translation.timeoutMs = v;
					await this.plugin.saveSettings();
				});
		});
		new Setting(containerEl).setName("启用翻译缓存").setDesc("重复文本不重复请求").addToggle((t) => {
			t.setValue(this.plugin.settings.translation.cacheEnabled).onChange(async (v) => {
				this.plugin.settings.translation.cacheEnabled = v;
				await this.plugin.saveSettings();
			});
		});
		new Setting(containerEl).setName("测试翻译连接").setDesc("使用当前配置发送一条测试请求").addButton((b) => {
			b.setButtonText("测试").setCta().onClick(async () => {
				b.setDisabled(true);
				b.setButtonText("测试中…");
				const ok = await this.plugin.translation.healthCheck();
				b.setDisabled(false);
				b.setButtonText("测试");
				new Notice(ok ? "NyaReader：翻译连接正常。" : "NyaReader：翻译连接不可用，请检查配置。", 6000);
			});
		});
		new Setting(containerEl).setName("清空翻译缓存").addButton((b) => {
			b.setButtonText("清空").setWarning().onClick(async () => {
				await this.plugin.translation.clearCache();
				new Notice("NyaReader：翻译缓存已清空。");
			});
		});
	}

	private renderOfflineSection(el: HTMLElement): void {
		el.createEl("h4", { text: "离线翻译（本地引擎）" });
		new Setting(el)
			.setName("离线引擎地址")
			.setDesc("例如 http://127.0.0.1:8989 （MTranServer）")
			.addText((t) => {
				t.setPlaceholder("http://127.0.0.1:8989")
					.setValue(this.plugin.settings.translation.offlineEndpoint)
					.onChange(async (v) => {
						this.plugin.settings.translation.offlineEndpoint = v.trim();
						await this.plugin.saveSettings();
					});
			});
		new Setting(el)
			.setName("API Token（可选）")
			.setDesc("离线引擎若需要鉴权则填写")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(this.plugin.settings.translation.offlineToken).onChange(async (v) => {
					this.plugin.settings.translation.offlineToken = v.trim();
					await this.plugin.saveSettings();
				});
			});
		new Setting(el)
			.setName("导入既有 MTranServer 配置")
			.setDesc("粘贴 NyaHome / 旧插件 data.json 中 translation 对象的 JSON，自动填充地址与 Token。")
			.addTextArea((ta) => {
				ta.setPlaceholder('{"endpoint":"http://127.0.0.1:8989","token":"..."}').onChange(async (raw) => {
					try {
						const data = JSON.parse(raw) as { endpoint?: string; token?: string; targetLanguage?: string };
						if (data.endpoint) this.plugin.settings.translation.offlineEndpoint = data.endpoint.trim();
						if (data.token) this.plugin.settings.translation.offlineToken = data.token.trim();
						if (data.targetLanguage) this.plugin.settings.translation.targetLanguage = data.targetLanguage;
						await this.plugin.saveSettings();
						new Notice("NyaReader：已导入 MTranServer 配置。");
					} catch {
						new Notice("NyaReader：JSON 解析失败，请检查粘贴内容。", 4000);
					}
				});
			});
	}

	private renderOnlineSection(el: HTMLElement): void {
		el.createEl("h4", { text: "在线翻译" });
		new Setting(el)
			.setName("服务商")
			.addDropdown((d) => {
				d.addOptions({ openai: "OpenAI 兼容 API", deepl: "DeepL" })
					.setValue(this.plugin.settings.translation.provider)
					.onChange(async (v) => {
						this.plugin.settings.translation.provider = v as TranslationProviderType;
						await this.plugin.saveSettings();
						await this.plugin.translation.reloadConfig();
					});
			});
		if (this.plugin.settings.translation.provider === "openai") {
			new Setting(el)
				.setName("API 地址")
				.setDesc("OpenAI 兼容 base URL，例如 https://api.openai.com/v1 或自定义中转")
				.addText((t) =>
					t.setValue(this.plugin.settings.translation.openaiBaseUrl).onChange(async (v) => {
						this.plugin.settings.translation.openaiBaseUrl = v.trim();
						await this.plugin.saveSettings();
					})
				);
			new Setting(el).setName("API Key").addText((t) => {
				t.inputEl.type = "password";
				t.setValue(this.plugin.settings.translation.openaiApiKey).onChange(async (v) => {
					this.plugin.settings.translation.openaiApiKey = v.trim();
					await this.plugin.saveSettings();
				});
			});
			new Setting(el)
				.setName("模型名称")
				.addText((t) =>
					t.setValue(this.plugin.settings.translation.openaiModel).onChange(async (v) => {
						this.plugin.settings.translation.openaiModel = v.trim();
						await this.plugin.saveSettings();
					})
				);
		} else {
			new Setting(el)
				.setName("DeepL API Key")
				.addText((t) => {
					t.inputEl.type = "password";
					t.setValue(this.plugin.settings.translation.deeplApiKey).onChange(async (v) => {
						this.plugin.settings.translation.deeplApiKey = v.trim();
						await this.plugin.saveSettings();
					});
				});
			new Setting(el)
				.setName("DeepL API 地址")
				.addText((t) =>
					t.setValue(this.plugin.settings.translation.deeplBaseUrl).onChange(async (v) => {
						this.plugin.settings.translation.deeplBaseUrl = v.trim();
						await this.plugin.saveSettings();
					})
				);
		}
	}
}
