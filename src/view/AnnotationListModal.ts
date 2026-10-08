/**
 * 批注管理弹窗：列出当前书籍的全部批注（高亮/下划线/笔记），
 * 支持跳转到批注位置、编辑笔记、删除（PDF 会从文件本体移除）。
 */
import { App, Modal, Notice, setIcon } from "obsidian";
import type { Annotation, AnnotationKind } from "../services/annotations/AnnotationModel";

export interface AnnotationListModalOptions {
	getAnnotations: () => Promise<Annotation[]>;
	onJump: (a: Annotation) => void;
	onEditNote: (a: Annotation) => Promise<void>;
	onDelete: (a: Annotation) => Promise<void>;
}

const KIND_LABEL: Record<AnnotationKind, string> = {
	highlight: "高亮",
	underline: "下划线",
	note: "笔记",
};

const KIND_ICON: Record<AnnotationKind, string> = {
	highlight: "highlighter",
	underline: "underline",
	note: "pencil",
};

export class AnnotationListModal extends Modal {
	private listEl!: HTMLElement;
	private countEl!: HTMLElement;
	private emptyEl!: HTMLElement;

	constructor(app: App, private opts: AnnotationListModalOptions) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("批注管理");
		this.contentEl.addClass("nyareader-annotations-modal");
		const header = this.contentEl.createDiv({ cls: "nyareader-annotations-header" });
		this.countEl = header.createSpan({ cls: "nyareader-annotations-count", text: "加载中…" });
		this.listEl = this.contentEl.createDiv({ cls: "nyareader-annotations-list" });
		this.emptyEl = this.contentEl.createDiv({ cls: "nyareader-annotations-empty", text: "还没有批注。选中文本后点标题栏「高亮」或「笔记」即可添加。" });
		this.emptyEl.hide();
		void this.refresh();
	}

	async refresh(): Promise<void> {
		const annotations = (await this.opts.getAnnotations()).sort((a, b) => b.createdAt - a.createdAt);
		this.countEl.setText(`${annotations.length} 条批注`);
		this.listEl.empty();
		this.emptyEl.toggle(!annotations.length);
		for (const a of annotations) {
			this.listEl.appendChild(this.buildRow(a));
		}
	}

	private buildRow(a: Annotation): HTMLElement {
		const row = this.listEl.createDiv({ cls: "nyareader-annotation-row" });
		const icon = row.createSpan({ cls: `nyareader-annotation-kind is-${a.kind}` });
		setIcon(icon, KIND_ICON[a.kind]);
		icon.setAttribute("aria-label", KIND_LABEL[a.kind]);

		const main = row.createDiv({ cls: "nyareader-annotation-main" });
		main.createDiv({ cls: "nyareader-annotation-meta", text: `${KIND_LABEL[a.kind]} · ${this.formatTime(a.createdAt)}` });
		main.createDiv({ cls: "nyareader-annotation-text", text: a.text || "（无选中文本）" });
		if (a.note) main.createDiv({ cls: "nyareader-annotation-note", text: `笔记：${a.note}` });

		const actions = row.createDiv({ cls: "nyareader-annotation-actions" });
		this.addAction(actions, "arrow-right", "跳转", () => this.opts.onJump(a));
		if (a.kind === "note" || a.note) {
			this.addAction(actions, "pencil", "编辑笔记", () => void this.editNote(a));
		}
		this.addAction(actions, "trash", "删除", () => void this.delete(a));
		return row;
	}

	private addAction(container: HTMLElement, icon: string, title: string, onClick: () => void): void {
		const btn = container.createEl("button", { cls: "nyareader-annotation-action", attr: { title, "aria-label": title } });
		setIcon(btn, icon);
		btn.addEventListener("click", onClick);
	}

	private async editNote(a: Annotation): Promise<void> {
		const next = window.prompt("笔记内容：", a.note ?? "");
		if (next == null) return;
		try {
			await this.opts.onEditNote({ ...a, note: next.trim() || undefined });
			new Notice("NyaReader：笔记已更新。", 2000);
			await this.refresh();
		} catch (e) {
			new Notice(`NyaReader：更新失败：${e instanceof Error ? e.message : String(e)}`, 5000);
		}
	}

	private async delete(a: Annotation): Promise<void> {
		try {
			await this.opts.onDelete(a);
			new Notice("NyaReader：批注已删除。", 2500);
			await this.refresh();
		} catch (e) {
			new Notice(`NyaReader：删除失败：${e instanceof Error ? e.message : String(e)}`, 5000);
		}
	}

	private formatTime(ts: number): string {
		const d = new Date(ts);
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
