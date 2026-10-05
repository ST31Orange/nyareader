/** 翻译 Provider 与缓存单测：用注入的 fake HTTP transport 验证请求构造与响应解析。 */
import { describe, it, expect } from "vitest";
import { OpenAICompatibleProvider, DeepLProvider, MTranServerProvider, ITranslationProvider } from "../src/services/translation/providers/providers";
import { TranslationCache, translationKey } from "../src/services/translation/TranslationCache";
import type { HttpTransport, HttpResponse } from "../src/utils/http";
import type { TranslationSettings } from "../src/settings";

function fakeTransport(handler: (url: string, body: string, headers: Record<string, string>) => HttpResponse): HttpTransport {
	return {
		async request(req) {
			return handler(req.url, req.body ?? "", req.headers ?? {});
		},
	};
}

const baseConfig: TranslationSettings = {
	sourceLanguage: "auto",
	targetLanguage: "zh-Hans",
	mode: "online",
	provider: "openai",
	offlineEndpoint: "http://127.0.0.1:8989",
	offlineToken: "",
	openaiBaseUrl: "https://api.example.com/v1",
	openaiApiKey: "sk-test",
	openaiModel: "gpt-test",
	deeplApiKey: "deepl-key",
	deeplBaseUrl: "https://api-free.deepl.com/v2",
	timeoutMs: 5000,
	cacheEnabled: true,
	cacheMaxEntries: 100,
};

function cfg(patch: Partial<TranslationSettings> = {}): () => TranslationSettings {
	return () => ({ ...baseConfig, ...patch });
}

describe("OpenAICompatibleProvider", () => {
	it("构造正确的 chat/completions 请求并解析译文", async () => {
		const transport = fakeTransport((url, body, headers) => {
			expect(url).toBe("https://api.example.com/v1/chat/completions");
			expect(headers.Authorization).toBe("Bearer sk-test");
			const payload = JSON.parse(body) as { model: string; messages: Array<{ role: string }> };
			expect(payload.model).toBe("gpt-test");
			return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "你好" } }] }), headers: {} };
		});
		const p = new OpenAICompatibleProvider({ config: cfg(), http: transport });
		const result = await p.translateText("hello", false, "auto", "zh-Hans");
		expect(result.translatedText).toBe("你好");
	});

	it("HTTP 错误抛出可读信息", async () => {
		const transport = fakeTransport(() => ({ status: 401, body: "unauthorized", headers: {} }));
		const p = new OpenAICompatibleProvider({ config: cfg(), http: transport });
		await expect(p.translateText("hello", false, "auto", "zh-Hans")).rejects.toThrow(/401/);
	});
});

describe("DeepLProvider", () => {
	it("构造表单请求并解析译文", async () => {
		const transport = fakeTransport((url, body, headers) => {
			expect(url).toBe("https://api-free.deepl.com/v2/translate");
			expect(headers.Authorization).toBe("DeepL-Auth-Key deepl-key");
			expect(body).toContain("source_lang=auto");
			return { status: 200, body: JSON.stringify({ translations: [{ text: "こんにちは" }] }), headers: {} };
		});
		const p = new DeepLProvider({ config: cfg({ provider: "deepl" }), http: transport });
		const result = await p.translateText("hello", false, "auto", "ja");
		expect(result.translatedText).toBe("こんにちは");
	});
});

describe("MTranServerProvider", () => {
	it("兼容旧配置字段（endpoint/token）并解析 translatedText", async () => {
		const transport = fakeTransport((url, body, headers) => {
			expect(url).toBe("http://127.0.0.1:8989/translate");
			expect(body).toContain("from");
			void headers;
			return { status: 200, body: JSON.stringify({ translatedText: "你好" }), headers: {} };
		});
		const p = new MTranServerProvider({ config: cfg({ provider: "mtran", offlineEndpoint: "http://127.0.0.1:8989" }), http: transport });
		const result = await p.translateText("hello", false, "auto", "zh-Hans");
		expect(result.translatedText).toBe("你好");
	});

	it("未配置地址时抛出明确错误", async () => {
		const p = new MTranServerProvider({ config: cfg({ provider: "mtran", offlineEndpoint: "" }), http: fakeTransport(() => ({ status: 500, body: "", headers: {} })) });
		await expect(p.translateText("hello", false, "auto", "zh-Hans")).rejects.toThrow(/地址未配置/);
	});
});

describe("TranslationCache", () => {
	it("LRU 命中与淘汰", () => {
		const cache = new TranslationCache(null, 2);
		const k1 = translationKey("a", "auto", "zh-Hans", "openai");
		const k2 = translationKey("b", "auto", "zh-Hans", "openai");
		const k3 = translationKey("c", "auto", "zh-Hans", "openai");
		cache.set(k1, "一");
		cache.set(k2, "二");
		expect(cache.get(k1)).toBe("一"); // k1 被访问，变最近
		cache.set(k3, "三"); // 淘汰最旧的 k2
		expect(cache.get(k2)).toBeUndefined();
		expect(cache.get(k3)).toBe("三");
	});

	it("translationKey 区分 provider", () => {
		expect(translationKey("x", "auto", "zh-Hans", "openai")).not.toBe(translationKey("x", "auto", "zh-Hans", "deepl"));
	});
});

// 类型引用避免未使用告警
void (0 as unknown as ITranslationProvider);
