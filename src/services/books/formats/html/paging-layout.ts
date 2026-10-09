/**
 * 分页版式的纯函数内核（无 DOM、无 obsidian 依赖，可单测）。
 *
 * 背景：HtmlDocEngine 用「CSS 多栏容器（一栏 = 一页）+ transform 水平位移」实现翻页。
 * 这套算法的所有"算术"（页宽/页高、单双页回退、槽宽、页边距、列位移、页码换算）
 * 都集中在这里，引擎只负责把结果写进 DOM。
 *
 * 为什么抽出纯函数（重构要点）：
 * - 旧版这些常量散落在引擎里并与测量逻辑耦合，改一个边距要在三处对齐；
 * - 「双页回退单页」「列位移」「百分比↔页码」是本功能最容易出错的部分，
 *   抽出来才能用单测锁死（tests/paging-layout.test.ts）。
 */

/** 单页模式的栏间距（px） */
export const GUTTER_SINGLE = 40;
/** 双页对开的栏间距（px）：更窄，缩小中间留白 */
export const GUTTER_DOUBLE = 30;
/** 单页模式的页内左右内边距（px） */
export const PAGE_MARGIN_X_SINGLE = 28;
/** 双页模式的页内左右内边距（px）：更窄，避免两页正文挤在一起 */
export const PAGE_MARGIN_X_DOUBLE = 18;
/**
 * 页面与阅读区边缘的留白（px）。
 * 注意：宿主（Obsidian 视图壳）另有自己的 padding（--nyar-reading-pad-x），
 * 两边都要保持"收敛"的小值，避免旧版 20+28+32+38≈118px 的叠加留白。
 */
export const BOOK_MARGIN = 10;
/** 计算页宽时预留的安全余量（px/每侧）：杜绝取整误差让右页贴边被裁 */
export const SAFETY = 4;
/** 低于该可用宽度时，即使选择「双页」也自动退回单页（对应 epub.js 的 spread:"auto"） */
export const MIN_SPREAD_WIDTH = 640;
/** 双页模式下每页的最小可读宽度（px），低于此值退回单页 */
export const MIN_SPREAD_PAGE_WIDTH = 300;
/** 页宽下限 / 上限（px） */
export const MIN_PAGE_WIDTH = 120;
export const MAX_PAGE_WIDTH = 1400;
/** 页高下限（px） */
export const MIN_PAGE_HEIGHT = 120;
/** 图片在页内允许占用的高度预算：页高减去上下页内边距与一点呼吸空间 */
export const IMAGE_HEIGHT_RESERVE = 8;

export interface PageLayoutInput {
	/** iframe 实测内容宽度（px，= 宿主阅读区宽度） */
	viewWidth: number;
	/** iframe 实测内容高度（px） */
	viewHeight: number;
	/** 是否用户选择了双页对开 */
	double: boolean;
}

export interface PageLayout {
	/** 单页宽（px，不含页边距与槽宽） */
	pageWidth: number;
	/** 页高（px，含上下页边距） */
	pageHeight: number;
	/** 栏间距 / 页间槽宽（px） */
	gutter: number;
	/** 每页左右内边距（px） */
	pageMarginX: number;
	/** 书窗（可见页容器）宽度（px） */
	bookWidth: number;
	/** 书窗高度（px）＝ pageHeight */
	bookHeight: number;
	/** 实际生效的双页对开（窗口太窄时为 false） */
	double: boolean;
	/** 一页对应的水平步长（px）＝ pageWidth + gutter */
	columnStride: number;
}

/**
 * 计算分页版式。
 *
 * 规则（与旧实现等价，但边界更明确）：
 * - 可用空间 = iframe 尺寸 - BOOK_MARGIN*2 - SAFETY*2；
 * - 双页对开需同时满足：用户选择双页、可用宽 ≥ MIN_SPREAD_WIDTH、每页宽 ≥ MIN_SPREAD_PAGE_WIDTH，
 *   否则自动退回单页（窄窗下强行双页会把右页挤出阅读区）；
 * - 页宽/页高永不超过可用空间，并有下限。
 */
