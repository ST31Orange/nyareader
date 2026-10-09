/**
 * 一键"验证 + 部署到本地 Obsidian"。
 *
 * 顺序（任一步失败即中止，不会把半成品部署出去）：
 *   1. npm run typecheck（0 error）
 *   2. npx vitest run（全绿）
 *   3. npm run build（产出 main.js / styles.css）
 *   4. 备份当前插件目录的代码文件（保留数据文件）
 *   5. 复制 4 个产物到 vault 插件目录，并校验字节一致
 *
 * 用法：
 *   node scripts/deploy-local.mjs            # 完整流程
 *   node scripts/deploy-local.mjs --skip-tests
 *
 * vault 路径可用环境变量 NYAR_VAULT 覆盖。
 */
import { execFileSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const VAULT =
	process.env.NYAR_VAULT ??
	"C:\\Users\\ST31ORANGEJUICE\\OneDrive - buaa.edu.cn\\ST31___NOTES\\NyaNotes";
const PLUGIN_DIR = join(VAULT, ".obsidian", "plugins", "nyareader");
const ARTIFACTS = ["main.js", "manifest.json", "styles.css", "pdf.worker.min.mjs"];
const skipTests = process.argv.includes("--skip-tests");

/** 在项目目录跑一个命令，实时继承 stdio（保留彩色输出）。 */
function run(label, cmd, args) {
	process.stdout.write(`\n=== ${label} ===\n`);
	execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
}

function stamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
	if (!existsSync(PLUGIN_DIR)) {
		console.error(`插件目录不存在：${PLUGIN_DIR}`);
		console.error("可用环境变量 NYAR_VAULT 指定 vault 路径。");
		process.exit(2);
	}

	// 1) 类型检查（这步失败通常意味着有人正在改代码，直接中止）
	try {
		run("typecheck", "npm", ["run", "typecheck"]);
	} catch {
		console.error("\n✗ typecheck 失败：可能有成员正在改代码。未部署。");
		process.exit(1);
	}

	// 2) 测试
	if (!skipTests) {
		try {
			run("vitest", "npx", ["vitest", "run", "--reporter=dot"]);
		} catch {
			console.error("\n✗ 测试未全绿：未部署。");
			process.exit(1);
		}
	}

	// 3) 构建
	try {
		run("build", "npm", ["run", "build"]);
	} catch {
		console.error("\n✗ 构建失败：未部署。");
		process.exit(1);
	}

	// 4) 备份（只备份代码文件，data.json / 索引 / 封面缓存不动）
	const backup = join(PLUGIN_DIR, `_backup-${stamp()}`);
	mkdirSync(backup, { recursive: true });
	for (const f of ARTIFACTS) {
		const src = join(PLUGIN_DIR, f);
		if (existsSync(src)) copyFileSync(src, join(backup, f));
	}
	process.stdout.write(`\n备份: ${backup}\n`);

	// 5) 部署 + 校验
	for (const f of ARTIFACTS) {
		const src = join(ROOT, f);
		if (!existsSync(src)) throw new Error(`构建产物缺失：${f}`);
		copyFileSync(src, join(PLUGIN_DIR, f));
	}
	let ok = true;
	for (const f of ARTIFACTS) {
		const a = readFileSync(join(ROOT, f));
		const b = readFileSync(join(PLUGIN_DIR, f));
		const same = a.equals(b);
		if (!same) ok = false;
		process.stdout.write(`  ${same ? "✓" : "✗"} ${f}  ${b.length} B\n`);
	}
	const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8"));
	process.stdout.write(`\n版本: ${manifest.version}  部署目录: ${PLUGIN_DIR}\n`);
	if (!ok) {
		console.error("✗ 部署后字节校验不一致！");
		process.exit(1);
	}
	process.stdout.write("\n✓ 已部署。请在 Obsidian 中关闭再启用 NyaReader（或 Ctrl+R）后测试。\n");
}

main();
