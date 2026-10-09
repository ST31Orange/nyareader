/**
 * 批注管理面板：列出当前书籍的全部批注（高亮/笔记）。
 *
 * 对齐成熟阅读器的 UX（见 docs/annotation-research.md）：
 * - **按书内位置排序**（默认）而不是按创建时间 —— 和阅读顺序一致才方便回看；
 * - 六色色板可直接改色；备注可编辑；删除有确认；
 * - 搜索过滤（正文/笔记）；
 * - 导出 Markdown（`==…==` + `> [!note]`，落进 vault 可 grep）。
 */
import { App, Modal, Notice, setIcon } from "obsidian";
import type { Annotation, AnnotationKind, HighlightColor } from "../services/annotations/AnnotationModel";
import { HIGHLIGHT_COLORS, HIGHLIGHT_COLOR_LABEL, normalizeHighlightColor } from "../services/annotations/AnnotationModel";
import { ANNOTATION_SORT_LABEL, sortAnnotations, type AnnotationSortKey } from "../utils/annotation-sort";
import { PromptModal } from "./components/PromptModal";

export type { AnnotationSortKey } from "../utils/annotation-sort";

export interface AnnotationListModalOptions {
	getAnnotations: () => Promise<Annotation[]>;
	/** 跳转到批注位置（优先用引擎的 focusHighlight，能精确高亮定位） */
	onJump: (a: Annotation) => void;
	onEditNote: (a: Annotation) => Promise<void>;
	onDelete: (a: Annotation) => Promise<void>;
	/** 新增：改颜色（侧车 + 引擎重绘） */
	onUpdateColor?: (a: Annotation, color: HighlightColor) => Promise<void>;
	/** 新增：导出 Markdown */
	onExport?: (list: Annotation[]) => Promise<void>;
	/** 初始排序（默认按位置） */
	initialSort?: AnnotationSortKey;
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

const SORT_LABEL = ANNOTATION_SORT_LABEL;

export class AnnotationListModal extends Modal {
	private listEl!: HTMLElement;
	private countEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private searchEl!: HTMLInputElement;
	private all: Annotation[] = [];
	private sort: AnnotationSortKey;
	private query = "";

	constructor(app: App, private opts: AnnotationListModalOptions) {
		super(app);
		this.sort = opts.initialSort ?? "position";
	}

	onOpen(): void {
		this.titleEl.setText("批注管理");
		this.contentEl.addClass("nyareader-annotations-modal");

		// 工具条：搜索 + 排序 + 导出
		const header = this.contentEl.createDiv({ cls: "nyareader-annotations-header" });
		this.countEl = header.createSpan({ cls: "nyareader-annotations-count", text: "加载中…" });
		this.searchEl = header.createEl("input", {
			cls: "nyareader-annotations-search",
			attr: { type: "search", placeholder: "搜索正文或笔记…", "aria-label": "搜索批注" },
		});
		this.searchEl.addEventListener("input", () => {
			this.query = this.searchEl.value.trim().toLowerCase();
			this.renderList();
		});
		const sortSel = header.createEl("select", { cls: "nyareader-annotations-sort", attr: { "aria-label": "排序方式" } });
		for (const key of Object.keys(SORT_LABEL) as AnnotationSortKey[]) {
			sortSel.createEl("option", { value: key, text: SORT_LABEL[key] });
		}
		sortSel.value = this.sort;
		sortSel.addEventListener("change", () => {
			this.sort = sortSel.value as AnnotationSortKey;
			this.renderList();
		});
		if (this.opts.onExport) {
			const exportBtn = header.createEl("button", { cls: "nyareader-annotations-export", text: "导出 Markdown" });
			exportBtn.addEventListener("click", () => void this.exportMarkdown());
		}

		this.listEl = this.contentEl.createDiv({ cls: "nyareader-annotations-list" });
		this.emptyEl = this.contentEl.createDiv({
			cls: "nyareader-annotations-empty",
			text: "还没有批注。选中文本后会弹出浮层，点色块即可高亮（也可加笔记）。",
		});
		this.emptyEl.hide();
		void this.refresh();
	}

	async refresh(): Promise<void> {
		this.all = await this.opts.getAnnotations();
		this.renderList();
	}

	/** 应用搜索 + 排序后重绘列表。 */
	private renderList(): void {
		const visible = this.visibleAnnotations();
		this.countEl.setText(
			this.query ? `${visible.length} / ${this.all.length} 条批注` : `${this.all.length} 条批注`
		);
		this.listEl.empty();
		this.emptyEl.toggle(!visible.length);
		this.emptyEl.setText(
			this.all.length && !visible.length ? "没有匹配的批注。" : "还没有批注。选中文本后会弹出浮层，点色块即可高亮（也可加笔记）。"
		);
		for (const a of visible) this.listEl.appendChild(this.buildRow(a));
	}