export function computePageLayout(input: PageLayoutInput): PageLayout {
	const availW = Math.max(MIN_PAGE_WIDTH, Math.floor(input.viewWidth - (BOOK_MARGIN + SAFETY) * 2));
	const availH = Math.max(MIN_PAGE_HEIGHT, Math.floor(input.viewHeight - (BOOK_MARGIN + SAFETY) * 2));

	// 先用「双页」尺寸估算是否真的能对开；退单页后槽宽/页边距必须用单页的值
	// （回归：旧实现按 input.double 取，窄窗退回单页时误用了双页的 30/18）
	const widthForDouble = (availW - GUTTER_DOUBLE) / 2 - PAGE_MARGIN_X_DOUBLE * 2;
	const double = input.double && availW >= MIN_SPREAD_WIDTH && widthForDouble >= MIN_SPREAD_PAGE_WIDTH;
	const gutter = double ? GUTTER_DOUBLE : GUTTER_SINGLE;
	const pageMarginX = double ? PAGE_MARGIN_X_DOUBLE : PAGE_MARGIN_X_SINGLE;

	// 单页：可用宽 - 左右页边距；双页：再减去槽宽后对半
	const rawWidth = double ? widthForDouble : availW - pageMarginX * 2;
	const pageWidth = clamp(Math.round(rawWidth), MIN_PAGE_WIDTH, Math.min(MAX_PAGE_WIDTH, availW));
	const pageHeight = clamp(Math.round(availH), MIN_PAGE_HEIGHT, availH);
	const bookWidth = double ? pageWidth * 2 + gutter : pageWidth;

	return {
		pageWidth,
		pageHeight,
		gutter,
		pageMarginX,
		bookWidth,
		bookHeight: pageHeight,
		double,
		columnStride: pageWidth + gutter,
	};
}

export function clamp(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min;
	return Math.min(max, Math.max(min, n));
}

/** 一页的列位移（px，负值；用于 transform: translateX） */
export function columnOffsetPx(page: number, layout: Pick<PageLayout, "columnStride">): number {
	return -(Math.max(1, page) - 1) * layout.columnStride;
}

/** 页宽 + 槽宽：翻一页的水平步长 */
export function pageStridePx(layout: Pick<PageLayout, "columnStride">): number {
	return layout.columnStride;
}

/** 双页对开时左页必须为奇数（1|2、3|4…）；单页模式原样返回 */
export function alignSpreadPage(page: number, double: boolean): number {
	const p = Math.max(1, Math.floor(page));
	if (!double) return p;
	return p % 2 === 0 ? p - 1 : p;
}

/**
 * 翻页步长：双页对开翻 2 页，否则 1 页。
 * @param double 实际生效的双页（注意传 layout.double，而不是用户设置）
 */
export function pageStep(double: boolean): number {
	return double ? 2 : 1;
}

/** 把页码限制在 [1, total]；total<=0 时返回 1 */
export function clampPage(page: number, total: number): number {
	if (!Number.isFinite(page)) return 1;
	if (total <= 0) return 1;
	return Math.min(total, Math.max(1, Math.round(page)));
}

/** 0~10000 的百分比定位符 → 页码 */
export function pageFromPercent(percent: number, total: number): number {
	if (!Number.isFinite(percent) || total <= 0) return 1;
	const raw = Math.round((percent / 10000) * total) || 1;
	return clampPage(raw, total);
}

/**
 * 页码 → 0~10000 的百分比定位符（用页中心，避免边界抖动）。
 *
 * 边界：读到最后一页时必须给出 10000（100%），否则进度条永远到不了尽头
 * （页中心语义在末页只有约 99%）。
 */
export function percentFromPage(page: number, total: number): number {
	if (total <= 0) return 0;
	const p = clampPage(page, total);
	if (p >= total) return 10000;
	return Math.round(((p - 0.5) / total) * 10000);
}

/** 相对进度 0~1（页中心语义，末页为 1；与 percentFromPage 一致） */
export function percentageFromPage(page: number, total: number): number {
	if (total <= 0) return 0;
	const p = clampPage(page, total);
	if (p >= total) return 1;
	return Math.min(1, Math.max(0, (p - 0.5) / total));
}

/**
 * 由「一页对应的水平步长」反推总页数。
 *
 * 用于 O(1) 测量：在栏容器末尾放一个零宽标记元素，
 * 取它相对容器左缘的偏移，除以步长即最后一列的序号（从 0 开始）。
 *
 * @param markerLeft 标记元素相对栏容器左缘的偏移（px，offsetLeft 语义）
 * @param layout 当前版式（只需 columnStride）
 */
export function pageCountFromMarker(markerLeft: number, layout: Pick<PageLayout, "columnStride">): number {
	if (!Number.isFinite(markerLeft) || layout.columnStride <= 0) return 1;
	return Math.max(1, Math.round(markerLeft / layout.columnStride) + 1);
}

