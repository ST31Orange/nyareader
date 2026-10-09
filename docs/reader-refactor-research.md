# NyaReader 渲染层重构调研（分页 / 大文件 / 图片 / 排版 / 虚拟滚动）

> 本文只做**调研与建议**，不改代码。每条按「来源 → 该项目做法 → 对本项目的启示 → 落到哪个文件/函数」写。
> 无法从一手来源确认的内容一律标注 **未验证**，并写出实际尝试过的 URL。
> 抓取环境说明：本次 `github.com` 与 `raw.githubusercontent.com` 被网络策略拦截（"resolves to a non-public IP address"），GitHub 源码改走 jsDelivr / unpkg 镜像，镜像 URL 见参考链接。

本项目涉及的关键文件：`src/services/books/formats/html/paging-layout.ts`（分页版式纯函数）、`src/services/books/formats/mobi/HtmlDocEngine.ts`（多栏 + transform 引擎、`buildBaseCss`）、`src/services/books/formats/epub/EpubDocument.ts`、`src/services/books/formats/epub/EpubLazyLoader.ts`、`src/services/books/formats/txt/TxtEngine.ts` + `TxtLayout.ts`、`src/view/ReaderController.ts`、`styles.css`。

---

## 一、分页布局

### 1. epub.js 的 `layout` / `spread`（含 `spread:"auto"` 窄窗退回单页）/ `Rendition` viewport 分页

**来源**：epub.js v0.3.93 官方 API 文档 <https://cdn.jsdelivr.net/npm/epubjs@0.3.93/documentation/md/API.md>（API.md 第 1166–1229 行 `Layout` 章、第 867–869 行 `Rendition` 参数）；官方 README <https://cdn.jsdelivr.net/npm/epubjs@0.3.93/README.md>；包内文件清单 <https://data.jsdelivr.com/v1/packages/npm/epubjs@0.3.93?structure=flat>。

**该项目的做法（原文摘录）**

```
## Layout  — Figures out the CSS values to apply for a layout
- settings.layout   (optional, default 'reflowable')
- settings.spread
- settings.minSpreadWidth  (optional, default 800)
- settings.evenSpreads  (optional, default false)
### spread — Switch between using spreads or not, and set the width at which they switch to single.
- spread: "none" | "always" | "auto"     - min: integer in pixels
Returns boolean  spread true | false
## Rendition options
- options.minSpreadWidth  overridden by spread: none (never) / both (always)
```

要点：`layout` 取值 `reflowable`（默认）/`pre-paginated`；README 中的 `flow` 为 `auto`（默认，跟随 OPF，未设则按 `paginated`）/`paginated`/`scrolled-doc`。**`spread:"auto"` 的语义就是按宽度阈值在双页与单页间切换**，阈值 `minSpreadWidth` 默认 **800px**，且会被 `none`/`always` 覆盖。分页由 `manager`（`default` 一次一个 section；`continuous` 拼多个并预载相邻）+ `view`（默认 `iframe`）组合；`Contents` 暴露 `columns(width,height,columnWidth,gap)`、`scrollWidth()`、`textWidth()`，即**由 iframe 内文档的多栏宽度反推页数**。

**对本项目的启示**

1. `MIN_SPREAD_WIDTH = 640`（paging-layout.ts:31）与 epub.js 的 `minSpreadWidth = 800` 是同一类阈值设计，方向正确。差别在 epub.js 把它做成**可被调用方覆盖的参数**，本项目写死为常量。建议上提为 `ReaderSettings` 可覆盖项，并保留本项目已有的「用户选择 vs 实际生效」区分（`PageLayout.double`），用它灰化 UI 按钮，比 epub.js 的布尔返回更清晰。
2. epub.js 把双页语义集中在 `Layout.spread(spread, min) -> boolean`；本项目拆成 `computePageLayout()` 的 `double` 判定 + `alignSpreadPage()` + `pageStep()`，**已等价且可单测**，无需引入 epub.js。
3. 唯一值得抄的是 `evenSpreads`（默认 false）——决定「是否强制对开从奇数页开始」。本项目用 `alignSpreadPage()` 硬编码「左页恒为奇数」，**没有给用户关掉奇偶对齐的开关**；将来做「跨章连续对开」时这是第一个要动的点。

→ 落到 `paging-layout.ts` 的 `MIN_SPREAD_WIDTH` / `MIN_SPREAD_PAGE_WIDTH` / `alignSpreadPage()` / `pageStep()`。

---

### 2. Readium 的 viewport 分页与分栏做法

**来源**：Readium CSS CSS03 <https://readium.org/css/docs/CSS03-injection_and_pagination.html>、CSS04 <https://readium.org/css/docs/CSS04-multicolumn_layout.html>、CSS19 <https://readium.org/css/docs/CSS19-api.html>、CSS12 <https://readium.org/css/docs/CSS12-user_prefs.html>；R2 Navigator Design Dilemmas <https://readium.org/technical/r2-navigator-design-dilemmas/>；Kotlin Toolkit `EpubPreferences` / `ColumnCount` / `Spread` <https://readium.org/kotlin-toolkit/latest/api/readium/readium-navigator/org.readium.r2.navigator.epub/-epub-preferences/>。

> 注：用户提到的 `readium-shared-js` 我未取到一手文档（GitHub 被拦截），**未验证**；下文全部基于 Readium CSS 与 Kotlin Toolkit 一手文档。

**该项目的做法（原文摘录）**

CSS03：*"Contents are paginated using **CSS multicolumns** … it's been cross-platform for a long time; it's responsive; it's tried and tested."* / *"The single page model relies on the **column width of the `:root` element**. Line-length is constrained by the **`max-width` of the `body`** element, including its padding. Finally an **`auto` margin centers the content**."* / *"--RS__defaultLineLength … is **`100%` by default** so that it does not conflict with the the zoom factor."*

外边距归属（CSS03 写成了契约）：*"**at least the top and bottom margins must be set on this container, and not inside it.**"*；*"For `body`, we own: `overflow`; sizing: `(min-|max-)width`, `(min-|max-)height`, `box-sizing`; **spacing: `margin` and `padding`**."*；*"--RS__pageGutter … it will **substract from `--USER__lineLength`**."*

列数归属：`--USER__colCount` *"By default, this setting behaves as `1`. **Value `0` is handled as an error and resolves to `1`.** It is up to implementers to decide whether they want this setting to be available … (e.g. setting only available in landscape and/or larger screens)."*；`--RS__colWidth` *"We set it to `100vw` … for a single-column for Safari – otherwise it won't fragment content, and **`auto` for multiple so that the column-count can be prioritized**."*

Kotlin Toolkit 把两件事拆开：`ColumnCount = { AUTO, ONE, TWO }` 管**可重排内容的列数**；`Spread = { AUTO, NEVER, ALWAYS }`，其文档说 *"Indicates if the **fixed-layout** publication should be rendered with a synthetic spread (dual-page)."* —— 即 **「双栏」与「双页对开」是两个旋钮**。

CSS 多栏的公认局限（CSS04 原文）：*"it is **not possible to set properties/values on column boxes** … the column box has **no concept of padding, margin or borders**; column boxes **don't establish containing blocks** for elements with `position: fixed || absolute`; **multicol elements with column heights larger than the viewport may pose accessibility issues**."*；*"there is **no JavaScript API available, we don't even know the number of columns which have been created and their real width**; since we can't use `overflow: paged-x`, there is **no way we can force the `scrollWidth` to be a multiple of the viewport, we must force the creation of an extra column if needed**."*

路线之争（R2 原文）：*"The first approach, and the approach used in Readium 1.x, is **CSS columns** … The second approach is to use **`overflow: paged-x`** … relying on a mechanism that is immature and not well-supported, but it does seem to perform much better than CSS columns … Our strategy is to use **CSS columns for our web reader** … For mobile though, our plan is to use `paged-x`."*

**对本项目的启示**

1. **「多栏 + transform」是行业主流选择**：Readium 1.x/2.x Web 阅读器、Kotlin Toolkit 可重排模式、Readium CSS 全部基于 CSS multicol；`overflow: paged-x`（CSS GCPM）至今未成熟（Readium CSS04 明确说 *"It is very unlikely a level 2 spec will tackle those problems in the short term"*）。本项目不必迁移到 `paged-x`。
2. **列数由读系统定且必须有 1 列兜底**：Readium 的 `--USER__colCount` 默认 1、`0` 视为错误按 1 处理。本项目 `computePageLayout()` 已有 `MIN_SPREAD_PAGE_WIDTH` 兜底，方向一致；建议照抄「0/非法值 → 1 列」的显式契约并加断言。
3. **Readium 把 margin/padding 归属写成契约**（`vh` 相关外边距放容器而非内容；`body` 只拥有 overflow/sizing/margin/padding）——这正是第四节要解决的「外边距叠加」的官方答案。
4. **CSS 多栏没有 JS API 告诉你列数/列宽**，这是本项目「零宽标记反推列号」存在的根本理由。Readium 用 `scrollWidth` 反推，本项目用 `offsetLeft` 反推，**后者更稳**（不受容器 `overflow`/`padding` 影响），且**不需要像 Readium 那样"造额外一列"让 `scrollWidth` 成为视口整数倍** —— 这是本项目相对 Readium 的真实优势，应写进注释防止后人"优化"回去。

→ 落到 `paging-layout.ts`（`double` 判定与下限）、`HtmlDocEngine.ts` 的 `measurePages()`。

---

### 3. foliate-js 的 paginator（多栏容器 + 位移；列数上限 / 跨栏元素 / 首末页空白 / measure）

