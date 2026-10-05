/** 离线引擎探测单测。 */
import { describe, it, expect } from "vitest";
import { probeOfflineServer, normalizeEndpoint } from "../src/services/translation/offline-probe";
import type { HttpTransport, HttpResponse } from "../src/utils/http";

function transport(handler: (url: string, method?: string) => HttpResponse | null): HttpTransport {
	return {
		async request(req) {
			const res = handler(req.url, req.method);
			if (!res) throw new Error("connection refused");
			return res;
		},
	};
}

describe("normalizeEndpoint", () => {
	it("去掉尾部斜杠", () => {
		expect(normalizeEndpoint("http://127.0.0.1:8989/")).toBe("http://127.0.0.1:8989");
	});
	it("空值处理", () => {
		expect(normalizeEndpoint("   ")).toBe("");
	});
});

describe("probeOfflineServer", () => {
	it("/languages 返回 2xx 判定运行中", async () => {
		const http = transport(() => ({ status: 200, body: JSON.stringify({ languages: ["zh", "en"] }), headers: {} }));
		const result = await probeOfflineServer(http, "http://127.0.0.1:8989");
		expect(result.running).toBe(true);
		expect(result.detail).toContain("2 种语言");
	});

	it("/languages 失败时回退到 /translate", async () => {
		const http = transport((url) => {
			if (url.endsWith("/languages")) return { status: 404, body: "not found", headers: {} };
			if (url.endsWith("/translate")) return { status: 200, body: JSON.stringify({ translatedText: "好" }), headers: {} };
			return null;
		});
		const result = await probeOfflineServer(http, "http://127.0.0.1:8989");
		expect(result.running).toBe(true);
	});

	it("无法连接判定未运行并给出错误", async () => {
		const http = transport(() => null);
		const result = await probeOfflineServer(http, "http://127.0.0.1:8989");
		expect(result.running).toBe(false);
		expect(result.error).toBeTruthy();
	});

	it("空地址直接返回未运行", async () => {
		const http = transport(() => ({ status: 200, body: "{}", headers: {} }));
		const result = await probeOfflineServer(http, "");
		expect(result.running).toBe(false);
		expect(result.error).toBe("未填写地址");
	});
});