/**
 * **纯末尾追加**后，由测量标记的位移反推"新增页数"（增量测量，task-7 A 步）。
 *
 * 语义：标记恒在内容末尾，因此"标记所在列号 + 1"就是页数；两次读数的差 =
 * 新内容占用的列数 = 新增页数。与 {@link pageCountFromMarker} 使用同一套 round 语义，
 * 所以两者恒满足 `pagesAfter = pagesBefore + appendedPageCount(...)`。
 *
 * 注意：这里只做算术，**不读 DOM**。调用方必须自己保证两次 `markerLeft` 之间
 * 没有发生版式（字号/页宽/单双页）变化，否则位移里混入了重排导致的列变化。
 *
 * @param prevMarkerLeft 追加前的标记偏移（px，offsetLeft 语义）
 * @param nextMarkerLeft 追加后的标记偏移（px）
 * @returns 新增页数（≥0：内容被删除/收缩时夹到 0）
 */
export function appendedPageCount(
	prevMarkerLeft: number,
	nextMarkerLeft: number,
	layout: Pick<PageLayout, "columnStride">
): number {
	if (!Number.isFinite(prevMarkerLeft) || !Number.isFinite(nextMarkerLeft)) return 0;
	const prev = pageCountFromMarker(prevMarkerLeft, layout);
	const next = pageCountFromMarker(nextMarkerLeft, layout);
	return Math.max(0, next - prev);
}

/**
 * 追加内容的"落盘延迟"（task-7 A/B 步的合并策略）。
 *
 * 连续补章时希望把多批追加合并成**一次**重排，于是每次追加都把落盘时间往后推
 * `settleMs`；但页面又不能长时间停在旧页数上，所以用 `maxHoldMs` 封顶：
 * 从第一批待落盘内容开始算，最多等 `maxHoldMs` 就必须落盘。
 *
 * @param now 当前时间（与 firstPendingAt 同源，ms）
 * @param firstPendingAt 第一批"待落盘内容"出现的时间；0（或非有限值）表示没有待落盘内容
 * @param settleMs 静默窗口（最后一次追加后多久落盘）
 * @param maxHoldMs 最长持有时间（超过则强制落盘）
 * @returns 定时器应等待的毫秒数（0 = 立即落盘）
 */
export function nextSettleDelayMs(now: number, firstPendingAt: number, settleMs: number, maxHoldMs: number): number {
	if (!Number.isFinite(now) || !Number.isFinite(firstPendingAt) || firstPendingAt <= 0) return 0;
	const byHold = firstPendingAt + maxHoldMs - now;
	return Math.max(0, Math.min(settleMs, byHold));
}

/** 可见页在栏容器中的位移（px，正数，用于 translateX 的取负值） */
export function visibleOffsetPx(page: number, layout: Pick<PageLayout, "columnStride">): number {
	return (clamp(page, 1, Number.MAX_SAFE_INTEGER) - 1) * layout.columnStride;
}

// ---------------------------------------------------------------- 按章独立分页（task-10 / D 方案）
//
// 背景（已量化）：整本书放在**一个**多栏容器里时，改字号必须对"已加载的全部内容"
// 重排一次：6462 页 / 84k 块实测同步段 ~1s、帧内墙钟 13.7–15.1s（一次整篇布局
// 298–346ms，纯 DOM 插入 50 批只要 14–16ms）——成本全在"对全部内容做布局"。
//
// D 方案把布局单位改成"当前章 ±1"：只有活动窗口里的章节参与分栏，其余章节留在
// 冷区（display:none，DOM 仍在，成本为零）。于是改字号只需要重排 2–3 章。
//
// 代价：全局页数不再是"量出来"的，而是
//   Σ(活动窗口/历史命中章节的测量值) + Σ(未测章节按字符数插值估计)
// 因此这里提供一整套纯函数：版式指纹、字符插值、前缀和映射、活动窗口计算。
// 全部无 DOM、可单测；引擎只负责把结果写进 DOM。

/**
 * 版式指纹的输入：**任何**会改变断行/分页结果的量都必须进来。
 *
 * 漏掉一个量就会出现"复用了旧版式下测得的页数"——表现为改字号后页码不更新
 * （比慢更糟）。因此这里刻意把 fontFamily/lineHeight 都纳入，而不只是字号。
 */
