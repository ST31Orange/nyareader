/**
 * NyaLingoClient 单测：验证 getPlugin 探测、委托翻译、未安装时的降级行为。
 */
import { describe, it, expect, vi } from "vitest";
import { NyaLingoClient, NyaLingoApiShape } from "../src/services/lingo/NyaLingoClient";
import type { Plugin } from "obsidian";

function fakeLingo(overrides: Partial<NyaLingoApiShape> = {}): Plugin & NyaLingoApiShape {
	return {
		translate: vi.fn(async (text: string) => `译:${text}`),
		healthCheck: vi.fn(async () => true),
		getConfig: vi.fn(() => ({ targetLanguage: "zh-Hans" })),
		onSettingsChange: vi.fn(() => () => undefined),
		testConnection: vi.fn(async () => ({ ok: true })),
		openSetupWizard: vi.fn(),
		clearCache: vi.fn(async () => undefined),
		...overrides,
	} as unknown as Plugin & NyaLingoApiShape;
}

function makeClient(opts: { plugin: Plugin | null; onMissing?: () => void }) {
	return new NyaLingoClient({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		app: {} as any,
		getPlugin: () => opts.plugin,
		onMissing: opts.onMissing,
	});
}

describe("NyaLingoClient.isAvailable", () => {
	it("已安装时返回 true", () => {
		const client = makeClient({ plugin: fakeLingo() });
		expect(client.isAvailable()).toBe(true);
	});
	it("未安装时返回 false", () => {
		const client = makeClient({ plugin: null });
		expect(client.isAvailable()).toBe(false);
	});
	it("未实现公共 API 的旧版本视为不可用", () => {
		const stale = { name: "nyalingo" } as unknown as Plugin;
		const client = makeClient({ plugin: stale });
		expect(client.isAvailable()).toBe(true); // 仅检测 getPlugin 是否非空
		expect(client.getConfig()).toBeNull(); // 但调用 API 时因无 translate 被视为不可用
	});
});

describe("NyaLingoClient.translate", () => {
	it("委托给 NyaLingo 并透传目标语言", async () => {
		const lingo = fakeLingo();
		const client = makeClient({ plugin: lingo });
		const out = await client.translate("hello", { to: "ja" });
		expect(out).toBe("译:hello");
		expect(lingo.translate).toHaveBeenCalledWith("hello", { to: "ja" });
	});
	it("未安装时触发 onMissing 并抛可读错误", async () => {
		const onMissing = vi.fn();
		const client = makeClient({ plugin: null, onMissing });
		await expect(client.translate("hello")).rejects.toThrow(/NyaLingo/);
		expect(onMissing).toHaveBeenCalled();
	});
});

describe("NyaLingoClient helpers", () => {
	it("healthCheck 未安装时返回 false", async () => {
		const client = makeClient({ plugin: null });
		expect(await client.healthCheck()).toBe(false);
	});
	it("testConnection 未安装时返回可读 detail", async () => {
		const client = makeClient({ plugin: null });
		const r = await client.testConnection();
		expect(r.ok).toBe(false);
		expect(r.detail).toContain("未检测到");
	});
	it("openSettingsOrWizard 未安装时触发 onMissing", () => {
		const onMissing = vi.fn();
		const client = makeClient({ plugin: null, onMissing });
		client.openSettingsOrWizard();
		expect(onMissing).toHaveBeenCalled();
	});
	it("getTargetLanguage 未安装时返回空串", () => {
		const client = makeClient({ plugin: null });
		expect(client.getTargetLanguage()).toBe("");
	});
	it("onSettingsChange 未安装时返回 noop", () => {
		const client = makeClient({ plugin: null });
		const unsub = client.onSettingsChange(() => undefined);
		expect(typeof unsub).toBe("function");
		expect(() => unsub()).not.toThrow();
	});
});
