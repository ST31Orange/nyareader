# NyaReader

多格式电子书阅读器 Obsidian 插件：EPUB / PDF / MOBI / AZW3 / TXT，带书架管理、即划即译与批注。

> 与 NyaHome / AmberNyaDesk 相互独立，是单独的插件。

## 功能

- **格式支持**：EPUB、PDF、MOBI、AZW3、TXT
- **书架主页**：管理你的图书库（新建区域/文件夹、拖拽导入、删除、排序），卡片显示标题+作者+阅读进度+最近阅读
- **阅读版式**：分页/滚动、目录导航、进度记忆、字号/行距/边距调节、日间/夜间/护眼主题、单栏/双栏
- **紧凑布局**：常用按钮进 Obsidian 标题栏那一行 + 细高可折叠工具栏，最大化阅读区；点「翻译」开启划词翻译（按钮变色激活，右侧 320px 翻译面板）
- **即划即译**：选中文本后右侧面板立即显示译文
- **翻译引擎**：委托独立插件 **NyaLingo**（离线 MTranServer / 在线 OpenAI 兼容 / DeepL），配置只存一份，NyaReader 只留目标语言设置
- **批注**：高亮、笔记；PDF 写入文件本身（自动备份），其他格式侧车存储 `.annotations.json`

## 安装（本地部署）

把 `main.js`、`manifest.json`、`styles.css`、`pdf.worker.min.mjs` 复制到：

```
<Vault>/.obsidian/plugins/nyareader/
```

启用插件后，命令面板运行「打开书架…」或「打开电子书…」，或右键支持的电子书文件选择「用 NyaReader 打开」。

## 翻译（需 NyaLingo）

NyaReader 的翻译由独立插件 **NyaLingo** 提供（两者共用一套翻译基础设施）：

1. 安装并启用 **NyaLingo**（单独 GitHub 库 https://github.com/ST31Orange/nyalingo ，BRAT 安装）。
2. 在 NyaLingo 设置中配置：离线翻译（MTranServer，点「打开安装向导」分步引导）或在线翻译（OpenAI 兼容 / DeepL）。
3. 回到 NyaReader 设置可测试连接、选择目标语言；阅读时点标题栏「翻译」按钮开启划词翻译。

> 未安装 NyaLingo 时，NyaReader 翻译不可用，并会提示安装引导。

## 开发

```bash
npm install
npm run dev        # 监听构建
npm run build      # 类型检查 + 生产构建（自动复制 pdf.worker.min.mjs）
npm test           # 运行 Vitest 单元测试
```

## 测试

48 个单元测试覆盖：PDF 坐标换算、PDF 批注写入与回读、PalmDOC 解压、MOBI HTML 提取、TXT 编码检测与章节识别、NyaLingo 客户端探测与降级、书架扫描/分组/导入/排序、翻译分块、设置归一化。

## 已知限制

- MOBI/AZW3 为"尽力而为"解析（PalmDOC 解压 + HTML 提取）；复杂文件建议用 Calibre 转换为 EPUB。
- 仅桌面端（`isDesktopOnly: true`）。
- 翻译依赖 NyaLingo 插件（建议与 NyaHome/NyaReader 一同安装）。