export interface PagedLayoutKey {
	/** 有效字号（px，已叠加缩放） */
	fontSize: number;
	/** 行距倍数 */
	lineHeight: number;
	/** 字体族（不同字体的度量不同，断行点会变） */
	fontFamily: string;
	/** 页宽（px，不含页边距与槽宽） */
	pageWidth: number;
	/** 页高（px） */
	pageHeight: number;
	/** 栏间距（px） */
	gutter: number;
	/** 页内左右内边距（px） */
	pageMarginX: number;
	/** 实际生效的双页对开 */
	double: boolean;
}

function round2(n: number): number {
	return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * 版式指纹（稳定、可读、可直接比较）。
 *
 * 数值四舍五入到 0.01：浮点噪声（18.000000000000004）不应该让缓存失效，
 * 但 18.01 与 18 必须区分。
 */
export function layoutFingerprint(key: PagedLayoutKey): string {
	return [
		round2(key.fontSize),
		round2(key.lineHeight),
		String(key.fontFamily ?? ""),
		round2(key.pageWidth),
		round2(key.pageHeight),
		round2(key.gutter),
		round2(key.pageMarginX),
		key.double ? "d" : "s",
	].join("|");
}

/** 每章的分页测量结果（按章独立分页的核心状态）。 */
export interface ChapterPageMeasure {
	/** 章内页数（在 `fingerprint` 这套版式下测得） */
	pages: number;
	/** 章内字符数（插值估计的权重；缺失时按 0 处理） */
	chars: number;
	/** 测量时使用的版式指纹 */
	fingerprint: string;
}

/** 总页数估计结果（`estimated` 为 true 时必须能被视图层识别）。 */
export interface TotalPagesEstimate {
	/** 全书页数（已测部分精确 + 未测部分估计） */
	pages: number;
	/** 参与精确求和的章节数（指纹匹配） */
	measuredChapters: number;
	/** 走插值估计的章节数 */
	estimatedChapters: number;
	/** 估计页数占比 0~1（0 = 全书都是精确测量） */
	estimatedFraction: number;
	/** 未测章节使用的"每页字符数"（由已测章节加权得出） */
	charsPerPage: number;
}

/** 没有可用样本时的兜底"每页字符数"（中文正文约 900 字/页，接近 18px/页宽 1112 的常见值） */
export const FALLBACK_CHARS_PER_PAGE = 900;

/**
 * 用"每页字符数"估计一章的页数（未测章节的插值）。
 * @param chars 该章字符数
 * @param charsPerPage 每页字符数（来自已测章节的加权平均）
 */
export function estimatePagesFromChars(chars: number, charsPerPage: number): number {
	const c = Number.isFinite(chars) && chars > 0 ? chars : 0;
	if (c <= 0) return 1;
	const per = Number.isFinite(charsPerPage) && charsPerPage > 0 ? charsPerPage : FALLBACK_CHARS_PER_PAGE;
	return Math.max(1, Math.round(c / per));
}

/**
 * 由已测章节推导"每页字符数"（Σ字符 / Σ页数，即按篇幅加权，对大章更稳）。
 * 没有任何有效样本时返回 {@link FALLBACK_CHARS_PER_PAGE}。
 */
export function charsPerPageFromMeasures(
	measures: readonly (ChapterPageMeasure | null | undefined)[],
	chars: readonly number[],
	fingerprint: string
): number {
	let sumChars = 0;
	let sumPages = 0;
	for (let i = 0; i < measures.length; i++) {
		const m = measures[i];
		if (!m || m.fingerprint !== fingerprint || !(m.pages > 0)) continue;
		const c = Number.isFinite(chars[i]) && chars[i] > 0 ? chars[i] : m.chars;
		if (!(c > 0)) continue;
		sumChars += c;
		sumPages += m.pages;
	}
	if (sumChars <= 0 || sumPages <= 0) return FALLBACK_CHARS_PER_PAGE;
	return sumChars / sumPages;
}

/**
 * 全书总页数：已测章节用测量值，未测/指纹失效章节按字符数插值。
 *
 * 关键性质（引擎依赖）：
 * - **单调**：任一 `chars[i]` 增大不会让 `pages` 减小（读方向不会漂移）；
 * - **指纹失效只影响该章**：改字号后只有活动窗口那几章需要重新测量，
 *   其余章节沿用旧测量（若是同一指纹）或插值 —— 这正是 D 方案的提速来源；
 * - `estimatedFraction === 0` ⇔ 全书都是精确测量（整本布局模式）。
 */
export function estimateTotalPages(
	measures: readonly (ChapterPageMeasure | null | undefined)[],
	chars: readonly number[],
	fingerprint: string,
	chapterCount?: number
): TotalPagesEstimate {
	const n = chapterCount ?? Math.max(measures.length, chars.length);
	const charsPerPage = charsPerPageFromMeasures(measures, chars, fingerprint);
	let pages = 0;
	let measuredChapters = 0;
	let estimatedPages = 0;
	let estimatedChapters = 0;
	for (let i = 0; i < n; i++) {
		const m = measures[i];
		const c = Number.isFinite(chars[i]) && chars[i] > 0 ? chars[i] : m?.chars ?? 0;
		if (m && m.fingerprint === fingerprint && m.pages > 0) {
			pages += m.pages;
			measuredChapters++;
			continue;
		}
		const est = estimatePagesFromChars(c, charsPerPage);
		pages += est;
		estimatedPages += est;
		estimatedChapters++;
	}
	const total = Math.max(1, pages);
	return {
		pages: total,
		measuredChapters,
		estimatedChapters,
		estimatedFraction: Math.min(1, Math.max(0, estimatedPages / total)),
		charsPerPage: Math.round(charsPerPage * 100) / 100,
	};
}

/**
 * 章节页数的前缀和：`offsets[i]` = 第 i 章第一页的全局页号（1-based），
 * `offsets[n]` = 全书页数 + 1。
 *
 * 用于 全局页号 ↔ (章号, 章内页号) 的双向映射（`chapterForPage` / `pageForChapter`）。
 */
export function chapterPageOffsets(pages: readonly number[]): number[] {
	const offsets = new Array<number>(pages.length + 1);
	offsets[0] = 1;
	for (let i = 0; i < pages.length; i++) {
		const p = Number.isFinite(pages[i]) && pages[i] > 0 ? Math.floor(pages[i]) : 1;
		offsets[i + 1] = offsets[i] + p;
	}
	return offsets;
}

/**
 * 全局页号 → (章号, 章内页号)。页码会被夹到 [1, total]。
 * 双页对开时调用方需要先把页号对齐到奇数（见 {@link alignSpreadPage}）。
 */
export function chapterForPage(page: number, offsets: readonly number[]): { chapter: number; pageInChapter: number } {
	const n = Math.max(0, offsets.length - 1);
	if (n === 0) return { chapter: 0, pageInChapter: 1 };
	const total = Math.max(1, offsets[n] - 1);
	const p = clampPage(page, total);
	let lo = 0;
	let hi = n - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (offsets[mid] <= p) lo = mid;
		else hi = mid - 1;
	}
	return { chapter: lo, pageInChapter: p - offsets[lo] + 1 };
}

