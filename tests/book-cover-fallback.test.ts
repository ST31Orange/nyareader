/**
 * 封面提取：诊断分类 + 兜底候选链 + 大图跳过 + 缓存校验/迁移（服务层）。
 *
 * 背景：用户报"封面存在渲染失败的情况（《银河帝国》那本书）"。实测该书的
 * `extractEpubCover` 本身是成功的（234KB JPEG），所以本轮补的是**残缺/异常书**的兜底
 * 与**失败可诊断**，外加两处会导致"渲染失败"的真实坑：
 *   1) 旧 `cachePath` 少一个斜杠 -> 封面被写在插件根目录（`covers<fp>.cover`）；
 *   2) 缓存不复核魔数 -> 空/损坏缓存会被当作封面交给 `<img>`（必然解码失败）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import JSZip from "jszip";
import {
	MAX_COVER_BYTES,
	BookCoverService,
	extractEpubCoverDetailed,
	extractMobiCoverDetailed,
	isImageBytes,
} from "../src/services/books/BookCoverService";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

interface EpubSpec {
	metaCover?: string; // manifest id
	coverImageProp?: boolean;
	guideHref?: string;
	/** manifest 里额外放一张图片（用于"没有声明时退回首图"） */
	manifestImage?: { id: string; href: string; bytes: Uint8Array };
	spineFirstPageImage?: string;
	coverBytes?: Uint8Array;
	coverHref?: string;
	omitCoverFile?: boolean;
	/** manifest 里完全不声明封面条目（用于"没有 cover 声明"的兜底用例） */
	omitCoverItem?: boolean;
}

async function buildEpub(spec: EpubSpec): Promise<ArrayBuffer> {
	const zip = new JSZip();
	zip.file(
		"META-INF/container.xml",
		`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
	);
	const items: string[] = [];
	const coverHref = spec.coverHref ?? "Images/cover.jpg";
	if (!spec.omitCoverFile && spec.coverBytes) zip.file(`OEBPS/${coverHref}`, spec.coverBytes);
	const props = spec.coverImageProp ? ' properties="cover-image"' : "";
	if (!spec.omitCoverItem) items.push(`<item id="cover-img" href="${coverHref}" media-type="image/jpeg"${props}/>`);
	if (spec.manifestImage) {
		zip.file(`OEBPS/${spec.manifestImage.href}`, spec.manifestImage.bytes);
		items.push(`<item id="${spec.manifestImage.id}" href="${spec.manifestImage.href}" media-type="image/png"/>`);
	}
	zip.file("OEBPS/c1.xhtml", `<html><body>${spec.spineFirstPageImage ? `<p>x</p><img src="${spec.spineFirstPageImage}"/>` : "<p>hi</p>"}</body></html>`);
	items.push(`<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>`);
	if (spec.guideHref) zip.file(`OEBPS/${spec.guideHref}`, `<html><body><img src="Images/from-guide.jpg"/></body></html>`);
	if (spec.guideHref) zip.file(`OEBPS/Images/from-guide.jpg`, JPEG);
	zip.file(
		"OEBPS/content.opf",
		`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title>${
			spec.metaCover ? `<meta name="cover" content="${spec.metaCover}"/>` : ""
		}</metadata><manifest>${items.join("")}</manifest><spine><itemref idref="c1"/></spine>${
			spec.guideHref ? `<guide><reference type="cover" href="${spec.guideHref}"/></guide>` : ""
		}</package>`
	);
	return await zip.generateAsync({ type: "arraybuffer" });
}

describe("EPUB 封面：候选链兜底 + 失败原因分类", () => {
	it("没有 cover 声明时退回 manifest 第一张 image（source=first-manifest-image）", async () => {
		const buf = await buildEpub({ manifestImage: { id: "img1", href: "Images/a.png", bytes: PNG }, omitCoverItem: true });
		const r = await extractEpubCoverDetailed(buf);
		expect(r.image?.mime).toBe("image/png");
		expect(r.attempts.some((a) => a.source === "first-manifest-image" && a.ok)).toBe(true);
		expect(r.reason).toBeNull();
	});

	it("guide reference[type=cover] 指向封面页时取该页首图（source=guide-reference）", async () => {
		const buf = await buildEpub({ guideHref: "cover.xhtml", omitCoverFile: true });
		const r = await extractEpubCoverDetailed(buf);
		expect(r.image).not.toBeNull();
		expect(r.attempts.some((a) => a.source === "guide-reference" && a.ok)).toBe(true);
	});

	it("spine 第一页里的首图也能兜底（source=first-spine-image）", async () => {
		const zip = new JSZip();
		zip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`);
		zip.file("OEBPS/Images/p.png", PNG);
		zip.file("OEBPS/c1.xhtml", `<html><body><img src="Images/p.png"/></body></html>`);
		zip.file(
			"OEBPS/content.opf",
			`<package><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`
		);
		const r = await extractEpubCoverDetailed(await zip.generateAsync({ type: "arraybuffer" }));
		expect(r.image?.mime).toBe("image/png");
		expect(r.attempts.some((a) => a.source === "first-spine-image" && a.ok)).toBe(true);
	});

	it("声明了封面但文件缺失 -> reason=candidate-missing（且候选记录可读）", async () => {
		const r = await extractEpubCoverDetailed(await buildEpub({ metaCover: "cover-img", omitCoverFile: true }));
		expect(r.image).toBeNull();
		expect(r.reason).toBe("candidate-missing");
		expect(r.attempts[0]).toMatchObject({ source: "meta-cover", reason: "candidate-missing" });
	});

	it("声明了封面但它不是图片 -> reason=not-image", async () => {
		const r = await extractEpubCoverDetailed(
			await buildEpub({ metaCover: "cover-img", coverBytes: new TextEncoder().encode("这不是图片这是文本内容") })
		);
		expect(r.image).toBeNull();
		expect(r.reason).toBe("not-image");
	});

	it("封面 >8MB 直接跳过（不解压）-> reason=too-large，并记录声明大小", async () => {
		const huge = new Uint8Array(MAX_COVER_BYTES + 1024);
		huge.set([0xff, 0xd8, 0xff], 0);
		const r = await extractEpubCoverDetailed(await buildEpub({ metaCover: "cover-img", coverBytes: huge }));
		expect(r.image).toBeNull();
		expect(r.reason).toBe("too-large");
		const attempt = r.attempts.find((a) => a.reason === "too-large");
		expect(attempt?.bytes).toBeGreaterThan(MAX_COVER_BYTES);
	});

	it("不是 zip / 无 OPF -> reason=not-zip（不再静默 null）", async () => {
		const r = await extractEpubCoverDetailed(new TextEncoder().encode("not a zip").buffer as ArrayBuffer);
		expect(r.image).toBeNull();
		expect(r.reason).toBe("not-zip");
	});

	it("正常封面：meta 声明优先，attempts 标 ok 且带字节数", async () => {
		const r = await extractEpubCoverDetailed(await buildEpub({ metaCover: "cover-img", coverBytes: JPEG }));
		expect(r.image?.mime).toBe("image/jpeg");
		expect(r.reason).toBeNull();
		expect(r.attempts[0]).toMatchObject({ source: "meta-cover", ok: true, bytes: JPEG.length });
	});
});