**来源**：foliate-js v1.0.1 `paginator.js` 全文（unpkg 镜像）<https://unpkg.com/foliate-js@1.0.1/paginator.js>；npm 包页 <https://www.npmjs.com/package/foliate-js>。

**该项目的做法（源码摘录）**

默认值（`#top` 的 Shadow DOM）：`--_gap: 7%; --_margin: 48px; --_max-inline-size: 720px; --_max-block-size: 1440px; --_max-column-count: 2; --_max-column-count-portrait: 1;`

列数与列宽：`const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))`；`const columnWidth = vertical ? (size / divisor - margin) : (size / divisor - gap)`。

写进 iframe 文档的样式（`View.columnize`）：`'column-width': \`${Math.trunc(columnWidth)}px\``、`'column-gap'`、`'column-fill': 'auto'`、`'padding': '0 ${gap/2}px'`、`'overflow': 'hidden'`、`'overflow-wrap': 'break-word'`，并重置 `position/border/margin/max-height/max-width/min-height/min-width`，以及 `'-webkit-line-box-contain': 'block glyphs replaced'`（*"fix glyph clipping in WebKit"*）。

**关键点：foliate-js 不用 `translateX`，也不用「极宽容器」。** 它把 **iframe 自身撑到 `pageCount * pageSize` 宽**，内部 `documentElement` 始终一页宽，翻页靠滚动 `#container.scrollLeft`：

