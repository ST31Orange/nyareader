# NyaReader 阅读页重构报告（v0.4.4 → v0.4.5）

> 范围：阅读页面（EPUB / MOBI / AZW3 / TXT / PDF 的打开与阅读体验）。
> 书架页仅做零风险观察，未改动其逻辑。
> 本文回答四个问题：架构摘要、问题区域、重构策略、改进后的代码。
> 所有结论都带可复现的验证命令与实测数字；无法验证的项明确标注。

---

## 一、架构与数据流摘要

### 1.1 分层

```
main.ts（插件生命周期、命令、视图注册）
  └─ view/
       ├─ BookshelfView        书架：书库 → 文件夹 → 书（三级），拖动排序、封面缓存
       ├─ ReaderView           阅读视图壳（ItemView）：标题栏控件、目录面板、翻译面板、快捷键、加载态
       │    └─ ReaderController   编排层：打开书 → 解析 → 建引擎 → 恢复进度；转发翻页/缩放/批注/翻译
       │         ├─ services/books/Parser + formats/*   解析：EPUB/MOBI/TXT/PDF → BookModel
       │         └─ services/books/IReaderEngine         渲染引擎接口（HtmlDocEngine / TxtEngine / PdfEngine）
       ├─ TranslationPanel / AnnotationListModal / components/*
       └─ （数据面）storage/BookIndexService、history/HistoryStore、annotations/*、lingo/NyaLingoClient
```

关键约束（types.ts 顶部已声明，重构中被严格遵守）：

- 视图层只依赖 `ReaderController`；
- 引擎只实现 `IReaderEngine`，不 import 视图层；
- 服务层与工具层不 import 插件类。

### 1.2 一条完整数据流（打开一本 EPUB）

```
用户点书（BookshelfView）
 → main.openBookFile(file)
 → ReaderView.openBook(file)
    → Controller.openBook(file, mountContainer)
       ① emitStage("reading")   读取文件（vault.adapter.readBinary）
       ② 格式嗅探 sniffFormat / 扩展名
       ③ emitStage("parsing")   并行发起 sha256（WebCrypto）与解析（provisionalFingerprint 占位）
       ④ emitStage("index")     回填真实指纹 → BookIndexService.upsert（进度/最近打开）
       ⑤ emitStage("rendering") mountEngine()
            EpubParser.parse  → BookModel（OPF/NCX/nav 结构）
            EpubDocument.openEpubSource → EpubSource（懒加载章节源）
            new HtmlDocEngine({ html: 前 N 章, resolveAsset })
            engine.mount(container)  → iframe srcdoc → load → 分页测量
       ⑥ 恢复进度（EPUB 先补章到目标章节）→ emitStage("done")
       ⑦ EpubLazyLoader.start() 后台按 idle 切片补章 → engine.notifyContentAppended
 → 用户操作：翻页/滚动（引擎）→ locationChanged → 防抖写进度
            划词（引擎）→ selection → TranslationPanel / 批注
```

### 1.3 阅读页三种引擎的定位

| 引擎 | 格式 | 渲染方式 | 分页实现 |
|---|---|---|---|
| `HtmlDocEngine` | EPUB / MOBI / AZW3 | iframe + `srcdoc`，整本合并为单文档 | CSS 多栏（一栏=一页）+ `translateX` 位移 |
| `TxtEngine` | TXT | 宿主 DOM + 测量修正型虚拟滚动（prefix-sum） | 分页模式 = 滚动容器按视口高度整屏翻 |
| `PdfEngine` | PDF | pdf.js 连续滚动 + 视口附近懒渲染 canvas | 分页模式 = 锁定滚动 + 按页跳转 |

---

## 二、问题区域（重构前）

按严重度排序。每条：现象 → 根因（文件:行）→ 影响。

### P0-1 大文件打开后「单双页 / 滚动 / 翻页失灵」

- **现象**：大书打开后点双页/翻页/切模式没反应，或页码乱跳。
- **根因（多条叠加）**：
  1. `HtmlDocEngine.measurePages()` 遍历栏容器的**每个子元素**调 `getBoundingClientRect()`，并在测量前把 `transform` 置空、测完还原 —— 一本数万块的书每次测量都触发整篇同步布局（当时约 600 行，代码里已用注释记录过"翻页位移漂移"的踩坑）。
  2. `applyBaseStyle()` 每次 `applySettings` 都 `remove()` 旧 `<style>` 再 `createElement` 新的 → 整篇文档重排。
  3. `ResizeObserver` 与 `window.resize` 都会触发 `relayoutPages(true)`，没有合并、没有"尺寸未变则跳过"，静止状态下的抖动会把页码与位移冲掉。
  4. `mount()` 用 `Promise.race([load, setTimeout(800)])`，超时后**照样测量**：文档没就绪时测出 `pages=1` 或错页数，此后所有翻页都基于错误页数。
  5. `capabilities.pageNav` 跟随当前模式变化（`pageNav: this.isPaged()`），切换瞬间视图层读到 `false` 就把按钮隐藏/禁用 —— 用户看到的就是"按钮失灵"。