/** (章号, 章内页号) → 全局页号（chapterForPage 的逆） */
export function pageForChapter(chapter: number, pageInChapter: number, offsets: readonly number[]): number {
	const n = Math.max(0, offsets.length - 1);
	if (n === 0) return 1;
	const c = Math.max(0, Math.min(n - 1, Math.floor(chapter)));
	const len = Math.max(1, offsets[c + 1] - offsets[c]);
	const within = Math.max(1, Math.min(len, Math.floor(pageInChapter)));
	return offsets[c] + within - 1;
}

/**
 * 分页活动窗口：只有 `[active - radius, active + radius]` 章参与分栏，
 * 其余章节留在冷区（display:none）。返回闭区间且已夹到 [0, n-1]。
 *
 * @param radius 前后各保留几章。1 = 当前章 ±1（默认，改字号只重排 2–3 章）；
 *   增大可让跨章翻页更顺滑，代价是重排章节数线性增长。
 */
export function activeWindowRange(
	active: number,
	chapterCount: number,
	radius = CHAPTER_WINDOW_RADIUS
): { from: number; to: number } {
	const n = Math.max(0, Math.floor(chapterCount));
	if (n === 0) return { from: 0, to: -1 };
	const a = Math.max(0, Math.min(n - 1, Math.floor(active)));
	const r = Math.max(0, Math.floor(radius));
	return { from: Math.max(0, a - r), to: Math.min(n - 1, a + r) };
}

/** 活动窗口默认半径（当前章 ±1） */
export const CHAPTER_WINDOW_RADIUS = 1;

