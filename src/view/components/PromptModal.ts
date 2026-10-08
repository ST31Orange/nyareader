/**
 * 通用文本输入弹窗。
 * 替代 window.prompt：Obsidian 的 Electron 渲染器中 prompt 并不可靠（可能直接返回 null），
 * 导致"按钮点了没反应"。用标准 Modal 保证输入链路可用。
 */
import { App, Modal, Notice } from "obsidian";

export interface PromptModalOptions {
	title: string;
	placeholder?: string;
	initialValue?: string;
	submitText?: string;
	multiline?: boolean;
	/** value 已经 trim 且非空 */
	onSubmit: (value: string) => void | Promise<void>;
}

export class PromptModal extends Modal {
	private inputEl!: HTMLInputElement | HTMLTextAreaElement;

	constructor(app: App, private opts: PromptModalOptions) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.opts.title);
		this.contentEl.addClass("nyareader-prompt-modal");
		if (this.opts.multiline) {
			this.inputEl = this.contentEl.createEl("textarea", {
				attr: { rows: "4", spellcheck: "false", placeholder: this.opts.placeholder ?? "" },
			});
		} else {
			this.inputEl = this.contentEl.createEl("input", {
				attr: { type: "text", placeholder: this.opts.placeholder ?? "" },
			});
		}
		this.inputEl.addClass("nyareader-prompt-input");
		if (this.opts.initialValue) this.inputEl.value = this.opts.initialValue;
		this.inputEl.addEventListener("keydown", (evt) => {
			const e = evt as KeyboardEvent;
			const enter = e.key === "Enter" && (this.opts.multiline ? e.ctrlKey || e.metaKey : true);
			if (enter) {
				e.preventDefault();
				void this.submit();
			}
		});

		const buttons = this.contentEl.createDiv({ cls: "nyareader-prompt-buttons" });
		buttons.createEl("button", { text: this.opts.submitText ?? "确定", cls: "mod-cta" }).addEventListener("click", () => void this.submit());
		buttons.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
		setTimeout(() => this.inputEl.focus(), 0);
	}

	private async submit(): Promise<void> {
		const value = this.inputEl.value.trim();
		if (!value) {
			new Notice("内容不能为空");
			return;
		}
		await Promise.resolve(this.opts.onSubmit(value));
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