- **影响**：用户主诉。也是本次重构的核心。

### P0-2 打开大文件慢（首屏前无任何反馈）

- **根因**：
  1. `buildEpubHtml()` 用 `await` 串行读取**全部** spine 章节字符串，再拼成一份巨型 HTML；图片一律 base64 内联（`MAX_INLINE_IMAGE = 1.5MB`），HTML 体积被放大到与整本书相当。
  2. `ReaderController.openBook` 先 `readBinary` → 再 `sha256Hex(整个 buffer)` 等全量哈希完成 → 才开始解析，全串行且无阶段反馈。
  3. 章节样式按「整串 CSS `includes` 比较」去重，大书 O(n²)。
  4. PDF 被解析**两次**：`PdfParser.parse` 为拿目录 `getDocument` 一次后立刻 `doc.destroy()`，`PdfEngine.mount` 又对同一 buffer `getDocument` 一次。
- **影响**：40MB 级 EPUB 首屏前要等数秒到数十秒且界面无反馈，用户以为卡死。

### P0-3 电子书内图片不显示

- **根因**：
  1. 图片 base64 内联，**超过 1.5MB 直接 `src=""` 清空**（配合 CSS 隐藏）→ 大图彻底消失。
  2. 缺失资源同样被 `src=""` 清空 → 空洞，而不是可见占位。
  3. 分页模式给图片的 `max-height: calc(var(--nyar-page-h) - 44px)` 用固定 44px 余量、而 `--nyar-page-h` 又被写死在 `:root`（480/680），与实际页高不符 → 图被裁或拉伸。
  4. 章节内相对 `href` 按 **OPF 目录**解析而不是**章节所在目录**：`OEBPS/text/ch1.xhtml` 里写 `../images/a.png` 必然找不到文件 → 丢图、丢外链 CSS。
- **影响**：用户主诉"电子书内的图片显示问题"。

### P1-1 排版边距太大

- **根因**：四层留白叠加，且彼此不知情 ——
  `.nyareader-reading { padding: 20px 28px }`（styles.css）
  + 引擎 `body { margin: m px auto }`（m×1.6 = 38.4px 左右）
  + `.nyareader-book { padding: 14px 32px }`（PAGE_MARGIN_X）
  + `OUTER_PAD = 20`（外层留白）。
  实测左右各约 **66px**，且窄窗更糟、宽窗不变。
- **影响**：用户主诉"排版的边距太大"。

### P1-2 超宽窗口行宽无限

- **根因**：正文没有 measure（行宽上限）。2200px 窗口实测一行 **2067px ≈ 162 个汉字**。
- **影响**：可读性严重下降，属于"排版溢出"。

### P1-3 窗口缩小时页面被裁 / 横向溢出

- **根因**：`.nyareader-reading { overflow:auto }` + 内部绝对定位的书页按旧尺寸定位；iframe 没有显式 `display/height/min-height`，在 flex 容器里会被顶出可视区。

### P2 结构性 / 可维护性风险

| 风险 | 证据 |
|---|---|
| 5 处重复的默认版式字面量 | `types.ts`、`settings.ts`、`HtmlDocEngine`、`TxtEngine`、`PdfEngine` 各写一份 `{fontFamily, fontSize:18, ... pageWidth:420}`，改一个值要改五处 |
| 分页算术散落在引擎里 | 页宽/页高/回退/槽宽/页码换算与 DOM 测量耦合，无法单测，之前已因此产生"窄窗退单页误用双页槽宽"的回归 |
| 第三方库解析（EPUB）与渲染（本项目）职责重叠 | `EpubZipCache`（解析/渲染共用 zip）与 `EpubDocument` 都做 href 解析，`resolveHref` 在两处各写一份 |
| 死代码/未使用样式 | `styles.css` 的 `.nyareader-engine-loading` 从未被使用；`PdfEngine` 里 `this.pagesEl`/`rows` 之外的中间变量曾长期无人清理 |
| 度量不一致 | `TxtEngine.currentPercentage()` 用 `scrollTop/contentHeight`，`goTo()` 用 `scrollTop/(contentHeight-viewportHeight)` → 滚到底百分比到不了 1 |
| 进度永远到不了 100% | `percentFromPage` 用页中心语义，末页只给 ~99% |
| 懒加载只解决首屏、不解决峰值内存 | `EpubLazyLoader` 只有追加、没有卸载路径；读完全书后内存与"整本合并"收敛到同一量级（需 DOM 卸载，与"多栏 + 零宽标记测总页数"存在架构冲突，本次不动，见 §五） |

