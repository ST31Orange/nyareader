# NyaReader

多格式电子书阅读器 Obsidian 插件：EPUB / PDF / MOBI / AZW3 / TXT，带书架管理、即划即译与批注。

> 与 NyaHome 相互独立，是单独的插件；翻译由配套插件 NyaLingo 提供。

## 功能

- **格式支持**：EPUB、PDF、MOBI、AZW3、TXT
- **书架主页**：管理图书库（新建区域/文件夹、拖拽导入、删除、排序、按区域切换显示模式），三种显示模式：
  - **完整**：封面 + 标题/作者 + 进度条 + 底部格式·进度·日期
  - **紧凑**：三行小卡片（加粗书名 / 作者 + 文件类型 / 整行进度条）
  - **列表**：一行书名 + 格式标识 + 进度
- **阅读版式**：
  - **分页 / 滚动**双模式切换（标题栏按钮）；
  - **单页 / 双页（对开）**布局：双页按 1|2 → 3|4 真实分页翻页；
  - 目录导航、进度记忆、字号/行距/边距调节、日间/夜间/护眼主题
- **紧凑布局**：阅读控件集中在 Obsidian 标题栏一行（书架 / 打开 / 目录 / 翻译 / 页码·缩放 / 高亮 / 笔记 / 批注 / 更多），最大化阅读区；右侧翻译面板默认 320px、可拖拽调宽；点「翻译」开启划词翻译（按钮变色激活）
- **即划即译**：选中文本后右侧面板立即显示译文，可修改原文后重新翻译
- **翻译引擎**：委托独立插件 **NyaLingo**（离线 MTranServer / 在线 OpenAI 兼容 / DeepL），配置只存一份，NyaReader 只留目标语言设置
- **批注**：高亮、笔记；PDF 写入文件本身（自动备份），其他格式侧车存储 `.annotations.json`

## 安装（本地部署）

把 `main.js`、`manifest.json`、`styles.css`、`pdf.worker.min.mjs` 复制到：

```
<Vault>/.obsidian/plugins/nyareader/
```

启用插件后，命令面板运行「打开书架…」或「打开电子书…」，或右键支持的电子书文件选择「用 NyaReader 打开」。

## 翻译（自动安装 NyaLingo）

NyaReader 的翻译由独立插件 **NyaLingo** 提供（两者共用一套翻译基础设施）：

1. **首次运行会自动安装并启用 NyaLingo**（需联网；装好后重载 Obsidian 一次即可使用）。
2. 也可用命令「安装 / 修复 NyaLingo 翻译插件」，或在 NyaReader 设置页点「安装 / 修复 NyaLingo」。
3. 在 NyaLingo 设置中配置：离线翻译（MTranServer，默认地址 `http://127.0.0.1:8989`，内置中英互译）或在线翻译（OpenAI 兼容 / DeepL）。
4. 阅读时点标题栏「翻译」按钮开启划词翻译。

> 未安装 NyaLingo 时，NyaReader 翻译不可用并会提示安装引导。

## 开发

```bash
npm install
npm run dev        # 监听构建
npm run build      # 类型检查 + 生产构建（自动复制 pdf.worker.min.mjs）
npm test           # 运行 Vitest 单元测试
```

## 测试

99 个单元测试覆盖：PDF 坐标换算、PDF 批注写入与回读、PalmDOC 解压、MOBI HTML 提取、EPUB 封面提取、TXT 编码检测与章节识别、NyaLingo 客户端探测与降级、书架扫描/分组/导入/排序/删除、翻译分块、页码换算、设置归一化。

## 已知限制

- MOBI/AZW3 为"尽力而为"解析（PalmDOC 解压 + HTML 提取）；复杂文件建议用 Calibre 转换为 EPUB。
- 仅桌面端（`isDesktopOnly: true`）。
- 翻译依赖 NyaLingo 插件（NyaReader 首次运行会自动安装）。