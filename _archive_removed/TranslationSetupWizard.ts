/**
 * 离线翻译引擎安装向导（Translation Setup Wizard）。
 * 解决"不知道怎么装离线翻译包"的问题：
 * - 自动识别当前平台，给出对应下载入口与安装包说明
 * - 一键打开官方下载页（GitHub Releases）
 * - 提供 npx / Docker 备选方案
 * - 填地址后一键"测试连接"，成功即可用
 * 界面尽量口语化、步骤化。
 */
import { App, Modal, Notice, Setting } from "obsidian";
import type { HttpTransport } from "../utils/http";
import { openExternal, detectPlatform } from "../utils/external";
import { probeOfflineServer, normalizeEndpoint } from "../services/translation/offline-probe";

const REPO_URL = "https://github.com/xxnuo/MTranServer";
const RELEASES_URL = `${REPO_URL}/releases`;
const DOCS_URL = `${REPO_URL}#readme`;
const DEFAULT_ENDPOINT = "http://127.0.0.1:8989";

export interface SetupWizardOptions {
	/** 当前已填的离线地址（供预填） */
	initialEndpoint: string;
	/** 保存地址（用户点了"完成"或测试成功后调用） */
	onSaveEndpoint: (endpoint: string) => Promise<void>;
	/** HTTP 传输（Obsidian requestUrl 实现） */
	http: HttpTransport;
	/** 设为在线翻译模式（切换后关闭向导） */
	onSwitchToOnline?: () => Promise<void>;
	/** 结束（打开设置页等） */
	onDone?: () => void;
}

const PLATFORM_LABEL: Record<ReturnType<typeof detectPlatform>, string> = {
	win: "Windows",
	mac: "macOS",
	linux: "Linux",
	other: "未知系统",
};

const PLATFORM_PKG_HINT: Record<ReturnType<typeof detectPlatform>, string> = {
	win: "Windows 安装包：mtranserver-desktop-…-win-x64.exe",
	mac: "macOS 安装包：mtranserver-desktop-…-mac-universal.dmg",
	linux: "Linux 安装包：mtranserver-desktop-…-linux-x86_64.AppImage",
	other: "请在 Releases 页面选择适合你系统的安装包。",
};

export class TranslationSetupWizard extends Modal {
	private statusEl: HTMLElement | null = null;
	private endpoint = DEFAULT_ENDPOINT;
	private saved = false;

	constructor(app: App, private opts: SetupWizardOptions) {
		super(app);
		this.endpoint = normalizeEndpoint(opts.initialEndpoint) || DEFAULT_ENDPOINT;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("nyareader-wizard");
		const platform = detectPlatform();

		contentEl.createEl("h2", { text: "离线翻译引擎安装向导" });
		contentEl.createEl("p", {
			text: "离线翻译在你自己的电脑上本地运行，隐私安全、无需联网。目前推荐安装开源免费的 MTranServer。",
		});

		// ---- 第 1 步：下载 ----
		contentEl.createEl("h3", { text: "1️⃣ 下载安装包" });
		contentEl.createEl("p", { text: `检测到你的系统：${PLATFORM_LABEL[platform]}` });
		contentEl.createEl("p", { cls: "nyareader-wizard-hint", text: PLATFORM_PKG_HINT[platform] });
		new Setting(contentEl)
			.setName("MTranServer 官方下载页")
			.setDesc("选择最新版本，下载对应平台的桌面端安装包")
			.addButton((b) =>
				b.setButtonText("打开下载页").setCta().onClick(() => {
					openExternal(RELEASES_URL);
				})
			);

		// ---- 第 2 步：安装启动 ----
		contentEl.createEl("h3", { text: "2️⃣ 安装并启动" });
		const steps: Record<ReturnType<typeof detectPlatform>, string> = {
			win: "双击安装包完成安装；安装后打开 MTranServer，在托盘图标菜单选择「启动服务」。",
			mac: "打开 .dmg 把应用拖入「应用程序」；首次打开在 系统设置→隐私与安全性 允许；随后启动。",
			linux: "给 .AppImage 加执行权限后运行；启动后托盘会显示服务状态。",
			other: "请参照官方 README 完成部署。",
		};
		contentEl.createEl("p", { text: steps[platform] });
		contentEl.createEl("p", { cls: "nyareader-wizard-hint", text: "启动后，翻译服务默认监听 http://127.0.0.1:8989。" });

		// ---- 第 3 步：填地址并测试 ----
		contentEl.createEl("h3", { text: "3️⃣ 回到 NyaReader 填入地址并测试" });
		this.statusEl = contentEl.createDiv({ cls: "nyareader-wizard-status" });

		const endpointSetting = new Setting(contentEl)
			.setName("离线引擎地址")
			.setDesc("保持默认即可；若你改了端口请同步修改");
		endpointSetting.addText((t) => {
			t.setValue(this.endpoint).setPlaceholder(DEFAULT_ENDPOINT).onChange((v) => {
				this.endpoint = normalizeEndpoint(v);
			});
		});

		const statusLine = new Setting(contentEl).setName("连接状态").setDesc("点击测试，确认引擎是否已运行");
		statusLine.addButton((b) =>
			b.setButtonText("测试连接").onClick(async () => {
				b.setDisabled(true);
				b.setButtonText("测试中…");
				this.setStatus("正在连接…");
				const result = await probeOfflineServer(this.opts.http, this.endpoint, 5000);
				if (result.running) {
					this.setStatus(`✅ 连接成功：${result.detail ?? "运行中"}`);
					await this.opts.onSaveEndpoint(this.endpoint);
					this.saved = true;
				} else {
					this.setStatus(`❌ ${result.error ?? "连接失败"}。\n  请确认：① 已安装并启动 MTranServer；② 地址与端口正确；③ 若第一次启动需要等待模型下载完成。`);
				}
				b.setDisabled(false);
				b.setButtonText("测试连接");
			})
		);

		// ---- 备选方案 + 完成 ----
		contentEl.createEl("h3", { text: "备选安装方式（无需桌面端）" });
		new Setting(contentEl).setName("npx 一键启动（需 Node.js）").setDesc("npm i -g mtranserver@latest 后运行 mtranserver").addButton((b) =>
			b.setButtonText("查看文档").onClick(() => openExternal(DOCS_URL))
		);
		new Setting(contentEl).setName("不想装离线引擎？").setDesc("改用在线翻译（OpenAI 兼容 / DeepL）").addButton((b) =>
			b.setButtonText("改用在线翻译").onClick(() => {
				void (async () => {
					await this.opts.onSwitchToOnline?.();
					this.close();
					this.opts.onDone?.();
				})();
			})
		);

		new Setting(contentEl).addButton((b) =>
			b.setButtonText("完成").setCta().onClick(() => {
				void (async () => {
					await this.opts.onSaveEndpoint(this.endpoint);
					this.saved = true;
					this.close();
					this.opts.onDone?.();
				})();
			})
		);
	}

	private setStatus(text: string): void {
		if (this.statusEl) this.statusEl.setText(text);
	}

	onClose(): void {
		if (!this.saved) {
			// 用户直接关闭：仍保存当前地址，避免下次再弹
			void this.opts.onSaveEndpoint(this.endpoint);
		}
		this.contentEl.empty();
	}
}

export function openTranslationSetupWizard(app: App, opts: SetupWizardOptions): void {
	new TranslationSetupWizard(app, opts).open();
}
