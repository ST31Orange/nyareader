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
}

export class TranslationPanel {
	private rootEl!: HTMLElement;
	private headerEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private currentTo = "zh-Hans";
	private busy = false;

	constructor(private opts: TranslationPanelOptions) {}

	/** 创建面板 DOM 并挂载到容器。 */
	mount(container: HTMLElement): void {
		this.currentTo = this.opts.getTarget();
		this.rootEl = container.createDiv({ cls: "nyareader-trans-panel" });
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

		this.rootEl.style.display = "none";
		container.appendChild(this.rootEl);
	}

	/** 显示面板（划译时自动打开）。 */
	show(): void {
		this.rootEl.style.display = "";
	}

	hide(): void {
		this.rootEl.style.display = "none";
	}

	isVisible(): boolean {
		return this.rootEl.style.display !== "none";
	}

	toggle(): void {
		if (this.isVisible()) this.hide();
		else this.show();
	}

	getTargetLanguage(): string {
		return this.currentTo;
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
