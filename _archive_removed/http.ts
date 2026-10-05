/**
 * 基于 Obsidian requestUrl 的 HTTP 传输封装（桌面端可绕 CORS）。
 * 抽象为接口，便于单测时注入 fake transport。
 * 注意：RequestUrlParam 无 timeout 字段，超时由本层自实现。
 */
import { requestUrl, RequestUrlParam } from "obsidian";

export interface HttpResponse {
	status: number;
	body: string;
	headers: Record<string, string>;
}

export interface HttpRequest {
	url: string;
	method?: "GET" | "POST" | "PUT" | "DELETE";
	headers?: Record<string, string>;
	body?: string;
	timeoutMs?: number;
}

export interface HttpTransport {
	request(req: HttpRequest): Promise<HttpResponse>;
}

function timeoutError(ms: number): Error {
	return new Error(`HTTP 请求超时（${ms}ms）。`);
}

function withTimeout<T>(task: Promise<T>, ms: number | undefined): Promise<T> {
	if (ms === undefined) return task;
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(timeoutError(ms)), ms);
		task.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			}
		);
	});
}

/** Obsidian 官方 requestUrl 实现。 */
export const obsidianHttpTransport: HttpTransport = {
	async request(req) {
		const params: RequestUrlParam = {
			url: req.url,
			method: req.method ?? "GET",
			headers: req.headers ?? {},
			throw: false,
		};
		if (req.body !== undefined) params.body = req.body;
		const res = await withTimeout(requestUrl(params), req.timeoutMs);
		return { status: res.status, body: res.text, headers: res.headers };
	},
};

/** 简易 fetch 实现，供测试或非 Obsidian 环境使用。 */
export const fetchHttpTransport: HttpTransport = {
	async request(req) {
		return withTimeout(
			fetch(req.url, {
				method: req.method ?? "GET",
				headers: req.headers ?? {},
				body: req.body,
			}).then(async (res) => {
				const headers: Record<string, string> = {};
				res.headers.forEach((v, k) => {
					headers[k] = v;
				});
				return { status: res.status, body: await res.text(), headers };
			}),
			req.timeoutMs
		);
	},
};