---

## 三、重构策略

原则：**功能不变，先分离纯函数、再修根因、最后用真实浏览器取证。**

1. **把算术从 DOM 里拿出来**
   `paging-layout.ts` 承载页宽/页高/单双页回退/槽宽/页边距/列位移/页码换算/栏容器栅格宽度，
   全部纯函数 + JSDoc，用单测锁死边界（26 条）。引擎只负责把结果写进 DOM。
2. **把测量从 O(文档规模) 降到 O(1)**
   在栏容器末尾放一个零宽标记 `#nyareader-end-marker`，用它的 `offsetLeft` 反推最后一列序号。
   关键点：`offsetLeft` 相对 `offsetParent`（`position:relative` 的栏容器），**不受父级 transform 影响**，因此不必再"置空 transform 再还原"。
3. **让重排变成幂等且便宜**
   样式只维护一个 `<style>` 且文本相同不写；`ResizeObserver` 用 rAF 合并；版式尺寸未变化直接 return；内容追加时 `force=true` 但 `keepPage=true`（见下）。
4. **内容追加不能改变当前页码**
   分页总页数会随补章增长。若按"旧百分比 × 新页数"重算，10 页时读第 3 页，补章到 100 页就变成第 25 页 —— 读者被越推越后。新增 `keepPage` 开关：**只有窗口/字号变化才按百分比重算，末尾追加一律保持页码。**
5. **大文件走"首章优先 + 后台补章 + 资源外链"**
   首屏只构建前 2 章；其余由 `EpubLazyLoader` 在 `requestIdleCallback` 里按 16ms 预算切片追加；图片不再 base64，改为 `data-nyar-asset` 登记 + `blob:` URL 按需回填。
6. **打开链路分阶段可观测**
   `onStage(reading → parsing → index → rendering → done)`；sha256 与解析并行，解析器先用 `provisionalFingerprint` 占位、解析完回填真实指纹（进度/批注主键语义不变）。
7. **消除重复解析与重复布局**
   PDF 解析成果通过 `pdfHandoff` 一次性交接给渲染引擎（按 buffer 身份匹配 + TTL 兜底）；
   PDF 页偏移由 `computeRowTops()` 纯算术得出（不再逐页读 `offsetTop`）；
   默认版式收敛到 `DEFAULT_READER_SETTINGS` 单一来源。
8. **宿主与内容各管一段留白**
   宿主只给最小安全边（CSS 变量 `--nyar-reading-pad-x/y`，默认 8/6px，窄窗 4px），行宽与页边距交给引擎（滚动模式 `body max-width + margin auto`；分页模式由页宽决定）。
9. **用真实浏览器取证**
   Edge `--headless=new` + CDP：算法层探针、真实引擎端到端（esbuild 打包后在真实 iframe 里跑 mount/翻页/单双页/补章/图片）。

---

## 四、改进后的代码（关键片段）

### 4.1 纯函数内核：`src/services/books/formats/html/paging-layout.ts`

```ts
export function computePageLayout(input: PageLayoutInput): PageLayout {
	const availW = Math.max(MIN_PAGE_WIDTH, Math.floor(input.viewWidth - (BOOK_MARGIN + SAFETY) * 2));
	const availH = Math.max(MIN_PAGE_HEIGHT, Math.floor(input.viewHeight - (BOOK_MARGIN + SAFETY) * 2));

	// 先用「双页」尺寸估算是否真的能对开；退单页后槽宽/页边距必须用单页的值
	const widthForDouble = (availW - GUTTER_DOUBLE) / 2 - PAGE_MARGIN_X_DOUBLE * 2;
	const double = input.double && availW >= MIN_SPREAD_WIDTH && widthForDouble >= MIN_SPREAD_PAGE_WIDTH;
	const gutter = double ? GUTTER_DOUBLE : GUTTER_SINGLE;
	const pageMarginX = double ? PAGE_MARGIN_X_DOUBLE : PAGE_MARGIN_X_SINGLE;

	const rawWidth = double ? widthForDouble : availW - pageMarginX * 2;
	const pageWidth = clamp(Math.round(rawWidth), MIN_PAGE_WIDTH, Math.min(MAX_PAGE_WIDTH, availW));
	const pageHeight = clamp(Math.round(availH), MIN_PAGE_HEIGHT, availH);
	const bookWidth = double ? pageWidth * 2 + gutter : pageWidth;

	return { pageWidth, pageHeight, gutter, pageMarginX, bookWidth, bookHeight: pageHeight, double, columnStride: pageWidth + gutter };
}

/** 由「一页步长」反推总页数：O(1) 测量的核心算术 */
export function pageCountFromMarker(markerLeft: number, layout: Pick<PageLayout, "columnStride">): number {
	if (!Number.isFinite(markerLeft) || layout.columnStride <= 0) return 1;
	return Math.max(1, Math.round(markerLeft / layout.columnStride) + 1);
}
```

