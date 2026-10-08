/**
 * NyaLingoInstaller：在 NyaReader（NyaHome 同理）里"捎带安装"共享翻译插件 NyaLingo。
 *
 * 思路：
 * - 若 NyaLingo 已加载 → 无需处理；
 * - 若文件已存在但未启用 → 提示用户到"第三方插件"启用并重载；
 * - 否则从 NyaLingo 的 GitHub 仓库（raw.githubusercontent.com/ST31Orange/nyalingo/master/）
 *   下载 main.js / manifest.json / styles.css / versions.json 写入
 *   .obsidian/plugins/nyalingo/，并把 "nyalingo" 登记进 community-plugins.json，
 *   下次重载 Obsidian 时自动加载启用。
 * - 网络失败时回退到手动安装提示，不抛未捕获异常。
 *
 * 只写入用户自己的仓库产物（可信），未启用任何未知来源。
 */
import type { App } from "obsidian";

const NYALINGO_ID = "nyalingo";
const NYALINGO_GH = "ST31Orange/nyalingo";
const NYALINGO_BRANCH = "master";
const NYALINGO_FILES = ["main.js", "manifest.json", "styles.css", "versions.json"];
const NYALINGO_DIR = ".obsidian/plugins/nyalingo";
const COMMUNITY_PLUGINS_FILE = ".obsidian/community-plugins.json";

export type InstallResult =
	| { status: "already-loaded" }
	| { status: "installed-needs-reload" }
	| { status: "enable-needed" }
	| { status: "failed"; reason: string };

export class NyaLingoInstaller {
	constructor(private app: App) {}

	/** 确保 NyaLingo 已安装（未加载时尝试自动下载安装）。 */
	async ensureInstalled(isLoaded: boolean): Promise<InstallResult> {
		if (isLoaded) return { status: "already-loaded" };
		const adapter = this.app.vault.adapter;
		try {
			if (await adapter.exists(`${NYALINGO_DIR}/manifest.json`)) {
				// 文件已在，只差启用
				return { status: "enable-needed" };
			}
			await this.downloadFiles();
			await this.enableInCommunityPlugins();
			return { status: "installed-needs-reload" };
		} catch (e) {
			return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
		}
	}

	/** 从 GitHub raw 下载 NyaLingo 构建产物并写入插件目录。 */
	private async downloadFiles(): Promise<void> {
		const adapter = this.app.vault.adapter;
		await this.mkdirp(NYALINGO_DIR);
		for (const file of NYALINGO_FILES) {
			const url = `https://raw.githubusercontent.com/${NYALINGO_GH}/${NYALINGO_BRANCH}/${file}`;
			const res = await fetch(url);
			if (!res.ok) throw new Error(`下载 ${file} 失败（HTTP ${res.status}）`);
			const text = await res.text();
			if (file === "main.js") {
				await adapter.writeBinary(NYALINGO_DIR + "/" + file, new TextEncoder().encode(text).buffer as ArrayBuffer);
			} else {
				await adapter.write(NYALINGO_DIR + "/" + file, text);
			}
		}
	}

	/** 把 nyalingo 写进 community-plugins.json（下次启动自动启用）。 */
	private async enableInCommunityPlugins(): Promise<void> {
		const adapter = this.app.vault.adapter;
		let list: string[] = [];
		try {
			if (await adapter.exists(COMMUNITY_PLUGINS_FILE)) {
				const parsed = JSON.parse(await adapter.read(COMMUNITY_PLUGINS_FILE));
				if (Array.isArray(parsed)) list = parsed.filter((x) => typeof x === "string");
			}
		} catch {
			list = [];
		}
		if (!list.includes(NYALINGO_ID)) list.push(NYALINGO_ID);
		await adapter.write(COMMUNITY_PLUGINS_FILE, JSON.stringify(list, null, "\t"));
	}

	/** 递归创建目录（DataAdapter.mkdir 只建一级）。 */
	private async mkdirp(dir: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const parts = dir.split("/").filter(Boolean);
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			try {
				if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
			} catch {
				/* 忽略已存在等冲突 */
			}
		}
	}
}