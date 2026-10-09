# NyaReader 批注/标记功能：现状盘点、成熟工具调研与改造方案

> 状态：调研 + 方案文档（**不含任何产品代码改动**）
> 编写：stream-h（Team NyaReader）
> 代码基线：`D:\DSH_AI\NyaJob`（行号取自本次阅读时的实际内容，若后续改动请以符号名检索）
> 结论标注约定：**【官方文档】**= 有官方规范/文档明确写明；**【推断】**= 我基于代码或经验的推断，未获官方文档确认；**【未验证】**= 环境或时间限制未能证实。

---

## 1. 现状盘点（如实描述）

### 1.1 相关代码地图

| 层 | 文件 | 关键符号（行号） |
| --- | --- | --- |
| 模型/接口 | `src/services/annotations/AnnotationModel.ts` | `Annotation`(9)、`AnnotationKind`(7)、`IAnnotationStore`(26)、`annotationId()`(40) |
| 侧车存储 | `src/services/annotations/SidecarAnnotationStore.ts` | `sidecarPath()`(23)、`readForBook()`(36)、`addForBook()`(48)、`updateForBook()`(56)、`removeForBook()`(65) |
| PDF 内联存储 | `src/services/annotations/PdfInlineAnnotationStore.ts` | 索引文件(26)、`applyToFile()`(89)、`deleteInPlace()`(102)、`verify()`(131) |
| PDF 写注释 | `src/services/annotations/PdfAnnotationWriter.ts` | `writePdfAnnotation()`(48)、`removePdfAnnotation()`(108)、`KIND_SUBTYPE`(30)、`COLOR_RGB`(36) |
| PDF 备份 | `src/services/annotations/PdfBackupService.ts` | `ensureBackup()`(41)、`restore()`(57) |
| 列表 UI | `src/view/AnnotationListModal.ts` | `refresh()`(48)、`buildRow()`(58)、`editNote()`(84)、`delete()`(103) |
| 视图入口 | `src/view/ReaderView.ts` | 标题栏按钮(490-492)、更多菜单(755-777)、`openAnnotations()`(781)、`addHighlight()`(933)、`addNote()`(938) |
| 控制器 | `src/view/ReaderController.ts` | `addAnnotation()`(783)、`listAnnotations()`(810)、`removeAnnotation()`(820)、`updateAnnotationNote()`(834)、`addPdfAnnotation()`(844) |
| 引擎接口 | `src/services/books/IReaderEngine.ts` | `AnnotationTarget`(43)、`currentLocation()`(67)、`getSelection()`(73)、`showAnnotation()`(75)、`hideAnnotation?()`(77) |
| PDF 引擎 | `src/services/books/formats/pdf/PdfEngine.ts` | `getSelection()`(779)、`showAnnotation()`(829)、`hideAnnotation()`(837)、`annotationKey()`(844)、`paintOverlay()`(849) |
| HTML 引擎（EPUB/MOBI） | `src/services/books/formats/mobi/HtmlDocEngine.ts` | `goTo()`(629)、`currentLocation()`(721)、`getSelection()`(1249)、`showAnnotation()`(1268) |
| TXT 引擎 | `src/services/books/formats/txt/TxtEngine.ts` | `goTo()`(156)、`currentLocation()`(212)、`getSelection()`(268)、`showAnnotation()`(285) |
| 设置 | `src/settings.ts` | `annotationSidecarSuffix`(54/91，默认 `.annotations`) |

### 1.2 当前**能**做什么

1. **划词创建批注**：选中文本后，点阅读器标题栏的「高亮」「笔记」按钮（`ReaderView.ts:490-491`），或在「更多」菜单里选「高亮选中文本 / 添加笔记」（`ReaderView.ts:759-760`）。创建时 `ReaderController.addAnnotation()` 读取 `engine.getSelection()`，失败则回退到 `lastSelection`（`ReaderController.ts:785`）。
2. **PDF 高亮是可见的**：`PdfEngine.showAnnotation()` 把目标记入 `this.annotations` 并重绘 overlay（`PdfEngine.ts:829-834`），`paintOverlay()` 在页面 overlay 层上按保存的 rects 画 `.nyareader-pdf-annotation-marker` 色块，并按「保存时缩放 / 当前缩放」比例缩放（`PdfEngine.ts:849-867`，样式 `styles.css:528-532`）。
3. **PDF 高亮可跨会话恢复（部分）**：打开 PDF 时从插件目录索引 `nyareader-pdf-annotations.json` 读取，逐条 `engine.showAnnotation(a.target)` 重绘（`ReaderController.ts:592-611`）。
4. **PDF 删除是真的删掉注释**：`deleteInPlace()` 用自定义键 `/NyaReader` 匹配后重建 `/Annots` 数组，并在找不到时报错而不是误删别人的注释（`PdfInlineAnnotationStore.ts:102-129`、`PdfAnnotationWriter.ts:108-134`）。写回后有回读校验：pdf.js 能解析 + pdf-lib 能查到预期 `Subtype`（`PdfInlineAnnotationStore.ts:89-96,131-162`）。
5. **批注列表弹窗**：列全部批注（按 `createdAt` 倒序）、每行可「跳转 / 编辑笔记 / 删除」（`AnnotationListModal.ts:48-76`）；跳转调用 `engine.goTo(a.location)`（`ReaderView.ts:787`）。
6. **笔记可编辑**：笔记用 `PromptModal` 多行编辑，落到 `updateAnnotationNote()`（`ReaderView.ts:938-950`、`ReaderController.ts:834-842`）。
7. **数据落地**：PDF → 写进 PDF 文件本体 + 插件目录索引 JSON；EPUB/MOBI/AZW3/TXT → 书籍同目录的侧车 JSON `<书名>.annotations.json`（`SidecarAnnotationStore.ts:22-27`，后缀可配置）。

### 1.3 当前**不能**做什么 / 已确认的缺陷

> 每条都给出代码证据。**D1–D4 是用户所说"功能很差"的核心原因。**