### 4.2 O(1) 测页数：`HtmlDocEngine.measurePages()`

```ts
private measurePages(): number {
	const cols = this.columnsEl;
	const marker = this.endMarker;
	if (!cols || !marker) return 1;
	let markerLeft: number;
	if (marker.offsetParent === cols) {
		// offsetLeft 相对 offsetParent，不受父级 transform 影响 → 无需置空 transform
		markerLeft = marker.offsetLeft;
	} else {
		markerLeft = marker.getBoundingClientRect().left - cols.getBoundingClientRect().left;
	}
	return pageCountFromMarker(markerLeft, this.layout);
}
```
- 旧：`for (const el of cols.children) el.getBoundingClientRect()` + 置空/还原 transform = **O(块数)**，每次重排触发整篇同步布局。
- 新：**O(1)**，一次 `offsetLeft`。

### 4.3 重排：幂等、可合并、可保持页码

```ts
private scheduleRelayout(): void {
	if (!this.isPaged() || this.destroyed || !this.docReady) return;
	if (this.relayoutRaf) return;                       // rAF 合并 resize 抖动
	this.relayoutRaf = window.requestAnimationFrame(() => {
		this.relayoutRaf = 0;
		this.relayoutPages(true, this.pendingForceRelayout, false);
		this.pendingForceRelayout = false;
	});
}

private relayoutPages(emit: boolean, force = false, keepPage = false): void {
	// ...尺寸未就绪（<40px）直接 return；docReady 为假直接 return
	const sameLayout = /* pageWidth/pageHeight/gutter/pageMarginX/double 全部相同 */;
	if (sameLayout && !force && this.pages > 0) return;  // 静止抖动不再冲掉页码

	const prevPage = this.currentPage, prevPages = this.pages;
	this.pages = this.measurePages();
	this.currentPage = keepPage && prevPages > 0
		? clampPage(prevPage, this.pages)                 // 末尾追加：页码不动
		: clampPage(Math.round(prevPct * this.pages) || 1, this.pages); // 尺寸变化：按百分比还原
	this.currentPage = alignSpreadPage(this.currentPage, next.double);
	this.positionColumns();
	if (emit) this.emitProgress();
}

notifyContentAppended(html: string): void {
	const host = this.columnsEl ?? this.doc.body;
	host.insertAdjacentHTML("beforeend", html);
	if (this.isPaged()) {
		if (this.endMarker?.parentElement === host) host.appendChild(this.endMarker); // 标记永远在最后
		this.relayoutPages(true, true, true);            // 强制重测 + 保持页码
	}
	void this.resolvePendingAssets();
}
```

### 4.4 图片：不隐藏、按需 blob、可见占位

```ts
private async resolvePendingAssets(): Promise<void> {
	const pending = Array.from(this.doc.querySelectorAll<HTMLImageElement>("img[data-nyar-asset]"));
	if (!pending.length) return;
	const resolve = this.opts.resolveAsset;
	if (!resolve) {
		// 没有解析器也要给可见占位：否则 img 无 src 无样式 = 图片"凭空消失"
		for (const img of pending) img.classList.add("nyareader-img-missing");
		return;
	}
	for (const img of pending) {
		const path = img.dataset.nyarAsset;
		img.removeAttribute("data-nyar-asset");
		const url = await this.resolveAssetOnce(path);   // blob: URL，按路径缓存
		if (url) { img.src = url; img.classList.remove("nyareader-img-missing"); applied = true; }
		else img.classList.add("nyareader-img-missing");
	}
}
```

```css
/* 分页文档内：max-height 用真实页高变量推导，不再用固定 44px 余量 */
img, svg, video, picture > img { max-width: 100% !important; height: auto !important; object-fit: contain; }
.nyareader-columns img { max-height: var(--nyar-img-max-h) !important; width: auto; }
img.nyareader-img-missing { display:inline-block; min-width:96px; min-height:72px; border:1px dashed …; }
```

### 4.5 末尾补章不漂移（回归测试锁死）

```ts
it("按百分比重算会在补章后把读者往后推（正文追加时这是错误行为）", () => {
	expect(repositionByPercent(3, 10, 100)).toBe(25);   // 旧行为：3/10 → 25/100
});
it("保持页码策略在补章后仍停在第 3 页", () => {
	expect(repositionKeepPage(3, 100)).toBe(3);          // 新行为
});
```