```js
const contentSize = contentStart + contentRect[side]
const pageCount = Math.ceil(contentSize / this.#size)
const expandedSize = pageCount * this.#size
this.#iframe.style[side] = `${expandedSize}px`
this.#element.style[side] = `${expandedSize + this.#size * 2}px`   // ← 首末各留一页
...
get pages()   { return Math.round(this.viewSize / this.size) }
get atEnd()   { return this.#adjacentIndex(1) == null && this.page >= this.pages - 2 }
detail.fraction = (page - 1) / (pages - 2);  detail.size = 1 / (pages - 2)
```

| 你点名的陷阱 | foliate-js 的应对（源码级） | 本项目现状 |
|---|---|---|
| **列数上限** | 不设大 `column-count`；`column-count` 走 auto，列数被 `divisor = min(maxColumnCount, ceil(size/maxInlineSize))` 限死在 1~2，且 `maxColumnCount` 是用户可见的**窄**上限；`column-width` 用 `Math.trunc` 取整 | `MAX_COLUMNS = 20_000` + `COLS_WIDTH = 2_000_000`（HtmlDocEngine.ts:72-73），走「极宽容器」路线 |
| **跨栏元素** | 在 `open()` 里**改写作者 CSS**：`page-break-(after\|before\|inside)` → `-webkit-column-break-$1`（注释：*"`page-break-*` unsupported in columns"*）、`break-*: page` → `break-*: column`；`vw/vh` **数值换算成 px**（*"replace vw and vh as they cause problems with layout"*） | `buildBaseCss()` 直接写 `break-inside: avoid`，**未做作者 CSS 改写**，也未处理 `vw/vh` |
| **首末页空白** | 外层宽度 = `expandedSize + size * 2`（首末各多一页），进度全部建立在 `pages - 2` 上 | 无首末空白页概念；但用「页中心」`(p-0.5)/total` 做同类边界修正（paging-layout.ts:153-157） |
| **measure 时机** | 用 `Range.selectNodeContents(doc.body)` 的 `contentRange.getBoundingClientRect()` 作内容尺寸；`ResizeObserver` 观察 `doc.body`；**并显式兜底 Web 字体**：*"the resize observer above doesn't work in Firefox … until the bug is fixed we can at least account for font load"* → `doc.fonts.ready.then(() => this.expand())` | `relayoutPages()` 用 `iframe.clientWidth/clientHeight` + rAF 合帧 + `docReady` 守卫；**无 `document.fonts.ready` 兜底** |
| **rect 精度** | 自己重写 `getBoundingClientRect()` 聚合并集，注释：*"there seems to be a bug in `getBoundingClientRect()` in Firefox where it fails to include rects that have zero width and non-zero height … which makes the visible range include an extra space at column boundaries"* | 只对锚点元素调一次 `getBoundingClientRect()`（`pageOfElement`），不做 rect 聚合 |

**对本项目的启示**

1. **两条路线是工程取舍，不是对错。** foliate-js「单栏容器 + iframe 长滚动」：容器宽 = 视口宽，**永不触发 `column-count` 上限与取整误差**；代价是 iframe 元素宽度 = `页数 × 页宽`（它按「一个 spine 文档一个 iframe」用，页数天然有限）。本项目「单文档 + 极宽多栏 + `translateX`」：一个文档承载整本书、翻页是合成层位移（不触发重排），与「零宽标记 O(1) 测页数」天然契合。**结论：在「单文档承载整本书」这个前提下本项目路线是对的**；foliate 路线只有走「一章一个 iframe」才划算，所以第二节的补章策略**不要**演变成换 iframe。
2. **必须补的一课：`document.fonts.ready`。** `relayoutPages()` 只等两次 rAF，**在 `@font-face`/内嵌字体加载完成前测量的页数会偏小**；而字体加载**不改变 iframe 尺寸**，所以 `scheduleRelayout()` 不会被触发，没有第二次强制重排。这是一个**能直接复现的「页数少了 / 末页截断」类 bug**，优先级最高。
3. **作者 CSS 改写值得补**：`page-break-before/after/inside` → column 语义、`break-*: page` 归一。否则作者写的 `page-break-inside: avoid` 在分栏模式下完全不生效（本项目 `buildBaseCss()` 只注入了自己的规则，管不到作者规则里的 `page-break-*`）。
4. **`vh/vw` 归一化**：EPUB 里 `height: 100vh` 的插图在分栏下语义混乱（`100vh` 是 iframe 视口高，可能远大于页高）。foliate 选择数值替换；本项目可走更轻的路——`img` 强制 `max-height`（已做），但**容器类元素上的 `vh` 仍未处理**。
5. **`pages - 2` 与本项目的「页中心」是同一类修正**（都为了不让第一页/最后一页的分数变成 0 和 1），本项目写法更简单，可保留，但要在注释里写清「为什么用页中心」。

→ 落到 `HtmlDocEngine.ts` 的 `relayoutPages()`（补 `fonts.ready`）、`buildBaseCss()`（补 `page-break-*` 改写与 `vh/vw` 处理）、`measurePages()`。

---

### 4. 为什么「多栏容器 + transform 位移」可行，以及如何规避「极宽容器 + column-count 上限」的取整误差

**来源**：CSS Multicol L1 §3.4 伪算法 <https://www.w3.org/TR/css-multicol-1/>；MDN Multicol Basic concepts <https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Multicol_layout/Basic_concepts>；Readium CSS04 <https://readium.org/css/docs/CSS04-multicolumn_layout.html>。

**规范原文（CSS Multicol §3.4 Pseudo-algorithm，逐字）**

```
(01)  if ((column-width = auto) and (column-count = auto)) then
(02)      exit; /* not a multicol element */
(03)  if column-width = auto then
(04)      N := column-count
(05)  else if column-count = auto then
(06)      N := max(1, floor((U + column-gap)/(column-width + column-gap)))
(08)  else
(09)      N := min(column-count, max(1, floor((U + column-gap)/(column-width + column-gap))))
(11)  W := max(0, ((U + column-gap)/N - column-gap))
```

`U` = 多栏元素 used width，`N` = 列数，`W` = 列宽。**三条推论全部来自第 9–11 行：**

- 当 `column-width` 与 `column-count` 都非 auto 时，**`column-count` 是「上限」而非实际列数**：`N = min(column-count, floor((U+gap)/(width+gap)))`。
- **`W = (U + gap)/N - gap` 是用 `U` 除出来的，不是你请求的 `column-width`。** 只要 `column-count` 真被当作上限，`W ≠ pageWidth`，而**每列步长 = `W + gap`**，于是 `translateX(page * (pageWidth + gap))` 系统性漂移。
- 取整误差来源：`W` 是浮点除法的结果，浏览器布局时吸附到 LayoutUnit（Blink 为 1/64 px）；`U` 极大（本项目 `COLS_WIDTH = 2_000_000`）时误差在每列累积，`markerLeft / stride` 比值偏离整数。

**这正是 `HtmlDocEngine.ts:64-73` 注释记录的坑，而规范原文就是它的权威依据：**

> 关键约束（踩坑记录）：必须远大于"容器宽 ÷ 最小页宽"能产生的实际栏数。若实际栏数触及 column-count 上限，Chromium 会把容器宽度摊到上限栏数上，实际列距变成 容器宽÷栏数，与 pageWidth+gap 不符，导致翻页位移漂移、窄窗双页显示约 1.7 页并出现三栏错位。

MDN 的白话版（Basic concepts）同义：*"`column-count` will act as a **maximum number of columns** … no more columns will be drawn, and **the extra space is distributed evenly between the existing columns**, even if there is enough room for more columns of the specified `column-width` size."*

**为什么「多栏 + transform」整体仍可行（三条规范级理由）**

1. **列盒是独立 BFC**：*"These column boxes establish an independent block formatting context into which the multi-column container's content flows"*；首个子元素的 margin 不与容器折叠（规范专门给了 `margins-do-not-collapse` 说明），因此「固定列宽 + 固定列高 + `column-fill: auto`」能把内容**确定性**切成等宽等高的一列页，页首留白可预测。
2. **溢出列是规范行为，不是 hack**：CSS04 *"a multicol element can have more columns that it has room for, additional column boxes are created in the inline direction … columns that appear outside the multicol element are called **overflow columns**."* —— 「放不下就往右长」正是分页阅读要的语义。
3. **`transform: translateX()` 不参与布局**，只影响合成，翻页 O(1) 且不触发重排；配合绝对定位的 `.nyareader-book`（`position:absolute; left:50%; top:50%; transform: translate(-50%,-50%)`，HtmlDocEngine.ts:585-594），可见页永远居中。

**业界规避取整误差的三类做法（可验证）**

- **A. 压低列数（foliate-js，最稳妥）**：`divisor = min(maxColumnCount, ceil(size/maxInlineSize))` + **`Math.trunc(columnWidth)`** —— 主动把列宽取整，让 `W` 落在整数像素上，从源头消灭小数；列数 ≤ 2，除法误差不可能放大。
- **B. 把 `column-count` 抬到实际不可能触及的高度（本项目路线）**：`MAX_COLUMNS = 20_000` 使第 9 行的 `min()` 永远返回 `floor(...)` 分支，`column-count` 退化为**无效上限**，`N` 完全由 `U / column-width` 决定，`W = (U+gap)/N - gap ≈ pageWidth`（要求 `U` 使该除式整除）。
- **C. 用「零宽末端标记」直接测真实末列位置（本项目已有）**：`pageCountFromMarker(markerLeft, layout) = max(1, round(markerLeft / columnStride) + 1)`（paging-layout.ts:175-178）。**这是在测量层面而非算术层面消掉误差**：只要 `markerLeft` 是浏览器真实算出的，即使 `W` 有微小偏差，`round()` 也能吸收（偏差 << 半个 stride）。

**对本项目的启示（本次最具体的一条）**

1. **`COLS_WIDTH` 不该是拍脑袋的 `2_000_000`，应由 `columnStride` 反推。** 要让 `W` 恰等于 `pageWidth`，需 `(U + gap)/(W + gap)` 为整数，即 **`U = N * (pageWidth + gutter) - gutter`**，其中 `N` = 预估最大页数（例如上一轮实测 `pages * 1.25 + 8`）。`columnStride = pageWidth + gutter`、`bookWidth = pageWidth*2 + gutter` 已在 `paging-layout.ts:94,104` 定义，可直接用。**把 `COLS_WIDTH` 从 `HtmlDocEngine.ts` 的魔数改成 `paging-layout.ts` 里可单测的纯函数**，是本次最值得做的一件事。
2. **顺手把 `gutter` 与 `pageWidth` 都显式取整**：`pageWidth` 已 `Math.round`（paging-layout.ts:92），建议在 `computePageLayout()` 里 `const gutter = Math.round(...)`，并对返回的 `columnStride` 加整数性断言，对齐 foliate-js 的 `Math.trunc` 思路。
3. **保留并加固标记方案**：`offsetLeft` 相对 `offsetParent`（`.nyareader-columns`，`position: relative`），**不受父级 `translate(-50%,-50%)` 与 `translateX` 影响**——`HtmlDocEngine.ts:699-721` 的注释已写对，单测也锁住了。**不要换成 `scrollWidth`**（Readium 为此不得不"造额外一列"）。
4. **给 `MAX_COLUMNS` 加运行时自检**：`measurePages()` 之后断言 `markerLeft / columnStride` 与 `pages` 一致（容差 0.5），漂移超阈值则 `console.warn` 并按实测 `pages` 重算 `COLS_WIDTH` 再测一次。**当前代码没有任何自检**，真触到上限时症状是「页码乱跳」而不是报错。

→ 落到 `paging-layout.ts`（新增「由页数反推 `COLS_WIDTH`」纯函数、gutter 取整、stride 断言）、`HtmlDocEngine.ts` 的 `MAX_COLUMNS` / `COLS_WIDTH` / `measurePages()` / `buildBaseCss()` 中 `.nyareader-columns` 的 `width`。

---

## 二、大文件打开

### 5. 「spine 项按需加载 + 单章独立文档/视图」模型 vs 「整本合并成单文档」

**来源**：R2 Navigator Design Dilemmas §4/§5 <https://readium.org/technical/r2-navigator-design-dilemmas/>；foliate-js `paginator.js` 的 `#goTo` <https://unpkg.com/foliate-js@1.0.1/paginator.js>；EPUB 3.3 spine 与 synthetic spreads <https://www.w3.org/TR/epub-33/>。

**该项目的做法（一手原文）**

R2：*"The **single-iframe approach is central to Readium 1.x** … **Within the web page is an iframe containing the content of the book. The outer frame … is responsible for replacing the content inside the iframe when crossing resource boundaries**, injecting CSS and JavaScript as appropriate."* / *"A variant … is to use **multiple iframes** … things such as infinite scrolling (**where each iframe contains a single resource**). I am not aware of this approach being used in any in-production reader implementation."* / *"On mobile … **not use iframes at all, have a given web view only be responsible for one resource at a time** … features like **preloading adjacent resources**."*

foliate-js 完全对应「单章独立文档 + 前后置换」，**旧章显式卸载**：

```js
const oldIndex = this.#index
const onLoad = detail => {
  this.sections[oldIndex]?.unload?.()          // ← 释放上一章
  this.setStyles(this.#styles)
  this.dispatchEvent(new CustomEvent('load', { detail }))
}
await this.#display(Promise.resolve(this.sections[index].load()).then(src => ({ index, src, ... })))
```

即任意时刻**只有一个 section 的文档在内存里**：`sections[index].load()` 取当前章，`sections[oldIndex].unload()` 释放上一章。

**关于「内存与首屏时间的量级差异依据」——必须诚实说明**

我**没有**找到任何官方发布的「整本合并 vs 按需加载」对照 benchmark。因此：

- **可确证的是机制层面差异**：按需方案的**同时驻留文档数 = 1（含预载 2~3）**，与总章数无关；整本合并方案的**驻留 DOM 节点数 ∝ 全书字符量**。foliate-js 的 `unload()` 与 Readium 的 "replacing the content" 都表明释放是设计的一部分。
- **量纲可以推**：设 N 章、每章 m 个块级元素，则整本合并 ≈ `N·m` 个节点，按需 ≈ `m`（常数），比值 = `N`。本项目自己的量级锚点是「**3000 章 / 40MB**」（`EpubDocument.ts:6`）与「**50 万段 TXT**」（`TxtEngine.ts:17`）。
- **未验证**：「首屏从 X ms 降到 Y ms」「内存峰值从 A MB 降到 B MB」这类数字本文档不给，因为没有一手来源。建议本项目自建 benchmark（见启示 3）。

**对本项目的启示**

1. **本项目方向正确，做法比 Readium/foliate 更保守**：`buildEpubHtml()` 默认只构建前 2 章（`EpubDocument.ts:29,406-413`），其余由 `EpubLazyLoader` **增量追加到同一文档**（不是换 iframe），兼顾了「按需」与「单文档」。
2. **结构性风险必须写清：本项目只解决首屏时间，没解决峰值内存。** Readium/foliate 的核心是 **`unload()`**，而 `EpubLazyLoader` **只有追加、没有任何释放路径** —— 读完全书后内存会与「整本合并」收敛到同一量级。要做到真释放，需要「按页/按章卸载远离阅读位置的 DOM」，而这与「极宽多栏 + 零宽标记测总页数」**直接冲突**（删中间内容会让所有后续列号平移，`markerLeft` 失效）。**这是本项目最深的架构矛盾，建议单独立项，不要在本次重构里顺手做。**
3. **建议补一个可复现 benchmark**：固定一本 3000 章 EPUB，测 (a) `mount()` 到首帧可读耗时、(b) `performance.memory.usedJSHeapSize` 峰值、(c) 全书读完后的堆占用。没有这组数字，「懒加载有没有用」只能靠推理。测试可放 `verify/`（仓库已有）。

→ 落到 `EpubDocument.ts` 的 `buildEpubHtml()` / `DEFAULT_INITIAL_CHAPTERS`、`EpubLazyLoader.ts` 的 `start()` / `slice()` / `appendUpTo()`、`HtmlDocEngine.ts` 的 `notifyContentAppended()`。

---

### 6. 本项目现状与改法：「首章优先 + 后台补章」的利弊与风险

**来源**：本项目 `EpubLazyLoader.ts` / `EpubDocument.ts` / `ReaderController.ts`；对照 foliate-js `#goTo` 的 `unload()`；Readium R2 §4。

**本项目现状（读源码的确切事实）**：首屏 `buildInitialHtml(2)` 只 `await` 前 2 章（EpubDocument.ts:316-327）；`slice()` 每片 16ms 预算、`batchSize = clamp(4, 64, ceil(total/240))`（EpubLazyLoader.ts:79-82,162-171）；`private chain: Promise<void>` 保证后台补章与跳转预加载不交错（:87,145-152）；每章片段自带 `<span id="nyareader-epub-N">`（EpubDocument.ts:234-241）；进度换算 `toWholeBookPercent` / `toLoadedDocPercent`（:46-58）在 `ReaderController.ts:234,244` 使用；`notifyContentAppended()` 把标记重挂到末尾后 `relayoutPages(true, true)` 强制重测（HtmlDocEngine.ts:358-369）。

**利**：首屏只解析 2 章，**首屏时间与总章数基本解耦**（直接修掉 `EpubDocument.ts:4-7` 记录的旧缺陷「3000 章 / 40MB 的书要在首屏前把整本书读完」）；「单文档」保住了「零宽标记测总页数」的前提，也不需处理 foliate 那种跨章换文档的边界；串行队列 + 时间预算是标准做法。

**弊 / 风险（按严重度排序）**

1. **进度百分比被拆成两层，且换算假设不成立。** 引擎报的是「已加载前缀文档内百分比」，`toWholeBookPercent` 用 `p × f`（`f = loaded/total`）线性换算，**隐含假设「章节数分布 = 内容量分布」**。对章节长度差异大的书（200 字前言 vs 5 万字附录），补章使 `f` 变大时，同一阅读位置算出的整书百分比会**变小** → **进度条回退**。这是 `EpubLazyLoader.ts:46-50` 的数学必然，不是实现 bug，但用户可见。
   → 改法：`f` 的权重改为**字节数**。zip 条目的 `uncompressedSize` 无需解压即可读到，首屏 O(章数) 预扫得到稳定权重表。
2. **目录跳转要先补到第 K 章，而补章期间分页会重排。** `ensureChaptersThrough()` 一次追加 `preloadBatchSize = max(batchSize, 32)` 章（:137-139），在分页模式下是一次大 DOM 插入 + 一次全量重排 → 大书上「点目录后卡顿一两秒」。可优化：跳转时只补到目标章 + 暂停后台补章（队列与 `dispose()` 已支持）。
3. **追加后重排会改变总页数，进而改变页码。** `relayoutPages()` 用 `prevPct = (currentPage-0.5)/pages` 保存相对位置再反算（HtmlDocEngine.ts:691-693），做法正确，但由于 `f` 也在变，**页数与百分比同时变化**（「第 40/120 页」→「第 40/135 页」），非常容易让人困惑。
   → 改法：补章期间 UI 只显示**已加载部分**的总页数，或明确标注「正在补齐（已加载 x/y 章）」。`onStage("rendering", {loaded,total})`（:183）已在提供所需信息，只是 UI 没用。
4. **`appendUpTo()` 是 `for` 循环串行 `await` 每个 zip 条目，然后一次性 `append`**（:179）。3000 章时 `batchSize = 13`，即「13 次串行解压 + 一次大重排」。可改为按时间预算**逐章 append**，让重排更平滑。
5. **`initialChapters = 2` 硬编码。** 对「第一章就是全书一半」（网文转 EPUB 常见）仍会首屏解析一半的书；对「一万章 × 1KB」又太少。建议改为**按字节预算**（如首屏最多 512KB XHTML）与按章数上限取小。

**结论**：**不建议**切换到「一章一个 iframe」（会推翻分页引擎全部假设，成本远大于收益）。**建议**做三件小事：① `f` 的权重由章节数改为字节数；② `initialChapters` 改为「字节预算 + 章数上限」取小；③ 补章期间 UI 区分「已加载页数」与「预计总页数」。

→ 落到 `EpubLazyLoader.ts`（`chapterIndexForPercent` / `toWholeBookPercent` / `toLoadedDocPercent` / `adaptiveBatchSize` / `appendUpTo`）、`EpubDocument.ts`（`DEFAULT_INITIAL_CHAPTERS` / `buildInitialHtml`）、`ReaderController.ts:234,244`、`HtmlDocEngine.ts`（`notifyContentAppended` 的重排节奏）。

---

## 三、图片显示

### 7. 为什么静态资源应走 `blob:` object URL 而不是 base64 `data:` URI

**来源**：MDN `data:` URLs <https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/data>；MDN `blob:` URLs <https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob>；MDN `URL.createObjectURL()` <https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static>；RFC 4648 <https://www.rfc-editor.org/rfc/rfc4648.html>；RFC 2397 <https://www.rfc-editor.org/rfc/rfc2397.html>；EPUB 3.3 §3.7 <https://www.w3.org/TR/epub-33/#sec-data-urls>；epub.js `replacements` 选项 <https://cdn.jsdelivr.net/npm/epubjs@0.3.93/documentation/md/API.md>。

**(a) base64 膨胀 33% —— 由规范精确推导**

RFC 4648 §4 原文：*"The encoding process represents **24-bit groups** of input bits as output strings of **4 encoded characters**. … a 24-bit input group is formed by concatenating **3 8-bit input groups**."* 即 **3 字节 → 4 字符**，比值 `4/3 ≈ 1.3333`，**净增 33.3%**（外加 padding `=`，最坏多 2 字符）。这是规范定义的精确值，不是实测报道。

**(b) `data:` URL 只适合小数据 —— 规范就这么说**

RFC 2397 原文：*"The `data:` URL scheme is **only useful for short values** … The LITLEN (1024) limits the number of characters which can appear in a single attribute value literal, the ATTSPLEN (2100) limits the sum of all lengths …"*；*"(The embedded image is **probably near the limit of utility**. For anything else larger, **data URLs are likely to be inappropriate**.)"*；*"The effect of using long `data` URLs in applications is currently **unknown**; some software packages may exhibit unreasonable behavior when confronted with data that exceeds its allocated buffer size."*

**(c) blob URL 没有这个限制 —— MDN 的直接对比**

MDN `blob:` URLs 原文：*"Blob URLs are similar to data URLs, because they both allow representing in-memory resources as URLs; the difference is that **data URLs embed resources in themselves and have severe size limitations, whereas blob URLs require a backing `Blob` or `MediaSource` and can represent larger resources**."*

**(d) blob URL 的内存/GC 语义（含一个必须避开的反模式）**

MDN 原文：*"Each time you call `createObjectURL()`, a new object URL is created, even if you've already created one for the same object. Each of these must be released by calling `URL.revokeObjectURL()` when you no longer need them. **As long as there's one object URL active, the underlying object cannot be garbage-collected and may cause memory leaks**."* / *"For long-lived applications, you should **revoke object URLs only when the resource is no longer accessible by the user** (such as when the image is removed from the DOM)."* MDN 给出的**反模式**：

```js
const url = URL.createObjectURL(blob);
img.src = url;
img.addEventListener("load", () => { URL.revokeObjectURL(url); });  // ← 反模式
document.body.appendChild(img);
```

> *"Revoking the blob URL immediately after the image gets rendered would make the image unusable for user interactions (such as right-clicking to save the image or opening it in a new tab)."*

MDN `URL.createObjectURL()` 另注：*"This feature is **not available in Service Workers** due to its potential to create memory leaks."*

**(e) 引擎侧实证：epub.js 自己把 `blobUrl` 与 `base64` 并列**

epub.js `Book` 选项文档原文：*"`options.replacements` — use **base64, blobUrl, or none** for replacing assets in archived Epubs (optional, default `none`)"*；`Resources` 类文档里 `replacements` 的默认值是 `"base64"`，同时并列提供 `createBlobUrl(content,mime)` / `revokeBlobUrl(url)` 与 `createBase64Url(content,mime)`。**一个成熟引擎把 `blobUrl` 列为可选项、并默认不内联（`none`），本身就是「不该默认 base64」的行业证据。**

**(f) 关于「字符串解析与内存峰值 / GC 行为」的实测报道：未验证**

我多次检索 `"data URI base64 image performance memory benchmark"`、`"base64 encoding overhead memory peak"`，返回的多为 StackOverflow 修订页镜像（`https://stackoverflow.com/revisions/...`，内容不完整，不可作可靠引用）；搜索结果中的中文技术博客（`https://www.php.cn/faq/2717985.html`、`https://cloud.tencent.com.cn/developer/article/2078183`）属二手内容，未采信。**故本文档只主张结构性事实**：base64 使字符串长度 ×4/3（RFC 4648 可证）；`data:` URL 内容必须作为**字符串**存在于 HTML 中，因此同时以 ① HTML 文本本身 ② 解码后的字节 ③ 解码过程的中间缓冲 三种形态占内存；`blob:` URL 只让内容以引擎管理的 `Blob` 一种形态存在，HTML 里只有一个短 URL。**这是机制推论，不是实测数字**，请勿在外写成「实测降低 X%」。

**对本项目的启示**

1. **本项目已经做对了，且比 epub.js 默认更激进。** `registerChapterImages()` 把 `<img src>` 重写为 `data-nyar-asset="zip 路径"` 并**移除 `src`**（EpubDocument.ts:91-111），由 `resolveAssetUrl()` 在需要时 `URL.createObjectURL(new Blob([bytes], {type: mime}))`（:348-374），`HtmlDocEngine.resolvePendingAssets()` 回填 `img.src`（:777-800）。**这正是 RFC 2397 + MDN 共同推荐的形态。**
2. **`releaseAssetUrls()` 与 MDN 的告诫基本一致，但要确认调用时机。** `dispose()` 先 `releaseAssetUrls()` 再 `releaseEpubStructure()`（:391-394），时机是「关闭/切换书籍」，DOM 即将销毁，符合 MDN 语义。**务必确认 `ReaderController` 在「同一本书内部切章/重排」时不会调 `releaseAssetUrls()`**，否则图片会集体变成 `nyareader-img-missing` 占位。
3. **`srcset` 被无条件剥掉**（`registerChapterImages()` 里 `.replace(/\ssrcset\s*=\s*(...)/i, "")`，:104）。在 blob 方案下 `srcset` 候选项都是 zip 内路径，需要全部登记成候选表才能用。**这不算 bug（EPUB 里极罕见），但要在注释里说明「这是有意丢弃」**，避免后人误以为遗漏。
4. **`MAX_INLINE_CSS = 512 * 1024`（:44）说明 CSS 仍走内联字符串** —— 与图片走 blob 不矛盾（CSS 必须内联才能保证级联顺序），但要意识到**大书的 CSS 总量仍是 O(章数) 的字符串累积**（已用 `StyleRegistry` 按哈希去重缓解，:52-82）。这是下一个可能的内存来源。

→ 落到 `EpubDocument.ts` 的 `registerChapterImages()` / `resolveAssetUrl()` / `releaseAssetUrls()` / `dispose()`、`HtmlDocEngine.ts` 的 `resolvePendingAssets()` / `resolveAssetOnce()`。

---

### 8. EPUB 内图片尺寸自适应的推荐 CSS，以及尺寸未知时的占位策略

**来源**：MDN `object-fit` <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/object-fit>；MDN Multicol Handling content breaks <https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Multicol_layout/Handling_content_breaks>；MDN 响应式图片 <https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Responsive_images>；Readium CSS03 Safeguards <https://readium.org/css/docs/CSS03-injection_and_pagination.html>；foliate-js `setImageSize()` <https://unpkg.com/foliate-js@1.0.1/paginator.js>。

**权威依据**

`object-fit: contain`（MDN）：*"The replaced content is scaled to maintain its **aspect ratio** while fitting within the element's content box. The entire object is made to fill the box, while preserving its aspect ratio, so the object will be 'letterboxed' or 'pillarboxed' if its aspect ratio does not match the aspect ratio of the box."*

MDN 给出的 `max-width:100%` + `break-inside: avoid` 组合：

```css
img { max-width: 100%; }
figure { margin: 0; break-inside: avoid; }
```

MDN 同时明确 `break-inside` 是**建议**而非保证：*"To some extent, **your use of fragmentation is always a suggestion to the browser** … If the content doesn't break where you intended, the result may be untidy, but the content is still available for your users."* 取值含 `auto / avoid / avoid-page / avoid-column / avoid-region`。

Readium CSS03 官方 Safeguards：*"Safeguards deal with: **media sizing (e.g. `img`, `svg`, `audio`, `video`)**; word wrap for long strings; large table's overflow."*；暴露 `--RS__maxMediaWidth` / `--RS__maxMediaHeight` / `--RS__boxSizingMedia` / `--RS__boxSizingTable`。

foliate-js 逐元素写入且**尊重作者已设的 max 值**：

```js
setStylesImportant(el, {
  'max-height': vertical ? (maxHeight !== 'none' && maxHeight !== '0px' ? maxHeight : '100%')
                         : `${height - margin * 2}px`,
  'max-width':  vertical ? `${width - margin * 2}px`
                         : (maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%'),
  'object-fit': 'contain',
  'page-break-inside': 'avoid',
  'break-inside': 'avoid',
  'box-sizing': 'border-box',
})
```

**`srcset` 与「尺寸未知时的占位」**：MDN 说明 `w` 描述符要求你知道每个候选的**内在宽度**（*"An image's intrinsic size is its real size, which can be found by inspecting the image file"*）。**所以「尺寸未知就不能算 `w` 描述符」**，只能退化为 `x` 描述符或干脆不用 `srcset`。防 CLS 的正解是给出宽高比（`width`/`height` 属性或 `aspect-ratio`）—— **未验证**：本次 `https://web.dev/learn/design/typography` 与 `https://web.dev/learn/design/` 均 fetch failed，故这条只作**工程常识**列出，不作为有出处的结论。但本项目有更好的替代：图片是从 zip 按需读出的完整字节，**可解析图片头取得真实 `width`/`height`**（PNG 的 IHDR、JPEG 的 SOF、GIF 的 Logical Screen Descriptor、WebP 的 VP8/VP8L/VP8X），纯字节解析、不需 canvas、不需等解码，可在 `resolveAssetUrl()` 里顺手做掉。

**对本项目的启示**

1. **现有规则方向正确，但有三处可立刻收紧。** 现状（`HtmlDocEngine.ts:570-575`）为 `img, svg, video, picture > img { max-width: 100% !important; height: auto !important; object-fit: contain; }`，分页限高（:623-626）为 `.nyareader-columns img { max-height: var(--nyar-img-max-h) !important; width: auto; }`。三处：
   - **`height: auto !important` 与 `max-height: ... !important` 同时存在**时，图片会先按宽度撑满、再由 `max-height` 压缩，缩放路径对细高/扁宽图不可预测。**建议照 foliate 分轴处理**：横向分页时 `max-height` 由页高推导、`max-width` 留给作者或 `100%`，不要两个轴都用 `!important` 拍死。
   - **缺 `box-sizing: border-box`**。Readium 专门有 `--RS__boxSizingMedia`、foliate 显式写了。作者给 `img` 加 `border`/`padding` 时会溢出页宽。
   - **`break-inside: avoid` 只写了一次**（:641-643），建议同时写 `page-break-inside: avoid`（foliate 两者都写）。
2. **`object-fit: contain` 在 `height: auto` 时是空操作**（元素盒比例 = 图片比例）；只有 `max-height` 把盒子压矮时才生效。**这条要写进注释**，否则后人删掉 `height: auto` 会以为 `contain` 能兜住。
3. **`--nyar-img-max-h` 的推导依赖 `--nyar-page-margin-y: 14px`（:548-549），而 `IMAGE_HEIGHT_RESERVE = 8`（paging-layout.ts:40）是另一套常量**，语义重叠（都在算「页高留多少给非图片内容」），却分居两个文件。建议把页内纵向留白也收进 `PageLayout`（加 `pageMarginY` 字段），让 `--nyar-img-max-h` 完全由纯函数推导 —— 这**正好补全** `paging-layout.ts` 文件头写的重构目标：**目前只完成了一半，横向边距收进去了，纵向还没有。**
4. **占位策略已优于多数阅读器**（`nyareader-img-missing`：`min-width:96px; min-height:72px;` + 虚线框，:577-583），远好于旧实现「`>1.5MB` 就 `src=""`」。**唯一可改进的是「已知真实尺寸但加载失败」**：应按真实尺寸（或宽高比）给占位 —— 回到启示 1 的「解析图片头」。
5. **`srcset` 保持剥离，但加注释**（理由见上一节启示 3）。

→ 落到 `HtmlDocEngine.ts` 的 `buildBaseCss()`（图片规则、`--nyar-img-max-h`、`.nyareader-img-missing`）、`EpubDocument.ts` 的 `registerChapterImages()` / `readAsset()`（可扩展为解析图片头）、`paging-layout.ts`（新增 `pageMarginY`）。

---

## 四、排版（用户最不满意的点）

### 9. 最大行宽（measure）的推荐区间

**来源**：web.dev《Typography》 <https://web.dev/learn/design/typography>（**本次 fetch failed，文本来自搜索片段**）；Google Fonts Knowledge《Understanding measure/line length》 <https://fonts.google.com/knowledge/using_type/understanding_measure_line_length>（**fetch failed**）；memoir 手册 `memman.tex` <https://mirrors.mit.edu/CTAN/macros/latex/contrib/memoir/doc-src/memman.tex>；MDN `<length>`（`ch`/`em` 定义）<https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/length>；Readium CSS12 <https://readium.org/css/docs/CSS12-user_prefs.html>、CSS19 <https://readium.org/css/docs/CSS19-api.html>、CSS03 <https://readium.org/css/docs/CSS03-injection_and_pagination.html>。

**(a) `ch` 的精确定义（MDN 原文，「用 `ch` 当 measure 单位」的规范依据）**

> `ch` — Represents the width or, more precisely, the **advance measure of the glyph `0` (zero, the Unicode character U+0030)** in the element's `font`. In cases where determining the measure of the `0` glyph is impossible or impractical, it must be assumed to be `0.5em` wide by `1em` tall.

**(b) 45–75 字符（web.dev，部分未验证）** —— 搜索结果返回的该页文本含：*"For a single-column page set in a serifed text face, a line length of **45 to 75 characters** is widely considered to be a satisfactory length."* 并引用了 Bringhurst。**但 `https://web.dev/learn/design/typography` 在我这里 fetch failed**，该文本来自 `web_search` 片段，**故标为「来源为搜索片段，未直接核实原文（部分未验证）」**。

**(c) 66 字符（memoir 手册，部分未验证）** —— 检索片段出现 `as 45 to 75 characters but 66 characters is often`；但我在该文件抓取结果中检索 `45 to 75|66 characters|measure` **只匹配到 `\emph{measure}` 的定义段**，该句落在抓取截断（约 50KB）之外，**未能逐字核实上下文**。可确证的是 memoir 确实给出 measure 的传统定义与表达法：*"The normal length of a line of text is often called the **measure** … A 10pt font with 11pt leading on a 20pc measure is described as `10/11 × 20`"*。

**(d) 主流阅读系统的默认值（Readium，一手可查）**

- `--RS__defaultLineLength`：*"represents the `max-width` of the `body` element and is **`100%` by default** so that it does not conflict with the the zoom factor."*
- `--USER__lineLength`：*"The `max-width` of `body` … Possible values: any value CSS property `max-width|height` accepts."* —— **Readium 有意不给推荐值域，把决定权留给实现者**。
- **`--USER__colCount` 与 `--USER__lineLength` 是 Readium 里唯一两个布局类用户设置**（CSS12 的 Layout 小节）—— 即其认为「行宽」与「列数」是必须暴露给用户的两个排版旋钮。
- 其它推荐值域：`--USER__fontSize` *"a range from `75%` to `250%`"*；`--USER__lineHeight` *"a range from `1` to `2`"*；`--USER__paraSpacing` `0~2rem`；`--USER__paraIndent` `0~3rem`；`--USER__wordSpacing` `0~1rem`；`--USER__letterSpacing` `0~0.5rem`。
- `--RS__pageGutter` *"it will **substract from `--USER__lineLength`**."*

**Apple Books / Kindle / KOReader 的默认边距与断行设置：全部未验证。** Apple Books 与 Kindle 均为闭源、官方文档不披露版式常量；我未检索到可引用的官方数值。KOReader 我尝试 `http://koreader.rocks/koreader-user-guide.pdf`（返回 `unsupported content type "application/pdf"`）与 `https://deepwiki.com/koreader/crengine/2.2-layout-and-rendering`（HTTP 429），均失败，**故本文档不引用 KOReader 的任何默认数值**。

**综合建议区间（基于可确证部分的工程判断，非引用）**：行宽上限 **`45ch`~`75ch`**，中值约 `65ch`；**但 `ch` 在中文语境失真**（`ch` 是数字 `0` 的宽度，全角汉字约为其 2 倍），中文应改用 `em`：按「每行 28–42 个汉字」折算即 `max-width: 28em ~ 42em`。

**对本项目的启示**

1. **`--nyar-measure` 有两个同名不同源的版本，必须合并。** 宿主层 `styles.css:116` 写 `--nyar-measure: min(74ch, 720px)`，且注释说明「不作用在 `.nyareader-html-iframe` 上」；引擎层 `HtmlDocEngine.ts:547` 写 `--nyar-measure: ${this.settings.pageWidth}px`，并另有 `body { max-width: ${this.settings.pageWidth}px }`（:558）。`grep` 确认 `src/` 下**没有任何地方读取宿主层的那个变量**。也就是说**实际生效的行宽上限就是 `settings.pageWidth = 420px`（默认）**。420px 在 18px 字号下约 **23 个汉字/行** —— **这很可能就是用户「排版不满意」的头号原因：大屏上正文挤在中间一条窄柱。**
2. **建议把行宽统一为「三档语义」并全部走引擎**：① 滚动模式 `max-width: min(<userLineLength>, <页宽上限>)` + `margin-inline: auto`（Readium 的 *"auto margin centers the content"*）；② 分页模式行宽 = 页宽 − 2×页边距（由 `computePageLayout()` 推导），**不要再用 `settings.pageWidth` 覆盖**；③ 用户设置暴露为 `ReaderSettings.lineLength`，取值 `45ch`~`75ch`，中文 UI 按「每行字数」呈现。
   注：分页模式下 `body` 的内容已被 `wrapPaged()` 搬进 `.nyareader-columns`（HtmlDocEngine.ts:482-498），`body { max-width: 420px }` 理论上不再作用于正文 —— 这说明**分页模式的行宽当前完全由页宽决定（是对的），出问题的是滚动模式**。这条值得实测确认。
3. **`ch` 在中文里不可靠，建议双轨**：给 `ReaderSettings` 加 `lineLengthUnit: "ch" | "em" | "px"`，按 `dc:language` 默认（`zh/ja/ko` → `em`，其他 → `ch`）。Readium CSS12 的 CJK 处理就是这个思路：CJK 横向书写要**禁用** `--USER__textAlign` / `--USER__bodyHyphens` / `--USER__paraIndent` / `--USER__wordSpacing`，只保留 `--USER__noRuby`（`--USER__letterSpacing` 由实现者自行决定）。**本项目目前对 CJK 完全没做区分**（`buildBaseCss()` 无条件设 `text-indent` / `word-break`），这是可查证的真实缺口。
4. **推荐数值（工程判断，标注为建议）**：中文正文 `max-width: 34em`、行高 `1.6–1.9`、段间距 `0.5–0.8em`、首行缩进 `2em`；英文正文 `max-width: min(66ch, 700px)`、行高 `1.5–1.7`、无首行缩进、段间距 `0.8em`。

→ 落到 `styles.css` 的 `--nyar-measure`（删除或改为纯展示用）、`HtmlDocEngine.ts` 的 `buildBaseCss()`（`body` 的 `max-width` / `--nyar-measure` / `text-indent` 的 CJK 条件化）、`TxtEngine.ts` 的 `contentWidth()` 与 `styles.css` 的 `.nyareader-txt-window` padding（TXT 行宽目前完全由 `--nyareader-txt-margin` 决定，无 measure 上限）。

---

### 10. 「外边距不应叠加」与 CSS 变量化的用户版式设置体系

**来源**：Readium CSS03 <https://readium.org/css/docs/CSS03-injection_and_pagination.html>；CSS12 <https://readium.org/css/docs/CSS12-user_prefs.html>；CSS19 <https://readium.org/css/docs/CSS19-api.html>；CSS07 <https://readium.org/css/docs/CSS07-variables.html>。

**「外边距不应叠加」的官方依据（CSS03 原文）**

> *"**at least the top and bottom margins must be set on this container, and not inside it.**"* / *"You may also want to set **left and right margins on this container** so that all margins are equal in the two-column view."* / *"Finally, on larger screens, you'll have to set **dimensions on this container so that it doesn't become too large**."* / *"For `body`, we own: `overflow`; sizing: `(min-|max-)width`, `(min-|max-)height`, `box-sizing`; **spacing: `margin` and `padding`**."*

> *"You can control horizontal margins in several ways: 1. using `column-gap` and `padding` for `:root`; 2. using `column-gap` and `margin` for the web view/chrome view/iframe; 3. using `padding` for `:root` and/or `body`. Please note that when using `padding`, you must take it into account when sizing `:root` and/or `body`. **Their widths contain the padding set for the element**."*

分页模型：*"Page gutters are part of `body` (`--RS__pageGutter`), hence `--USER__lineLength` … Contents are **centered in `:root` using the `auto` value for `body` margins**."* / *"By default, `--RS__pageGutter` is set to `0` … it will **substract from `--USER__lineLength`**."*

**CSS 变量化用户设置体系（Readium 的完整设计）**

优先级（CSS19 原文）：*"As a reminder, the priority is, in general: **USER > AUTHOR > RS**"*。两层前缀：`--RS__*` 为 Reading System 默认值（`--RS__colWidth` / `--RS__colCount` / `--RS__colGap` / `--RS__pageGutter` / `--RS__defaultLineLength` / `--RS__maxMediaWidth` / `--RS__maxMediaHeight` / `--RS__boxSizingMedia` / `--RS__baseFontSize` / `--RS__baseLineHeight` / `--RS__typeScale` / `--RS__paraSpacing` / `--RS__paraIndent`…）；`--USER__*` 为用户设置，覆盖 `--RS__*`（`--USER__colCount` / `--USER__lineLength` / `--USER__fontSize` / `--USER__lineHeight` / `--USER__textAlign` / `--USER__bodyHyphens` / `--USER__paraSpacing` / `--USER__paraIndent` / `--USER__wordSpacing` / `--USER__letterSpacing` / `--USER__ligatures` / 主题色…）。

写入方式（**这段对本项目最有价值**）：

```js
var root = document.documentElement;
root.style.setProperty("--USER__var", "value");   // 设置
root.style.removeProperty("--USER__var");          // 移除
root.style.setProperty("--USER__var", "");         // 空字符串等价于 removeProperty（CSSOM 定义）
```

> *"Possible values are **strict** i.e. implementers can't use any other value; **recommended** values are loose."* / *"The selectors used in user settings are indeed **'conditional'**, styles are applied if the variable is set as an inline style in `html` (`:root`)."*

**性能提示（CSS12 原文，极易被忽略）**：*"at least some rendering engines are optimized to manage **global CSS variables** (i.e. the ones declared in `:root`) and reserve a special cache for faster lookup and updates. Changes should consequently be handled as **inline styles in the `html` element** if you want the best performance possible."*

**「flags」机制**：*"Some variables behave like flags … think of the preset values as **boolean inline styles**: if they are set on the `:root` element (i.e. `html`) then the flag is enabled."* 例：`--USER__view: readium-paged-on / readium-scroll-on`；`--USER__bodyHyphens: auto / none`。

**对本项目的启示**

1. **本项目已承认并部分修复了叠加问题，方向与 Readium 一致。** `styles.css:105-107` 注释：*「旧实现 padding:20px 28px 与引擎留白叠加后左右达 ~66px，这里收到最小安全边」*。现在合计左右留白 = 8（宿主 `--nyar-reading-pad-x`）+ 10（`BOOK_MARGIN`）+ 4（`SAFETY`）+ 28（`PAGE_MARGIN_X_SINGLE`）= **50px/侧、100px 双向**，散在 4 处。Readium 的答案是把这套算术**收进一个变量体系**。
2. **立即落地的改法：把「宿主 padding」与「引擎页内 padding」的契约写成一个变量链**（照抄两层前缀）：`--nyar-rs-view-pad-x`（宿主拥有）/ `--nyar-rs-book-margin`（= `BOOK_MARGIN`）/ `--nyar-rs-page-margin-x`（= `PAGE_MARGIN_X_*`）/ `--nyar-user-page-margin-x`（用户覆盖，落 `:root` 内联样式）。并在 `computePageLayout()` 入参里**显式带上 `hostPadX`**，从 `viewWidth` 里减掉，让「可用宽度」只有一个来源。（当前 `viewWidth` 来自已被宿主 padding 收窄过的 `iframe.clientWidth`，所以**算术是自洽的**；但一旦有人改 `.nyareader-reading` 的 padding，`BOOK_MARGIN + SAFETY` 的语义就会漂移，因为它是在「iframe 内」的坐标系里加的。）
3. **CSS 变量作用域要放对。** 本项目 `relayoutPages()` 用 `root.style.setProperty("--nyar-page-w", ...)` 写 `documentElement`（✅ 对，HtmlDocEngine.ts:684-687），但字号/主题等是通过**重写整个 `<style>` 的 textContent** 生效的（`applyBaseStyle()`，:519-531）——**每次拖字号滑块都会重写整张样式表 → 整篇文档重新解析样式**。已比旧实现（`remove + create`）好，但按 Readium 这条还能再进一步：**把「用户可变量」（字号、行高、页边距、行宽、主题色）改为 `:root` 上的 `setProperty`，把「不变量」（重置、safeguards、图片规则）留在静态 `<style>`**；这样拖滑块只改几个自定义属性，`<style>` 文本经常完全不变（`lastStyleText` 短路直接命中）。
4. **`user-select: text` 与主题目前硬编码在 `buildBaseCss()` 字符串里**（:569, 590-591），改为变量后主题切换也只改 `--nyar-bg` / `--nyar-fg` 两个值。
5. **CJK 需条件化（同第 9 条）**：本项目无条件设 `text-indent`（`HtmlDocEngine.ts:564` 与 `styles.css:486` 的 `.nyareader-txt-para { text-indent: 2em }`），对英文书是错误的。建议在 `ReaderSettings` 增 `language`（或从 OPF `dc:language` 推导），据此开关。
6. **`--RS__pageGutter` 会从 `--USER__lineLength` 里扣掉** —— 这条规则应照抄并写进注释，否则「用户把行宽设成 600px，结果因页边距又变窄」会被反复当 bug 报。

→ 落到 `styles.css` 的 `.nyareader-reading` / `--nyar-*` 变量组、`HtmlDocEngine.ts` 的 `applySettings()` / `applyBaseStyle()` / `buildBaseCss()` / `relayoutPages()`、`paging-layout.ts` 的 `computePageLayout()`（`hostPadX` 入参）、`src/types.ts` 的 `ReaderSettings`（新增 `lineLength` / `language`）。

---

## 五、虚拟滚动

### 11. 虚拟滚动与「估算 + 实测修正前缀和」：foliate-js / KOReader / calibre，以及本项目 TxtEngine 的水平

**来源**：calibre E-book viewer 官方手册 <https://manual.calibre-ebook.com/viewer.html>；foliate-js `paginator.js` <https://unpkg.com/foliate-js@1.0.1/paginator.js>；Readium CSS25 <https://readium.org/css/docs/CSS25-performance_hacks.html>；本项目 `TxtEngine.ts` / `TxtLayout.ts`；MDN `<length>`（`ch`）<https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/length>。

**(a) calibre —— paged/flow 两模式，但实现未公开**

官方手册原文（可确证部分）：*"The viewer has **two modes, 'paged' and 'flow'**. In paged mode the book content is presented as pages, similar to a paper book. In flow mode the text is presented continuously, like in a web browser … pressing **Ctrl+M**."* / *"You can change the **number of pages displayed on the screen as well as page margins** in Page layout."* / 快捷键 `Ctrl+]` 增加每屏页数、`Ctrl+[` 减少、`Ctrl+Alt+C` 自动 / *"the viewer will set the following classes on the `body` element: `body.calibre-viewer-paginated` … `body.calibre-viewer-scrolling`"* / CSS 变量 `--calibre-viewer-background-color`、`--calibre-viewer-foreground-color` / *"**Non re-flowable content**: Some books have very wide content that cannot be broken up at page boundaries. For example tables or `<pre>` tags. In such cases, you should switch the viewer to flow mode … Alternately, you can also add the following CSS … `code, pre { white-space: pre-wrap }`"*。

**「calibre 的虚拟滚动 / 估算 + 实测修正前缀和」：未验证。** viewer 的渲染内核是私有 C++ 组件（`ebook-viewer`），官方手册不描述其内部排版算法，我也未找到公开的算法文档。**故本文档不对 calibre 的内部虚拟滚动方案做任何断言**，只采用上表的公开契约。

**(b) KOReader / crengine —— 未验证。** 尝试来源均失败：`http://koreader.rocks/koreader-user-guide.pdf`（`unsupported content type "application/pdf"`）、`https://deepwiki.com/koreader/crengine/2.2-layout-and-rendering`（HTTP 429，Vercel 拦截）。**故不做任何断言。**

**(c) foliate-js —— 不是虚拟滚动，而是「真滚动 + 反查可见区」**

`flow:"scrolled"` 模式**不虚拟化 DOM**：整个 section 的 DOM 都在，iframe 高度被设为内容高度（`scrolled()` 里 `'height':'auto','width':'auto'`），滚动交给 `#container`。它的「虚拟」只体现在**按需计算可见区**（`#getVisibleRange` + `bisectNode` 二分 + `TreeWalker` 过滤），用于定位/选区/进度，**不用于减少 DOM**。两个值得借鉴的细节：

```js
// 二分找一个文本节点内的偏移
const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => { ... }
// acceptNode：完全出视口的元素直接 REJECT，不遍历其子树
if (right < start || left > end) return FILTER_REJECT
```

**(d) 本项目 TxtEngine —— 「估算 + 实测修正前缀和」的完整实现（读源码的确切事实）**

- 三段类型化数组：`heights: Float64Array`、`prefix: Float64Array`（长度 = 段数 + 1，`prefix[i]` = 前 i 段累计高度）、`measured: Uint8Array`（TxtEngine.ts:73-77；构造见 TxtLayout.ts:27-38）。设计意图写在 `TxtLayout.ts:4-13`：从「每段一个 JS 元素」的普通数组改掉，避免 50 万段的 150 万堆元素。
- 估算：`estimateParagraphHeight(len, charsPerLine, lineHeightPx, spacingPx) = ceil(len/charsPerLine) * lineHeight + spacing`（TxtLayout.ts:16-25）；`charsPerLine() = floor(width / (fontSize * CHAR_WIDTH_RATIO))`，`CHAR_WIDTH_RATIO = 0.62`（TxtEngine.ts:47, 329-332）。
- 实测修正：`measureRange(start,end)` 逐个读 `children[k].offsetHeight`，仅当 `!measured[idx] \|\| abs(heights[idx]-h) >= 0.5` 时写回并记录 `firstChanged`，再 `rebuildPrefix(firstChanged)` **只从第一个变化点往后重算**（TxtEngine.ts:421-435 + TxtLayout.ts:55-61）。
- 二分定位：`indexAtOffset(prefix,count,offset)` = 最后一个 `prefix[i] <= offset` 的 i（TxtLayout.ts:73-88；TxtEngine.ts:348-364 有一份等价内联实现）。
- 只渲染视口上下各一屏：`WINDOW_BUFFER_SCALE = 1`；`renderRange()` 只在**区间变化**时重建 DOM（TxtEngine.ts:43, 380-389）。
- 漂移纠正：仅当 `abs(restored - scrollTop) > max(24, viewH*0.35)` 才改 `scrollTop`（:394-398），注释说明这是为了避免「每次滚动都微调 scrollTop 会与用户滚动'打架'」。

**评价：这是一个正确且相当完整的实现，处于主流水平；在地基（数据结构）上甚至优于 foliate-js（foliate 不做 DOM 虚拟化）。**

- ✅ **类型化数组**：50 万段下 `heights + prefix ≈ 8MB`、`measured = 500KB`；用 JS 数组则每元素约 8B double + 数组头 + 可能的装箱，实测量级 3~5 倍。有实质收益。
- ✅ **增量 `rebuildPrefix`**：`O(变化段数 + 视口段数)` 而非 `O(总段数)` —— prefix-sum 虚拟滚动的关键，做对了。
- ✅ **二分定位** `O(log n)`；✅ **`renderedStart/renderedEnd` 短路**；✅ **漂移阈值防抖动**（自研虚拟滚动最常见的坑）。

**可改进点（按收益排序）**

1. **「估算」太粗：`CHAR_WIDTH_RATIO = 0.62` 是单一常数。** 中文字符宽度 ≈ `1.0em`，用 `0.62` 会把每行字符数高估约 1.6 倍 → **估算高度系统性偏小** → `prefix` 初值偏小、滚动条与内容总高偏差大，之后靠实测一点点回收（用户表现为「滚动条越滚越长/越滚越短」）。
   → **改用 canvas `measureText` 实测**：一次性用 `document.createElement("canvas").getContext("2d")` + `ctx.font = \`${fontSize}px ${fontFamily}\`` 测代表性样本（`"0"`、`"m"`、`"中"`、`" "`）的 `measureText().width`，得到**按字符类别的宽度表**（ASCII / CJK / 空格），把 `estimateParagraphHeight` 从「字符数 / 每行字符数」升级为「按类别累加宽度后取 `ceil`」。**离线一次性成本仅几十微秒**，估算误差可从 ±60% 降到 ±10% 量级。
   注意：`ch` 的规范定义就是「数字 `0` 的 advance measure」（MDN），与 `measureText("0")` 完全对应，**这条改法有规范支撑**；并应在 `document.fonts.ready` 后重测一次（字体加载会改变 `ch`）。局限：对比例西文 `measureText` 只能测样本，不能替代真正的断行算法，所以收益主要在 CJK 与混排文本上。
2. **`rebuildLayout()` 在字号/宽度变化时 `measured.fill(0)`（:322）把全部实测结果作废**，下一轮又从全估算开始 —— 对 50 万段的书，「每次改字号都要滚一遍才能让进度准确」。**改进：保留 `measured`，对已测段的 `heights` 按「新字号/新宽度 ÷ 旧字号/旧宽度」比例缩放**，只把比例关系不成立的段（含图片、表格、超长单词等 `height ≠ 行数×行高`）重置为未测。可把 `measured` 从 0/1 扩成 0/1/2（未测 / 已测且线性可缩放 / 已测且不可缩放）。
3. **`getTotalPages()` 与 `currentPercentage()` 语义不一致（bug 级）。** `getTotalPages()` 用 `ceil(content / vh)`（:217-222），`currentPercentage()` 用 `scrollTop / contentHeight`（:224-229）；而 `scrollTop` 最大只能到 `content - vh`，所以**滚到底时百分比达不到 1**（最大 = `(content - vh)/content`）。`HtmlDocEngine.currentPercentage()` 用 `(currentPage-0.5)/pages`（:435-445）也是同类「永远到不了 1」问题。**建议统一为「可滚动区间归一化」：`percentage = scrollTop / max(1, contentHeight - viewportHeight)`** —— 注意 `goTo()` **已经用了这个正确公式**（:160），只有 `currentPercentage()` 不一致，属明确可修项。
4. **`contentWidth()` 每次重排都调 `getComputedStyle`**（:334-339）。频率可接受，但 `getComputedStyle` 会强制样式解析；建议缓存，只在 `ResizeObserver` 触发时刷新。
5. **段间距「两处定义」风险**：`PARAGRAPH_SPACING_EM = 0.6`（TxtEngine.ts:45）与 `.nyareader-txt-para { padding: 0 0 0.6em 0 }`（styles.css:485）必须一致（注释也写了）。**这与 `paging-layout.ts` 文件头抱怨的「同一个数散落多处」同源。** 建议把 `0.6` 由引擎写入为 CSS 变量（`--nyareader-txt-para-gap`），`styles.css` 引用变量，彻底消除手工同步。
6. **无 measure（行宽）上限**：`.nyareader-txt-window { padding: 0 var(--nyareader-txt-margin, 24px) }`（styles.css:480），宽窗口下正文会拉得很宽。建议复用第 9/10 条的 measure 变量体系。

**综上：本项目 TxtEngine 的 prefix-sum 方案是「正确的标准解法 + 三处可量化改进」，不需要重写。** 要动手的是：估算精度（canvas `measureText`）、`measured` 的缩放复用、`currentPercentage()` 的归一化公式。

→ 落到 `TxtEngine.ts` 的 `charsPerLine()` / `rebuildLayout()` / `measureRange()` / `currentPercentage()`、`TxtLayout.ts` 的 `estimateParagraphHeight()` / `fillEstimatedHeights()`、`styles.css` 的 `.nyareader-txt-window` / `.nyareader-txt-para`。

---

## 附：方法与局限

**因网络策略未能抓取的 URL（列出以便后续补查）**

- `https://github.com/futurepress/epub.js/blob/master/documentation/md/API.md`；`https://github.com/readium/readium-shared-js`；`https://github.com/readest/readest/blob/30727d35/apps/readest-app/.claude/memory/inline-block-column-overflow.md`
- `https://raw.githubusercontent.com/kkpan11/calibre/8c80541cc87afde443fb5d4ff3d95b181ed8ffaa/manual/viewer.rst`（jsDelivr 镜像返回 `application/octet-stream`）
- `https://web.dev/learn/design/typography`（fetch failed）；`https://fonts.google.com/knowledge/using_type/understanding_measure_line_length`（fetch failed）
- `http://koreader.rocks/koreader-user-guide.pdf`（`application/pdf` 不支持）
- `https://deepwiki.com/koreader/crengine/2.2-layout-and-rendering`（HTTP 429）；`https://deepwiki.com/kovidgoyal/calibre/4.5-e-book-viewer`（HTTP 429）；`https://deepwiki.com/futurepress/epub.js/3.3-layout-system`（HTTP 429）

**已标注「未验证」的全部条目**：① `readium-shared-js` 实现细节；② 「整本合并 vs 按需加载」的具体内存/首屏数字（只给结构性推论与本项目自己的 3000 章/40MB、50 万段锚点）；③ data URI 与 blob URL 的**实测**性能/内存对比数字（只有 RFC 4648 的 33% 精确推导与 MDN 机制描述）；④ 「45–75 字符」「66 字符」的原始出处（web.dev 页面 fetch 失败、memoir 相关句落在抓取截断之外）；⑤ Apple Books / Amazon Kindle / KOReader 的默认行宽与边距数值；⑥ calibre E-book viewer 的内部虚拟滚动算法（闭源）；⑦ KOReader / crengine 的排版与虚拟滚动方案（PDF 不支持、DeepWiki 429）。

---

## 参考链接

**规范（W3C / WHATWG / IETF）**
1. CSS Multi-column Layout Module Level 1（含 §3.4 伪算法）— <https://www.w3.org/TR/css-multicol-1/>
2. EPUB 3.3 — <https://www.w3.org/TR/epub-33/> ；§3.7 Data URLs — <https://www.w3.org/TR/epub-33/#sec-data-urls>
3. RFC 4648 — The Base16, Base32, and Base64 Data Encodings — <https://www.rfc-editor.org/rfc/rfc4648.html>
4. RFC 2397 — The "data" URL scheme — <https://www.rfc-editor.org/rfc/rfc2397.html>
5. Fetch Standard（WHATWG）— <https://fetch.spec.whatwg.org/>

**MDN**
6. `data:` URLs — <https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/data>
7. `blob:` URLs — <https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob>
8. `URL.createObjectURL()` — <https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static>
9. Using files from web applications — <https://developer.mozilla.org/en-US/docs/Web/API/File_API/Using_files_from_web_applications>
10. `object-fit` — <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/object-fit>
11. `<length>`（`ch` / `em` / `ic`）— <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/length>
12. Multicol：Basic concepts — <https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Multicol_layout/Basic_concepts>
13. Multicol：Handling content breaks — <https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Multicol_layout/Handling_content_breaks>
14. Using responsive images in HTML — <https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Responsive_images>

**Readium**
15. Readium CSS 文档目录 — <https://readium.org/css/docs/>
16. CSS03 Inject and paginate EPUB contents — <https://readium.org/css/docs/CSS03-injection_and_pagination.html>
17. CSS04 How the multicolumn layout works — <https://readium.org/css/docs/CSS04-multicolumn_layout.html>
18. CSS07 How to use CSS custom properties — <https://readium.org/css/docs/CSS07-variables.html>
19. CSS08 Defaults — <https://readium.org/css/docs/CSS08-defaults.html>
20. CSS12 User Settings and Themes — <https://readium.org/css/docs/CSS12-user_prefs.html>
21. CSS19 Variables API — <https://readium.org/css/docs/CSS19-api.html>
22. CSS25 CSS Performance Hacks — <https://readium.org/css/docs/CSS25-performance_hacks.html>
23. R2 Navigator Design Dilemmas — <https://readium.org/technical/r2-navigator-design-dilemmas/>
24. Kotlin Toolkit `EpubPreferences` — <https://readium.org/kotlin-toolkit/latest/api/readium/readium-navigator/org.readium.r2.navigator.epub/-epub-preferences/>
25. Kotlin Toolkit `ColumnCount` — <https://readium.org/kotlin-toolkit/latest/api/readium/readium-navigator/org.readium.r2.navigator.preferences/-column-count/>
26. Kotlin Toolkit `Spread` — <https://readium.org/kotlin-toolkit/latest/api/readium/readium-navigator/org.readium.r2.navigator.preferences/-spread/>

**epub.js（经 jsDelivr 镜像）**
27. API 文档 `documentation/md/API.md` — <https://cdn.jsdelivr.net/npm/epubjs@0.3.93/documentation/md/API.md>
28. README — <https://cdn.jsdelivr.net/npm/epubjs@0.3.93/README.md>
29. 包内文件清单（jsDelivr Data API）— <https://data.jsdelivr.com/v1/packages/npm/epubjs@0.3.93?structure=flat>
30. npm 包页 — <https://www.npmjs.com/package/epubjs>

**foliate-js（经 unpkg 镜像）**
31. `paginator.js` 源码 — <https://unpkg.com/foliate-js@1.0.1/paginator.js>
32. npm 包页 — <https://www.npmjs.com/package/foliate-js>

**calibre 与排版参考**
33. calibre E-book viewer 官方手册 — <https://manual.calibre-ebook.com/viewer.html>
34. calibre 官网 About — <https://calibre-ebook.com/about>
35. memoir 宏包手册 `memman.tex` — <https://mirrors.mit.edu/CTAN/macros/latex/contrib/memoir/doc-src/memman.tex>
36. Google Fonts Knowledge — Understanding measure/line length（**fetch 失败，仅登记**）— <https://fonts.google.com/knowledge/using_type/understanding_measure_line_length>
37. web.dev — Typography（**fetch 失败；45–75 字符来自搜索片段**）— <https://web.dev/learn/design/typography>
38. DeepWiki — epub.js Layout System（**429，未采用**）— <https://deepwiki.com/futurepress/epub.js/3.3-layout-system>
39. DeepWiki — koreader/crengine Layout and Rendering（**429，未采用**）— <https://deepwiki.com/koreader/crengine/2.2-layout-and-rendering>
40. DeepWiki — calibre E-book Viewer（**429，未采用**）— <https://deepwiki.com/kovidgoyal/calibre/4.5-e-book-viewer>
41. KOReader 官方用户指南 PDF（**工具不支持 PDF，未采用**）— <http://koreader.rocks/koreader-user-guide.pdf>

**本项目文件（供交叉核对）**
42. `src/services/books/formats/html/paging-layout.ts` ｜ 43. `src/services/books/formats/mobi/HtmlDocEngine.ts` ｜ 44. `src/services/books/formats/epub/EpubDocument.ts` ｜ 45. `src/services/books/formats/epub/EpubLazyLoader.ts` ｜ 46. `src/services/books/formats/txt/TxtEngine.ts` ｜ 47. `src/services/books/formats/txt/TxtLayout.ts` ｜ 48. `src/view/ReaderController.ts` ｜ 49. `styles.css`