- **D1｜EPUB/MOBI/TXT 根本没有可见高亮。** 这两个引擎的 `showAnnotation()` 只做了一件事：`goTo(target.location)`（`HtmlDocEngine.ts:1268-1270`、`TxtEngine.ts:285-287`）；`hideAnnotation` 是可选的（`IReaderEngine.ts:77`），**只有 PdfEngine 实现了**（`PdfEngine.ts:837`）。全仓库搜不到任何高亮包裹逻辑（无 `nyar-hl`、无 `surroundContents`、无 CSS Custom Highlight API、无 overlay 层）。
- **D2｜非 PDF 批注在重新打开时完全不渲染。** 引擎挂载时只有 `pdf` 分支存在「读批注 → `showAnnotation`」的循环（`ReaderController.ts:606-610`）；`epub` / `mobi` / `txt` 分支没有任何等价逻辑，而 `sidecar` 仅在 add/list/remove/update 四个方法里被调用。结果：非 PDF 的批注只活在列表弹窗里，正文里看不见。
- **D3｜锚点弱到几乎不能叫"锚点"。** EPUB/MOBI 的 `location` 是**百分比 0~10000**（`HtmlDocEngine.ts:721-726`：分页时 `percentFromPage`，滚动时 `Math.round(percent*10000)`）；TXT 更糟：**滚动模式下 `location` 是段落索引，分页模式下是百分比 0~10000**（`TxtEngine.ts:156-173`），同一个字段两种语义 → 在滚动模式建的批注切到分页模式跳转必然错位（段落索引 800 会被当成 8%）。跳转误差随字号/页宽/窗口尺寸变化。
- **D4｜没有"冗余文本指纹"（textQuote）。** `Annotation` 只存 `text`（选中原文）和 `location`（`AnnotationModel.ts:9-24`），**没有**章节 href、字符偏移、前后文 before/after、CSS 选择器，也没有 `scale` 之外的几何冗余。因此内容一变或版式一变，除了"跳个大概位置"以外无法重新命中原文。
- **D5｜颜色字段是死的。** `addAnnotation()` 把颜色写死为 `"yellow"`（`ReaderController.ts:790`）；`IAnnotationStore.update()` 签名支持 `color`（`AnnotationModel.ts:32`）但 `updateAnnotationNote()` 只传 `note`（`ReaderController.ts:834-842`）；UI 无颜色选择；PDF 高亮色块 CSS 是写死的 `rgba(255,235,59,0.35)`（`styles.css:528-532`），不读 `annotation.color`。→ 数据里有 5 种颜色（`PdfAnnotationWriter.ts:36-42`），界面上一个都用不到（PDF 里的 `/C` 会写进去，所以在 Acrobat 里可能看到黄色；NyaReader 自己的 overlay 永远是黄的）。
- **D6｜`underline` 是死代码。** UI 只创建 `highlight` / `note`（`ReaderView.ts:933-951`），`KIND_SUBTYPE` 里的 `Underline` 永远不会被触发（`PdfAnnotationWriter.ts:30-34`）。
- **D7｜导出是死代码。** `exportJson()` 存在于接口和两个 store（`AnnotationModel.ts:36`、`PdfInlineAnnotationStore.ts:80`、`SidecarAnnotationStore.ts:89`），但全仓库**没有任何调用点**（grep `exportJson` 只有定义）；且 Sidecar 版本直接 `throw`（`SidecarAnnotationStore.ts:89-91`）。→ 用户无法把批注导出成 Markdown/JSON。
- **D8｜列表很原始。** 只有「时间倒序」一种排序（`AnnotationListModal.ts:49`），**与书中位置无关**；没有搜索、没有按颜色/类型过滤、没有分组、没有导出按钮、没有"定位到原文并闪烁强调"。
- **D9｜划词后没有任何浮层。** 全仓库没有 `selectionchange` / 选区浮层 / 选区工具栏（grep 无命中），入口只有标题栏按钮和「更多」菜单（`ReaderView.ts:490-492,755-761`）。移动端/触屏上这一步尤其难受（需要先把视线移到标题栏）。
- **D10｜并发与同步没有保护。** 侧车每次增删改都「全量读 → 全量写」（`SidecarAnnotationStore.ts:48-77`），没有锁、没有版本号、没有冲突合并。PDF 索引 `PdfInlineAnnotationStore` 是把整表驻留内存、每次 `persist()` 全量覆盖（`PdfInlineAnnotationStore.ts:30-44`），两个窗口同时开同一本书就会互相覆盖（**【推断】**：Obsidian 同 vault 多窗口场景）。
- **D11｜侧车文件名丢掉了原扩展名，可能串书。** `sidecarPath()` 取「最后一个点之前」的部分再加后缀（`SidecarAnnotationStore.ts:23-27`）：`MyBook.epub` → `MyBook.annotations.json`，而 `MyBook.pdf` → **同一个** `MyBook.annotations.json`。同目录下同名不同格式的书会共享批注。
- **D12｜两套 id 生成规则。** 侧车/PDF 索引用 `a<ts36><rand>`（`AnnotationModel.ts:40-42`），而 `addPdfAnnotation()` 自己生成 `nyar-<ts36>-<rand>`（`ReaderController.ts:849`）——正好也是写进 PDF `/NyaReader` 键的那个值。两套规则没有统一函数。
- **D13｜存储抽象只完成了一半。** `SidecarAnnotationStore.list()` 直接 `return []`，`add/update/remove/exportJson` 一律 `throw "请使用 xxxForBook"`（`SidecarAnnotationStore.ts:29-33,79-91`）。`ReaderController` 因此绕过接口直接调 `readForBook/addForBook/...`。→ `IAnnotationStore` 实际上不可替换，未来想换 Markdown 存储必须动 Controller。
- **D14｜PDF 写回文件模型的风险。**
  - 每加/删一条批注都整体重写 PDF 文件（`ReaderController.ts:877` 的 `writeBinary`、`PdfInlineAnnotationStore.ts:108`），大 PDF 会明显卡顿，且会让外部同步（Syncthing/iCloud）反复上传整本大文件；**【推断】** 也会让其他阅读器（Acrobat/Calibre）的缓存/书签失效。
  - 备份只在**第一次**创建（`PdfBackupService.ts:41-45` 命中索引就直接返回），因此备份是"原始版本"，这本身是合理的，但 **`restore()` 没有任何 UI 调用点**（grep `restore(` 只有定义）→ 备份文件在界面上无法恢复，用户只能手动去找 `xxx.backup-<ts>.pdf`。
  - 备份文件是 `.pdf` 且落在 vault 里（`PdfBackupService.ts:48`）。**【未验证】** 书库扫描/书架是否会把 `*.backup-*.pdf` 当书列出——若会，就既是噪音也是遍历成本。
  - 索引文件在插件目录 `nyareader-pdf-annotations.json`（`PdfInlineAnnotationStore.ts:26-28`），不在书旁边，也不算"可读可 grep 的笔记"。
- **D15｜PDF 注释写法规格细节（细节但对外部阅读器有影响）。**
  - `QuadPoints` 的注释说明写作「左下、右下、左上、右上」（`PdfAnnotationWriter.ts:19-21`），而 PDF 规范常用的顺序是 **左上、右上、左下、右下**——顺序不同在 Acrobat/Preview 里可能表现为高亮框错位/交叉。详见 §2.7。
  - `/M` 用 `new Date().toISOString()`（`PdfAnnotationWriter.ts:64`），规范要求 `D:YYYYMMDDHHmmSS` 形式。
  - 未写 `/NM`（注释名），而是用自定义键 `/NyaReader`（`:69`）；未生成 `/AP` 外观流；`Rect` 先写 `[0,0,0,0]` 再被覆盖（`:60,:82`）。
  - note 类型的 `Contents` 在无笔记时回退成选中文本（`:65`），导致 PDF 里分不出「高亮」和「带笔记的高亮」。
- **D16｜没有去重、没有撤销。** 同一段文字连续点两次「高亮」会得到两条批注（PDF 会往文件里写两个重叠 QuadPoints）。删除没有 undo，也没有「确认」对话框（`AnnotationListModal.ts:103-111` 直接删）。
- **D17｜"笔记"不是"给高亮加笔记"。** `note` 类型是独立的一条批注（PDF 里是 `/Text` 便签），与高亮是两条平级记录（`ReaderController.ts:783-806`）。用户想「先高亮再加笔记」只能得到两条不相关的记录，列表里也并排显示。
- **D18｜测试覆盖不均。** `tests/pdf-annotation.test.ts` 只覆盖 PDF writer 的写入/删除/校验；**没有任何**针对 Sidecar 存储、锚点恢复、列表 UI 的测试（grep `tests/**` 里 `Annotation` 仅命中该文件）。

### 1.4 一句话总结现状

> PDF 走通了「写进文件 + 可见 + 能删 + 能校验」这条最难的路，但**没有颜色、没有笔记与高亮的关联、文件重写成本高**；
> 而 EPUB/MOBI/TXT **连"看见高亮"都没做到**，锚点只有一个随版式漂移的百分比，数据存成不可读的 JSON，还带着串书和并发覆盖的隐患。
> 用户感知到的"很差"，本质是 **D1（看不见）+ D2（重开不渲染）+ D3/D4（锚点不可靠）+ D7/D8（不能导出/检索/管理）**。

---

## 2. 成熟工具调研

> 说明：`github.com` 在本环境常被拒（non-public IP），因此 GitHub 上的仓库文件改用 **jsDelivr 镜像**（`cdn.jsdelivr.net/gh/...`）读取；读到的是仓库里同一份文件内容。
> 【官方】= 规范/官方文档/官方源码；【第三方】= 非官方但可信的技术资料；【未验证】= 我没能读到原文，只给出 URL。

### 2.1 Readium：Locator 模型（本次调研里最有参考价值的一套模型）

