/**
 * 真实 EPUB 只读诊断：找出「打开慢 / 封面失败」的结构性原因。
 *
 * 只读用户文件，绝不写入。输出：
 * - zip 条目统计（总/未压缩字节、压缩率）
 * - 按类别聚合：正文 xhtml / 图片 / 字体 / 样式
 * - spine 章节数、每章未压缩大小分布（最大/中位/最小）
 * - 封面链路：OPF cover 声明 → 图片大小 → 是否超过阈值
 * - 解析各阶段耗时（JSZip.load / OPF / 切章）
 *
 * 用法：node tests/manual/diagnose-epub.mjs "<epub 路径>"
 */
import { readFileSync } from "node:fs";
import JSZip from "jszip";

const path = process.argv[2];
if (!path) {
	console.error("用法: node tests/manual/diagnose-epub.mjs <epub 路径>");
	process.exit(2);
}

const bytes = readFileSync(path);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
console.log(`文件: ${path}`);
console.log(`大小: ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);

const t0 = performance.now();
const zip = await JSZip.loadAsync(buffer);
const tLoad = performance.now() - t0;
console.log(`JSZip.loadAsync: ${tLoad.toFixed(1)} ms`);

// ---- 条目统计 ----
const entries = [];
zip.forEach((relPath, file) => {
	if (file.dir) return;
	const size = file._data?.uncompressedSize ?? 0;
	const csize = file._data?.compressedSize ?? 0;
	entries.push({ relPath, size, csize });
});
const totalUncompressed = entries.reduce((a, e) => a + e.size, 0);
const totalCompressed = entries.reduce((a, e) => a + e.csize, 0);
console.log(`条目数: ${entries.length}`);
console.log(`未压缩总计: ${(totalUncompressed / 1024 / 1024).toFixed(2)} MB（压缩后 ${(totalCompressed / 1024 / 1024).toFixed(2)} MB）`);
console.log(`膨胀率: ${(totalUncompressed / bytes.length).toFixed(2)}×`);

const cat = (p) => {
	const lower = p.toLowerCase();
	if (/\.(xhtml|html|htm)$/.test(lower)) return "正文 xhtml";
	if (/\.(jpe?g|png|gif|webp|svg)$/.test(lower)) return "图片";
	if (/\.(ttf|otf|woff2?|ttc)$/.test(lower)) return "字体";
	if (/\.css$/.test(lower)) return "样式";
	if (/\.(ncx|opf|xml)$/.test(lower)) return "OPF/NCX/XML";
	return "其它";
};
const byCat = {};
for (const e of entries) {
	const c = cat(e.relPath);
	byCat[c] ??= { count: 0, bytes: 0, max: { relPath: "", size: 0 } };
	byCat[c].count++;
	byCat[c].bytes += e.size;
	if (e.size > byCat[c].max.size) byCat[c].max = { relPath: e.relPath, size: e.size };
}
console.log("\n按类别（未压缩字节）:");
for (const [c, v] of Object.entries(byCat).sort((a, b) => b[1].bytes - a[1].bytes)) {
	console.log(`  ${c.padEnd(14)} ${String(v.count).padStart(5)} 个  ${(v.bytes / 1024 / 1024).toFixed(2).padStart(8)} MB  最大=${(v.max.size / 1024 / 1024).toFixed(2)}MB ${v.max.relPath.slice(0, 60)}`);
}

// ---- OPF / spine ----
const containerXml = await zip.file("META-INF/container.xml")?.async("string");
const opfPath = /full-path=["']([^"']+)["']/.exec(containerXml ?? "")?.[1];
console.log(`\nOPF: ${opfPath}`);
const opf = opfPath ? await zip.file(opfPath)?.async("string") : null;
const dir = opfPath?.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";
const itemRe = /<item\b[^>]*>/gi;
const manifest = new Map();
let m;
while ((m = itemRe.exec(opf ?? "")) !== null) {
	const attrs = {};
	const re = /([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
	let a;
	while ((a = re.exec(m[0])) !== null) attrs[a[1]] = a[2] ?? a[3] ?? "";
	if (attrs.id) manifest.set(attrs.id, attrs);
}
const spineIds = [];
const ir = /<itemref\b[^>]*idref=["']([^"']+)["']/gi;
while ((m = ir.exec(opf ?? "")) !== null) spineIds.push(m[1]);
console.log(`manifest 条目: ${manifest.size}，spine 章节: ${spineIds.length}`);

const resolve = (href) => {
	const clean = href.split("#")[0].split("?")[0];
	const parts = (dir ? dir.split("/") : []).concat(clean.split("/"));
	const out = [];
	for (const p of parts) {
		if (!p || p === ".") continue;
		if (p === "..") { out.pop(); continue; }
		out.push(p);
	}
	return out.join("/");
};

const spineSizes = spineIds.map((id) => {
	const item = manifest.get(id);
	if (!item) return 0;
	const p = resolve(item.href);
	return zip.file(p)?._data?.uncompressedSize ?? 0;
}).filter((n) => n > 0);
const sorted = [...spineSizes].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
console.log(`章节未压缩大小: 最大 ${(Math.max(...spineSizes) / 1024).toFixed(0)}KB / 中位 ${(median / 1024).toFixed(0)}KB / 最小 ${(Math.min(...spineSizes) / 1024).toFixed(0)}KB`);
console.log(`前 2 章总计: ${((spineSizes[0] ?? 0) + (spineSizes[1] ?? 0) / 1024).toFixed(0)}KB  → 首屏只需这部分`);

// ---- 封面链路 ----
console.log("\n封面诊断:");
const coverMeta = /<meta\b[^>]*name=["']cover["'][^>]*content=["']([^"']+)["']/i.exec(opf ?? "")?.[1];
console.log(`  <meta name="cover"> = ${coverMeta ?? "(无)"}`);
let coverHref;
if (coverMeta) coverHref = manifest.get(coverMeta)?.href;
if (!coverHref) {
	for (const item of manifest.values()) {
		if (/cover/i.test(item.properties ?? "")) { coverHref = item.href; break; }
	}
}
console.log(`  properties=cover / meta 指向 = ${coverHref ?? "(无)"}`);
// 兜底：manifest 里第一个图片
let firstImage;
for (const item of manifest.values()) {
	if (/^image\//i.test(item["media-type"] ?? "")) { firstImage = item.href; break; }
}
console.log(`  manifest 首个图片 = ${firstImage ?? "(无)"}`);
const coverPath = coverHref ? resolve(coverHref) : null;
if (coverPath) {
	const f = zip.file(coverPath);
	const size = f?._data?.uncompressedSize ?? 0;
	console.log(`  封面文件: ${coverPath}  ${(size / 1024 / 1024).toFixed(2)} MB  ${f ? "存在" : "缺失!"}`);
	if (f) {
		const head = await f.async("uint8array");
		const sig = head.slice(0, 12);
		const isJpeg = sig[0] === 0xff && sig[1] === 0xd8;
		const isPng = sig[0] === 0x89 && sig[1] === 0x50;
		const isGif = sig[0] === 0x47 && sig[1] === 0x49;
		const isWebp = String.fromCharCode(...sig.slice(0, 4)) === "RIFF";
		console.log(`  魔数: ${isJpeg ? "JPEG" : isPng ? "PNG" : isGif ? "GIF" : isWebp ? "WEBP" : `未知 [${Array.from(sig.slice(0, 4)).map((b) => b.toString(16)).join(" ")}]`}`);
	}
}
// 所有候选封面（按大小）
const imageItems = [...manifest.values()].filter((i) => /^image\//i.test(i["media-type"] ?? ""));
console.log(`  manifest 图片条目: ${imageItems.length}`);
const bigImages = imageItems
	.map((i) => ({ href: i.href, size: zip.file(resolve(i.href))?._data?.uncompressedSize ?? 0 }))
	.sort((a, b) => b.size - a.size)
	.slice(0, 5);
for (const b of bigImages) console.log(`    ${(b.size / 1024 / 1024).toFixed(2).padStart(6)} MB  ${b.href}`);

// ---- 字体（可能拖慢 iframe 渲染）----
const fonts = entries.filter((e) => cat(e.relPath) === "字体");
if (fonts.length) {
	console.log("\n内嵌字体（iframe 渲染时要解码，可能是卡顿来源）:");
	for (const f of fonts.sort((a, b) => b.size - a.size).slice(0, 8)) {
		console.log(`    ${(f.size / 1024 / 1024).toFixed(2).padStart(6)} MB  ${f.relPath}`);
	}
}

// ---- 解析 OPF 耗时 ----
const t1 = performance.now();
await zip.file(opfPath)?.async("string");
console.log(`\n读取 OPF: ${(performance.now() - t1).toFixed(1)} ms`);