### 4.6 宿主留白与行宽（`styles.css`）

```css
.nyareader-reading {
	--nyar-reading-pad-x: 8px; --nyar-reading-pad-y: 6px;   /* 旧：padding: 20px 28px 固定 */
	--nyar-measure: min(74ch, 720px);
	flex: 1; min-width: 0; min-height: 0; overflow: hidden; position: relative;
	padding: var(--nyar-reading-pad-y) var(--nyar-reading-pad-x);
}
@media (max-width: 719px) { .nyareader-reading { --nyar-reading-pad-x: 4px; --nyar-reading-pad-y: 4px; } }
@container (max-width: 719px) { .nyareader-reading { --nyar-reading-pad-x: 4px; } }  /* 侧栏分屏也能命中 */

/* 必须铺满：不要 max-width/margin-inline，否则窗口够宽也永远退回单页 */
.nyareader-html-iframe { display:block; width:100%; height:100%; min-height:0; border:0; }
```
行宽约束移交渲染文档内部：滚动模式 `body { max-width: <pageWidth>px; margin: 24px auto; padding-inline: min(24, margin/2) }`，分页模式不加 `max-width`。

### 4.7 打开链路：并行指纹 + 阶段上报（`ReaderController.openBook`）

```ts
this.emitStage("reading");
const buffer = await this.plugin.app.vault.adapter.readBinary(file.path);
format = this.detectFormat(file.name, buffer);
const provisional = provisionalFingerprint(file.path, buffer.byteLength);
const fingerprintPromise = sha256Hex(buffer);            // 与解析并行（WebCrypto 后台线程）
const working = format === "pdf" ? buffer.slice(0) : buffer;  // PDF 一份规范副本，交接身份才匹配
this.emitStage("parsing");
const book = await parser.parse({ fingerprint: provisional, path: file.path, format, buffer: working });
this.emitStage("index");
const fingerprint = await fingerprintPromise.catch(() => provisional);
book.fingerprint = fingerprint;                          // 回填真实指纹，主键语义不变
```

### 4.8 消除 PDF 重复解析（`pdfHandoff.ts`）

```ts
/** 解析阶段把文档对象放进「一次性交接」槽位，渲染引擎 mount 时优先取用。 */
export function putPdfHandoff(buffer: ArrayBuffer, doc: PDFDocumentProxy): void {
	if (entry && entry.doc !== doc) releaseEntry();
	entry = { buffer, doc, createdAt: Date.now() };
}
export function takePdfHandoff(buffer: ArrayBuffer): PDFDocumentProxy | null {
	if (!entry) return null;
	if (entry.buffer !== buffer || Date.now() - entry.createdAt > HANDOFF_TTL_MS) { releaseEntry(); return null; }
	const doc = entry.doc; entry = null; return doc;   // 一次性取走
}
```
配套：`PdfEngine` 新增 `docOwned` 与幂等 `releaseDoc()`，`destroy()` 不再无条件 `doc.destroy()`。

### 4.9 单一默认值来源

```ts
// types.ts
export const DEFAULT_READER_SETTINGS: ReaderSettings = { …, pageWidth: 640 };  // 旧：420，超宽窗口一行仅 ~27 汉字
// 各引擎
private settings: ReaderSettings = { ...DEFAULT_READER_SETTINGS, scrollMode: true };
```

### 4.10 进度按「内容量」而不是「章数」加权（`EpubLazyLoader`）

```ts
/**
 * 按"内容量权重"计算已加载前缀在整本书里的占比。
 * 权重取 zip 条目的 uncompressedSize（中央目录里就有，不需要解压，O(章数)）。
 */
export function weightedLoadedFraction(loadedPrefix: number, weights: readonly number[]): number { … }

/**
 * 逆运算：整书进度 → 已加载文档内百分比。
 * 关键点：章内位置必须在「钳位后的章」上重新插值，
 * 否则指向未加载章节时会把不存在的位置映射成错误坐标（回归测试已锁）。
 */
export function weightedDocPercent(wholeBookPercent: number, loadedPrefix: number, weights: readonly number[]): number { … }
```

为什么需要它：旧口径 `bookPct = docPct × (已加载章数 / 总章数)` 隐含「每章内容量相同」的假设。
真实 EPUB 里常见「前面若干短章、后面一章占大半」的分布，此时按章数算会让**进度条在后台补章时明显回退**。
改用字节权重后：

| 分布（前 3 章各 1KB、第 4 章 97KB） | 章数口径 | 字节口径 |
|---|---|---|
| 加载 1 章后 | 0.25 | **0.01** |
| 加载 3 章后 | 0.75 | **0.03** |

