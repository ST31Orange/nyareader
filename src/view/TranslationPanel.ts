/**
 * 右侧翻译面板（即划即译）。
 * 选中文本后由 ReaderController 调用 translate 并展示译文；支持目标语言切换。
 */
import { debounce } from "../utils/debounce";

export interface TranslationPanelOptions {
	onTranslate: (text: string, to: string) => Promise<string>;
	getLanguages: () => Array<{ value: string; label: string }>;
	getTarget: () => string;
	setTarget: (lang: string) => void;
	onOpenSettings?: () => void;
	/** 读取/写入面板宽度（px）；由视图持久化到设置 */
	getWidth?: () => number;
	setWidth?: (px: number) => void;
	/** 显隐变化回调，供视图切换 host 宽度与按钮激活态 */
	onVisibilityChange?: (visible: boolean) => void;
}

/** 面板宽度约束（拖拽调宽用）。 */
const MIN_PANEL_WIDTH = 240;
const MAX_PANEL_WIDTH = 760;

export class TranslationPanel {
	private rootEl!: HTMLElement;
	private headerEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private currentTo = "zh-Hans";
	private busy = false;
	private visible = false;
	private resizerEl: HTMLElement | null = null;

	constructor(private opts: TranslationPanelOptions) {}

	/** 创建面板 DOM 并挂载到容器。 */
	mount(container: HTMLElement): void {
		this.currentTo = this.opts.getTarget();
		this.rootEl = container.createDiv({ cls: "nyareader-trans-panel" });
		// 左边缘拖拽调宽手柄
		this.resizerEl = this.rootEl.createDiv({ cls: "nyareader-trans-resizer", attr: { title: "拖动调整宽度" } });
		this.attachResizer();
		this.headerEl = this.rootEl.createDiv({ cls: "nyareader-trans-header" });
		this.bodyEl = this.rootEl.createDiv({ cls: "nyareader-trans-body" });
		this.statusEl = this.rootEl.createDiv({ cls: "nyareader-trans-status" });

		const title = this.headerEl.createSpan({ text: "翻译" });
		title.style.fontWeight = "600";

		const langSel = this.headerEl.createEl("select");
		for (const lang of this.opts.getLanguages()) {
			const opt = langSel.createEl("option", { value: lang.value, text: lang.label });
			if (lang.value === this.currentTo) opt.selected = true;
		}
		langSel.addEventListener("change", () => {
			this.currentTo = langSel.value;
			this.opts.setTarget(this.currentTo);
		});

		const settingsBtn = this.headerEl.createEl("button", { text: "设置", cls: "nyareader-icon-btn" });
		settingsBtn.addEventListener("click", () => this.opts.onOpenSettings?.());

		// 用 class 控制显隐，避免依赖内联 style 字符串（旧实现用 :has([style*=...]) 匹配失败）
		this.rootEl.addClass("is-hidden");
		container.appendChild(this.rootEl);
	}

	/** 显示面板（划译时自动打开）。 */
	show(): void {
		this.setVisible(true);
	}

	hide(): void {
		this.setVisible(false);
	}

	isVisible(): boolean {
		return this.visible;
	}

	private setVisible(next: boolean): void {
		if (this.visible === next) return;
		this.visible = next;
		this.rootEl.toggleClass("is-hidden", !next);
		this.opts.onVisibilityChange?.(next);
	}

	/** 切换显隐，返回切换后的可见状态（便于外部同步按钮激活态）。 */
	toggle(): boolean {
		if (this.isVisible()) {
			this.hide();
			return false;
		}
		this.show();
		return true;
	}

	getTargetLanguage(): string {
		return this.currentTo;
	}

	/** 左边缘拖拽调宽：拖动中实时更新，松手后由视图持久化。 */
	private attachResizer(): void {
		const handle = this.resizerEl;
		if (!handle) return;
		handle.addEventListener("pointerdown", (evt: PointerEvent) => {
			if (evt.button !== 0) return;
			evt.preventDefault();
			const startX = evt.clientX;
			const startWidth = this.opts.getWidth?.() ?? 320;
			handle.setPointerCapture(evt.pointerId);
			handle.addClass("is-dragging");
			const onMove = (e: PointerEvent): void => {
				// 手柄在左边缘：向左拖动 => 变宽
				const next = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, startWidth + (startX - e.clientX)));
				this.opts.setWidth?.(Math.round(next));
			};
			const onUp = (e: PointerEvent): void => {
				handle.removeEventListener("pointermove", onMove);
				handle.removeEventListener("pointerup", onUp);
				handle.removeEventListener("pointercancel", onUp);
				handle.removeClass("is-dragging");
				try {
					handle.releasePointerCapture(e.pointerId);
				} catch {
					/* 指针已释放 */
				}
			};
			handle.addEventListener("pointermove", onMove);
			handle.addEventListener("pointerup", onUp);
			handle.addEventListener("pointercancel", onUp);
		});
	}

	/** 防抖划译入口。 */
	translateSelection(text: string): void {
		if (!text.trim()) return;
		this.translateDebounced(text);
	}

	private translateDebounced = debounce((text: string) => {
		void this.doTranslate(text);
	}, 400);

	private async doTranslate(text: string): Promise<void> {
		if (this.busy) return;
		this.show();
		this.busy = true;
		this.setStatus("翻译中…");
		const source = this.bodyEl.createDiv({ cls: "nyareader-trans-source" });
		source.textContent = text;
		this.bodyEl.empty();
		this.bodyEl.appendChild(source);
		try {
			const result = await this.opts.onTranslate(text, this.currentTo);
			this.statusEl.setText("");
			const target = this.bodyEl.createDiv({ cls: "nyareader-trans-target" });
			target.textContent = result;
			this.bodyEl.appendChild(target);
		} catch (e) {
			this.statusEl.setText(`翻译失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.busy = false;
		}
	}

	private setStatus(msg: string): void {
		this.statusEl.setText(msg);
	}

	destroy(): void {
		this.rootEl?.remove();
	}
}
