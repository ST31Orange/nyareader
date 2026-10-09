/**
 * 构建产物验证：确认关键文案确实进了 main.js。
 *
 * ⚠️ 两个坑（都踩过）：
 * 1. esbuild 默认 `charset` 会把非 ASCII 转义成 `\uXXXX`，所以**搜原文会 false**；
 * 2. 转义用的是**大写十六进制**（`\u9ED8`），按小写搜同样 false。
 *    因此必须按"大写转义形式"匹配，否则会误判成"没打进包"。
 */
import { readFileSync } from "node:fs";

const js = readFileSync("main.js", "utf8");
const esc = (s) =>
	[...s]
		.map((c) => (c.charCodeAt(0) > 127 ? "\\u" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0") : c))
		.join("");

const targets = [
	"默认翻页方式",
	"分页（一页一页翻）",
	"滚动（连续向下滚）",
	"迁移位置",
	"迁移 NyaReader 目录",
	"目标下若已有同名",
	"批注目录未能搬迁",
	"library 与 annotations 一并搬走",
	"默认版式",
];

let allOk = true;
for (const s of targets) {
	const direct = js.includes(s);
	const escaped = js.includes(esc(s));
	const ok = direct || escaped;
	if (!ok) allOk = false;
	console.log(`${ok ? "✓" : "✗"} ${s.padEnd(26)} 原文=${direct} 转义=${escaped}`);
}
console.log(`\n${allOk ? "全部文案已进产物" : "有文案缺失！"}`);
process.exitCode = allOk ? 0 : 1;
