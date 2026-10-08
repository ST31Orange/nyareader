/**
 * 通用确认弹窗。
 * 替代 window.confirm：Obsidian 的 Electron 渲染器中 confirm 并不可靠（可能直接
 * 返回 false），导致"删除区域/删除书籍点了没反应"。用标准 Modal 保证确认链路可用。
 */
import { App, Modal, Notice } from "obsidian";

export interface ConfirmModalOptions {
	title: string;
	message: string;
	confirmText?: string;
	onConfirm: () => void | Promise<void>;
}

export class ConfirmModal extends Modal {
	constructor(app: App, private opts: ConfirmModalOptions) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.opts.title);
		this.contentEl.addClass("nyareader-confirm-modal");
		this.contentEl.createDiv({ cls: "nyareader-confirm-message", text: this.opts.message });
		const buttons = this.contentEl.createDiv({ cls: "nyareader-prompt-buttons" });
		const confirmBtn = buttons.createEl("button", {
			text: this.opts.confirmText ?? "确定",
			cls: "mod-warning",
		});
		confirmBtn.addEventListener("click", () => void this.confirm());
		buttons.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
		confirmBtn.focus();
	}

	private async confirm(): Promise<void> {
		try {
			await Promise.resolve(this.opts.onConfirm());
		} catch (e) {
			new Notice(`NyaReader：操作失败：${e instanceof Error ? e.message : String(e)}`, 6000);
			return;
		}
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