/**
 * 由标记偏移反推**列号**（0-based）。
 *
 * 与 {@link pageCountFromMarker} 的关系：`pageCountFromMarker = columnIndex + 1`。
 * 按章独立分页时，窗口里每章末尾放一个标记，相邻两章的列号差 = 后一章占用的列数，
 * 因此需要一个"列号"口径的纯函数（页数口径会在跨章求和时多算 1）。
 */
export function columnIndexFromMarker(markerLeft: number, layout: Pick<PageLayout, "columnStride">): number {
	return Math.max(0, pageCountFromMarker(markerLeft, layout) - 1);
}

/**
 * 多栏容器的最大列数（同时也是分配容器宽度的基准栏数）。
 *
 * 关键约束（踩坑记录，v0.5 由独立验证量化复现）：
 * - **`column-width` 必须显式给出**（= 页宽）。只写 `column-count` 时浏览器会把容器
 *   宽度按列数均分：`2_000_000 / 10000 = 200px`，与 pageWidth 完全无关，
 *   一页里会塞进多个窄栏（曾因此让页数从 232 涨到 496）；
 * - 必须远大于「容器宽 ÷ 最小页宽」能产生的实际栏数。若实际栏数触及 column-count
 *   上限，浏览器会把容器宽度摊到上限栏数上，实际列距变成 容器宽÷栏数；
 * - **容器宽度必须是「步长的整数倍减一个槽宽」**。旧实现把宽度写死为 2_000_000，
 *   当 (2_000_000 + gutter) 不能被 (pageWidth + gutter) 整除时（例如 2200px 窗口下
 *   pageWidth=1400、stride=1440 → 1388 列，每列多 0.951px），误差会随列号线性累积：
 *   末页那一栏右缘最终超出页窗口 219.69px，被 overflow:hidden 裁掉；
 * - 因此宽度不能是常量，必须由 columnGridWidth(stride) 按当前步长推导。
 */
export const MAX_COLUMNS = 20_000;
/**
 * 多栏容器许用的最大像素宽度（浏览器对超宽布局有上限，取 2e6 与旧实现同量级）。
 * Blink 实际能生效的列数上限为 10000，超过部分会被忽略，所以基准栏数还要再夹一次。
 */
export const MAX_COLUMNS_WIDTH = 2_000_000;
/** Blink 实际生效的列数上限（超过会被忽略，导致均分而非按 column-width） */
export const BROWSER_COLUMN_LIMIT = 10_000;

/**
 * 计算多栏容器的宽度，使浏览器的列摊平结果**精确等于** pageWidth + gutter。
 *
 * 推导（对应 CSS Multicol 的列宽分配）：设容器宽 U、列距 g、步长 s = pageWidth + g。
 * 显式给出 `column-width = pageWidth` 时浏览器取
 *   n = min(column-count, floor((U + g) / s))，实际栏宽 = (U − (n−1)·g) / n。
 * 只要取 U = n * s − g，就有 (U + g) / n = s，实际步长恒等于 s，漂移为 0。
 *
 * @param layout 当前版式（需要 pageWidth / columnStride / gutter）
 * @returns 容器宽度（px，恒满足「整数倍减一个槽宽」）
 */
export function columnGridWidth(layout: Pick<PageLayout, "pageWidth" | "columnStride" | "gutter">): number {
	const stride = Math.max(1, Math.floor(layout.columnStride));
	const gutter = Math.max(0, layout.gutter);
	// 基准栏数：受 Blink 列数上限约束，否则 n 会被浏览器截断而使均分逻辑生效
	const baseCount = Math.min(MAX_COLUMNS, BROWSER_COLUMN_LIMIT);
	const byCount = baseCount * stride - gutter;
	if (byCount <= MAX_COLUMNS_WIDTH) return byCount;
	// 宽度受限时向下取整到「整数倍减一个槽宽」，保证仍然整除
	const n = Math.max(1, Math.floor((MAX_COLUMNS_WIDTH + gutter) / stride));
	return n * stride - gutter;
}

/**
 * 多栏容器的列数（与 columnGridWidth 配套，供 CSS 使用）。
 * 与宽度保持同一基准，保证 `column-count` 不会成为限制因素。
 */
export function columnGridCount(layout: Pick<PageLayout, "pageWidth" | "columnStride" | "gutter">): number {
	const width = columnGridWidth(layout);
	const stride = Math.max(1, Math.floor(layout.columnStride));
	const gutter = Math.max(0, layout.gutter);
	return Math.max(1, Math.min(MAX_COLUMNS, Math.floor((width + gutter) / stride)));
}