describe("MOBI 封面：失败原因分类", () => {
	it("损坏输入 -> reason=broken-mobi", () => {
		expect(extractMobiCoverDetailed(new Uint8Array(4)).reason).toBe("broken-mobi");
	});
});

// ---------------------------------------------------------------- 服务层缓存

interface FakeAdapter {
	files: Map<string, Uint8Array>;
	removed: string[];
	mkdirs: string[];
}

function fakePlugin(adapter: FakeAdapter, bookBytes: Uint8Array) {
	return {
		manifest: { dir: ".obsidian/plugins/nyareader" },
		app: {
			vault: {
				readBinary: async () => bookBytes.slice().buffer as ArrayBuffer,
				adapter: {
					exists: async (p: string) => adapter.files.has(p),
					readBinary: async (p: string) => {
						const b = adapter.files.get(p);
						if (!b) throw new Error("missing");
						return b.slice().buffer as ArrayBuffer;
					},
					writeBinary: async (p: string, data: ArrayBuffer) => {
						adapter.files.set(p, new Uint8Array(data));
					},
					remove: async (p: string) => {
						adapter.removed.push(p);
						adapter.files.delete(p);
					},
					mkdir: async (p: string) => {
						adapter.mkdirs.push(p);
					},
				},
			},
		},
	} as never;
}