每章等权时两种口径完全一致（退化安全）。
`chapterIndexForPercent` 仍按章数做**保守**估算（宁可多预加载、不肯少加载），字节权重只用于进度显示。

---

## 五、验证与结果

### 5.1 回归（全部 PASS）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npx vitest run` | **18 files / 218 passed + 1 skipped**（skip = `NYAR_PERF_FULL=1` 的 40MB 用例，已手动跑过） |
| `npm run build` | 成功；`main.js` 2.41MB；`pdf.worker.min.mjs` 已复制 |
| 真实引擎 E2E（Edge 真实 iframe） | **67/67 PASS**（7 场景，含 2200/360 两个曾漂移的宽度） |

### 5.1b 独立验证（stream-d，不写产品代码）

- `verify/baseline.json` vs `verify/after.json`：同一套 6 场景 × 111/154 条 DOM 断言。
  - baseline（`git 92a0daf` 旧引擎）：**107 PASS / 43 FAIL**（P3a 容差收到 0.2px 后）。
  - after（**复跑后的最终结果**）：**153 PASS / 0 FAIL**（12 条 advisory 不算硬失败）。
- 复跑中 stream-d 抓到一处真实回归并已修复：我在改 `columnGridWidth` 时**漏掉了 `column-width`**，
  浏览器于是按列数均分容器（`2_000_000 / 10000 ≈ 200px`），与页宽无关，页数从 232 涨到 496。
  修复后实测：`computed column-width == 页宽`、相邻列间距 == 步长、每列漂移 0、`clippedRight = 0`。
- 证据强度：DOM/几何断言全部 **E1**（真实引擎 + 真实 `buildEpubHtml` + 真实 `styles.css` + Edge 实测几何）；「PDF 同一份 working buffer」为 E3。
- 5 项「无法验证」已如实记录（Obsidian 真实宿主布局、真实 EPUB 的 CSS/字体组合空间、鼠标键盘事件路径、MOBI 二进制解析、真实 zip 字节 → blob 那一段）。

### 5.2 算法层（真实浏览器）

`node verify/headless-pagination.mjs --width 900|2200|560 [--double]`

| 场景 | 页数 | 位移校验 | 横向溢出 |
|---|---|---|---|
| 900×700 单页 | 80 | 2 页位移 1712 == 2×856 ✅ | 无（874/874） |
| 2200×900 双页 | 60 | 1330 == 2×665 ✅ | 无（1374/1374） |
| 560×700 双页 | 80 | 1032 == 2×1032 ✅ | 无（534/534），已自动退回单页 |

### 5.3 真实引擎端到端（esbuild 打包真实 `HtmlDocEngine` → Edge 真实 iframe）

`node tests/manual/real-engine-check.mjs`（2000 块 + 大图 + 长图 + 登记图，7 个场景 / **67 条断言全部 PASS**）

| 场景 | 页宽/步长 | computed column-width | 相邻列左缘间距 | 漂移 | 末页裁切 |
|---|---|---|---|---|---|
| 1200×800 单页（144 页） | 1090/1130 | 1090（=页宽） | 1130 | **0** | 0 |
| 1200×800 双页（250 页） | 522/552 | 522 | 552 | **0** | 0 |
| 2200×900 单页（144 页） | 1400/1440 | 1400 | 1440 | **0** | 0 |
| 2200×900 双页（144 页） | 1035/1065 | 1035 | 1065 | **0** | 0 |
| 360×700 单页（326 页） | 276/316 | 276 | 316 | **0** | 0 |

其它断言：补章后页码保持（追加 300 块：页码不变、总页数变大）；`resolveAsset` 注入时 `img.src` 为 `blob:`、未注入时为可见占位；无横向溢出；单/双页位移精确等于「翻过页数 × 步长」。

**该 harness 在修复过程中真实抓到 4 个缺陷**（全部已修）：

1. 未注入 resolver 时 `img[data-nyar-asset]` 既不解析也不加占位类 → 图片凭空消失（正是用户报告的现象）；
2. `percentFromPage/percentageFromPage` 在末页只有 ~99% → 进度条永远到不了尽头；现末页精确返回 10000/1；
3. **列距累积漂移**（独立验证 stream-d 量化）：旧实现把栏容器宽度写死 `2_000_000px`，
   `n = min(column-count, floor((U+g)/(w+g)))`、实际步长 `= (U+g)/n`；2200px 窗口下
   `2000040/1440 = 1388.9…` → 每列多 **0.951px**，乘以末列号 231 后累积 **219.69px**，
   末页每行右侧被 `overflow:hidden` 裁掉。修法：宽度改由 `columnGridWidth()` 推导
   （取 `U = n × stride − gutter`，使 `(U + gutter)/n ≡ stride`）。
