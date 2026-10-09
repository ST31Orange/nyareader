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
import { moveFolder, resolveMoveTarget, type MovePort } from "./utils/move-folder";

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
				`当前目录：${anchor}（书库 ${shelfDir}、批注 ${annotationDir}）。` +
					`**填什么就搬到哪里**：填「日历/NyaReader」就搬到那个路径。` +
					`程序会把整个目录（含 library 与 annotations）递归搬过去，目标不存在会自动创建；` +
					`目标下若已有同名内容则不覆盖并提示。`
			)
			.addButton((b) =>
				b.setButtonText("迁移…").onClick(() => {
					new PromptModal(this.app, {
						title: "迁移 NyaReader 目录",
						placeholder: "目标位置，例如 日历/NyaReader",
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
	 * **用户明确要求的做法**：不要再"自己造目录"、不要区分一级/二级，
	 * 直接把**旧目录整个打开、内容全部搬过去**，然后重建索引。
	 *
	 * 实际执行（全部交给已被真实文件系统单测覆盖的 `moveFolder()`）：
	 * 1. 算出当前目录 `from`（一般是 `nyareader`，即 library/annotations 的共同上级）；
	 * 2. 算出目标 `to`：若你填的路径最后一段就是目录名（如 `日历/NyaReader`）→ 它本身；
	 *    否则（如 `日历`）→ 搬成 `日历/<目录名>`（和拖文件夹的直觉一致）；
	 * 3. 递归把 `from` 下**每一个条目**搬到 `to`（先子项后目录，目标父目录先建好）；
	 * 4. 更新设置、阅读进度索引里所有书路径、批注目录，并刷新设置页。
	 *
	 * 冲突（目标下已有同名文件/目录）会**在动手之前**拒绝，不会产生半搬状态。
	 */
	private async migrateBookshelf(rawTarget: string): Promise<void> {
		const app = this.plugin.app;
		const oldShelf = this.plugin.settings.bookshelfDir || DEFAULT_BOOKSHELF_DIR;
		const oldAnnotations = this.plugin.settings.annotationDir || annotationDirForBookshelf(oldShelf);

		// 源 = 当前目录（library 与 annotations 的共同上级；不标准时退回书库目录本身）
		const from = bookshelfAnchor(oldShelf, oldAnnotations);
		if (!(app.vault.getAbstractFileByPath(from) instanceof TFolder)) {
			new Notice(`NyaReader：找不到当前目录「${from}」，无法迁移。`, 8000);
			return;
		}

		const raw = (rawTarget ?? "").trim();
		const resolved = resolveMoveTarget({ from, rawTarget: raw });
		if (resolved.error || !resolved.to) {
			new Notice(`NyaReader：${resolved.error}`, 8000);
			return;
		}
		const to = resolved.to;

		const res = await moveFolder(this.movePort(), from, to);
		if (!res.ok) {
			const why = res.conflicts?.length ? `目标下已存在同名内容（${res.conflicts.slice(0, 3).join("、")}）` : res.error;
			console.error("[NyaReader] 迁移失败", { from, to, ...res });
			new Notice(
				`NyaReader：迁移失败：${why}\n（把「${from}」搬到「${to}」${res.rolledBack === false ? "；回滚未完全成功" : "；已回滚"}）`,
				12000
			);
			return;
		}

		// 搬完后重新推导两个子目录的新位置（目录整体搬走，内部结构不变）
		const tail = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
		const newShelf = `${to}/${tail(oldShelf)}`;
		const newAnnotations = `${to}/${tail(oldAnnotations)}`;
		await this.finishMigration(oldShelf, newShelf, oldAnnotations, newAnnotations, true, to, from, res.moved);
	}

	/** 把 `moveFolder` 需要的文件操作接到 Obsidian 的 vault 上。 */
	private movePort(): MovePort {
		const app = this.plugin.app;
		const adapter = app.vault.adapter;
		return {
			exists: (p) => adapter.exists(p).catch(() => false),
			mkdirp: async (p) => this.mkdirpVault(p),
			list: async (p) => {
				const listed = await adapter.list(p).catch(() => ({ files: [], folders: [] }));
				return [...listed.folders, ...listed.files].map((full) => full.slice(full.lastIndexOf("/") + 1));
			},
			isDir: async (p) => {
				const st = await adapter.stat(p).catch(() => null);
				return st?.type === "folder";
			},
			// 走 vault.rename：Obsidian 会同步它自己的文件缓存（单纯 fs rename 不会）
			rename: async (from, to) => {
				const file = app.vault.getAbstractFileByPath(from);
				if (!file) throw new Error(`找不到「${from}」`);
				await app.vault.rename(file, to);
			},
			removeDir: async (p) => {
				const file = app.vault.getAbstractFileByPath(p);
				if (file) await app.vault.delete(file, true);
			},
		};
	}

	/**
	 * 迁移收尾：更新设置 + 阅读进度索引路径 + 批注目录注入 + 刷新设置页。
	 *
	 * @param movedCount 实际搬动的文件数（用于给用户一个可核对的数字）
	 */
	private async finishMigration(
		oldShelf: string,
		newShelf: string,
		oldAnnotations: string,
		newAnnotations: string,
		annotationsMoved: boolean,
		anchorDir: string,
		fromDir: string,
		movedCount: number
	): Promise<void> {
		// 阅读进度索引里的书路径也要跟着改，否则"进度全部丢失"
		const oldPrefix = `${oldShelf}/`;
		const newPrefix = `${newShelf}/`;
		let updated = 0;
		for (const e of this.plugin.bookIndex.list()) {
			if (e.path.startsWith(oldPrefix)) {
				await this.plugin.bookIndex.upsert({ ...e, path: e.path.replace(oldPrefix, newPrefix) });
				updated++;
			}
		}
		this.plugin.settings.bookshelfDir = newShelf;
		this.plugin.settings.annotationDir = annotationsMoved ? newAnnotations : oldAnnotations;
		setAnnotationSidecarDir(this.plugin.settings.annotationDir);
		await this.plugin.saveSettings();
		console.info("[NyaReader] 迁移完成", { fromDir, anchorDir, movedCount, shelf: newShelf, annotations: this.plugin.settings.annotationDir, indexUpdated: updated });
		new Notice(
			`NyaReader：已迁移「${fromDir}」→「${anchorDir}」（${movedCount} 个文件；` +
				`进度索引更新 ${updated} 条）。若书架显示异常，重启一次 Obsidian 即可重建索引。`,
			10000
		);
		this.display();
	}
}
