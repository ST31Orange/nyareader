# NyaReader

多格式电子书阅读器 Obsidian 插件：EPUB / PDF / MOBI / AZW3 / TXT，带即划即译与批注。

> 与 NyaHome / AmberNyaDesk 相互独立，是单独的插件。

## 功能

- **格式支持**：EPUB、PDF、MOBI、AZW3、TXT
- **阅读版式**：分页/滚动、目录导航、进度记忆、字号/行距/边距调节、日间/夜间/护眼主题、单栏/双栏
- **即划即译**：选中文本后右侧面板立即显示译文
- **翻译引擎**：离线翻译（MTranServer，默认）、在线翻译（OpenAI 兼容 API / DeepL）
- **批注**：高亮、笔记；PDF 写入文件本身（自动备份），其他格式侧车存储 `.annotations.json`

## 安装（本地部署）

把 `main.js`、`manifest.json`、`styles.css`、`pdf.worker.min.mjs` 复制到：

```
<Vault>/.obsidian/plugins/nyareader/
```

启用插件后，在命令面板运行「打开电子书…」，或右键支持的电子书文件选择「用 NyaReader 打开」。

## 翻译配置

打开 设置 → 第三方插件 → NyaReader：

1. **离线翻译**（默认）：填写本地 MTranServer 地址（如 `http://127.0.0.1:8989`），可粘贴既有 `data.json` 中的 `translation` 配置一键迁移。
2. **在线翻译**：切换到「在线翻译」，选择 OpenAI 兼容 / DeepL，填写地址、密钥、模型。
3. 默认中英互译（源语言 auto → 目标中文），可切换目标语言。

## 开发

```bash
npm install
npm run dev        # 监听构建
npm run build      # 类型检查 + 生产构建（自动复制 pdf.worker.min.mjs）
npm test           # 运行 Vitest 单元测试
```

## 测试

36 个单元测试覆盖：PDF 坐标换算、PDF 批注写入与回读、PalmDOC 解压、MOBI HTML 提取、TXT 编码检测与章节识别、翻译 Provider（OpenAI/DeepL/MTranServer）、翻译缓存、设置归一化、翻译分块。

## 已知限制

- MOBI/AZW3 为"尽力而为"解析（PalmDOC 解压 + HTML 提取）；复杂文件建议用 Calibre 转换为 EPUB。
- 仅桌面端（`isDesktopOnly: true`）。
