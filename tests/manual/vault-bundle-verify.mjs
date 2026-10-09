/**
 * 复核：工作区与 vault 的 main.js 是否都包含本轮新增的文案。
 */
import { readFileSync } from "node:fs";

const VAULT = "C:/Users/ST31ORANGEJUICE/OneDrive - buaa.edu.cn/ST31___NOTES/NyaNotes/.obsidian/plugins/nyareader";
const esc = (s) =>
	[...s]
		.map((c) => (c.charCodeAt(0) > 127 ? "\\u" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0") : c))
		.join("");

const targets = ["默认翻页方式", "迁移位置", "填什么就搬到哪里", "个文件；"];
const ws = readFileSync("main.js", "utf8");
const vault = readFileSync(`${VAULT}/main.js`, "utf8");

console.log(`工作区 main.js ${ws.length}B / vault ${vault.length}B`);
console.log(`字节一致: ${readFileSync("main.js").equals(readFileSync(`${VAULT}/main.js`))}\n`);

let ok = true;
for (const s of targets) {
	const a = ws.includes(esc(s));
	const b = vault.includes(esc(s));
	if (!a || !b) ok = false;
	console.log(`${a && b ? "✓" : "✗"} ${s.padEnd(20)} 工作区=${a} vault=${b}`);
}
console.log(`\n${ok ? "两处都包含新文案，部署有效" : "有缺失"}`);
process.exitCode = ok ? 0 : 1;