	private visibleAnnotations(): Annotation[] {
		const filtered = this.query
			? this.all.filter(
					(a) =>
						(a.text ?? "").toLowerCase().includes(this.query) || (a.note ?? "").toLowerCase().includes(this.query)
				)
			: [...this.all];
		return sortAnnotations(filtered, this.sort);
	}

	private buildRow(a: Annotation): HTMLElement {
		const color = normalizeHighlightColor(a.color);
		const row = this.listEl.createDiv({ cls: "nyareader-annotation-row" });
		// 颜色小圆点：点开就是色板
		const dot = row.createEl("button", {
			cls: `nyareader-annotation-color is-${color}`,
			attr: { title: `颜色：${HIGHLIGHT_COLOR_LABEL[color]}（点击更换）`, "aria-label": "更换颜色" },
		});
		dot.addEventListener("click", (e) => {
			e.stopPropagation();
			this.openColorPicker(dot, a);
		});

		const main = row.createDiv({ cls: "nyareader-annotation-main" });
		const meta = `${KIND_LABEL[a.kind]} · ${this.formatTime(a.createdAt)}${a.approximate ? " · ⚠ 位置可能不准" : ""}`;
		main.createDiv({ cls: "nyareader-annotation-meta", text: meta });
		main.createDiv({ cls: "nyareader-annotation-text", text: a.text || "（无选中文本）" });
		if (a.note) main.createDiv({ cls: "nyareader-annotation-note", text: `笔记：${a.note}` });
		// 点击行 = 跳转（比只点小箭头更快）
		row.addEventListener("click", () => this.opts.onJump(a));

		const actions = row.createDiv({ cls: "nyareader-annotation-actions" });
		this.addAction(actions, "arrow-right", "跳转", () => this.opts.onJump(a));
		this.addAction(actions, "pencil", a.note ? "编辑笔记" : "添加笔记", () => this.editNote(a));
		this.addAction(actions, "trash", "删除", () => void this.delete(a));
		// 已有颜色时也允许点圆点换色（上方已绑定）
		return row;
	}

	/** 行内色板：点色块立即改色。 */
	private openColorPicker(anchor: HTMLElement, a: Annotation): void {
		const existing = anchor.parentElement?.querySelector(".nyareader-annotation-palette");
		if (existing) {
			existing.remove();
			return;
		}
		const palette = (anchor.parentElement ?? this.listEl).createDiv({ cls: "nyareader-annotation-palette" });
		for (const c of HIGHLIGHT_COLORS) {
			const sw = palette.createEl("button", {
				cls: `nyareader-sel-color is-${c}`,
				attr: { title: HIGHLIGHT_COLOR_LABEL[c], "aria-label": `改为${HIGHLIGHT_COLOR_LABEL[c]}色`, type: "button" },
			});
			sw.addEventListener("click", (e) => {
				e.stopPropagation();
				palette.remove();
				void this.changeColor(a, c);
			});
		}
	}

	private async changeColor(a: Annotation, color: HighlightColor): Promise<void> {
		if (!this.opts.onUpdateColor) return;
		try {
			await this.opts.onUpdateColor(a, color);
			await this.refresh();
		} catch (e) {
			new Notice(`NyaReader：改色失败：${e instanceof Error ? e.message : String(e)}`, 5000);
		}
	}

	private async exportMarkdown(): Promise<void> {
		if (!this.opts.onExport) return;
		try {
			await this.opts.onExport(this.visibleAnnotations());
		} catch (e) {
			new Notice(`NyaReader：导出失败：${e instanceof Error ? e.message : String(e)}`, 6000);
		}
	}

	private addAction(container: HTMLElement, icon: string, title: string, onClick: () => void): void {
		const btn = container.createEl("button", { cls: "nyareader-annotation-action", attr: { title, "aria-label": title } });
		setIcon(btn, icon);
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			onClick();
		});
	}

	private editNote(a: Annotation): void {
		new PromptModal(this.app, {
			title: a.note ? "编辑笔记" : "添加笔记",
			multiline: true,
			initialValue: a.note ?? "",
			placeholder: "笔记内容",
			submitText: "保存",
			onSubmit: async (note) => {
				try {
					await this.opts.onEditNote({ ...a, note });
					new Notice("NyaReader：笔记已更新。", 2000);
					await this.refresh();
				} catch (e) {
					new Notice(`NyaReader：更新失败：${e instanceof Error ? e.message : String(e)}`, 5000);
				}
			},
		}).open();
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