来源：[Readium Architecture — Locators](https://readium.org/architecture/models/locators/)、[Locations for HTML Documents（HTML 扩展）](https://readium.org/architecture/models/locators/extensions/html.html)、[Best Practices for Locators per Format](https://readium.org/architecture/models/locators/best-practices/format.html)、[R2 Locator Architecture](https://readium.org/technical/r2-locator-architecture/)。均为官方文档站，已实际抓取正文。**【官方】**

- **每个 Locator 必须带资源引用**：`href`（资源 URI，**不允许**指向资源内部 fragment）+ `type`（media type）；可选 `title`、`locations`、`text`。
- **`locations` 是"同一位置的多种表达"**，而不是一个字段装所有信息：`fragments`（数组，媒体相关，如 PDF 的 `page=12`、`viewrect=50,50,640,480`）、`progression`（资源内百分比 0~1）、`position`（整本出版物内的序号，整数 >0）、`totalProgression`（整本百分比 0~1）。
- **HTML 扩展**追加 `cssSelector`、`partialCfi`、`domRange`。其中 `partialCfi` = **去掉 OPF spine 那一段（第一个 `!` 之前）的"右半边" CFI**，而且不带 `epubcfi(...)` 外壳；`domRange` = `{start:{cssSelector, textNodeIndex, charOffset?}, end?:…}`，即"可序列化的 DOM Range"（元素 + 第几个文本节点 + 字符偏移）。
- **`text` 对象就是"冗余文本指纹"**：`before` / `highlight` / `after` 三段（对应我们说的 prefix / exact / suffix）。官方明文规定：在 range 场景下 `text` **必须**用"原始 DOM 字符数据"（含无意义的空白）填充，以便消费方拿它去匹配原文；面向用户展示前才做清洗。
- **官方"按格式的最佳实践"直接给出了批注的最小充分字段集**（这是我最想抄的一条）：
  - EPUB 的 **Highlights/Annotations**：`href`、`type`、`text`、`locations.progression`，以及 `locations` 里 **`cssSelector` / `domRange` / `partialCfi` 三者至少一个**；建议再加 `totalProgression`、`position`。
  - PDF 的 **Highlights/Annotations**：`href`、`type`、`text`、`locations.fragments` 里的 `page` **和** `viewrect`、`locations.progression`、`locations.position`；建议加 `totalProgression`。
  - 即：**"文本片段 + 结构定位 + 百分比兜底"三层同时存**，缺一层就能降级但会退化。这一点直接印证了 D3/D4 是根本问题。
- Readium 另有独立的 annotations 仓库（`readium/annotations`，模型 + JSON 序列化），但 **【未验证】**：该仓库在 GitHub 上，本环境未能读取正文；上面所有结论均来自 readium.org 官方文档站。参考链接：[readium/annotations](https://github.com/readium/annotations)。

### 2.2 EPUB CFI：EPUB 锚点的事实标准，以及它的"坑"

来源：[EPUB Canonical Fragment Identifiers 1.1（W3C EPUB WG 规范草稿站）](https://w3c.github.io/epub-specs/epub33/epubcfi/)、[IDPF 原版 CFI 规范](https://idpf.org/epub/linking/cfi/epub-cfi.html)、[W3C Selectors and States（CFI 被列为 EPUB3 的 FragmentSelector 规范）](https://www.w3.org/TR/selectors-states/)。**【官方】**（CFI 1.1 已实抓全文）

- **形态**：`epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/3:10)`。`/` 走 XML 子节点（元素偶数、字符数据块奇数），`[id]` 是 ID 断言，`!` 是"步进到被引用文档"（spine itemref → manifest item href，或 iframe/embed/object/image 的引用属性），`:` 是字符偏移（**基于 UTF-16 code unit，且是 0 基、"字符之间"的位置**），`~` 时间偏移、`@` 空间偏移（0~100）。
- **range 写法**：`epubcfi(P,S,E)` = 父路径 + 起子路径 + 止子路径；起止必须按文档顺序非递减。
- **为什么它是事实标准**（规范自述设计目标，逐条来自原文）：跨阅读系统互操作；不修改文档即可指向任意位置；同一逻辑位置的不同 CFI 比较后应相等；不需要打开文件就能排序比较；可高效解析；**"references should be able to recover their target locations through parser variations and document revisions"**。
- **抗变动的两个机制（重点）**：① **ID 断言** `[chap01ref]`；② **文本位置断言** `[yyy]`（前文）/ `[xx,y]`（前文,后文），可在字符偏移后附带，用于校验并**纠偏**（规范的 "Intended target location correction" 一节）。纠偏失败时：**"the CFI MUST be considered an invalid reference"**。
- **坑 1：坑来自"断言是可选信息"，很多实现不写断言**。规范说断言本来就是为了"improve the robustness…and migrating them from one revision of the document to another"；**如果不写断言，路径就纯粹依赖节点序号，文献一改版/换解析器就会漂移**。规范还规定：排序/比较前**必须整体剥掉所有方括号断言**——也就是说 CFI 字符串本身不承载"抗变动"信息，靠的是括号里的冗余。
- **坑 2：跨阅读系统差异**。Readium 的官方最佳实践把 `cssSelector` / `domRange` / `partialCfi` 并列成"三者选一"，并明确 `partialCfi` 只是"CFI 的右半边、不带 epubcfi 外壳"——说明**CFI 不是唯一且不是必选的锚点方案**；不同引擎产出的 CFI 细节（尤其断言内容）并不统一。**【官方（Readium）+ 推断】**
- **坑 3：UTF-16 vs Unicode 码点**。CFI 偏移按 UTF-16 code unit 计数（规范原文），而 W3C Text Quote/Position Selector 明确要求按 **Unicode code points** 计数。两者在含 emoji/罕见字（代理对）时**不相等**——跨模型换算必须显式处理。**【官方（两处规范各自明文）+ 推断（差异由我比对得出）】**
- 规范还提供 `;s=b` / `;s=a` 的 **side bias**（分页环境下位置挂在前一段还是后一段），以及"扩展参数应以 `vnd.` 开头、不认识的参数必须忽略"。

### 2.3 KOReader：侧车 Lua + 多目标导出 + 按颜色/样式过滤（最接近 NyaReader 的形态）

来源：[KOReader exporter 插件源码（jsDelivr 镜像）](https://cdn.jsdelivr.net/gh/koreader/koreader@master/plugins/exporter.koplugin/main.lua)、[clip.lua（解析/字段定义，jsDelivr 镜像）](https://cdn.jsdelivr.net/gh/koreader/koreader@master/plugins/exporter.koplugin/clip.lua)、[KOReader 用户手册](https://koreader.rocks/user_guide/)、[Obsidian KOReader 高亮导入插件 README（jsDelivr 镜像）](https://cdn.jsdelivr.net/gh/t5k6/obsidian-koreader-highlights@main/README.md)。**【官方源码】+【第三方（导入插件）】**

- **存储**：批注存在**书籍同目录的 `.sdr` 侧车目录**里的 **Lua 文档设置文件**（通过 `BookList.getDocSettings(doc_path)` 读写；导入插件 README 亦明确"scans for `.sdr` directories, parses Lua metadata files"）。**【官方源码 + 第三方】**
  - ⚠️ 具体文件名（社区常说的 `metadata.<ext>.lua`）我**没有直接读到**，标 **【未验证】**；但"`.sdr` 目录 + Lua 元数据文件"这一点有上面的双重来源。
- **记录字段（来自 KOReader 自己的读取代码，权威度高）**：
  - 新格式：文档设置里的 `annotations` 数组，每条含 `pageref` / `pageno`、`datetime`、`text`、`note`、`chapter`、`drawer`（高亮样式）、`color`、`page`、`pos0`/`pos1`（可带 `page`）、`pboxes`（图片高亮的框）。
  - 旧格式：`highlight` 表（按页分组）+ `bookmarks` 表；代码里显式保留了兼容分支（`if annotations == nil then … readSetting("highlight")`）。
  - **图片高亮**：`text == ""` 且有 `pos0/pos1/pboxes` 时，导出为**裁剪出的 PNG**（`clipPagePNGString` + md5 去重键）。
  - **重排模式下的坑（KOReader 自己注释了）**：`-- highlights in reflowing mode don't have page in pos`。
- **导出**：内置多目标——**Markdown、HTML、JSON、纯文本、My Clippings、Joplin、Readwise、Nextcloud、xmnote**；两种粒度：「当前书」与「历史里所有书」。默认落到 KOReader 数据目录的 `/clipboard`，文件名模板可配（如 `%D-%M %A - %T`）。**【官方源码】**
- **过滤**：导出前可按 **highlight style（drawer）** 和 **color** 过滤（菜单里是多选），这也说明 KOReader 的高亮有"多种样式 + 多组颜色"的二维属性。**【官方源码】**
- **`.sdr` 侧车的代价**：与 NyaReader 一样是"书旁边放私有格式文件"——可同步但**不可 grep、不可在 Obsidian 里直接读**；这正是社区要写导入插件的根本原因（导入插件会把内容按章节/页码整理成 Markdown，并支持模板 + frontmatter + 去重）。**【第三方（导入插件）】**

### 2.4 Calibre 电子书阅读器：划词浮层 + 笔记 + 颜色 + 按章节排序的高亮面板 + 全库浏览

来源：[calibre 官方手册 — The E-book viewer](https://manual.calibre-ebook.com/viewer.html)（已实抓正文）。**【官方】**

- **交互（原文）**："When you select text in the viewer, a little popup bar appears next to the selection. You can click the highlight button in that bar to create a highlight. **You can add notes and change the color of the highlight.**" → **划词即出浮层，浮层里能选颜色、加笔记**，这正是 NyaReader 缺的（D9）。
- **列表（原文）**："You can use the Highlights button in the viewer controls to show a separate panel with a list of all highlights in the book, **sorted by chapter**." → 列表**按书内位置排序**，而不是按创建时间（对比 D8）。
- **全库视图（原文）**："You can browse *all highlights* in your entire calibre library by right clicking the View button and choosing **Browse annotations**."
- **同步（原文）**：通过 calibre Content server 的浏览器版阅读器，可在 Preferences → Miscellaneous 里填用户名开启**批注同步**，`*` 表示与匿名用户同步。
- **书签的特殊处理（原文）**：查看 EPUB 时，**书签是直接存进 EPUB 文件本身**的（"these bookmarks are actually saved in the EPUB file itself… send the file to a friend… they will be able to see your bookmarks"），可在首选项里关闭。
- **"定位即引用"的两种思路**：`Go to → Location` 生成可复制的**当前定位 URL**（`calibre://` 协议，见快捷键 `Ctrl+Shift+C`）；以及 **Reference mode**——给每个段落显示"章节号 + 段号"的唯一编号，可用 `Go to` 输入该编号跳转。**这对 TXT/纯文本的锚点设计是极好的先例**（章节/段号 ≥ 百分比）。**【官方】**
- **存储位置**：calibre 的资料库元数据用 SQLite（`metadata.db`）——手册在多语言版本里都有一句"SQLite wird benutzt um robust von der metadata…"。批注能被"整个资料库级别浏览"，说明它存在**资料库数据库**里而非书旁边。**但要强调：我没有从官方文档里读到那张表/那列的确切名字，所以"批注存在 metadata.db 的 annotations 表"标为【推断，未验证】。** 相关链接：[calibre 手册](https://manual.calibre-ebook.com/)、[calibre 手册（PDF 版，含 SQLite 说明）](https://manual.calibre-ebook.com/pt/calibre.pdf)。
- **导出**：官方 viewer 文档里**没有**"导出批注到 Markdown/JSON"的条目；社区用第三方工具（如 CalibreQuarry 的 `--export-annotations` 把高亮/书签/笔记导成 JSON）补足。**【第三方】** 参考：[CalibreQuarry patchnotes](https://github.com/VirInvictus/CalibreQuarry/blob/main/patchnotes.md)。

### 2.5 Apple Books / Kindle：公开可见的批注 UX 与已知的数据出口

- **Apple Books**：官方支持页 [在 iPhone 上的"图书" App 中为图书添加注解](https://support.apple.com/zh-sg/guide/iphone/iph17bf340c1/ios)（HTTP 200，但页面为 JS 渲染，**我只确认了 URL 可访问，未读到正文 → 本节 Apple 细节标【未验证】**）。公开可见的行为（社区共识，**未逐条验证**）：划词后弹出菜单可选择**多种高亮颜色**、加笔记、复制/分享；笔记与书签在阅读界面的"目录/书签"入口里集中列出，可跳回原文；可通过分享/导出把笔记带出。**我的推断**：Apple Books 的批注存在 Books 自己的数据库/云里，不写进 EPUB 文件——对"用户能否把批注搬到 vault"来说是不可直接复用的封闭格式。**【推断，未验证】**
- **Kindle**：
  - **`My Clippings.txt` 格式（有权威来源，来自 KOReader 的解析代码）**：每条 4 行——① `Title(Author Name)`；② `Your Highlight on Page 123 | Added on Monday, April 21, 2014 10:08:07 PM`；③ 空行；④ 正文；然后以 `==========` 分隔（KOReader 的 `parseMyClippings()` 就是按这个逐行状态机解析的）。**【官方源码（KOReader）】**
  - **已知坑（这些是第三方/社区总结，标【第三方】）**：`My Clippings.txt` 只能**追加**、去重困难（KOReader 的 `updateMyClippings` 注释就写明了"appending is the only way to modify notes in My Clippings"，并用"条数变多就整体替换"来近似去重）；位置用 Page/Location 两种编号；中文/日文设备的日期关键字要多语言匹配（KOReader 的 `keywords` 表里就有 `标注 / 笔记 / 书签` 和 `下午`）。参考：[导出 Kindle 高亮的第三方指南](https://keep.md/blog/export-kindle-highlights)、[My Clippings 正则解析讨论](https://stackoverflow.com/questions/16947390/using-regex-to-parse-kindle-my-clippings-txt-file)。
  - **官方出口**：Kindle Notebook 网页版（`read.amazon.com/notebook`）可看/导出笔记；设备上的 `My Clippings.txt` 只能作为文件导出。**【第三方，未验证官方帮助页正文】**

### 2.6 Obsidian 生态：批注最终要"落成 Markdown"，这部分是硬约束

来源：[Obsidian Help — Basic formatting syntax（官方文档源文件，jsDelivr 镜像）](https://cdn.jsdelivr.net/gh/obsidianmd/obsidian-help@master/en/Editing%20and%20formatting/Basic%20formatting%20syntax.md)、[Obsidian Help — Callouts（同上）](https://cdn.jsdelivr.net/gh/obsidianmd/obsidian-help@master/en/Editing%20and%20formatting/Callouts.md)、[Obsidian Help — Highlighter（Web Clipper）](https://obsidian.md/help/web-clipper/highlight)。**【官方】**

- **原生高亮语法就是 `==text==`**，且**原生支持 6 种颜色**——在 `==` 后面紧跟颜色 emoji：
  | 颜色 | 写法 |
  | --- | --- |
  | 红 | `==🔴文本==` |
  | 橙 | `==🟠文本==` |
  | 黄 | `==🟡文本==` |
  | 绿 | `==🟢文本==` |
  | 蓝 | `==🔵文本==` |
  | 紫 | `==🟣文本==` |
  **不带 emoji 就用主题默认高亮色**。编辑器里输入 `==` 会提示颜色，Live Preview 里光标放进高亮会出现色块可直接改色。
  → **这条直接决定颜色模型**：NyaReader 的颜色如果要"落进 vault 还能保持可读、可搜索、与原生渲染一致"，**首选就是复用 Obsidian 的 6 色 emoji 约定**，而不是自定义 HEX 或自定义 inline code。
- **Callout 语法**：`> [!note]`（`note/abstract/info/todo/tip/success/question/warning/failure/danger/bug/example/quote` 等类型，大小写不敏感、未知类型回落为 `note`），支持自定义标题、`+`/`-` 折叠、嵌套；颜色/图标通过 CSS 变量 `--callout-color` / `--callout-icon` 定制，`.callout[data-callout="…"]` 是钩子。
  → **"笔记"最合适的落地形态**：把高亮作为一个 `==…==` 行，把用户笔记写成紧随其后的 `> [!note]` 引用块（或行内注释），这样**在 Obsidian 里天然渲染、天然可读、天然可 grep**。
- **Web Clipper 的 Highlighter**：官方文档页 [obsidian.md/help/web-clipper/highlight](https://obsidian.md/help/web-clipper/highlight) 可访问（HTTP 200），但正文由 JS 渲染、**我未能读到内容 → 相关细节标【未验证】**。可确认的侧面证据：官方 clipper 仓库的 issue 标题提到"Highlights made in Reader mode **are not wrapped with `==` markers** in `{{content}}`"——即**clipper 会把网页高亮包成 `==…==` 并注入到 `{{content}}` 变量**；另外社区还有 "URL Fragment Text"（`#:~:text=`）的术语条目，用于**从笔记跳回网页的原文位置**。参考：[obsidian-clipper issue #852](https://github.com/obsidianmd/obsidian-clipper/issues/852)、[URL Fragment Text 术语](https://obsidianguide.de/05-anhang/02-glossar/url-fragment-text)。**【第三方/间接】**
- **对 NyaReader 的启示**：Obsidian 生态里"阅读器批注进 vault"的既有做法是**由外部插件去解析别人的私有侧车**（见 2.3 的 KOReader 导入插件）。NyaReader 作为 vault 内插件，**有独特优势：可以直接产出原生 Markdown，不需要任何导入器**。

### 2.7 PDF 侧：标准注释、pdf.js 的边界、pdf-lib 的能力与限制

来源：[W3C Selectors and States — FragmentSelector（PDF `page=`/`viewrect=` 与 RFC 3778）](https://www.w3.org/TR/selectors-states/)、[Readium PDF locator 最佳实践](https://readium.org/architecture/models/locators/best-practices/format.html)、[PDF 32000-1:2008 规范（Adobe 官方发布）](https://www.adobe.com/content/dam/acom/en/devnet/pdf/pdfs/PDF32000_2008.pdf)、[Apple PDFKit `quadrilateralPoints`](https://developer.apple.com/documentation/pdfkit/pdfannotation/quadrilateralpoints)、[ISO/DIS 32000 Table 177（"Additional entries specific to text markup annotations"）](https://archive.org/download/ISODIS32000E/ISO_DIS_32000_%28E%29.pdf)、[How to use the PDF.js AnnotationEditorLayer（Nutrient，第三方）](https://www.nutrient.io/blog/pdfjs-annotation-editor-layer/)、[pdf-lib README（jsDelivr 镜像）](https://cdn.jsdelivr.net/gh/Hopding/pdf-lib@master/README.md)。**【官方/第三方已标注】**

- **标准注释模型（已由本项目实践验证可用）**：文本标记类注释（`/Highlight`、`/Underline`）用 `/QuadPoints`（4 个点 = 8 个数）+ `/Rect` + `/C`（颜色）+ `/Contents` + `/T`（作者）+ `/M`（修改时间）；便签是 `/Text`。NyaReader 的 `PdfAnnotationWriter.ts` 正在做这件事。
- **QuadPoints 的点顺序**：规范里 `/QuadPoints` 的四个点有约定顺序，Apple PDFKit 的文档把该属性定义为"quadrilateral points"但**其正文页由 JS 渲染，我没读到顺序原文**；ISO/DIS 32000 的 Table 177 是以 PDF 形式提供的**我也未能提取文字**。→ **本节关于"顺序"的结论标【未验证】**。基于常见实现的**推断**：约定顺序是 **左上 → 右上 → 左下 → 右下**，而 `PdfAnnotationWriter.ts:19-21` 的注释写的是"左下、右下、左上、右上"。**这属于必须真机验证的一项**（做法：用 Acrobat / macOS Preview / Firefox 各开一次带该注释的 PDF，看高亮框是否错位或交叉）。**【未验证 + 推断】**
- **PDF 侧 locator 的成熟表述**：Readium 对 PDF 批注要求 `page` **和** `viewrect` 两种 fragment 同时存在，外加 `progression`/`position`——即"页内矩形 + 全书比例 + 全书序号"三层冗余。**【官方】** W3C 的 FragmentSelector 也把 PDF 的 `page=10&viewrect=50,50,640,480` 作为标准 fragment 语法（conformsTo = RFC 3778）。**【官方】**
- **pdf.js 的边界（重要）**：
  - pdf.js 能**渲染** PDF 自带注释（annotation layer），但**不提供"把注释写回原文件"的高层 API**；本项目也正是因此改用 pdf-lib 写回。
  - pdf.js 3.x 起内置了 **`AnnotationEditorLayer`**（FreeText / Ink / Stamp / Highlight；`HIGHLIGHT` 在 3.x 后段才加入，**建议 4.x**），通过 `eventBus.dispatch("switchannotationeditormode", …)` 切换工具、`switchannotationeditorparams` 调颜色，用 `pdfDocument.saveDocument()` 把注释**写进新 PDF（标准注释对象，不是栅格化）**。**【第三方，Nutrient 官方博客，内容详实】**
  - **但它有致命短板（正是我们要避开的）**：内置编辑器**不暴露逐条批注的 create/update/delete 事件**，官方博客的 FAQ 明说"For real per-annotation create/update/delete events, you need a custom annotation layer"，并且**没有公开 API 可以把已有批注注入编辑器**——"you'd have to write them into the PDF first (using pdf-lib or similar) and then open the modified file in PDF.js"。**【第三方】**
  → **结论**：NyaReader 继续"自己维护批注模型 + 自己画 overlay + 用 pdf-lib 写回文件"的方向是对的；**不要**指望 pdf.js 编辑器替我们做持久化。pdf.js 的 `AnnotationEditorLayer` 只在"纯 PDF 手写标注、不需要列表/同步"的场景更省事。
- **pdf-lib 的能力与硬限制**（官方 README，已实抓）：
  - 能力：创建/修改 PDF、表单、附件、绘制文本/图片/矢量、设元数据……**能力清单里没有"注释（annotations）"这一项** → 写注释必须像本项目一样**手工构造 `PDFDict` 并挂到 `/Annots`**。**【官方】**
  - 硬限制（官方 "Limitations" 与 "Encryption Handling"）：**不能提取/编辑表单之外的页面文本**；不支持 HTML/CSS 注入；**不支持加密文档**（`PDFDocument.load` 会抛 `EncryptedPDFError`，`ignoreEncryption: true` 并不会解密、后续修改可能失败或异常）。
  - → **对 NyaReader 的风险提醒**：**加密 PDF 上"写回批注"这条链路会直接失败**，必须捕获并降级为"只存侧车/只画 overlay，不写文件"（现状代码没有看到针对加密的兜底分支，见 §4.6）。**【官方 + 推断】**

### 2.8 调研小结：成熟工具的 8 条共性

| # | 共性做法 | 对应到 NyaReader 的差距 |
| --- | --- | --- |
| 1 | 锚点**多表达并存**（结构定位 + 文本指纹 + 百分比兜底） | D3/D4 |
| 2 | 文本指纹用 `before/exact/after` 冗余，且保留原始空白 | D4 |
| 3 | 划词**立刻出浮层**（颜色 / 高亮 / 笔记 / 复制） | D9 |
| 4 | 颜色是**一等公民**，且有固定小集合 + UI 可选 | D5（写死 yellow） |
| 5 | 列表**按书内位置排序**，支持分组/搜索/跳转 | D8 |
| 6 | **导出**是标配（Markdown / JSON / Readwise / 剪贴板） | D7 |
| 7 | 存储要么进文件（PDF/EPUB 书签）、要么侧车 + **专门的导入器**；私人格式必然催生导入器 | D11/D13 |
| 8 | 大文件"每条批注重写整本"的做法，成熟工具都尽量避免 | D14 |

---

## 3. 差距分析（按用户价值排序）

### P0 —— 不做则"批注功能等于不存在"

| 差距 | 成熟工具的做法 | NyaReader 现状 | 用户可感知的后果 |
| --- | --- | --- | --- |
| **G1 非 PDF 高亮不可见** | 划词即上色（calibre/KOReader/Apple/Books 全都有） | D1：`showAnnotation` = `goTo` | 用户高亮完看不到任何变化，认为"功能坏了" |
| **G2 重开书后批注不渲染** | 打开书即恢复全部高亮 | D2：只有 PDF 分支有重放循环 | "我昨天标的东西今天没了" |
| **G3 锚点漂移 / 只能跳个大概** | 结构定位 + 文本指纹 + 百分比三层冗余（Readium/CFI） | D3/D4：只有百分比（TXT 还混用段索引） | 改字号/切单双栏后跳转错位；TXT 跨模式跳转完全错 |
| **G4 批注无法导出/无法进 vault** | 导出 Markdown/JSON/剪贴板是标配（KOReader 9 个目标、calibre 全库浏览） | D7：`exportJson` 是死代码 | 用户无法把批注变成笔记，功能闭环断掉 |
| **G5 划词后没有浮层** | 选区旁弹小工具条（calibre 明文描述） | D9：只能移鼠标去标题栏点按钮 | 触屏/移动端几乎不可用，操作成本极高 |
| **G6 列表不能按位置排序/搜索** | "sorted by chapter"（calibre 明文） | D8：只有时间倒序 | 想回顾某一章的批注时无法定位 |

### P1 —— 让功能"好用"而不是"能用"

| 差距 | 说明 |
| --- | --- |
| **G7 颜色是死的**（D5） | 数据模型有 `color`、PDF writer 有 5 色映射，但 Controller 写死 `yellow`、UI 无入口、overlay 样式写死 → 完整实现 + 对齐 Obsidian 6 色 |
| **G8 笔记与高亮是两条互不相关的记录**（D17） | 应合并为"一条批注 = 锚点 + 高亮 + 可选笔记" |
| **G9 `underline` / 笔记图标等能力未暴露**（D6） | 补 UI 入口或明确删除死代码 |
| **G10 每次写回整本 PDF**（D14） | 节流 + 批量写；加密 PDF 兜底；备份可恢复 |
| **G11 PDF 注释细节不符合外部阅读器预期**（D15） | `/M` 格式、`/NM`、QuadPoints 顺序真机验证 |
| **G12 侧车命名丢扩展名会串书**（D11） | 新路径带扩展名，读时兼容旧路径 |
| **G13 并发/多端覆盖**（D10） | read-merge-write + 墓碑删除标记 |
| **G14 存储抽象只做了一半**（D13） | `IAnnotationStore` 要么补全、要么删掉，避免"看似可替换实则不可替换" |
| **G15 大书性能**（几百条批注） | 按资源懒加载范围、列表虚拟化 |

### P2 —— 生态与进阶

- 全库批注检索与**反向链接**（批注块可被 `[[...]]` 引用）→ 与 Obsidian 的核心能力结合。
- 图片/区域高亮（KOReader 用 `pos0/pos1/pboxes` 裁 PNG）。
- 导出到 Readwise / Anki / 剪贴板 / 模板化读书笔记。
- 批注驱动的 AI（摘要、问答、关联已有笔记）。
- 高亮"重叠/嵌套"的合并与渲染（同段多处高亮）。

---

## 4. 改造方案

### 4.1 统一锚点模型：`AnnotationAnchor`（三层冗余）

**设计原则（来自 §2.1/§2.2 的官方要求）**：Readium 的 EPUB 批注最佳实践要求"`text` + `href/type` + `progression` + (`cssSelector`|`domRange`|`partialCfi`) 至少其一"；W3C 又明确指出 TextPositionSelector **"is very brittle with regards to changes to the resource"**；CFI 的抗变动靠的是 ID/文本断言这种冗余。**结论：锚点必须同时保存"结构定位 + 文本指纹 + 百分比兜底"，任何单一表达都不够。**

```ts
/** 归一化口径必须显式版本化：换算法时要能识别旧数据 */
export type Normalization = "nyar-nfc-ws1-utf16-v1";

/** 冗余文本指纹（= W3C TextQuoteSelector 的 exact/prefix/suffix，Readium 的 highlight/before/after） */
export interface TextQuote { exact: string; prefix: string; suffix: string }   // 计数单位：UTF-16 code unit

export interface PdfAnchor {                 // 结构定位（PDF）
  pageIndex: number;                         // 0 基
  quad: Array<[number, number]>;             // 4 点 ×(x,y)，PDF pt，左下原点；顺序需核对规范（§2.7）
  rect: [number, number, number, number];
  pageSize: [number, number];
  rotation?: 0 | 90 | 180 | 270;
}

export interface HtmlAnchor {                // 结构定位（EPUB/MOBI）
  chapterHref: string;                       // EPUB: OPF spine item href；MOBI: 章节文件名/序号
  chapterIndex: number;                      // （不可再用"全书百分比"当主定位，见 D3）
  charRange: [number, number];               // 章节文本拼接后的 UTF-16 偏移
  cssSelector?: string;                      // 三选一但至少存一个（Readium 对批注的硬要求）
  domRange?: { start: { cssSelector: string; textNodeIndex: number; charOffset: number };
               end?:   { cssSelector: string; textNodeIndex: number; charOffset: number } };
  partialCfi?: string;                       // Readium 语义：不带 epubcfi() 外壳、不含 spine 段
}

export interface PlainTextAnchor {           // 结构定位（TXT）
  paragraphIndex: number;                    // 段落数组下标（文件不变则天然稳定）
  charRange: [number, number];               // 段内 UTF-16 偏移
  chapterIndex?: number;
}

export interface AnnotationAnchor {
  schema: "nyar-anchor/1";
  format: "pdf" | "epub" | "mobi" | "azw3" | "txt";
  href: string;                              // PDF/TXT = 书籍路径；EPUB = spine item href
  mediaType: string;                         // application/pdf | application/xhtml+xml | text/plain
  pdf?: PdfAnchor; html?: HtmlAnchor; text?: PlainTextAnchor;
  quote: TextQuote;                          // 冗余之二：文本指纹（所有格式都存）
  progression?: number; totalProgression?: number;   // 冗余之三：兜底进度 0~1
  /** 命中结构定位=exact；靠 quote 重锚=recovered；只能按进度=approx；旧数据=legacy */
  quality: "exact" | "recovered" | "approx" | "legacy";
  normalization: Normalization;
}
```

**为什么必须存 textQuote（回答"抗重排"这件事）**：

1. **重排（reflow）会让"像素/页码/百分比"全部失效**，但**文本本身不变**——所以唯一稳定的东西是"这句话及其前后文"。这正是 W3C TextQuoteSelector 的定义与用途（"describing a range of text by copying it, and including some of the text immediately before (a prefix) and after (a suffix) it to distinguish between multiple copies"）。
2. **CFI 的抗变动也依赖冗余**：`[id]` 与 `[before,after]` 断言就是为了"recover intended location even after some modifications"；断言缺失时 CFI 只是脆弱的节点序号路径。
3. **归一化必须版本化**：NFC + 连续空白折叠为单空格 + 去掉零宽字符 + 章节边界拼接方式，这些一变，指纹的匹配行为就变。所以存 `normalization`，未来换算法时可识别并重算。
4. **计数单位必须统一**：CFI 用 UTF-16 code unit，W3C Text Position 用 Unicode 码点——我们在 DOM 环境里实现，**统一采用 UTF-16 code unit**（与 `Range.startOffset` / `String.length` 一致），并在跨 Readium/W3C 数据时显式换算。

**解析（定位）优先级**（`resolveAnchor()` 的算法）：

```
1) 结构定位直接命中（pdf.pageIndex+quad / html.cssSelector+charOffset / text.paragraphIndex+charRange）→ quality=exact
2) 用 quote.exact 在该资源全文里搜索：
   - 唯一命中 → 采用，quality=recovered（同时把结构定位回写修正）
   - 多处命中 → 用 prefix/suffix 打分（编辑距离/最长公共前后缀）取最高分
   - 未命中 → 尝试"exact 拆成首尾片段"的模糊匹配（容忍少量字符被改动）
3) 仍失败 → 用 progression/totalProgression 跳到近似位置，quality=approx，
   在正文对应区域画出"虚线/低透明度"标记，并在批注面板里显示"位置可能已变化 + 重新锚定"按钮
4) 旧数据（只有 location 百分比 + text）→ quality=legacy，progression=location/10000，quote.exact=text
```

### 4.2 存储方案：**推荐「JSON 侧车为唯一真相 + Markdown 笔记为自动产物」，并支持 P1 的"笔记单向回写"**

**推荐结论**：不要二选一。理由：

- 锚点（quad / domRange / partialCfi / quote / progression）**无法在 Markdown 里无损表达**，硬塞进 Markdown 会变成"Markdown 里藏 JSON"，反而更不可读；而且用户手编 Markdown 很容易破坏结构。
- 但"用户最终要在 vault 里看到批注、要能 grep、要能同步"这个需求**必须满足**，所以 **Markdown 产物是 P0 交付物**。
- 因此：**机器可读的真相 = 侧车 JSON（v2）；人可读、可 grep、可同步的视图 = 自动维护的 Markdown 笔记**。两者是"数据库 ↔ 视图"关系，不是双写对等关系。

**具体形态**：

```
<书目录>/
  MyBook.epub
  MyBook.epub.annotations.json      ← v2 真相源（新增扩展名，避免串书）
  MyBook.annotations.json           ← v1 旧文件：只读兼容，永不删除、永不覆盖
vault 笔记区（路径可设置，默认 NyaReader/Annotations/）：
  MyBook.md                         ← 自动生成的批注笔记（可 grep、可同步、可链接）
```

`MyBook.md` 的推荐格式（**全部是 Obsidian 原生语法**，见 §2.6）：

```markdown
---
nyar-book: "MyBook.epub"
nyar-fingerprint: "<bookFingerprint>"
nyar-annotations: 12
nyar-updated: 2026-01-01T10:00:00Z
---

# MyBook — 批注

## 第 3 章 · 章节标题

==🟡 被高亮的原文句子。==
> [!note] 我的想法
> 这里可以写笔记；也可以留空。

<span id="nyar-a1b2c3"></span>
<!-- nyar:anchor id=a1b2c3 kind=highlight color=yellow page=42 -->
```

- 高亮 → `==…==`（6 色用 emoji 前缀，见 §4.4）。
- 笔记 → 紧随其后的 `> [!note]` 引用块（可折叠 `> [!note]-`）。
- **锚点行** → 一条 HTML 注释（`<!-- nyar:anchor … -->`），供插件**原地更新**（找到块 id 就替换，找不到就追加），使"重新生成"不会产生重复段落，也让用户手改正文（笔记）时不会被覆盖。
- 章节分组用 `##`，顺序按书内位置（与列表排序一致）。

**迁移路径（保证不破坏现有 `*.annotations.json`）**：

1. **读**：先读 `MyBook.epub.annotations.json`（v2）；不存在再读 `MyBook.annotations.json`（v1）；仍不存在则读旧的插件目录全局索引 `nyareader-pdf-annotations.json`。三条路径都命中就按优先级合并（v2 优先）。
2. **映射**：v1 → v2 只**增字段不改语义**：`location`（百分比或页号）→ `anchor.progression` / `anchor.pdf.pageIndex`；`target.rects/scale` → `anchor.pdf.quad`（可由 rects 反推）或保留为 `viewportRects` 供快速绘制；`text` → `anchor.quote.exact`；`kind/color/note/createdAt/updatedAt` 原样保留。`quality: "legacy"`。
3. **写**：只写新路径（`<name>.<ext>.annotations.json`），`schema: 2`；**旧文件保留不动**（可加一次性 UI 提示："已迁移 N 条旧批注，旧文件已保留"）。
4. **不破坏的硬约束**：任何情况下**不删除/不重命名** `*.annotations.json`；解析失败时**只读不写**（宁可这批批注不显示，也不能把用户数据写坏）；写入使用"临时文件 + 覆盖"或 Obsidian adapter 的原子写。
5. **Markdown 生成是幂等的**：只更新带 `nyar:anchor id=` 的块，用户手写的其他内容原样保留。

**可选（P1）**：允许用户直接编辑 Markdown 里的 `> [!note]` 内容，插件在打开书时做一次"MD → JSON"的 note 字段同步（**只同步 note，不同步锚点**），冲突时以 `updatedAt` 较新者为准并在 UI 提示。

**为什么不选"Markdown 为唯一真相"**：会把锚点数据挤进 Markdown（产生不可读的隐藏块），且任何 Markdown 编辑器/格式化插件/同步冲突都可能破坏它，风险高于收益。

### 4.3 可见高亮：EPUB / MOBI / TXT 的渲染方案（P0 核心）

**三种候选与取舍**：

| 方案 | 机制 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A. CSS Custom Highlight API** | `CSS.highlights.set("nyar-hl", new Highlight(...ranges))` + `::highlight(nyar-hl)` | **不改 DOM**（不影响本项目自己的分页/虚拟滚动/测量）；Range 可批量设置；滚动重排后依然有效 | 需浏览器支持（`CSS.highlights`）；伪元素样式能力有限、**点击命中不可靠**（需另做热区）；跨 iframe 需在 iframe 自己的 document 上注册；高亮样式受主题影响需小心 |
| **B. `<span class="nyar-hl">` DOM 包裹** | 在文本节点上 `splitText` + `surroundContents`/手工包裹 | 兼容性最好；可加 `border`/`title`/事件；可被 CSS 主题统一控制 | **改变 DOM**：跨元素选区要按文本节点切分；`normalize()`/重排/章节重建会丢，需要重放；可能影响引擎自身的字符偏移与分页计算（需在测量之后注入并重算） |
| **C. overlay 绝对定位色块** | 像 `PdfEngine.paintOverlay` 那样算 `getClientRects()` 画 div | 与 PDF 一致，不改 DOM | **每次滚动/重排都要重算**，几百条批注时成本高；需要虚拟化 + IntersectionObserver |

**推荐：A 主方案 + B 降级，C 仅用于"点击热区/近似标记"。**

```
if (typeof CSS !== "undefined" && "highlights" in CSS) → 方案 A（主）
else → 方案 B（降级，包裹 span）
点击/长按命中：只对"视口内可见的那几条"用 getClientRects() 生成热区（方案 C 的轻量版）
```

- **EPUB/MOBI（`HtmlDocEngine`）**：在 iframe 的 `contentDocument`/`contentWindow` 上注册；`setAnnotations()` 时按 `chapterHref` 分组，**只对当前已构建的章节**构建 Range（懒加载，见 §4.6 性能）；章节重建（追加章节、换字号重排）后重新构建 Range（Highlight API 的 Range 是活对象，DOM 被替换后需重建）。
- **TXT（`TxtEngine`）**：用 `text.paragraphIndex + charRange` 直接定位到该段落的文本节点（TXT 是虚拟滚动、`p.textContent` 直填，段落短，构建 Range 成本低），同样优先用 A；虚拟滚动的段落被回收时其高亮随之消失，滚动回来重建——**这一点与列表/搜索结果也要一致处理**。
- **PDF（`PdfEngine`）**：保留现有 overlay，但同时**改为从 anchor（页 + PDF pt quad）绘制**，而不是从"保存时的 viewport rects"绘制——这样缩放/换布局后仍能正确还原（现在的 `ratio = current/saved` 只在等比缩放时成立）。

**接口改动（最小集）**：`IReaderEngine` 增加一个**可选/新增**方法，让 Controller 在打开书时对所有格式统一重放：

```ts
// IReaderEngine.ts
setAnnotations(items: readonly EngineAnnotation[]): void;   // 全量设置（替代逐条 showAnnotation 做"重放"）
// EngineAnnotation = { id, anchor: AnnotationAnchor, color, kind, note? }
// 引擎内部：构建 Range / 绘制 overlay / 建立 id → 可视元素的映射
getSelectionAnchor(): { anchorDraft: Omit<AnnotationAnchor, "quote"> & { domText?: string } } | null;
// 引擎最懂 DOM，由它产出 cssSelector/domRange/charRange；quote 由 Controller 用同一套归一化函数补全
```
`showAnnotation(target)` 保留为兼容层（内部转成 `setAnnotations` 的单条增量）。

### 4.4 交互 UX

**1) 划词浮层（P0）**

- 触发：`selectionchange`（防抖）+ `mouseup` / `touchend`；位置用 `range.getBoundingClientRect()` 相对阅读容器计算；EPUB/MOBI 在 iframe 内注入浮层（避免跨文档坐标换算），TXT/PDF 在外层容器。
- 按钮（从左到右）：**高亮（长按/点右侧小三角展开 6 色）· 笔记 · 复制 · 翻译（复用 NyaLingo 划词翻译）· 取消**。
- 细节：`mousedown` 在浮层上 `preventDefault()`，否则点按钮会清空选区；浮层内不产生新的 selection；点击空白/滚动/翻页后关闭；**保留 `lastSelection` 作为兜底**（现状已有）。

**2) 颜色体系（P0 数据 / P1 UI 完整化）**

- **6 色，完全复用 Obsidian 原生高亮色约定**（§2.6）：`🟡 yellow（默认）· 🟢 green · 🔵 blue · 🔴 red · 🟠 orange · 🟣 purple`。
- 理由：导出到 Markdown 后颜色语义**仍然生效**（Obsidian 原生渲染 `==🟡…==`），而不需要自定义 CSS；同时映射到 PDF `/C` 的 RGB 与阅读器内的 CSS 变量。
- 实现：`Annotation.color: "yellow"|"green"|…`（**保持现有字符串枚举不变**，减少迁移成本），新增 `colorToCss()` / `colorToRgb()` / `colorToEmoji()` 三个纯函数供阅读器与导出共用；设置里可选默认色与是否启用多色。

**3) 批注列表面板（P0 基础 / P1 完整）**

- 从 `Modal` 升级为 **`ItemView` 右侧面板**（可与正文并排，符合"边读边看批注"）。
- 默认**按书内位置排序**（calibre 的 "sorted by chapter"），可切"按时间/按颜色/按类型"。
- 顶部：搜索框（搜原文 + 笔记）、颜色筛选 chips、类型筛选、条数统计。
- 每条：颜色条 + 原文（可折叠长文）+ 笔记（行内可编辑）+ 操作（跳转 / 复制 / 编辑 / 删除）。
- 跳到批注时：滚动到该位置 + **短暂脉冲高亮**（`nyar-hl-flash` 动画 1.2s），让用户确认"就是这条"。
- 删除：二次确认 + **撤销**（toast 里给 Undo，保留最近 1 步）。
- 分组：PDF 按页、EPUB/TXT 按章节（引擎提供章节标题）。

**4) 快捷键（建议）**：`H` 高亮选中 · `N` 加/改笔记 · `Ctrl/Cmd+Shift+A` 打开批注面板 · `[` / `]` 上一条/下一条批注 · `Delete` 仅在面板聚焦且二次确认时删除。实现前需与 Obsidian 默认键位表比对避让。

### 4.5 分阶段实施计划

**P0（目标：EPUB/MOBI/TXT"高亮可见 + 重开还在 + 跳得准 + 能导出"，且 PDF 不回归）**

| 编号 | 任务 | 验收标准（可测） |
| --- | --- | --- |
| P0-1 | `AnnotationAnchor` 模型 + 侧车 v2（含 v1 读取兼容） | 单测：v1 JSON → v2 锚点映射正确；旧文件内容字节不变 |
| P0-2 | `HtmlDocEngine` / `TxtEngine` 实现 `setAnnotations()` 与可见高亮（方案 A，降级 B） | 手动：EPUB 划词高亮后正文出现色块；改字号/切单双栏/切分页滚动后仍在同一句上 |
| P0-3 | Controller：打开书时对**所有格式**重放批注（修复 D2） | 关闭重开（含 Obsidian 重启）后高亮全部可见 |
| P0-4 | 选区浮层（高亮/6 色可选/笔记/复制/翻译） | 浮层出现在选区旁；点浮层不丢选区；触屏可用（长按选择后出现） |
| P0-5 | 批注面板：按位置排序 + 搜索 + 跳转脉冲 + 笔记编辑 + 删除（含撤销） | 12 条批注按章节正确分组；搜索"笔记关键字"能命中；跳转命中同一句 |
| P0-6 | 导出 Markdown（`==…==` + `> [!note]` + frontmatter），可选自动写入 vault 笔记文件 | 导出文件在 Obsidian 里渲染为原生高亮 + callout，可全文搜索到笔记文字 |
| P0-7 | 回归 | `tests/pdf-annotation.test.ts` 全绿；PDF 高亮/删除/写回行为与现状一致 |

**P0 明确不做**：不改各引擎分页/虚拟滚动内核；不做 PDF 写回节流以外的文件策略变更；不做双向 MD 同步；不做全库检索。

**P1**：颜色 UI 完整化 + 笔记与高亮合并为一条（G8）· `underline` 入口（G9）· 面板分组/统计/过滤 · Markdown 单向回写（只同步 note）· PDF 写回节流 + 加密兜底 + `/NM`/`/M` 修正 + QuadPoints 顺序真机验证（G10/G11）· 侧车命名带扩展名（G12）· 冲突合并与墓碑（G13）· 性能优化：按资源懒加载、面板虚拟化（G15）。

**P2**：全库批注检索与反向链接 · 图片/区域高亮 · Readwise/Anki/剪贴板导出 · 模板化读书笔记 · 批注驱动 AI。

**全程明确不改（防范围爆炸）**：
1. **不改产品代码以外的任何东西**——本阶段只产出本文档。
2. 不引入新第三方依赖（不用 pdf.js 内置编辑器、不引锚点库；Highlight API 是浏览器原生）。
3. **不改书籍原文件**（EPUB/MOBI/TXT 一律只在侧车/笔记区写）；PDF 保留现有"写文件"路径，只在其上加节流与兜底。
4. 不动翻译（NyaLingo）与阅读进度存储链路（只共用容器，不改语义）。
5. 不改 `AnnotationKind` 的既有取值与 `Annotation.color` 的既有字符串枚举（保证旧数据可读）。
6. 不删除任何旧文件、不改动 `*.annotations.json` 的既有内容。

### 4.6 风险与迁移

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| **旧批注数据不兼容** | 用户丢数据 | v1 只读兼容 + 字段映射 + `quality:"legacy"` 标记；解析失败只读不写；不删旧文件（§4.2 步骤 1-4） |
| **PDF 写回损坏文件** | 最严重的数据风险 | 保留现有"首次备份 + 回读校验（pdf.js 解析 + pdf-lib 校验 Subtype）"；新增：写回前 `try/catch EncryptedPDFError` → 降级为"只画 overlay + 侧车存储"并明确提示；写回失败**不更新侧车**、不改内存状态 |
| **PDF 备份文件污染书库** | 书架出现 `*.backup-*.pdf` | **需 lead 决策**：备份留在书旁（用户好找）vs 移到插件目录（不污染书库、但用户不易找）。无论哪种，都应给"恢复备份"一个 UI 入口（现状 `restore()` 无调用点，D14） |
| **每次写回整本 PDF** | 大文件卡顿、同步反复上传 | P0 先用"写回队列 + 节流（合并 1~2s 内的多次写回，逐条入队后一次写出）"；P1 再考虑"默认只存侧车 + 显式『写入 PDF 文件』按钮" |
| **性能（几百条批注）** | 滚动卡顿 | 按 `href`/章节分组索引；只为可见章节构建 Range；面板虚拟化/分组折叠；避免在 scroll 里做全量 `getClientRects` |
| **多端同步冲突** | 批注互相覆盖 | read-merge-write（写前重读合并）+ 以 `id` 为主键 + `updatedAt` 优先 + 删除写墓碑（`deletedAt`）而非直接丢；Markdown 产物按块 id 幂等更新，避免大段 diff |
| **Markdown 名称冲突** | 同一书名两本书 | 笔记文件名用 `<书名> -- <fingerprint 前 8 位>.md`；侧车用带扩展名的路径（G12） |
| **Highlight API 兼容性** | 某些平台高亮不出现 | **必须能力检测 + 降级到 span 包裹**；降级路径要有独立验收（在 `CSS.highlights` 被禁用的情况下测一遍）**【未验证】**：Obsidian 各平台内核版本需实测确认 |

---

## 附录 A：本次调研的来源清单（全部为实际访问过的 URL）

**规范/官方文档**
- Readium Locators：<https://readium.org/architecture/models/locators/>
- Readium HTML 位置扩展：<https://readium.org/architecture/models/locators/extensions/html.html>
- Readium 按格式的 locator 最佳实践：<https://readium.org/architecture/models/locators/best-practices/format.html>
- Readium R2 Locator 架构：<https://readium.org/technical/r2-locator-architecture/>
- W3C Selectors and States（TextQuote/TextPosition/CssSelector/RangeSelector、PDF & EPUB3 fragment）：<https://www.w3.org/TR/selectors-states/>
- EPUB CFI 1.1（W3C EPUB WG）：<https://w3c.github.io/epub-specs/epub33/epubcfi/>
- IDPF 原版 EPUB CFI：<https://idpf.org/epub/linking/cfi/epub-cfi.html>
- calibre viewer 官方手册：<https://manual.calibre-ebook.com/viewer.html>
- Obsidian 基础格式（`==高亮==` 与 6 色）：<https://cdn.jsdelivr.net/gh/obsidianmd/obsidian-help@master/en/Editing%20and%20formatting/Basic%20formatting%20syntax.md>
- Obsidian Callouts：<https://cdn.jsdelivr.net/gh/obsidianmd/obsidian-help@master/en/Editing%20and%20formatting/Callouts.md>
- Obsidian Web Clipper Highlighter：<https://obsidian.md/help/web-clipper/highlight>
- PDF 32000-1:2008（Adobe 官方 PDF 规范）：<https://www.adobe.com/content/dam/acom/en/devnet/pdf/pdfs/PDF32000_2008.pdf>
- ISO/DIS 32000 Table 177（文本标记注释条目）：<https://archive.org/download/ISODIS32000E/ISO_DIS_32000_%28E%29.pdf>
- Apple PDFKit `quadrilateralPoints`：<https://developer.apple.com/documentation/pdfkit/pdfannotation/quadrilateralpoints>
- Apple Books 添加注解（官方支持页）：<https://support.apple.com/zh-sg/guide/iphone/iph17bf340c1/ios>

**源码（GitHub 经 jsDelivr 镜像读取）**
- KOReader exporter：<https://cdn.jsdelivr.net/gh/koreader/koreader@master/plugins/exporter.koplugin/main.lua>
- KOReader clippings 解析/字段定义：<https://cdn.jsdelivr.net/gh/koreader/koreader@master/plugins/exporter.koplugin/clip.lua>
- Obsidian KOReader 导入插件：<https://cdn.jsdelivr.net/gh/t5k6/obsidian-koreader-highlights@main/README.md>
- pdf-lib README（Features / Limitations / Encryption）：<https://cdn.jsdelivr.net/gh/Hopding/pdf-lib@master/README.md>

**第三方技术资料**
- pdf.js `AnnotationEditorLayer` 用法与限制（Nutrient）：<https://www.nutrient.io/blog/pdfjs-annotation-editor-layer/>
- CalibreQuarry 批注导出：<https://github.com/VirInvictus/CalibreQuarry/blob/main/patchnotes.md>
- obsidian-clipper 高亮包裹 `==` 的 issue：<https://github.com/obsidianmd/obsidian-clipper/issues/852>
- Kindle 高亮导出指南：<https://keep.md/blog/export-kindle-highlights>
- My Clippings 解析讨论：<https://stackoverflow.com/questions/16947390/using-regex-to-parse-kindle-my-clippings-txt-file>

**未能读取正文（仅确认 URL）**：Apple Books 支持页、Obsidian Web Clipper 文档、Readium annotations 仓库、ISO 32000 Table 177 正文、pdf.js 官方 wiki —— 相关内容已在正文逐条标注【未验证】。
