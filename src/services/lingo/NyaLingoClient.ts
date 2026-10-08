/**
 * NyaLingoClient：NyaReader 到 NyaLingo（共享翻译服务）的客户端适配。
 *
 * 设计目标：
 * - NyaReader 只保留 UI 级设置（目标语言），引擎/密钥/缓存等全部委托 NyaLingo 一份；
 * - 通过公开 API app.plugins.getPlugin("nyalingo") 调用（合规）；
 * - NyaLingo 未安装/未启用时，抛出可读错误并给出安装引导回调；
 * - 构造函数注入 getPlugin，便于单元测试。
 */
import type { App, Plugin } from "obsidian";

/** NyaLingo 对外暴露的 API 形状（与 nyalingo 仓库 src/main.ts 保持一致）。 */
export interface NyaLingoApiShape {
	translate(text: string, opts?: { from?: string; to?: string; html?: boolean }): Promise<string>;
	healthCheck(): Promise<boolean>;
	getConfig(): Record<string, unknown>;
	onSettingsChange(cb: (cfg: Record<string, unknown>) => void): () => void;
	testConnection(): Promise<{ ok: boolean; detail?: string }>;
	openSetupWizard(): void;
	/** 打开 NyaLingo 真正的设置面板（旧版本可能不存在）。 */
	openSettings?(): void;
	clearCache(): Promise<void>;
}

export interface NyaLingoClientOptions {
	app: App;
	/** 便于测试注入 */
	getPlugin?: (id: string) => Plugin | null;
	/** NyaLingo 未安装/未启用时的引导（默认仅抛错，可由视图层注入弹窗） */
	onMissing?: () => void;
}

export class NyaLingoClient {
	private readonly app: App;
	private readonly getPluginImpl: (id: string) => Plugin | null;
	private readonly onMissing: () => void;
	private unsub: (() => void) | null = null;

	constructor(opts: NyaLingoClientOptions) {
		this.app = opts.app;
		this.getPluginImpl = opts.getPlugin ?? ((id) => (this.app as unknown as { plugins: { getPlugin?(id: string): Plugin | null } }).plugins.getPlugin?.(id) ?? null);
		this.onMissing = opts.onMissing ?? (() => undefined);
	}

	/** NyaLingo 是否已安装并启用（getPlugin 返回非空即已加载）。 */
	isAvailable(): boolean {
		return this.getPluginImpl("nyalingo") !== null;
	}

	/** 取当前 NyaLingo 插件实例（可能为空）。 */
	private instance(): NyaLingoApiShape | null {
		const p = this.getPluginImpl("nyalingo");
		if (!p) return null;
		// 运行时校验是否实现了公共 API，避免旧版本
		if (typeof (p as unknown as NyaLingoApiShape).translate !== "function") return null;
		return p as unknown as NyaLingoApiShape; // Plugin 未声明这些方法，运行时校验
	}

	/**
	 * 翻译一段文本。未安装/未启用时调用 onMissing 并抛可读错误。
	 */
	async translate(text: string, opts?: { from?: string; to?: string; html?: boolean }): Promise<string> {
		const inst = this.instance();
		if (!inst) {
			this.onMissing();
			throw new Error("未检测到 NyaLingo 翻译插件。请先安装并启用 NyaLingo（设置 → 第三方插件 → NyaLingo）。");
		}
		return inst.translate(text, opts);
	}

	async healthCheck(): Promise<boolean> {
		const inst = this.instance();
		if (!inst) return false;
		return inst.healthCheck();
	}

	async testConnection(): Promise<{ ok: boolean; detail?: string }> {
		const inst = this.instance();
		if (!inst) return { ok: false, detail: "未检测到 NyaLingo 插件。" };
		return inst.testConnection();
	}

	getConfig(): Record<string, unknown> | null {
		const inst = this.instance();
		return inst ? inst.getConfig() : null;
	}

	/** 订阅 NyaLingo 设置变更（返回取消函数；未安装返回 noop）。 */
	onSettingsChange(cb: (cfg: Record<string, unknown>) => void): () => void {
		this.unsub?.();
		const inst = this.instance();
		if (!inst) return () => undefined;
		this.unsub = inst.onSettingsChange(cb);
		return this.unsub;
	}

	/**
	 * 打开 NyaLingo 设置面板。
	 * 优先调用真正的设置界面 openSettings()，旧版本降级到安装向导；未安装时触发引导。
	 */
	openSettingsOrWizard(): void {
		const inst = this.instance();
		if (!inst) {
			this.onMissing();
			return;
		}
		if (typeof inst.openSettings === "function") inst.openSettings();
		else inst.openSetupWizard();
	}

	async clearCache(): Promise<void> {
		const inst = this.instance();
		if (!inst) return;
		await inst.clearCache();
	}

	/** 读取 NyaLingo 当前目标语言（用于 UI 同步；未安装返回空串）。 */
	getTargetLanguage(): string {
		const cfg = this.getConfig();
		return (cfg?.targetLanguage as string | undefined) ?? "";
	}
}
