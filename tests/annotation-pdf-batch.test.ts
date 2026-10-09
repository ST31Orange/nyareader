/**
 * PDF 批注 P0 新增能力的单测：
 * ① 节流合并用的 `applyBatchAndWrite()`：一批 N 条 = 一次备份 + 一次读 + 一次写，且 N 条都在文件里；
 * ② `isEncryptedPdfError()`：真实 `EncryptedPDFError` 实例必须被识别（加密 PDF 兜底的前提）；
 * ③ 备份只在首次创建（一批多条不会产生多份备份）。
 */
import { describe, it, expect } from "vitest";
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFString, EncryptedPDFError } from "pdf-lib";
import { PdfInlineAnnotationStore } from "../src/services/annotations/PdfInlineAnnotationStore";
import { PdfBackupService } from "../src/services/annotations/PdfBackupService";
import { isEncryptedPdfError, type WriteAnnotationInput } from "../src/services/annotations/PdfAnnotationWriter";

/** 内存 vault 适配器 + 最小 plugin 形状（只实现被测代码用到的部分）。 */
function memoryPlugin(seed: Record<string, ArrayBuffer | string> = {}) {
	const files = new Map<string, ArrayBuffer | string>(Object.entries(seed));
	const writes: string[] = [];
	const adapter = {
		read: async (p: string) => {
			const v = files.get(p);
			if (typeof v !== "string") throw new Error(`ENOENT: ${p}`);
			return v;
		},
		write: async (p: string, d: string) => {
			writes.push(p);
			files.set(p, d);
		},
		readBinary: async (p: string) => {
			const v = files.get(p);
			if (!(v instanceof ArrayBuffer)) throw new Error(`ENOENT: ${p}`);
			return v;
		},
		writeBinary: async (p: string, d: ArrayBuffer) => {
			writes.push(p);
			files.set(p, d);
		},
		exists: async (p: string) => files.has(p),
		mkdir: async () => undefined,
	};
	const plugin = { manifest: { dir: "plugins/nyareader/" }, app: { vault: { adapter } } };
	return { plugin: plugin as never, files, writes };
}

function input(id: string, pageIndex: number, x: number): WriteAnnotationInput {
	return {
		id,
		pageIndex,
		kind: "highlight",
		quad: [
			{ x, y: 690 },
			{ x, y: 710 },
			{ x: x + 120, y: 710 },
			{ x: x + 120, y: 690 },
		] as WriteAnnotationInput["quad"],
		pageWidth: 612,
		pageHeight: 792,
		text: `选中文本 ${id}`,
		note: undefined,
		color: "yellow",
		author: "NyaReader",
	};
}

async function annotIdsOf(bytes: Uint8Array): Promise<string[]> {
	const doc = await PDFDocument.load(bytes.slice().buffer as ArrayBuffer);
	const page = doc.getPage(0);
	const annotsRef = page.node.Annots();
	if (!annotsRef) return [];
	const arr = annotsRef instanceof PDFArray ? annotsRef : ((await doc.context.lookup(annotsRef)) as PDFArray | null);
	if (!(arr instanceof PDFArray)) return [];
	const ids: string[] = [];
	for (const ref of arr.asArray()) {
		const dict = doc.context.lookup(ref);
		const marker = dict instanceof PDFDict ? dict.get(PDFName.of("NyaReader")) : undefined;
		if (marker instanceof PDFString) ids.push(marker.asString());
	}
	return ids;
}

describe("applyBatchAndWrite（PDF 写回节流合并）", () => {
	it("一批 3 条：一次写盘、3 条注释都在文件里、只备份一次", async () => {
		const doc = await PDFDocument.create();
		doc.addPage([612, 792]);
		const original = (await doc.save()).slice().buffer as ArrayBuffer;
		const { plugin, files, writes } = memoryPlugin({ "books/A.pdf": original });
		const store = new PdfInlineAnnotationStore(plugin, new PdfBackupService(plugin));

		const result = await store.applyBatchAndWrite("books/A.pdf", [input("n1", 0, 60), input("n2", 0, 200), input("n3", 0, 340)]);

		const ids = await annotIdsOf(result.bytes);
		expect(ids.sort()).toEqual(["n1", "n2", "n3"]);
		// 写盘次数：1 次备份 + 1 次批注文件 + 1 次备份索引 = 3（而不是每条各写一次）
		expect(writes.filter((p) => p === "books/A.pdf")).toHaveLength(1);
		expect(writes.filter((p) => p.includes(".backup-"))).toHaveLength(1);
		expect(writes).toHaveLength(3);
		// 备份内容与原始文件一致
		const backupPath = writes.find((p) => p.includes(".backup-"))!;
		expect(new Uint8Array(files.get(backupPath) as ArrayBuffer)).toEqual(new Uint8Array(original));
		// 再写一批：备份复用，不再新增备份
		const second = await store.applyBatchAndWrite("books/A.pdf", [input("n4", 0, 480)]);
		expect(writes.filter((p) => p.includes(".backup-"))).toHaveLength(1);
		expect((await annotIdsOf(second.bytes)).sort()).toEqual(["n1", "n2", "n3", "n4"]);
	});

	it("空批次直接报错（调用方不应空转写盘）", async () => {
		const { plugin } = memoryPlugin();
		const store = new PdfInlineAnnotationStore(plugin, new PdfBackupService(plugin));
		await expect(store.applyBatchAndWrite("books/A.pdf", [])).rejects.toThrow(/批次为空/);
	});
});

describe("isEncryptedPdfError（加密 PDF 兜底的前提）", () => {
	it("真实的 pdf-lib EncryptedPDFError 必须被识别", () => {
		const err = new EncryptedPDFError();
		// 实测：pdf-lib 这个类**没有**设置 `name`（仍是 "Error"），所以只靠 name 判断会漏掉，
		// 消息里的 "encrypted" 兜底是**必需**的（否则加密 PDF 会被当成"写坏了"而报错而不是降级）。
		expect(err.name).toBe("Error");
		expect(isEncryptedPdfError(err)).toBe(true);
		expect(String(err.message)).toMatch(/encrypt/i);
	});

	it("名字丢失时按消息里的 encrypt 兜底识别", () => {
		const err = new Error("Input document to `PDFDocument.load` is encrypted.");
		expect(isEncryptedPdfError(err)).toBe(true);
	});

	it("其它错误不能被误判为加密（否则会错误地降级到侧车）", () => {
		expect(isEncryptedPdfError(new Error("写回校验失败：未找到 Highlight 注释"))).toBe(false);
		expect(isEncryptedPdfError(undefined)).toBe(false);
		expect(isEncryptedPdfError("boom")).toBe(false);
	});
});