4. **修复第 3 条时把 `column-width` 字段删掉了**（Lead 自己的回归，由 stream-d 复验抓到）：
   只剩 `column-count` 时浏览器按列数均分容器（`2_000_000 / 10000 ≈ 200px`），
   与页宽完全无关，页数从 232 涨到 496、一页里塞进多个窄栏。
   修法：恢复 `column-width: var(--nyar-page-w)`，并把列数也改为由
   `columnGridCount()` 推导（受 Blink 实际生效上限 10000 约束）。
   教训：**几何断言必须校验「列宽/列距」本身，不能只用 `pageWidth+gutter` 当基准做自证**——
   该 harness 现已补上 `getComputedStyle(columnsEl).columnWidth` 与「相邻列左缘间距」两条探针。

### 5.4 性能（合成样本，见各 teammate 报告与 `verify/`）

| 指标 | 旧 | 新 | 备注 |
|---|---|---|---|
| 3000 章 / 40.6MB EPUB 首屏构建 | 241.3ms / 13.5MB HTML | **0.7ms / 3KB HTML** | 约 360×；未计入 13.5MB 文档的 DOM 解析/布局代价 |
| 3000 章 / 11.4MB EPUB 首屏构建 | 110–145ms | 0.3–0.7ms | 190–760× |
| TXT 50 万段布局 | 34.0ms / +29.4MB 堆 | **17.8ms / +2.3MB 堆** | 堆降约 13× |

**分页重排成本（独立验证，真实引擎 + 真实 DOM 计数器，E1 证据，`verify/_perf.json`）**

在同一页内分别挂载 `git 92a0daf`（旧）与当前工作区的真实 `HtmlDocEngine`，统计每次强制重排期间 DOM 几何读取与子元素迭代次数（5 次采样取中位数）：

| 合成书 | 引擎 | 每次重排总操作数 | 子元素迭代 | 耗时中位数 |
|---|---|---|---|---|
| 2080 块（262 页） | 旧 | **2095**（3 几何 + 2092 迭代） | 2092 | 11.6ms |
| 2080 块 | 新 | **1**（1 几何 + 0 迭代） | 0 | ~0ms |
| 6240 块（836 页） | 旧 | **6271**（3 几何 + 6268 迭代） | 6268 | 33.2ms |
| 6240 块 | 新 | **1**（1 几何 + 0 迭代） | 0 | ~0.1ms |

读法：旧实现的操作数随文档规模**线性增长**（2080→6240 块，操作数 2095→6271、耗时 11.6→33.2ms），新实现恒为 **1 次几何读取**、耗时不再随规模增长。这正是「大文件打开后翻页/单双页失灵」的直接量化解释：旧实现每翻一页/每次重排都要扫一遍全文档并逐块触发布局。

### 5.4b 本轮追加的性能优化（第二轮，均已实测）

**(1) PDF 分页偏移：O(页数²) → O(页数)，滚动一屏 15 万次强制布局 → 0 次**

旧 `PdfEngine.fixSlotSize()` 每修正一页尺寸都会 `for (const s of this.slots) s.top = s.el.offsetTop`——
3000 页文档滚动一屏（约渲染 50 页）就是 15 万次强制布局读取。现在改为：只写 CSS + 批次结束调用一次
`computeRowTops()`（纯算术，行高 = 行内最高页高）。真实 Edge 实测（`tests/manual/perf-pdf-offsets.mjs`，各 3 次取最优）：

| 场景 | 旧（全表读 offsetTop） | 新（一次纯算术） | 提速 | 省下的布局读取 |
|---|---|---|---|---|
| 1000 页 / 滚一屏 50 页 | 66.4ms，50000 次 | 0.2ms，0 次 | **178.8×** | 50,000 |
| 3000 页 / 滚一屏 50 页 | 195.4ms，150000 次 | 0.7ms，0 次 | **279.1×** | 150,000 |
| 3000 页双页 / 滚一屏 50 页 | 174.2ms，150000 次 | 0.9ms，0 次 | **193.6×** | 150,000 |

配套单测：`tests/pdf-row-tops.test.ts`（含 200 页随机混合尺寸下与「逐页累计」参考实现逐项相等）。

**(2) TXT 行数估算：固定 0.62 → canvas 实测汉字宽度（误差 68% → 3%）**

旧实现用固定 `CHAR_WIDTH_RATIO = 0.62` 估算每行字符数。真实浏览器实测（`tests/manual/measure-cjk-line.mjs`）：

