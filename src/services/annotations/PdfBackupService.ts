/**
 * PDF 自动备份服务。
 * 写入 PDF 批注前，将原文件复制为 `<name>.backup-<ts>.pdf`，并维护
 * 备份索引，防止写坏后无法恢复。
 */
import type { Plugin } from "obsidian";

export interface PdfBackupResult {
	backupPath: string;
	created: boolean;
}

const BACKUP_INDEX = "nyareader-pdf-backups.json";

export class PdfBackupService {
	constructor(private plugin: Plugin) {}

	private indexPath(): string {
		return `${this.plugin.manifest.dir ?? ""}${BACKUP_INDEX}`.replace(/\/+/g, "/").replace(/^\//, "");
	}

	private async readIndex(): Promise<Record<string, string>> {
		try {
			const raw = await this.plugin.app.vault.adapter.read(this.indexPath());
			return JSON.parse(raw) as Record<string, string>;
		} catch {
			return {};
		}
	}

	private async writeIndex(index: Record<string, string>): Promise<void> {
		const dir = this.plugin.manifest.dir ?? "";
		if (dir) await this.plugin.app.vault.adapter.mkdir(dir).catch(() => undefined);
		await this.plugin.app.vault.adapter.write(this.indexPath(), JSON.stringify(index, null, 2));
	}

	/**
	 * 若该文件还没有备份，则创建一份并记录到索引。
	 * 已存在备份则复用，避免每次批注都产生新副本。
	 */
	async ensureBackup(filePath: string): Promise<PdfBackupResult> {
		const index = await this.readIndex();
		if (index[filePath]) {
			return { backupPath: index[filePath], created: false };
		}
		const dot = filePath.lastIndexOf(".");
		const base = dot > 0 ? filePath.slice(0, dot) : filePath;
		const backupPath = `${base}.backup-${Date.now()}.pdf`;
		const data = await this.plugin.app.vault.adapter.readBinary(filePath);
		await this.plugin.app.vault.adapter.writeBinary(backupPath, data);
		index[filePath] = backupPath;
		await this.writeIndex(index);
		return { backupPath, created: true };
	}

	/** 从备份恢复原文件（覆盖当前文件，调用方需确认）。 */
	async restore(filePath: string): Promise<boolean> {
		const index = await this.readIndex();
		const backup = index[filePath];
		if (!backup) return false;
		try {
			const data = await this.plugin.app.vault.adapter.readBinary(backup);
			await this.plugin.app.vault.adapter.writeBinary(filePath, data);
			return true;
		} catch {
			return false;
		}
	}

	/** 查询某文件已有的备份路径（无则 undefined）。 */
	async getBackupPath(filePath: string): Promise<string | undefined> {
		const index = await this.readIndex();
		return index[filePath];
	}
}