describe("BookCoverService：缓存校验 / 旧路径迁移 / 诊断", () => {
	let created: string[];
	let originalCreate: typeof URL.createObjectURL | undefined;
	let originalRevoke: typeof URL.revokeObjectURL | undefined;

	beforeEach(() => {
		created = [];
		originalCreate = URL.createObjectURL;
		originalRevoke = URL.revokeObjectURL;
		// Node 环境可能没有 createObjectURL：用可断言的替身
		(URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => {
			const url = `blob:test/${created.length}`;
			created.push(url);
			return url;
		};
		(URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
	});
	afterEach(() => {
		if (originalCreate) URL.createObjectURL = originalCreate;
		if (originalRevoke) URL.revokeObjectURL = originalRevoke;
	});

	const epubWithCover = async (): Promise<Uint8Array> =>
		new Uint8Array(await buildEpub({ metaCover: "cover-img", coverBytes: JPEG }));

	it("缓存不是图片：删除并重新提取（否则 <img> 必然解码失败）", async () => {
		const adapter: FakeAdapter = { files: new Map(), removed: [], mkdirs: [] };
		const book = await epubWithCover();
		adapter.files.set(".obsidian/plugins/nyareader/covers/fp1.cover", new TextEncoder().encode("坏缓存"));
		const diagnostics: unknown[] = [];
		const service = new BookCoverService(fakePlugin(adapter, book), (d) => diagnostics.push(d));
		const url = await service.getCoverUrl({ path: "a.epub", extension: "epub" } as never, "fp1");
		expect(url).toMatch(/^blob:test\//);
		expect(adapter.removed).toContain(".obsidian/plugins/nyareader/covers/fp1.cover");
		expect(isImageBytes(adapter.files.get(".obsidian/plugins/nyareader/covers/fp1.cover")!)).toBe(true);
		expect(diagnostics).toContainEqual(expect.objectContaining({ reason: "cache-invalid" }));
	});

	it("新缓存路径带斜杠：covers/<fp>.cover（旧代码少斜杠，会把文件写在插件根目录）", async () => {
		const adapter: FakeAdapter = { files: new Map(), removed: [], mkdirs: [] };
		const service = new BookCoverService(fakePlugin(adapter, await epubWithCover()), () => undefined);
		await service.getCoverUrl({ path: "a.epub", extension: "epub" } as never, "fp2");
		expect(adapter.files.has(".obsidian/plugins/nyareader/covers/fp2.cover")).toBe(true);
		expect(adapter.files.has(".obsidian/plugins/nyareader/coversfp2.cover")).toBe(false);
		expect(adapter.mkdirs).toContain(".obsidian/plugins/nyareader/covers");
	});

	it("旧路径 covers<fp>.cover 里的有效封面会被迁移到新路径并删除旧文件", async () => {
		const adapter: FakeAdapter = { files: new Map(), removed: [], mkdirs: [] };
		adapter.files.set(".obsidian/plugins/nyareader/coversfp3.cover", JPEG);
		const service = new BookCoverService(fakePlugin(adapter, await epubWithCover()), () => undefined);
		const url = await service.getCoverUrl({ path: "a.epub", extension: "epub" } as never, "fp3");
		expect(url).toMatch(/^blob:test\//);
		expect(adapter.files.has(".obsidian/plugins/nyareader/covers/fp3.cover")).toBe(true);
		expect(adapter.removed).toContain(".obsidian/plugins/nyareader/coversfp3.cover");
	});

	it("提取失败会通过 onDiagnostic 报出原因（不再静默）", async () => {
		const adapter: FakeAdapter = { files: new Map(), removed: [], mkdirs: [] };
		const diagnostics: Array<{ reason: string; detail?: string }> = [];
		// PDF/TXT 没有内嵌封面：unsupported-format
		const service = new BookCoverService(fakePlugin(adapter, new Uint8Array([1, 2, 3])), (d) => diagnostics.push(d));
		expect(await service.getCoverUrl({ path: "a.pdf", extension: "pdf" } as never)).toBeNull();
		expect(diagnostics[0]?.reason).toBe("unsupported-format");
	});

	it("clear() 延迟一代释放：在途 await 拿到的 URL 不会被立刻 revoke", async () => {
		const adapter: FakeAdapter = { files: new Map(), removed: [], mkdirs: [] };
		const revoked: string[] = [];
		(URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u) => revoked.push(u);
		const service = new BookCoverService(fakePlugin(adapter, await epubWithCover()), () => undefined);
		const url = await service.getCoverUrl({ path: "a.epub", extension: "epub" } as never, "fp4");
		expect(url).toBeTruthy();
		service.clear();
		expect(revoked).not.toContain(url);
		service.clear(); // 再清一次才释放上一代
		expect(revoked).toContain(url);
	});
});