| 字号/宽度 | 真实行数 | 真实字/行 | 旧口径(0.62) | 新口径(canvas 汉字) | 汉字实测宽 |
|---|---|---|---|---|---|
| 18px / 640px | 15 | 34 | 57（**+68%**） | 35（**+3%**） | 1em |
| 18px / 900px | 10 | 50 | 80 | 56 | 1em |
| 16px / 360px | 23 | 22 | 36 | 25 | 1em |
| 20px / 900px | 12 | 42 | 72 | 51 | 1em |

估算偏大 → 段落高度偏小 → 长文滚动到中段后实测修正把位置往回拉，即用户感知的「滚动位置跳动」。
现在用 `measureCharWidthRatio()`（优先纯汉字样本，回退混合样本，再回退常量；按字体+字号缓存）。

**(3) 补章进度：有界漂移 → 零漂移（绝对字节权重）**

进度换算改用 **整本** 的 zip 未压缩字节权重（中央目录直接可读，不解压，O(章数) 预扫），
而不是「已加载前缀」的权重，因此同一阅读位置的整书百分比**不随后台补章漂移**；
`wholeBookPercent` 与 `loadedDocPercent` 用同一套模型（p 在**已加载文档内线性**），严格互逆。

> **这里踩过一个真实 bug（值得记录）**：第一版把 p 当成"最后一个已加载章内的位置"
> （`(prefixWeight(loaded−1) + p×w[loaded−1]) / total`）。它在全部章节加载后
> `doc(0.10)` 会返回 **0.91**、`doc(0.42)` 返回 **0.94**，与引擎实际语义（p 是整份已加载
> 文档内的线性位置）不符，且与逆函数不互逆——**读者读到 10% 却落盘 91%**。
> 该缺陷由 stream-e 用探针实测发现（当时已有测试只断言"单调/有界/不 NaN"，拦不住）。
> 正确式子是一行：`wholeBookPercent(p) = p × prefixWeight(loaded) / totalWeight`。
> 修复后实测：全部加载时 `0.10→0.10 / 0.42→0.42 / 0.90→0.90`（往返恒等）；
> 部分加载时严格互逆；同一绝对位置在 loaded=2/4 时都得到 `0.015000`（零漂移）。
> 回归断言已补进 `tests/epub-lazy.test.ts`（恒等、互逆、零漂移三条）。

### 5.5 排版实测（headless Edge，宿主壳 + 引擎文档）

| 面板宽 | 宿主 padding | 正文左起 | 行宽 | 汉字/行 | 横向溢出 |
|---|---|---|---|---|---|
| 360px | 4/4px | 4.0px | 337px | 19 | 0 |
| 900px | 8/8px | 232.5px | 640px（新默认） | ~40 | 0 |
| 2200px | 8/8px | 790px | 640px（居中） | ~40 | 0 |
| *旧（2200px）* | *28px* | *66.4px* | *2067px* | ***162*** | *0* |

---

## 六、未做 / 已知限制（诚实清单）

1. **懒加载只解决首屏，不解决峰值内存**：`EpubLazyLoader` 只有追加、无卸载。真正释放需要"卸载远离阅读位置的 DOM"，而本项目用「极宽多栏 + 零宽标记测总页数」，删中间内容会让后续列号平移、标记失效 —— 这是架构性冲突，建议单独立项（改为"单章独立文档 / 分节渲染"是正解）。
2. **滚动模式下补章仍可能让整书百分比有小幅抖动**：已改为按 zip 条目的
   `uncompressedSize` 加权（见 §4.10），把「按章数」导致的明显回退压到很小；
   但「同一阅读位置对应的整书百分比」仍会随补章有 ≤ 一屏量级的有界变化，
   全部加载完成后精确收敛。
3. **MOBI/AZW3 未做章节懒加载**：仍是单份 HTML，大文件首屏偏慢。
4. **EPUB 深度恢复需要按比例预加载**：旧进度在 80% 处时需补到该章（≈读 80% 章节），仍显著优于旧的全量构建，但首次恢复不是瞬时的。
5. **未在 Obsidian 运行时内实测**：验证基于真实引擎代码 + 真实浏览器 + 真实 DOM，但未启动 Obsidian 本体跑端到端点击流；视图层的加载遮罩/忙态是静态契约测试 + headless DOM 复刻。
6. 未提交（工作区改动停留在 `D:\DSH_AI\NyaJob` 的未提交状态），以便你 review 后再决定提交。

---

## 七、参考

- 开源阅读器经验调研（41 条已核实来源 + 12 处显式标注"未验证"）：`docs/reader-refactor-research.md`
- 独立验证工具链与结果：`verify/README.md`、`verify/baseline.json`、`verify/after.json`
- 真实引擎 E2E：`tests/manual/real-engine-check.mjs`
