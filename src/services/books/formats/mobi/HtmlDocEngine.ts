/**
 * HTML 文档引擎：渲染单个 HTML 字符串（EPUB/MOBI/AZW3 提取结果）到 iframe。
 *
 * 两种阅读模式：
 * - 滚动模式（scrollMode=true）：正文连续单栏滚动。
 * - 分页模式（scrollMode=false）：真正的按页排版——
 *   把正文放进 CSS 多栏容器（固定栏宽=页宽、栏高=页高、column-fill:auto），
 *   每一栏就是一页，页号按内容先后严格连续（第 1 页排满才进第 2 页）。
 *   阅读窗口只显示当前一页（单页模式）或两页对开（双页模式：1|2 → 3|4 → …），
 *   通过水平位移把对应栏移入窗口。
 *
 * v0.5 重构要点（大文件下"单双页/滚动/翻页失灵"的根因修复）：
 * 1. 页数测量从 O(子元素数) 降为 O(1)：在栏容器末尾放一个零宽标记元素，
 *    用它的 offsetLeft 反推最后一列的列号。旧实现遍历所有子元素并逐个
 *    getBoundingClientRect()，一本大书（数万块）每次测量都触发整篇同步布局，
 *    正是"打开大书后翻页/切单双页失灵"的直接原因。
 * 2. 版式计算全部走 paging-layout.ts 的纯函数，常量与算术不再散落在引擎里。
 * 3. 注入样式只更新同一个 <style> 的 textContent，内容不变则完全不写
 *    （旧实现每次 applySettings 都 remove + create，整篇文档重排）。
 * 4. ResizeObserver 触发的重排用 rAF 合并，且尺寸未变化时直接返回，
 *    避免静止状态下的抖动把页码/位移冲掉。
 * 5. mount 只在 iframe 真正 load 后测量；不再保留"800ms 兜底"后测量，
 *    杜绝在文档未就绪时算出错误的页数。
 * 6. capabilities 恒定声明本引擎支持的能力（不再随模式变化），
 *    避免切换瞬间视图层读到错误能力而隐藏/失灵按钮。
 * 7. 图片：不隐藏、不裁切；max-height 用真实页高变量推导，
 *    并支持把 data-nyar-asset 登记的 zip 资源按需解析为 blob: URL 后回填。
 */
import type {
	AnnotationTarget,
	EngineHighlight,
	EngineHighlightPlacement,
	IReaderEngine,
	ReaderEngineEvents,
	ReaderEngineCapabilities,
	SelectionAnchorDraft,
	ZoomMode,
} from "../../IReaderEngine";
import { SimpleReaderEmitter } from "../../IReaderEngine";
import type { BookModel, ReaderSettings, RelayoutState } from "../../../../types";
import { DEFAULT_READER_SETTINGS } from "../../../../types";
import { normalizeSelectionText } from "../../../../utils/text";
import { buildTextQuote, quoteFromText } from "../../../annotations/AnnotationAnchor";
import { HighlightLayer, type HighlightRegion } from "../html/HighlightLayer";
import {
	activeWindowRange,
	appendedPageCount,
	chapterForPage,
	chapterPageOffsets,
	CHAPTER_WINDOW_RADIUS,
	clampPage,
	columnGridCount,
	columnGridWidth,
	columnIndexFromMarker,
	columnOffsetPx,
	computePageLayout,
	estimateTotalPages,
	IMAGE_HEIGHT_RESERVE,
	alignSpreadPage,
	layoutFingerprint,
	nextSettleDelayMs,
	pageCountFromMarker,
	pageForChapter,
	pageFromPercent,
	pageStep,
	percentFromPage,
	type ChapterPageMeasure,
	type PageLayout,
	type TotalPagesEstimate,
} from "../html/paging-layout";

/**
 * 重排原因（= types.ts 里 RelayoutState.reason 的子集别名，便于本文件内引用）。
 *
 * 视图层用 `busy:true` 显示"正在重新排版…"，把"卡死数秒"变成"有明确反馈的等待"。
 * 调用时机保证可上屏：`busy:true` 在阻塞布局**之前**发出；当上一次重排已经
 * 超过 {@link SLOW_RELAYOUT_MS}（预测这次也慢）时，重排会被推迟到**下一帧**执行，
 * 让状态文字有机会先绘制出来。
 */
export type RelayoutReason = RelayoutState["reason"];

/**
 * 总页数信息（task-10：页数变成估计值时必须能被调用方识别）。
 *
 * 视图层应据此把页码显示成 `≈ 6000 页`，而不是把估计值当真值展示。
 */
export interface TotalPagesInfo {
	/** 全书页数（已测章节精确 + 未测章节按字符插值） */
	pages: number;
	/** 是否含估计值（false = 全部章节都是精确测量，等价于整本布局） */
	estimated: boolean;
	/** 章节总数 */
	chapters: number;
	/** 当前版式指纹下已精确测量的章节数 */
	measuredChapters: number;
	/** 走插值估计的章节数 */
	estimatedChapters: number;
	/** 估计页数占比 0~1 */
	estimatedFraction: number;
	/** 估计用的"每页字符数" */
	charsPerPage: number;
	/** 当前参与分栏的活动窗口（闭区间；-1 表示未启用窗口化） */
	windowFrom: number;
	windowTo: number;
}

export interface HtmlDocEngineOptions {
	book: BookModel;
	html: string;
	/** 实际格式标识（epub/mobi/azw3）；默认 "html" */
	formatLabel?: string;
	/**
	 * zip 内资源解析器：把 data-nyar-asset 登记的路径解析成可用的 URL（通常是 blob:）。
	 * 由 ReaderController/EpubDocument 注入；未提供时只清理占位、不报错。
	 */
	resolveAsset?: (path: string) => Promise<string | null>;
	/**
	 * **按章独立分页**（task-10 / D 方案）开关，默认 true。
	 *
	 * true：分页模式下只有"当前章 ±{@link CHAPTER_WINDOW_RADIUS}"参与分栏，
	 * 其余章节留在 `display:none` 的冷区（DOM 保留），于是**改字号只重排 2–3 章**；
	 * 代价是全局页数变成"已测章节之和 + 未测章节按字符数插值"，需要视图层用
	 * `isPageCountEstimated()` / `getTotalPagesInfo()` 识别（显示成 `≈ N 页`）。
	 *
	 * false：一键回退到旧行为（整本布局、页数精确）。用于真机出现定位/高亮异常时回滚。
	 */
	chapterPagedPagination?: boolean;
	/**
	 * 章节锚点前缀（可选）：用于把追加内容切成"章"。
	 * EPUB 传 `nyareader-epub-`，MOBI/AZW3 传 `nyareader-mobi-`；
	 * 不传时按 `nyareader-(epub|mobi|toc|fp|chapter)-<数字>` 识别，识别不到就整段算一章。
	 */
	chapterAnchorPrefix?: string;
}

const THEME_CSS: Record<ReaderSettings["theme"], string> = {
	light: "html { background:#f2f2f2; } body { color:#1f1f1f; }",
	dark: "html { background:#141416; } body { color:#cfcfcf; } a { color:#8ab4f8; }",
	sepia: "html { background:#e9e0cd; } body { color:#5b4636; }",
};

/**
 * 栏容器末尾的零宽测量标记的 id / 类名。
 *
 * 多栏容器的宽度与列数上限不再写死（旧实现 2_000_000 / 20_000 会在
 * 宽度不能被步长整除时产生每列漂移，末页被裁），改由 paging-layout 的
 * columnGridWidth() 按当前步长推导，见那里的推导与踩坑记录。
 */
const END_MARKER_ID = "nyareader-end-marker";
/** iframe 加载的兜底等待（仅用于极端情况下不永久挂起，不用于测量时机判断） */
const LOAD_FAILSAFE_MS = 15_000;
/**
 * 追加内容的"静默窗口"（ms）：最后一次追加之后多久把暂存内容落盘（并做**一次**重排）。
 * 连续补章会被合并成一次落盘 —— 这是"补章不再周期性卡顿"的关键。
 */
const APPEND_SETTLE_MS = 120;
/**
 * 暂存内容的最长持有时间（ms）：即使补章一直不停，也最多等这么久就必须落盘，
 * 避免页数/进度长时间停在旧值上。
 */
const APPEND_MAX_HOLD_MS = 1000;
/**
 * "慢重排"门槛（ms）：超过它就认为用户会明显感到卡顿，于是
 * 1) 上报 busy 状态（视图显示"正在重新排版…"），2) 把重排推迟一帧让提示先上屏。
 */
const SLOW_RELAYOUT_MS = 120;
/**
 * 等 `document.fonts.ready` 的超时（ms）。
 *
 * `srcdoc` iframe 没有基础 URL：@font-face 的相对路径会 404，字体永远不就绪，
 * `fonts.ready` 可能迟迟不 resolve。没有超时兜底时页数会一直用"未就绪字体"的结果，
 * 而且"等字体"会和用户的字号变更互相挤压（同一帧里两次整篇重排）。
 */
const FONT_READY_TIMEOUT_MS = 1500;
/** 章节在文档里被标记的 data 属性（用于"元素 → 章节"反查） */
const CHAPTER_TAG_ATTR = "data-nyar-chapter";
/** 每章末尾的零宽测量标记的类名（按章独立分页时逐章测页数） */
const CHAPTER_END_CLASS = "nyar-chapter-end";
/** 冷区容器类名（分页模式下不参与布局的章节放在这里，display:none） */
const COLD_CLASS = "nyareader-cold";
/** 章节锚点 id 的通用识别（未显式给前缀时的兜底） */
const CHAPTER_ANCHOR_RE = /^nyareader-(epub|mobi|toc|fp|chapter)-\d+$/;

/**
 * 一章的登记信息（task-10）。
 *
 * 章节不是"包裹元素"而是**一段连续顶层节点**：这样锚点标记仍然是多栏容器的
 * 顶层子节点，`HighlightLayer.highlightRegions()`（按 `span#nyareader-epub-N`
 * 等顶层锚点切区域）在窗口化分页下继续可用。
 */
interface ChapterSlot {
	/** 该章的顶层节点（严格保持文档顺序） */
	nodes: Node[];
	/** 章内字符数（未测章节按它插值估计页数） */
	chars: number;
	/** 该章内的章节锚点 id（目录跳转按 id 快速定位章节） */
	anchorIds: string[];
}

/** `goTo("#锚点")` 的解析诊断（排查"目录跳转静默失效"）。 */
export interface AnchorResolveDiag {
	anchorId: string;
	/** 解析到的章节索引（-1 = 没解析到） */
	chapter: number;
	from: number;
	to: number;
	chapters: number;
	/** false = 当前不是按章窗口化模式（整本布局） */
	windowed?: boolean;
	/** 激活窗口后的结果 */
	after?: { from: number; to: number; active: number };
}

export class HtmlDocEngine implements IReaderEngine {
	get format(): string {
		return this.opts.formatLabel ?? "html";
	}
	/**
	 * 能力恒定：分页/滚动/单双页切换是本引擎的内建能力，与当前模式无关。
	 * （旧实现让 pageNav 跟随 isPaged()，切换瞬间视图层会读到 false 而隐藏按钮。）
	 */
	get capabilities(): ReaderEngineCapabilities {
		return { zoom: true, pageNav: true, modeSwitch: true, layoutSwitch: true };
	}
	private emitter = new SimpleReaderEmitter();
	private container!: HTMLElement;
	private iframe!: HTMLIFrameElement;
	// 默认版式与全局默认值同源（重构点：旧实现在 5 处各写一份字面量，容易漂移）
	private settings: ReaderSettings = { ...DEFAULT_READER_SETTINGS };
	private doc: Document | null = null;
	private destroyed = false;
	/** iframe 是否已完成 load（未完成前不测量、不重排） */
	private docReady = false;
	/** 文本缩放系数（叠加在设置字号上），默认 100% */
	private zoomScale = 1;

	// ---------- 分页状态 ----------
	/** 阅读窗口（可见页容器，overflow hidden，居中） */
	private paged: HTMLElement | null = null;
	/** 多栏容器（一栏一页） */
	private columnsEl: HTMLElement | null = null;
	/** 栏容器末尾的零宽测量标记（O(1) 测页数） */
	private endMarker: HTMLElement | null = null;
	/** 已注入样式元素（缓存，避免反复重建） */
	private styleEl: HTMLStyleElement | null = null;
	/** 上一次写入的样式文本，用于跳过无变化写入 */
	private lastStyleText = "";
	/** 当前版式（由 paging-layout 纯函数算出） */
	private layout: PageLayout = computePageLayout({ viewWidth: 800, viewHeight: 600, double: false });
	private pages = 0;
	/** 当前第几页（双页模式下恒为奇数，表示对开的左页） */
	private currentPage = 1;
	/** 监听 iframe 元素尺寸变化（父文档实测，比 iframe 内部 resize 更可靠） */
	private iframeObserver: ResizeObserver | null = null;
	/** 重排 rAF 句柄（合并连续 resize 抖动） */
	private relayoutRaf = 0;
	/** 强制下一次重排（内容追加/图片就绪后页数会变） */
	private pendingForceRelayout = false;
	/** 已解析/正在解析的资源，避免重复请求 */
	private assetTasks = new Map<string, Promise<string | null>>();

	// ---------- 增量追加（task-7 A 步）----------
	/**
	 * 追加内容的暂存容器（display:none，挂在 iframe body 下）。
	 *
	 * 为什么需要它：列容器是**一个巨大的 CSS 多栏**，往里面插任何内容都会让
	 * 整篇文档重新布局；旧实现每批追加都同步 `measurePages()`（读标记 →
	 * 触发整篇布局），50 批补章 = 50 次 O(已加载全部内容) 的布局，叠起来就是
	 * 用户看到的"后台补章周期性卡顿"与"目录跳远章节卡死"。
	 *
	 * 暂存容器是 display:none 子树 —— 没有布局对象，往里追加**不触发任何布局**；
	 * 等到补章安静下来（或超过最长持有时间），才一次性并入列容器并做**一次**重排。
	 */
	private stageEl: HTMLElement | null = null;
	/** 暂存容器里是否有待落盘内容 */
	private stagedPending = false;
	/** 第一批待落盘内容的出现时间（0 = 当前没有待落盘内容） */
	private stageFirstPendingAt = 0;
	/** 落盘定时器句柄（0 = 未排定） */
	private stageTimer = 0;
	/** 版式重排的合并句柄与待办（B 步：同一帧内多次字号变更只重排一次） */
	private settingsRelayoutRaf = 0;
	/** rAF 被节流时的兜底定时器（保证重排一定落地） */
	private settingsRelayoutTimer = 0;
	private pendingSettingsRelayout: { emit: boolean; reason: RelayoutReason } | null = null;
	/** 上一次重排耗时（ms，用于"预测这次是否慢"） */
	private lastRelayoutMs = 0;
	/** 几何变量待重新下发（容器刚重建时必须写一次） */
	private geometryStale = true;
	/** 上一次测量到的标记偏移（增量测量的基准） */
	private lastMarkerLeft: number | null = null;
	/** 上一次测量相对上上次新增的页数（增量测量结果，供诊断） */
	private pagesAddedLastMeasure = 0;

	// ---------- 按章独立分页（task-10 / D 方案）----------
	/**
	 * 章节登记表：一章 = 多栏容器里**连续的一段顶层节点**，从章节锚点开始
	 * （锚点在 DOM 里保持顶层同级节点，这样 stream-i 的 highlightRegions() 仍然可用）。
	 *
	 * 分页模式下只有活动窗口 `[active-1, active+1]` 的章节留在 `.nyareader-columns`
	 * 里参与分栏，其余章节的节点被搬到冷区（display:none）：整篇布局的成本从
	 * "已加载全部内容"降到"2–3 章" —— 这正是改字号从 13.7–15.1s 降到亚秒级的原因。
	 */
	private chapters: ChapterSlot[] = [];
	/** 最近一次 `goTo("#锚点")` 的解析诊断（排查"目录跳转静默失效"用） */
	private lastAnchorResolve: AnchorResolveDiag | null = null;
	/** 窗口切换轨迹（诊断用；只保留最近若干次） */
	private windowTrace: Array<{ from: number; to: number; active: number; stack: string }> = [];
	/** 每章的测量缓存（与 chapters 等长；fingerprint 不匹配视为未测） */
	private chapterMeasures: (ChapterPageMeasure | null)[] = [];
	/** 每章末尾的零宽测量标记（只在窗口里有意义） */
	private chapterEndMarkers = new Map<number, HTMLElement>();
	/** 冷区容器（display:none）：不参与分栏的章节 */
	private coldEl: HTMLElement | null = null;
	/** 当前活动窗口（闭区间，已包含在 chapters 范围内） */
	private windowFrom = 0;
	private windowTo = -1;
	/** 当前阅读所在的章节（窗口以它为中心） */
	private activeChapterIdx = 0;
	/** 章节页数前缀和缓存（pageOffsets()[i] = 第 i 章第一页的全局页号） */
	private pageOffsetsCache: number[] = [1];
	/** 全书页数是否为估计值（视图层据此显示 ≈） */
	private pagesEstimated = false;
	/** 最近一次估计的明细（诊断/上报用） */
	private lastPagesEstimate: TotalPagesEstimate | null = null;
	/** 总页数信息缓存（getTotalPagesInfo 直接返回它） */
	private totalPagesInfoCache: TotalPagesInfo | null = null;
	/** 最近一批落盘追加的章节区间（用于判断是否触碰活动窗口） */
	private lastAppendRange: { from: number; to: number } | null = null;
	/** 锚点 id → 章节索引（目录跳转 O(1) 定位） */
	private anchorToChapter = new Map<string, number>();
	/** 重排状态回调（由 ReaderController 通过 setLayoutStateHandler 注入） */
	private layoutStateHandler: ((state: RelayoutState) => void) | null = null;

	// ---------- 可见高亮（批注 P0） ----------
	/**
	 * 高亮渲染层（CSS Custom Highlight API 主方案 / span 包裹降级）。
	 * 只保存**锚点**，不保存 DOM 引用：重排、切模式、补章之后 `refreshHighlights()` 会
	 * 按当前 DOM 重新解析，所以"改字号/切单双页/切滚动分页/后台补章后高亮不丢"。
	 */
	private highlightLayer: HighlightLayer | null = null;
	private highlightClickHandler: ((id: string) => void) | null = null;
	/** 内容结构版本号：并入新内容 / 重建容器时递增，让高亮层丢掉区域文本缓存 */
	private highlightStamp = 0;

	private resizeBound = (): void => {
		this.scheduleRelayout();
	};

	constructor(private opts: HtmlDocEngineOptions) {}

	on<E extends keyof ReaderEngineEvents>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		this.emitter.on(event, handler as never);
	}
	off<E extends keyof ReaderEngineEvents>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		this.emitter.off(event, handler as never);
	}

	/**
	 * 注入重排状态回调（C 步）。视图层据此显示"正在重新排版…"。
	 * 回调抛错不影响引擎；注入 null 可取消。
	 */
	setLayoutStateHandler(handler: ((state: RelayoutState) => void) | null): void {
		this.layoutStateHandler = handler;
	}

	/**
	 * 诊断快照（性能 harness / 排查用）：引擎内部的重排与增量测量数字。
	 * `lastAnchorResolve` 记录最近一次 `goTo("#锚点")` 的章节解析与窗口激活结果。
	 */
	getLayoutDiagnostics(): {
		lastRelayoutMs: number;
		pagesAddedLastMeasure: number;
		stagedPending: boolean;
		pages: number;
		lastAnchorResolve: AnchorResolveDiag | null;
		windowTrace: Array<{ from: number; to: number; active: number; stack: string }>;
	} {
		return {
			lastRelayoutMs: Math.round(this.lastRelayoutMs),
			pagesAddedLastMeasure: this.pagesAddedLastMeasure,
			stagedPending: this.stagedPending,
			pages: this.pages,
			lastAnchorResolve: this.lastAnchorResolve,
			windowTrace: this.windowTrace.slice(),
		};
	}

	/** 注入（或替换）zip 资源解析器；注入后立即回填当前文档中待解析的图片。 */
	setAssetResolver(resolve: (path: string) => Promise<string | null>): void {
		this.opts.resolveAsset = resolve;
		void this.resolvePendingAssets();
	}

	async mount(container: HTMLElement): Promise<void> {
		this.container = container;
		this.iframe = container.createEl("iframe", {
			cls: "nyareader-html-iframe",
			attr: { sandbox: "allow-same-origin", title: "NyaReader" },
		});
		this.iframe.style.width = "100%";
		this.iframe.style.height = "100%";
		this.iframe.style.border = "none";
		this.iframe.style.display = "block";

		await new Promise<void>((resolve) => {
			let settled = false;
			const done = (): void => {
				if (settled) return;
				settled = true;
				resolve();
			};
			// 只认 load：srcdoc 解析完成后 contentDocument 才是完整的。
			// 兜底计时器只是为了让极端情况下不永久挂起，它不改变测量时机（见 docReady 守卫）。
			this.iframe.addEventListener("load", done, { once: true });
			window.setTimeout(done, LOAD_FAILSAFE_MS);
			this.iframe.srcdoc = this.opts.html;
		});
		if (this.destroyed) return;

		this.doc = this.iframe.contentDocument;
		if (!this.doc) {
			this.emitter.emit("error", { message: "HTML 文档无法访问（CSP 限制）。" });
			return;
		}
		this.docReady = true;

		this.applyBaseStyle();
		if (this.isPaged()) {
			// 先把 body 里的初始内容按章节锚点登记成"章"（窗口化的前提）
			this.registerInitialContent();
			this.wrapPaged();
			// 等两帧：让 iframe 完成首次布局，避免在尺寸为 0 时测量
			await this.nextFrame();
			await this.nextFrame();
			if (this.destroyed) return;
			this.relayoutPages(true, true, false, "settings");
		} else {
			this.registerInitialContent();
			this.unwrapPaged();
		}
		this.attachContentListeners();
		void this.resolvePendingAssets();
		this.awaitFontsReady();
	}

	private nextFrame(): Promise<void> {
		return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
	}

	/**
	 * 等内嵌/网络字体加载完成后再测一次页数。
	 *
	 * 原因（可复现）：EPUB 常用 @font-face 自带的衬线/黑体，字体未就绪时按回退字体
	 * 测得的行高与断行都不同 → 页数偏小、末页被截。而字体加载**不改变 iframe 尺寸**，
	 * ResizeObserver 不会触发，所以没有这次重排就会一直用错误页数翻页。
	 * foliate-js 有同样的兜底（doc.fonts.ready）。
	 *
	 * **超时兜底（task-7）**：`srcdoc` iframe 没有基础 URL，`@font-face` 里的相对路径
	 * 会 404；此时 `document.fonts.ready` 可能长时间不 resolve，如果无限等下去，
	 * "等字体"会永远挂着，用户的字号变更还会和它挤在一起重排。
	 * 因此这里最多等 {@link FONT_READY_TIMEOUT_MS}：到点就用当前字体测一次，
	 * 之后字体真就绪时（promise 仍会 resolve）再补测一次。
	 */
	private awaitFontsReady(): void {
		const fonts = this.doc?.fonts;
		if (!fonts || typeof fonts.ready?.then !== "function") return;
		let done = false;
		const relayout = (): void => {
			if (done || this.destroyed) return;
			done = true;
			this.relayoutPages(true, true, true, "settings");
		};
		// 超时兜底：先按当前字体测一次（保证页数不会"永远等字体"）
		window.setTimeout(relayout, FONT_READY_TIMEOUT_MS);
		void fonts.ready
			.then(() => {
				// 字体晚于超时就绪时再补测一次（done 已置位则跳过，避免重复重排）
				relayout();
			})
			.catch(() => undefined);
	}

	/** iframe 内容窗口上的交互监听（滚轮、按键、选区、滚动进度）。 */
	private attachContentListeners(): void {
		const win = this.iframe.contentWindow;
		if (!win) return;
		win.addEventListener?.("mouseup", () => {
			const sel = this.getSelection();
			if (sel) this.emitter.emit("selection", { text: sel.text });
		});
		win.addEventListener?.(
			"wheel",
			(e: WheelEvent) => {
				if (e.ctrlKey || e.metaKey) {
					e.preventDefault();
					this.nudgeZoom(e.deltaY > 0 ? 1 / 1.1 : 1.1);
					return;
				}
				if (this.isPaged()) {
					// 分页模式：滚轮即翻页
					e.preventDefault();
					if (e.deltaY !== 0) void (e.deltaY > 0 ? this.nextPage() : this.prevPage());
				}
			},
			{ passive: false }
		);
		win.addEventListener?.("keydown", (e: KeyboardEvent) => this.onContentKeydown(e));
		win.addEventListener?.(
			"scroll",
			() => {
				if (this.isPaged()) return;
				this.emitter.emit("locationChanged", { location: this.currentLocation(), percentage: this.currentPercentage() });
			},
			{ passive: true }
		);
		if (typeof ResizeObserver !== "undefined") {
			this.iframeObserver = new ResizeObserver(() => this.scheduleRelayout());
			this.iframeObserver.observe(this.iframe);
		} else {
			win.addEventListener?.("resize", this.resizeBound);
		}
	}

	/** 分页模式 = 设置里未开启滚动模式。 */
	private isPaged(): boolean {
		return this.settings.scrollMode === false;
	}

	/**
	 * 对外：当前是否分页模式（键盘路由用）。
	 * `capabilities.pageNav` 是静态能力（本引擎恒为 true），**不能**用它判断当前模式。
	 */
	isPagedMode(): boolean {
		return this.isPaged();
	}

	/** 双页对开 = 分页模式 + layout==="double"（是否真正生效见 layout.double）。 */
	private isDouble(): boolean {
		return this.settings.layout === "double";
	}

	// ---------- 键盘（iframe 内容窗口内） ----------

	private onContentKeydown(e: KeyboardEvent): void {
		const mod = e.ctrlKey || e.metaKey;
		if (mod) {
			if (e.key === "=" || e.key === "+") {
				e.preventDefault();
				this.nudgeZoom(1.15);
			} else if (e.key === "-" || e.key === "_") {
				e.preventDefault();
				this.nudgeZoom(1 / 1.15);
			} else if (e.key === "0") {
				e.preventDefault();
				this.setZoom("custom", 1);
			}
			return;
		}
		switch (e.key) {
			case "ArrowUp":
			case "ArrowDown":
				e.preventDefault();
				if (this.isPaged()) {
					void (e.key === "ArrowDown" ? this.nextPage() : this.prevPage());
				} else {
					this.scrollStep(e.key === "ArrowDown" ? 1 : -1);
				}
				break;
			case "ArrowLeft":
			case "PageUp":
				e.preventDefault();
				void this.prevPage();
				break;
			case "ArrowRight":
			case "PageDown":
				e.preventDefault();
				void this.nextPage();
				break;
			case "Home":
				e.preventDefault();
				if (this.isPaged()) this.showPage(1);
				else this.iframe.contentWindow?.scrollTo(0, 0);
				this.emitProgress();
				break;
			case "End":
				e.preventDefault();
				if (this.isPaged()) this.showPage(this.pages || 1);
				else {
					const win = this.iframe.contentWindow;
					if (win) win.scrollTo(0, win.document.documentElement.scrollHeight);
				}
				this.emitProgress();
				break;
		}
	}

	// ---------- 缩放（字号放大缩小，重排分页） ----------

	setZoom(mode: ZoomMode, value?: number): void {
		if (mode === "fit-width" || mode === "fit-height") {
			this.zoomScale = 1;
		} else if (typeof value === "number" && value >= 0.4 && value <= 4) {
			this.zoomScale = value;
		}
		if (!this.doc) return;
		// 走同一条"合并 + 暂存落盘"路径；原因标 zoom，视图提示可区分
		this.applySettings(this.settings, "zoom");
		this.emitter.emit("zoomChanged", { mode: "custom", percent: Math.round(this.zoomScale * 100) });
	}

	getZoom(): { mode: ZoomMode; scale: number; percent: number } {
		return { mode: "custom", scale: this.zoomScale, percent: Math.round(this.zoomScale * 100) };
	}

	private nudgeZoom(factor: number): void {
		const next = Math.min(4, Math.max(0.4, this.getZoom().scale * factor));
		this.setZoom("custom", next);
	}

	private effectiveFontSize(): number {
		return Math.round(this.settings.fontSize * this.zoomScale * 10) / 10;
	}

	unmount(): void {
		this.destroyed = true;
		if (this.relayoutRaf) cancelAnimationFrame(this.relayoutRaf);
		this.relayoutRaf = 0;
		if (this.settingsRelayoutRaf) cancelAnimationFrame(this.settingsRelayoutRaf);
		this.settingsRelayoutRaf = 0;
		if (this.settingsRelayoutTimer) window.clearTimeout(this.settingsRelayoutTimer);
		this.settingsRelayoutTimer = 0;
		this.pendingSettingsRelayout = null;
		if (this.stageTimer) window.clearTimeout(this.stageTimer);
		this.stageTimer = 0;
		this.stagedPending = false;
		this.stageFirstPendingAt = 0;
		this.stageEl = null;
		this.lastMarkerLeft = null;
		this.layoutStateHandler = null;
		// 先释放高亮层（它会 unwrap 自己包裹的 span；iframe 随后被移除）
		this.highlightLayer?.dispose();
		this.highlightLayer = null;
		this.iframeObserver?.disconnect();
		this.iframeObserver = null;
		this.iframe?.remove();
		this.doc = null;
		this.docReady = false;
	}

	// ---------- 内容追加（大文件分章懒加载） ----------

	/**
	 * 追加一段新的正文 HTML（EPUB/MOBI 后台补章用）。
	 *
	 * **v0.6 增量追加（task-7 A 步）**：分页模式下**不再**"每批追加都同步测量"。
	 * 旧实现每批都 `relayoutPages(force)` → `measurePages()` 读标记 →
	 * 触发**整篇（已加载全部内容）的同步布局**：一本 2000+ 页的书补 50 批 =
	 * 50 次 O(总内容) 布局（实测 8.8s 同步阻塞、17.3s 单帧长任务），
	 * 并且目录跳远章节时（ensureChaptersThrough 连续补几十批）整段时长都堆在这里。
	 *
	 * 现在的路径：
	 * 1. 新内容先进入 **display:none 暂存容器**（无布局对象 → 追加不触发任何布局）；
	 * 2. 连续追加被合并，静默 {@link APPEND_SETTLE_MS} 之后一次性并入多栏容器；
	 * 3. 落盘时只做**一次**重排，并用增量测量（标记位移）得到精确页数。
	 *
	 * 任何"读状态/跳转/翻页"的调用都会先把暂存内容落盘（见 flushPendingContent），
	 * 因此对外可见的页数、锚点、进度语义与旧实现完全一致，只是不再逐批重排。
	 *
	 * @param html 追加的 HTML 片段（应自带章节锚点）
	 */
	notifyContentAppended(html: string): void {
		if (this.destroyed || !this.doc?.body) return;
		if (!this.isPaged()) {
			// 滚动模式：没有多栏测量，追加本身不触发"测量式"重排。
			// 但仍要切章登记（切回分页时才知道章节边界、才能按章布局）。
			const tmp = this.doc.createElement("div");
			tmp.innerHTML = html;
			const nodes = Array.from(tmp.childNodes);
			this.registerNodes(nodes, this.doc.body);
			this.refreshHighlights();
			void this.resolvePendingAssets();
			return;
		}
		const stage = this.ensureStageEl();
		if (!stage) {
			this.appendIntoLiveHost(html);
			void this.resolvePendingAssets();
			return;
		}
		stage.insertAdjacentHTML("beforeend", html);
		this.stagedPending = true;
		this.scheduleStageFlush();
		void this.resolvePendingAssets();
	}

	/**
	 * 把内容追加到**当前真正挂在文档里**的宿主。
	 *
	 * 宿主引用失效（shim 被外部摘掉/宿主重建）时先修复容器再追加 ——
	 * 否则内容会被塞进"孤儿节点"，表现为书变短/页数不再增长。
	 */
	private appendIntoLiveHost(html: string): void {
		const host = this.liveHost();
		if (!host) return;
		host.insertAdjacentHTML("beforeend", html);
		const marker = this.endMarker;
		// 标记元素必须始终在最后，才能测到真正的末列
		if (this.isPaged() && marker && marker.parentElement !== host) host.appendChild(marker);
		// 新内容可能正是某条"chapter 尚未加载"的高亮要找的章节：立刻重新解析一次
		this.refreshHighlights();
	}

	/** 当前生效的追加宿主（分页模式 = 挂在文档里的多栏容器；否则 body）。 */
	private liveHost(): HTMLElement | null {
		if (!this.isPaged()) return this.doc?.body ?? null;
		const cols = this.columnsEl;
		if (cols && cols.isConnected && this.paged?.contains(cols)) return cols;
		// 引用失效：先修复容器（wrapPaged 内部优先复用仍在的旧子树，绝不丢内容）
		this.wrapPaged();
		return this.columnsEl ?? this.doc?.body ?? null;
	}

	// ---------- 按章独立分页：登记 / 窗口 / 测量（task-10）----------

	/** 是否启用按章独立分页（默认开；`chapterPagedPagination:false` 一键回退整本布局）。 */
	private chapterPagedEnabled(): boolean {
		if (this.opts.chapterPagedPagination === false) return false;
		// 运行时紧急回退（不发版）：在 Obsidian 控制台执行
		//   window.__nyarDisableChapterPagedPagination = true
		// 然后重开这本书即可回到"整本布局 + 精确页数"的旧行为。
		const g = globalThis as { __nyarDisableChapterPagedPagination?: boolean };
		return g.__nyarDisableChapterPagedPagination !== true;
	}

	/** 当前是否处于"窗口化分页"状态（分页模式 + 开关开启 + 真的有章节可切）。 */
	private windowedChapters(): boolean {
		return this.isPaged() && this.chapterPagedEnabled() && this.chapters.length > 0;
	}

	/** 判定一个 id 是否章节锚点（显式前缀优先，其次通用正则）。 */
	private isChapterAnchorId(id: string): boolean {
		if (!id) return false;
		const prefix = this.opts.chapterAnchorPrefix;
		if (prefix && id.startsWith(prefix)) {
			const rest = id.slice(prefix.length);
			return /^\d+$/.test(rest);
		}
		return CHAPTER_ANCHOR_RE.test(id);
	}

	/** 冷区容器（display:none；分页模式下不参与布局的章节放这里）。 */
	private ensureColdEl(): HTMLElement | null {
		const doc = this.doc;
		if (!doc?.body) return null;
		if (this.coldEl && this.coldEl.isConnected) return this.coldEl;
		if (this.coldEl) {
			// 子树还在（只是被摘掉）：挂回去，绝不重建（重建会丢章节）
			doc.body.appendChild(this.coldEl);
			return this.coldEl;
		}
		const el = doc.createElement("div");
		el.className = COLD_CLASS;
		el.setAttribute("aria-hidden", "true");
		el.style.display = "none";
		doc.body.appendChild(el);
		this.coldEl = el;
		return el;
	}

	private chapterEndMarkerFor(index: number): HTMLElement | null {
		const doc = this.doc;
		if (!doc) return null;
		const existing = this.chapterEndMarkers.get(index);
		if (existing) return existing;
		const el = doc.createElement("span");
		el.className = CHAPTER_END_CLASS;
		el.setAttribute("data-chapter", String(index));
		this.chapterEndMarkers.set(index, el);
		return el;
	}

	private slotChars(nodes: readonly Node[]): number {
		let chars = 0;
		for (const n of nodes) {
			const text = n.textContent;
			if (text) chars += text.length;
		}
		return chars;
	}

	/**
	 * 收集一章里的"可跳转锚点 id"（目录 goto("#id") 用）。
	 *
	 * 只记 `nyar` 前缀的 id：生产里是 `nyareader-epub-N` / `nyareader-mobi-N` /
	 * `nyareader-toc-N` / `nyareader-fp-N`；同时兼容合成样本里的 `nyar-anchor-N`。
	 * 不记普通 id（一本书可能有上万个脚注 id，没有跳转价值）。
	 */
	private slotAnchors(nodes: readonly Node[]): string[] {
		const ids: string[] = [];
		for (const n of nodes) {
			if (n.nodeType !== 1) continue;
			const el = n as HTMLElement;
			if (el.id?.startsWith("nyar")) ids.push(el.id);
			for (const inner of Array.from(el.querySelectorAll?.('[id^="nyar"]') ?? [])) {
				const id = (inner as HTMLElement).id;
				if (id) ids.push(id);
			}
		}
		return ids;
	}

	/**
	 * 把一段顶层节点按章节锚点切成若干章并登记。
	 *
	 * @param nodes 顶层节点（**必须已按文档顺序排列**）
	 * @param target 这些节点最终要挂到哪个容器（分页窗口化 = 冷区；滚动模式 = body）
	 * @returns 新登记的章节索引区间
	 */
	private registerNodes(nodes: readonly Node[], target: HTMLElement): { from: number; to: number } {
		const from = this.chapters.length;
		if (!this.chapterPagedEnabled()) {
			// 回退模式：整篇算一章（页数精确、整本布局 —— 与旧行为一致）
			const existing = this.chapters[0];
			if (existing) {
				for (const n of nodes) {
					target.appendChild(n);
					existing.nodes.push(n);
				}
				existing.chars += this.slotChars(nodes);
				existing.anchorIds.push(...this.slotAnchors(nodes));
			} else {
				for (const n of nodes) target.appendChild(n);
				const slot: ChapterSlot = { nodes: nodes.slice(), chars: this.slotChars(nodes), anchorIds: this.slotAnchors(nodes) };
				this.chapters.push(slot);
				for (const id of slot.anchorIds) this.anchorToChapter.set(id, 0);
			}
			this.refreshPageOffsets();
			return { from: 0, to: this.chapters.length - 1 };
		}
		let run: Node[] = [];
		const flush = (): void => {
			if (!run.length) return;
			for (const n of run) target.appendChild(n);
			const index = this.chapters.length;
			const slot: ChapterSlot = { nodes: run, chars: this.slotChars(run), anchorIds: this.slotAnchors(run) };
			this.chapters.push(slot);
			for (const id of slot.anchorIds) this.anchorToChapter.set(id, index);
			this.tagChapterStart(index);
			run = [];
		};
		for (const node of nodes) {
			const el = node.nodeType === 1 ? (node as HTMLElement) : null;
			if (el && this.isChapterAnchorId(el.id)) {
				// 锚点即新章起点：先结算上一章（首个锚点之前的内容算"前言章"）
				flush();
			}
			run.push(node);
		}
		flush();
		this.refreshPageOffsets();
		return { from, to: this.chapters.length - 1 };
	}

	/** 给每章的第一个元素节点打标记，供"元素 → 章节"反查（高亮/锚点定位用）。 */
	private tagChapterStart(index: number): void {
		const slot = this.chapters[index];
		if (!slot) return;
		const first = slot.nodes.find((n) => n.nodeType === 1) as HTMLElement | undefined;
		if (first) first.setAttribute(CHAPTER_TAG_ATTR, String(index));
	}

	/** 元素/文本节点 → 章节索引（-1 = 不属于任何章节，例如测量标记）。 */
	private chapterIndexOfNode(node: Node | null): number {
		let el: Element | null = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
		// 1) 祖先链上的章节标记
		let cursor: Element | null = el;
		while (cursor) {
			const tag = cursor.getAttribute?.(CHAPTER_TAG_ATTR);
			if (tag !== null && tag !== undefined) {
				const index = parseInt(tag, 10);
				if (Number.isFinite(index) && index >= 0 && index < this.chapters.length) return index;
			}
			cursor = cursor.parentElement;
		}
		// 2) 前驱兄弟链上的章节标记（章节起点标记与本节点同级、且在本节点之前）
		const cols = this.columnsEl;
		const cold = this.coldEl;
		if (el && el.parentElement && (el.parentElement === cols || el.parentElement === cold)) {
			cursor = el.previousElementSibling;
			while (cursor) {
				const tag = cursor.getAttribute?.(CHAPTER_TAG_ATTR);
				if (tag !== null && tag !== undefined) {
					const index = parseInt(tag, 10);
					if (Number.isFinite(index) && index >= 0 && index < this.chapters.length) return index;
				}
				cursor = cursor.previousElementSibling;
			}
		}
		// 3) 按锚点 id 反查
		const id = el?.id || "";
		if (id) return this.chapterIndexForAnchor(id);
		return -1;
	}

	/** 锚点定位符（"#id" 或 id）→ 章节索引（-1 = 找不到）。 */
	private chapterIndexForAnchor(location: string): number {
		const id = location.startsWith("#") ? location.slice(1) : location;
		if (!id) return -1;
		const cached = this.anchorToChapter.get(id);
		if (cached !== undefined) return cached;
		for (let i = 0; i < this.chapters.length; i++) {
			if (this.chapters[i].anchorIds.includes(id)) return i;
		}
		return -1;
	}

	/** 章节页数前缀和（缓存；chapters/测量变化时刷新）。 */
	private pageOffsets(): number[] {
		if (this.pageOffsetsCache.length !== this.chapters.length + 1) this.refreshPageOffsets();
		return this.pageOffsetsCache;
	}

	/** 重算章节页数前缀和 + 全书页数估计。 */
	private refreshPageOffsets(): void {
		const fingerprint = this.currentFingerprint();
		const chars = this.chapters.map((c) => c.chars);
		const estimate = estimateTotalPages(this.chapterMeasures, chars, fingerprint, this.chapters.length);
		const per = Math.max(1, estimate.charsPerPage);
		// 逐章页数用**累计**（Bresenham 式）取整：未测章节贡献 chars/charsPerPage 的
		// 小数部分，只在累计边界上取整。若逐章独立 round，会引入系统性偏差
		// （每章最多 ±0.5 页 × 数百章 = 几十上百页的虚增）。
		const perChapter = new Array<number>(this.chapters.length);
		let acc = 0;
		let emitted = 0;
		for (let i = 0; i < this.chapters.length; i++) {
			const m = this.chapterMeasures[i];
			if (m && m.fingerprint === fingerprint && m.pages >= 0) acc += m.pages;
			else acc += (chars[i] || 0) / per;
			const offset = Math.max(emitted, Math.round(acc));
			perChapter[i] = offset - emitted;
			emitted = offset;
		}
		this.pageOffsetsCache = chapterPageOffsets(perChapter);
		this.pages = Math.max(1, this.pageOffsetsCache[this.pageOffsetsCache.length - 1] - 1);
		// "是否有估计成分"必须逐章检查：chapterMeasures 可能是**短数组/稀疏数组**，
		// 用 Array.some 在空数组上会返回 false（曾因此把估计值标成精确值）。
		let anyEstimated = false;
		for (let i = 0; i < this.chapters.length; i++) {
			const m = this.chapterMeasures[i];
			if (!m || m.fingerprint !== fingerprint) {
				anyEstimated = true;
				break;
			}
		}
		this.pagesEstimated = anyEstimated;
		this.lastPagesEstimate = estimate;
		this.totalPagesInfoCache = {
			pages: this.pages,
			estimated: this.pagesEstimated,
			chapters: this.chapters.length,
			measuredChapters: estimate.measuredChapters,
			estimatedChapters: estimate.estimatedChapters,
			estimatedFraction: estimate.estimatedFraction,
			charsPerPage: estimate.charsPerPage,
			windowFrom: this.windowFrom,
			windowTo: this.windowTo,
		};
	}

	/** 当前版式指纹（字号/行距/字体/页尺寸/单双页） */
	private currentFingerprint(): string {
		return layoutFingerprint({
			fontSize: this.effectiveFontSize(),
			lineHeight: this.settings.lineHeight,
			fontFamily: this.settings.fontFamily,
			pageWidth: this.layout.pageWidth,
			pageHeight: this.layout.pageHeight,
			gutter: this.layout.gutter,
			pageMarginX: this.layout.pageMarginX,
			double: this.layout.double,
		});
	}

	/** 把章节节点搬到冷区（保持顺序）。 */
	private moveChapterToCold(index: number): void {
		const slot = this.chapters[index];
		const cold = this.ensureColdEl();
		if (!slot || !cold) return;
		for (const node of slot.nodes) if (node.parentNode !== cold) cold.appendChild(node);
		const marker = this.chapterEndMarkers.get(index);
		if (marker && marker.parentNode !== cold) cold.appendChild(marker);
	}

	/** 把章节节点搬进多栏容器（插在末尾测量标记之前，保持窗口内顺序）。 */
	private moveChapterToWindow(index: number): void {
		const slot = this.chapters[index];
		const cols = this.columnsEl;
		if (!slot || !cols) return;
		const end = this.endMarker;
		for (const node of slot.nodes) if (node.parentNode !== cols) cols.insertBefore(node, end);
		const marker = this.chapterEndMarkerFor(index);
		if (marker && marker.parentNode !== cols) cols.insertBefore(marker, end);
	}

	/**
	 * 切换活动窗口：窗口外章节移入冷区，窗口内章节按升序移入多栏容器。
	 * 只做 DOM 搬运（不读布局），随后由调用方做**一次**重排。
	 */
	private applyWindow(range: { from: number; to: number }): void {
		if (!this.windowedChapters() || !this.columnsEl) return;
		this.windowTrace.push({ from: range.from, to: range.to, active: this.activeChapterIdx, stack: new Error().stack?.split("\n").slice(1, 4).join(" | ") ?? "" });
		if (this.windowTrace.length > 12) this.windowTrace.shift();
		// 先把窗口内章节全部移出，再按升序移入：避免"新插入的章跑到已存在章之后"
		for (let i = range.from; i <= range.to; i++) this.moveChapterToCold(i);
		for (let i = 0; i < this.chapters.length; i++) {
			if (i < range.from || i > range.to) this.moveChapterToCold(i);
		}
		for (let i = range.from; i <= range.to; i++) this.moveChapterToWindow(i);
		this.windowFrom = range.from;
		this.windowTo = range.to;
	}

	/**
	 * 激活某章（按需滑动窗口），并做**一次**重排（同时完成窗口内逐章测量）。
	 * 章节进出布局区后必须 `refreshHighlights()`（stream-i 的高亮契约）。
	 */
	private ensureWindow(index: number, reason: RelayoutReason = "append"): void {
		if (!this.windowedChapters()) return;
		const clamped = Math.max(0, Math.min(this.chapters.length - 1, Math.floor(index)));
		this.activeChapterIdx = clamped;
		const range = activeWindowRange(clamped, this.chapters.length, CHAPTER_WINDOW_RADIUS);
		if (range.from === this.windowFrom && range.to === this.windowTo) return;
		this.applyWindow(range);
		this.geometryStale = false; // 几何没变，不必重写 CSS 变量（那一写会失效整棵树）
		this.relayoutPages(true, true, true, reason);
		this.refreshHighlights();
	}

	/**
	 * 窗口内逐章测量 + 全书页数估计。
	 *
	 * 一次布局读 N 个标记（第一个读触发同步布局，之后都是廉价读数），
	 * 得到窗口内每章的精确页数；窗口外章节沿用旧指纹下的测量或插值。
	 */
	private refreshWindowPagination(): number {
		const fingerprint = this.currentFingerprint();
		const cols = this.columnsEl;
		if (!cols) return this.pages;
		let prevCol: number | null = null;
		for (let i = this.windowFrom; i <= this.windowTo; i++) {
			const marker = this.chapterEndMarkers.get(i);
			if (!marker || marker.parentElement !== cols) continue;
			const left = this.readMarkerLeftOf(marker, cols);
			if (left === null) continue;
			const col = columnIndexFromMarker(left, this.layout);
			const pages = prevCol === null ? col + 1 : Math.max(0, col - prevCol);
			prevCol = col;
			const slot = this.chapters[i];
			if (slot) this.chapterMeasures[i] = { pages, chars: slot.chars, fingerprint };
		}
		this.refreshPageOffsets();
		return this.pages;
	}

	/** 读取某个标记相对栏容器左缘的偏移（读它会触发一次同步布局）。 */
	private readMarkerLeftOf(marker: HTMLElement, cols: HTMLElement): number | null {
		if (marker.offsetParent === cols) return marker.offsetLeft;
		const rect = marker.getBoundingClientRect();
		const colsRect = cols.getBoundingClientRect();
		if (!rect || !colsRect) return null;
		return rect.left - colsRect.left;
	}

	/** 窗口内页码（1-based；窗口第一页 = 1）。 */
	private pageInWindow(page: number): number {
		if (!this.windowedChapters()) return page;
		const base = this.pageOffsets()[this.windowFrom] ?? 1;
		return Math.max(1, page - base + 1);
	}

	/** 暂存容器（display:none，挂在 iframe body 下）。 */
	private ensureStageEl(): HTMLElement | null {
		const doc = this.doc;
		if (!doc?.body) return null;
		if (this.stageEl) {
			if (this.stageEl.isConnected) return this.stageEl;
			// 子树仍在（只是被摘掉）：挂回去，绝不重建（重建会丢掉里面待落盘的内容）
			doc.body.appendChild(this.stageEl);
			return this.stageEl;
		}
		const el = doc.createElement("div");
		el.className = "nyareader-stage";
		el.setAttribute("aria-hidden", "true");
		el.style.display = "none";
		doc.body.appendChild(el);
		this.stageEl = el;
		return el;
	}

	/**
	 * 排定暂存内容的落盘：每次追加都把落盘时间往后推一个静默窗口，
	 * 但用 {@link APPEND_MAX_HOLD_MS} 封顶（避免页数长时间停在旧值）。
	 */
	private scheduleStageFlush(): void {
		const now = Date.now();
		if (!this.stageFirstPendingAt) this.stageFirstPendingAt = now;
		const delay = nextSettleDelayMs(now, this.stageFirstPendingAt, APPEND_SETTLE_MS, APPEND_MAX_HOLD_MS);
		if (this.stageTimer) window.clearTimeout(this.stageTimer);
		this.stageTimer = window.setTimeout(() => {
			this.stageTimer = 0;
			this.flushStaged();
		}, delay);
	}

	/**
	 * 把暂存内容落盘：**只搬 DOM，不重排、不读布局**。
	 *
	 * 按章独立分页（task-10）：新章直接进**冷区**（display:none），既不参与分栏
	 * 也不触发任何布局 —— 页数只按字符数估计更新。于是"后台补章"彻底不再引起重排。
	 * 回退模式/滚动模式：仍并入多栏容器或 body，并登记为章节（保持顺序与可回溯）。
	 *
	 * @returns 是否真的搬了内容
	 */
	private absorbStagedContent(): boolean {
		const stage = this.stageEl;
		if (!stage || !this.stagedPending) return false;
		this.stagedPending = false;
		this.stageFirstPendingAt = 0;
		if (this.stageTimer) {
			window.clearTimeout(this.stageTimer);
			this.stageTimer = 0;
		}
		const doc = this.doc;
		if (!doc) return false;
		const nodes: Node[] = [];
		while (stage.firstChild) nodes.push(stage.removeChild(stage.firstChild));
		if (!nodes.length) return false;
		if (this.isPaged() && this.chapterPagedEnabled()) {
			const cold = this.ensureColdEl();
			if (cold) {
				this.lastAppendRange = this.registerNodes(nodes, cold);
				this.refreshPageOffsets();
				// 内容结构变了：高亮层的区域划分与区域文本缓存必须失效
				this.refreshHighlights();
				return true;
			}
		}
		// 旧路径：并入多栏容器（若还在）或 body，保持"先加载的内容在前"的严格顺序
		const cols = this.columnsEl;
		const host = cols && this.paged?.contains(cols) ? cols : doc.body;
		if (!host) return false;
		const marker = this.endMarker;
		const frag = doc.createDocumentFragment();
		for (const n of nodes) frag.appendChild(n);
		if (marker && marker.parentElement === host) host.insertBefore(frag, marker);
		else host.appendChild(frag);
		this.lastAppendRange = this.registerNodes(Array.from(frag.childNodes), host);
		this.refreshPageOffsets();
		// 内容结构变了：高亮层的区域划分与区域文本缓存必须失效（随后由重放入口重新解析）
		this.refreshHighlights();
		return true;
	}

	/** 落盘 + 一次重排（keepPage=true：纯末尾追加不移动当前页）。 */
	private flushStaged(emit = true): void {
		const moved = this.absorbStagedContent();
		if (!moved) return;
		// 若同帧内还有待做的版式重排：合并成一次（新内容已并入，会一起参与这次重排）
		const pending = this.pendingSettingsRelayout;
		if (pending) {
			this.pendingSettingsRelayout = { emit: pending.emit || emit, reason: pending.reason };
			this.runPendingSettingsRelayout();
			return;
		}
		// 按章独立分页（task-10）：新章落在活动窗口之外 ⇒ **完全不需要重排**，
		// 页数只按字符数估计更新（这正是"后台补章不再周期性卡顿"的来源）。
		if (this.windowedChapters()) {
			const added = this.lastAppendRange;
			const touchesWindow = !!added && added.to >= this.windowFrom && added.from <= this.windowTo;
			if (!touchesWindow) {
				this.refreshPageOffsets();
				this.refreshHighlights();
				if (emit) this.emitProgress();
				return;
			}
		}
		this.relayoutPages(emit, true, true, "append");
	}

	/**
	 * 立即把暂存内容落盘（供任何"读状态/跳转/翻页"的入口调用）。
	 * 这是"暂存不影响功能"的关键：对外语义永远是"已追加的内容已经生效"。
	 */
	private flushPendingContent(): void {
		if (this.stagedPending) this.flushStaged(true);
	}

	// ---------- 跳转 ----------

	async goTo(location: string): Promise<void> {
		this.runPendingSettingsRelayout();
		this.flushPendingContent();
		// 目录锚点（EPUB/MOBI 内部跳转统一改写为 #nyareader-epub-NNN）
		if (location.startsWith("#")) {
			const anchorId = location.slice(1);
			// 按章独立分页：目标章可能躺在冷区（display:none）。
			// 此时它的 getBoundingClientRect() 全是 0，若直接判"不可见"就整段跳过跳转 ——
			// 目录跳到远处章节会**静默失效**。所以先按锚点反查章节并激活窗口，再取元素。
			if (this.windowedChapters()) {
				const chapter = this.chapterIndexForAnchor(anchorId);
				this.lastAnchorResolve = { anchorId, chapter, from: this.windowFrom, to: this.windowTo, chapters: this.chapters.length };
				if (chapter >= 0 && (chapter < this.windowFrom || chapter > this.windowTo)) {
					this.ensureWindow(chapter, "settings");
					this.lastAnchorResolve.after = { from: this.windowFrom, to: this.windowTo, active: this.activeChapterIdx };
				}
			} else {
				this.lastAnchorResolve = { anchorId, chapter: -1, from: this.windowFrom, to: this.windowTo, chapters: this.chapters.length, windowed: false };
			}
			const doc = this.iframe?.contentDocument;
			const target = doc?.getElementById(anchorId);
			if (target && "getBoundingClientRect" in target) {
				if (this.isPaged()) this.showPage(this.pageOfElement(target as HTMLElement));
				else (target as HTMLElement).scrollIntoView({ block: "start" });
			}
			this.emitProgress();
			return;
		}
		const pct = parseInt(location, 10);
		if (Number.isNaN(pct)) return;
		if (this.isPaged()) {
			this.showPage(pageFromPercent(pct, this.pages));
			return;
		}
		const win = this.iframe.contentWindow;
		if (!win) return;
		const d = win.document;
		const max = Math.max(1, d.documentElement.scrollHeight - win.innerHeight);
		win.scrollTo(0, (pct / 10000) * max);
		this.emitProgress();
	}

	/**
	 * 锚点元素在第几页（分页模式）：按元素相对阅读窗口的横坐标反推列号。
	 *
	 * 按章独立分页（task-10）：目标章可能正躺在冷区（display:none，没有几何），
	 * 因此先激活它（一次"重排 2–3 章"），再按列号换算 —— 目录跳远章节因此不再
	 * 需要"整本书都参与布局"。
	 *
	 * ⚠️ 窗口化模式下**必须**用"该章起始页 + 章内列号"算绝对页号：
	 * 若用 `currentPage - 1 + col`（旧写法），激活远处章节后 currentPage 还停在旧章，
	 * 算出来的是旧章的页 → 随后 `showPage()` 会据此把窗口**弹回旧章**，
	 * 表现为"目录跳到远处章节没反应"。
	 */
	private pageOfElement(el: HTMLElement): number {
		if (this.windowedChapters()) {
			const index = this.chapterIndexOfNode(el);
			if (index >= 0 && (index < this.windowFrom || index > this.windowTo)) {
				this.ensureWindow(index);
			}
			if (index >= 0) {
				const bookRect = this.paged?.getBoundingClientRect();
				const elRect = el.getBoundingClientRect();
				if (bookRect && this.layout.columnStride > 0) {
					const x = elRect.left - bookRect.left - this.layout.pageMarginX;
					const col = Math.max(0, Math.round(x / this.layout.columnStride));
					const chapterStart = this.pageOffsets()[index] ?? 1;
					return clampPage(chapterStart + col, this.pages);
				}
			}
		}
		const bookRect = this.paged?.getBoundingClientRect();
		const elRect = el.getBoundingClientRect();
		if (!bookRect || this.layout.columnStride <= 0) return this.currentPage;
		const x = elRect.left - bookRect.left - this.layout.pageMarginX;
		const col = Math.round(x / this.layout.columnStride);
		return clampPage(this.currentPage - 1 + col + 1, this.pages);
	}

	async nextPage(): Promise<void> {
		if (this.isPaged()) {
			this.showPage(this.currentPage + pageStep(this.layout.double));
			return;
		}
		this.flushPendingContent();
		this.iframe.contentWindow?.scrollBy({ top: this.iframe.clientHeight * 0.9, behavior: "smooth" });
	}

	async prevPage(): Promise<void> {
		if (this.isPaged()) {
			this.showPage(this.currentPage - pageStep(this.layout.double));
			return;
		}
		this.flushPendingContent();
		this.iframe.contentWindow?.scrollBy({ top: -this.iframe.clientHeight * 0.9, behavior: "smooth" });
	}

	/**
	 * 按**文档内相对进度**跳转（0~1），用于底部可拖动进度条。
	 *
	 * 与 goTo("0~10000") 的区别：这里直接用"页中心 ↔ 百分比"的互逆关系，
	 * 不依赖总页数是否准确，因此在只加载了部分章节时也能定位到已加载区域。
	 */
	goToFraction(fraction: number): void {
		this.runPendingSettingsRelayout();
		this.flushPendingContent();
		const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
		if (this.isPaged()) {
			// 页中心语义：f = (page-0.5)/pages → page = round(f*pages + 0.5)
			const page = this.pages > 0 ? Math.round(f * this.pages + 0.5) : 1;
			this.showPage(page || 1);
			return;
		}
		const win = this.iframe?.contentWindow;
		if (!win) return;
		const d = win.document;
		const max = Math.max(1, d.documentElement.scrollHeight - win.innerHeight);
		win.scrollTo(0, f * max);
		this.emitProgress();
	}

	/**
	 * 分页总页数（滚动模式返回 0）。
	 *
	 * 读之前先把"待落盘的补章内容"和"待做的版式重排"落地 —— 这样调用方
	 * （视图层的页码/进度条）永远看不到过期值，暂存机制对上层透明。
	 */
	getTotalPages(): number {
		this.runPendingSettingsRelayout();
		this.flushPendingContent();
		return this.isPaged() ? this.pages : 0;
	}

	/**
	 * 总页数是否为**估计值**（task-10）。
	 *
	 * 按章独立分页下，只有活动窗口那几章是精确测量的，其余章节按字符数插值，
	 * 所以视图层必须能识别：显示成 `≈ 6000 页` 而不是 `6000 页`。
	 * 回退模式（chapterPagedPagination:false）或所有章节都已测量时返回 false。
	 */
	isPageCountEstimated(): boolean {
		this.flushPendingContent();
		return this.isPaged() ? this.pagesEstimated : false;
	}

	/** 总页数明细（页码来源、窗口、估计占比）——视图层与诊断用。 */
	getTotalPagesInfo(): TotalPagesInfo {
		this.flushPendingContent();
		// 非窗口化（回退模式/滚动模式）：页数来自整篇测量，必然是精确值
		if (!this.isPaged() || !this.windowedChapters()) {
			return {
				pages: this.pages,
				estimated: false,
				chapters: Math.max(1, this.chapters.length),
				measuredChapters: this.chapters.length,
				estimatedChapters: 0,
				estimatedFraction: 0,
				charsPerPage: 0,
				windowFrom: this.windowFrom,
				windowTo: this.windowTo,
			};
		}
		return (
			this.totalPagesInfoCache ?? {
				pages: this.pages,
				estimated: this.pagesEstimated,
				chapters: this.chapters.length,
				measuredChapters: 0,
				estimatedChapters: this.chapters.length,
				estimatedFraction: 0,
				charsPerPage: 0,
				windowFrom: this.windowFrom,
				windowTo: this.windowTo,
			}
		);
	}

	currentLocation(): string {
		this.runPendingSettingsRelayout();
		this.flushPendingContent();
		if (this.isPaged()) return String(percentFromPage(this.currentPage, this.pages));
		return String(Math.round(this.currentPercentage() * 10000));
	}

	currentPercentage(): number {
		if (this.isPaged()) {
			if (this.pages <= 1) return 0;
			return Math.min(1, Math.max(0, (this.currentPage - 0.5) / this.pages));
		}
		const win = this.iframe.contentWindow;
		if (!win) return 0;
		const doc = win.document;
		const max = Math.max(1, doc.documentElement.scrollHeight - win.innerHeight);
		return Math.min(1, Math.max(0, win.scrollY / max));
	}

	// ---------- 版式应用 / 分页结构 ----------

	/**
	 * 应用版式设置（字号/行距/主题/页宽/单双页…）。
	 *
	 * **task-7 B 步**：这里不再无条件地"同步做一次整篇重排"。
	 * - 字号/行距变化确实需要整篇重排（断行全变，无法避免）；
	 * - 但"连续变更"（按住 Ctrl +/-、Ctrl+滚轮缩放、连点字号选择器）会在
	 *   {@link scheduleSettingsRelayout} 里被合并成**一次**重排；
	 * - 任何"读状态/跳转/翻页"都会先同步落地待做的重排，所以调用方
	 *   在 applySettings 之后立刻读到的永远是**新**页数（语义不回退）。
	 */
	applySettings(settings: ReaderSettings, reason: RelayoutReason = "settings"): void {
		this.settings = { ...settings };
		if (!this.doc) return;
		// 主题/版式可能变了：重新读一次宿主主题变量（滚动模式的背景跟随宿主）
		this.hostThemeCache = null;
		this.applyBaseStyle();
		if (this.isPaged()) {
			this.wrapPaged();
			this.scheduleSettingsRelayout(false, reason);
		} else {
			// 滚动模式：把暂存内容并入（保持顺序），退出分页结构
			this.absorbStagedContent();
			this.unwrapPaged();
		}
		void this.resolvePendingAssets();
	}

	/**
	 * 合并"同一帧内的连续版式变更"（B 步）。
	 *
	 * 首次变更：若上一次重排很快（<{@link SLOW_RELAYOUT_MS}），直接**同步**执行，
	 * 保持原有同步语义；
	 * 若上一次已经慢（大文件），先发出 `busy:true` 状态（让视图有时间画
	 * "正在重新排版…"），重排推迟到下一帧执行 —— 否则提示永远来不及上屏。
	 */
	private scheduleSettingsRelayout(emit: boolean, reason: RelayoutReason): void {
		const prev = this.pendingSettingsRelayout;
		this.pendingSettingsRelayout = { emit: prev?.emit || emit, reason: prev?.reason ?? reason };
		if (this.lastRelayoutMs <= SLOW_RELAYOUT_MS) {
			this.runPendingSettingsRelayout();
			return;
		}
		if (this.settingsRelayoutRaf) return;
		this.settingsRelayoutRaf = window.requestAnimationFrame(() => {
			this.settingsRelayoutRaf = 0;
			this.runPendingSettingsRelayout();
		});
		// 后台标签页里 rAF 会被节流甚至不触发：加一个定时器兜底，
		// 保证"改了字号"最终一定会落地（任何状态读取也会同步落地）。
		if (this.settingsRelayoutTimer) window.clearTimeout(this.settingsRelayoutTimer);
		this.settingsRelayoutTimer = window.setTimeout(() => {
			this.settingsRelayoutTimer = 0;
			this.runPendingSettingsRelayout();
		}, SLOW_RELAYOUT_MS * 2);
	}

	/** 立即执行待做的版式重排（若有）。 */
	private runPendingSettingsRelayout(): void {
		const pending = this.pendingSettingsRelayout;
		if (!pending) return;
		this.pendingSettingsRelayout = null;
		if (this.settingsRelayoutRaf) {
			cancelAnimationFrame(this.settingsRelayoutRaf);
			this.settingsRelayoutRaf = 0;
		}
		if (this.settingsRelayoutTimer) {
			window.clearTimeout(this.settingsRelayoutTimer);
			this.settingsRelayoutTimer = 0;
		}
		this.relayoutPages(pending.emit, true, false, pending.reason);
	}

	/** 切换滚动/分页模式并保持当前阅读位置。 */
	switchMode(scrollMode: boolean): void {
		const pct = this.currentPercentage();
		this.settings = { ...this.settings, scrollMode };
		if (!this.doc) return;
		this.applySettings(this.settings);
		// 模式切换是离散操作：立即落地（不等合并窗口），语义与旧实现一致
		this.runPendingSettingsRelayout();
		this.flushPendingContent();
		if (this.isPaged()) {
			this.showPage(pageFromPercent(Math.round(pct * 10000), this.pages || 1), false);
		} else {
			const win = this.iframe.contentWindow;
			if (win) {
				const d = win.document;
				const max = Math.max(1, d.documentElement.scrollHeight - win.innerHeight);
				win.scrollTo(0, pct * max);
			}
		}
		this.emitProgress();
		// 切到滚动模式时不会走 relayoutPages（没有分栏重排），所以这里显式重放一次高亮
		this.refreshHighlights();
	}

	/**
	 * 把 body 里的初始内容按章节锚点登记成"章"，并统一搬进冷区。
	 *
	 * 此时 body 的顶层节点就是渲染文档的初始正文（首屏那几章）；登记后由
	 * {@link populatePagedContainer} 决定哪几章进入多栏容器参与分栏。
	 */
	private registerInitialContent(): void {
		const doc = this.doc;
		const body = doc?.body;
		if (!doc || !body) return;
		const cold = this.ensureColdEl();
		if (!cold) return;
		const nodes = Array.from(body.childNodes).filter(
			(n) => n !== this.stageEl && n !== cold && n !== this.styleEl && !(n.nodeType === 3 && !(n.textContent ?? "").trim())
		);
		if (!nodes.length) {
			this.refreshPageOffsets();
			return;
		}
		this.registerNodes(nodes, cold);
		this.activeChapterIdx = 0;
		this.windowFrom = 0;
		this.windowTo = -1; // 交给 populatePagedContainer 决定
		this.refreshPageOffsets();
	}

	/**
	 * 决定哪些章进入多栏容器：窗口化 = 当前章 ±1；回退模式 = 全部。
	 * 只搬 DOM，不读布局（随后的重排会统一布局一次）。
	 */
	private populatePagedContainer(): void {
		if (!this.columnsEl) return;
		if (this.windowedChapters()) {
			const range = activeWindowRange(this.activeChapterIdx, this.chapters.length, CHAPTER_WINDOW_RADIUS);
			// 强制 applyWindow 重新搬运（windowFrom/windowTo 可能与目标相同但节点在冷区）
			this.windowFrom = -1;
			this.windowTo = -2;
			this.applyWindow(range);
			return;
		}
		for (let i = 0; i < this.chapters.length; i++) this.moveChapterToWindow(i);
		this.windowFrom = 0;
		this.windowTo = Math.max(0, this.chapters.length - 1);
	}

	/**
	 * 把章节内容搬进"阅读窗口 > 多栏容器"，进入分页模式。
	 *
	 * 宿主重建（shim 被外部摘掉）时**优先复用仍在的旧子树**：内容都在章节节点里
	 * （可能在旧 columns / 冷区 / body），直接"复位引用 + 新建"会让书清零。
	 */
	private wrapPaged(): void {
		if (this.paged && this.paged.isConnected && this.columnsEl && this.endMarker) {
			this.populatePagedContainer();
			return;
		}
		const doc = this.doc;
		const body = doc?.body;
		if (!doc || !body) return;
		// 旧子树仍完整（只是被摘掉）：挂回去即可，绝不重建（否则内容丢失）
		if (this.paged && this.columnsEl && this.paged.contains(this.columnsEl)) {
			body.appendChild(this.paged);
			if (this.endMarker && this.endMarker.parentElement !== this.columnsEl) this.columnsEl.appendChild(this.endMarker);
			this.populatePagedContainer();
			return;
		}
		// 只有引用真的失效时才复位并新建
		this.paged = null;
		this.columnsEl = null;
		this.endMarker = null;
		const shim = doc.createElement("div");
		shim.className = "nyareader-book";
		const columns = doc.createElement("div");
		columns.className = "nyareader-columns";
		// 清理历史遗留的测量标记：同一个 id 出现两次时，getElementById 只会拿到第一个，
		// 于是"标记位移 → 页数"会读到错误的元素（表现为切模式后页数不对）。
		const strays = Array.from(doc.querySelectorAll(`[id="${END_MARKER_ID}"]`));
		for (const stray of strays) stray.remove();
		// 暂存区 / 冷区（都是 display:none）不参与搬移：否则它们会被塞进多栏容器里，
		// 里面待落盘的内容/章节会变成"永远不参与分栏的隐藏块"（内容丢失）。
		const stage = this.stageEl;
		if (stage && stage.parentElement === body) body.removeChild(stage);
		const cold = this.coldEl;
		if (cold && cold.parentElement === body) body.removeChild(cold);
		// 兜底：还没登记过的 body 直属内容（理论上 registerInitialContent 已处理）直接搬入
		if (!this.chapters.length) {
			while (body.firstChild) columns.appendChild(body.firstChild);
		}
		if (stage) body.appendChild(stage);
		if (cold) body.appendChild(cold);
		const marker = doc.createElement("span");
		marker.id = END_MARKER_ID;
		marker.className = "nyareader-end-marker";
		columns.appendChild(marker);
		shim.appendChild(columns);
		body.appendChild(shim);
		this.paged = shim;
		this.columnsEl = columns;
		this.endMarker = marker;
		this.lastMarkerLeft = null;
		// 新容器没有内联宽高：下一次重排必须重新下发几何
		this.geometryStale = true;
		this.populatePagedContainer();
	}

	/**
	 * 退出分页模式：把**所有章节按索引顺序**搬回 body 正常流。
	 *
	 * 滚动模式必须保持连续（用户不该觉得"内容变少了"），所以这里不看窗口，
	 * 一律按 `this.chapters` 的登记顺序重建 body 流；测量标记直接丢弃
	 * （重复 id 的标记会导致切回分页后页数读到错误元素）。
	 */
	private unwrapPaged(): void {
		const doc = this.doc;
		const body = doc?.body;
		if (!doc || !body) return;
		// 摘掉所有零宽测量标记（全局 + 逐章）
		const strays = Array.from(doc.querySelectorAll(`#${END_MARKER_ID}, .${CHAPTER_END_CLASS}`));
		for (const stray of strays) stray.remove();
		this.chapterEndMarkers.clear();
		const stage = this.stageEl;
		const cold = this.coldEl;
		// 按登记顺序搬回 body（章节节点可能在 columns / 冷区 / body 任意一处）
		if (this.chapters.length) {
			for (const slot of this.chapters) {
				for (const node of slot.nodes) if (node.parentNode !== body) body.appendChild(node);
			}
		} else if (this.columnsEl) {
			while (this.columnsEl.firstChild) body.appendChild(this.columnsEl.firstChild);
		}
		if (this.paged) this.paged.remove();
		if (cold && cold.parentElement === body) cold.remove();
		if (stage) body.appendChild(stage);
		this.paged = null;
		this.columnsEl = null;
		this.endMarker = null;
		this.windowFrom = 0;
		this.windowTo = this.chapters.length - 1;
		this.lastMarkerLeft = null;
	}

	/**
	 * 注入基础样式：主题/字号/行距 + 分页版式。
	 *
	 * 只维护同一个 <style> 元素：文本内容未变化时完全不写 DOM，
	 * 避免旧实现"每次 remove + create"引发的整篇文档重排。
	 */
	private applyBaseStyle(): void {
		const doc = this.doc;
		if (!doc) return;
		const css = this.buildBaseCss();
		if (css === this.lastStyleText && this.styleEl?.isConnected) return;
		if (!this.styleEl?.isConnected) {
			this.styleEl = doc.createElement("style");
			this.styleEl.id = "nyareader-style";
			doc.head.appendChild(this.styleEl);
		}
		this.styleEl.textContent = css;
		this.lastStyleText = css;
	}

	/**
	 * 滚动模式下的正文栏宽（px）。
	 *
	 * 取用户设置 pageWidth，并夹在「最小可读 / 最大舒适」区间内：
	 * - 旧默认 420px 在 900px 以上的窗口里一行只有约 27 个汉字，偏窄；
	 *   默认值已调整为 640px（约 40 汉字/行，接近业界 45–75 字符的舒适区）；
	 * - 上限 900px 防止超宽窗口出现一行 100+ 字符。
	 */
	private scrollMeasure(): number {
		return Math.max(280, Math.min(900, Math.round(this.settings.pageWidth)));
	}

	/**
	 * 滚动模式下渲染文档的背景色。
	 *
	 * 用户实测问题：**EPUB 滚动模式有一块"自己的白色/灰色背景"，与阅读区实际背景对不上**，
	 * 而 MOBI/AZW3 看起来正常。原因：渲染文档默认走 `THEME_CSS`（light 是写死的 `#f2f2f2`），
	 * 而分页模式的白/深色是书页本身（该保留）；滚动模式没有"书页"概念，就应该与阅读区同底。
	 *
	 * 规则：
	 * - 分页模式 → 保留主题色（书页感，`light` 为白）；
	 * - 滚动模式 → 默认主题（light）**用宿主 Obsidian 的 `--background-primary`**（随主题/明暗自动匹配）；
	 *   若取不到宿主颜色，则退回透明（由阅读区底色透出来，同样不会突兀）；
	 * - 用户显式选了 dark/sepia → 仍用该主题色（用户明确要的"纸感"）。
	 */
	private scrollModeBackground(): string {
		if (this.isPaged()) return "";
		if (this.settings.theme !== "light") return "";
		return this.hostTheme().background ?? "transparent";
	}

	/** 滚动模式下的正文前景色（同理，默认跟随宿主 `--text-normal`）。 */
	private scrollModeForeground(): string {
		if (this.isPaged()) return "inherit";
		if (this.settings.theme !== "light") return "inherit";
		return this.hostTheme().text ?? "inherit";
	}

	/**
	 * 从宿主（父文档）读取 Obsidian 主题变量。
	 *
	 * 取 `containerEl`（.nyareader-root，它在父文档里）的计算样式；
	 * 取不到（测试环境/脱离文档）时返回空对象，调用方退回透明/继承，
	 * 因此**不依赖**宿主一定提供变量。
	 */
	private hostTheme(): { background?: string; text?: string } {
		if (this.hostThemeCache) return this.hostThemeCache;
		let out: { background?: string; text?: string } = {};
		try {
			const el = this.container;
			const win = el?.ownerDocument?.defaultView;
			if (el && win) {
				const cs = win.getComputedStyle(el);
				const bg = cs.getPropertyValue("--background-primary").trim();
				const fg = cs.getPropertyValue("--text-normal").trim();
				out = { background: bg || undefined, text: fg || undefined };
			}
		} catch {
			out = {};
		}
		this.hostThemeCache = out;
		return out;
	}

	private hostThemeCache: { background?: string; text?: string } | null = null;

	/** 生成渲染文档的基础样式表（纯字符串，便于对比与审查）。 */
	private buildBaseCss(): string {		const paged = this.isPaged();
		const dark = this.settings.theme === "dark";
		const m = this.settings.margin;
		const lh = this.settings.lineHeight;
		// 滚动模式的背景色见顶部 bg 注释：默认主题跟随宿主，避免 iframe 灰底与阅读区背景对不上
		const bg = this.scrollModeBackground();
		const fg = this.scrollModeForeground();
		// 版式变量：滚动模式用设置里的 margin；分页模式由 relayoutPages 写入实测页宽/页高
		return `
			${THEME_CSS[this.settings.theme]}
			:root {
				--nyar-page-w: ${this.layout.pageWidth}px;
				--nyar-page-h: ${this.layout.pageHeight}px;
				--nyar-gutter: ${this.layout.gutter}px;
				--nyar-page-margin-x: ${this.layout.pageMarginX}px;
				--nyar-measure: ${this.scrollMeasure()}px;
				--nyar-img-max-h: calc(var(--nyar-page-h) - var(--nyar-page-margin-y) * 2 - ${IMAGE_HEIGHT_RESERVE}px);
				--nyar-page-margin-y: 14px;
			}
			html {
				font-size: ${this.effectiveFontSize()}px;
				overflow: ${paged ? "hidden" : "auto"};
				/* 滚动模式：背景跟随宿主主题（见 scrollModeBackground 注释），分页模式保留书页色 */
				${bg ? `background: ${bg};` : ""}
			}
			body {
				font-family: ${this.settings.fontFamily};
				line-height: ${lh};
				color: ${fg};
				margin: ${paged ? 0 : `${m}px auto`};
				/*
				 * 行宽上限（measure）：
				 * - 分页模式：页宽由多栏列宽决定，绝不能再加 max-width，否则内容挤在栏内一侧；
				 * - 滚动模式：用设置里的 pageWidth 作为正文栏宽并居中，
				 *   避免超宽窗口下一行 150+ 字符（旧实现没有这个约束）。
				 */
				max-width: ${paged ? "none" : `${this.scrollMeasure()}px`};
				overflow: ${paged ? "hidden" : "auto"};
				/* 长单词/URL 不撑破行宽（排版溢出的直接原因之一） */
				overflow-wrap: break-word;
				word-break: break-word;
			}
			${
				paged
					? ""
					: `
			/* 滚动模式：正文宽度严格等于设置里的 pageWidth（border-box + auto margin）。
			   只在「容器宽 < 栏宽 + 左右 margin」时补最多 24px 的左右呼吸空间，
			   避免"设置 640 却被 padding 撑到 664"的叠加问题。 */
			body { box-sizing: border-box; }
			@supports (padding: max(0px)) {
				body {
					padding-inline: max(0px, min(24px, calc((${this.scrollMeasure() + m * 2}px - 100%) / 2)));
				}
			}`
			}
			p { margin: 0 0 0.8em 0; }
			h1, h2, h3, h4 { break-after: avoid; }
			/* KF8 内嵌资源（kindle:embed:/flow:）无法在浏览器解析，隐藏避免破图 */
			img[src^="kindle:"], image[src^="kindle:"] { display: none; }
			a[href^="kindle:"] { pointer-events: none; }
			* { user-select: text; }
			/* 图片：等比缩放，既不溢出页宽也不超出页高；不再有"超限即隐藏"的策略 */
			img, svg, video, picture > img {
				max-width: 100% !important;
				height: auto !important;
				object-fit: contain;
			}
			/* 缺失资源：给可见占位而不是清空 src 造成空洞 */
			img.nyareader-img-missing {
				display: inline-block;
				min-width: 96px;
				min-height: 72px;
				background: ${dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)"};
				border: 1px dashed ${dark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.18)"};
			}
			/* 分页版式：阅读窗口 + 多栏（一栏一页） */
			.nyareader-book {
				position: absolute;
				left: 50%; top: 50%;
				transform: translate(-50%, -50%);
				overflow: hidden;
				background: ${dark ? "#212124" : "#ffffff"};
				box-shadow: 0 1px 10px rgba(0,0,0,${dark ? 0.4 : 0.12});
				padding: var(--nyar-page-margin-y) var(--nyar-page-margin-x);
				box-sizing: border-box;
			}
			.nyareader-columns {
				position: relative;
				/*
				 * 宽度必须是「步长 × 列数 − 一个槽宽」：浏览器只有在
				 * (width + gap) 能被 (pageWidth + gap) 整除时，实际列距才精确等于
				 * pageWidth + gap。旧实现写死 2000000px，在 2200px 窗口下每列多
				 * 0.951px，累积到末页右缘超出 219.69px 被 overflow:hidden 裁掉。
				 * 宽度与列数由 columnGridWidth()/columnGridCount()（paging-layout 纯函数）推导。
				 */
				width: var(--nyar-cols-width);
				height: 100%;
				/*
				 * column-width 必须显式给出（= 页宽）：只写 column-count 时浏览器会把
				 * 容器宽度按列数均分（2_000_000 / 10000 = 200px），与页宽无关，
				 * 一页里会塞进多个窄栏 —— 这是必须保留的一条，去掉即回归。
				 */
				column-width: var(--nyar-page-w);
				column-count: var(--nyar-cols-count);
				column-gap: var(--nyar-gutter);
				column-fill: auto;
				overflow-wrap: break-word;
				word-break: break-word;
			}
			/* 顶层元素不能超出页宽：避免 width:100% 被多栏容器(极宽)撑爆 */
			.nyareader-columns > * {
				max-width: var(--nyar-page-w) !important;
				box-sizing: border-box;
			}
			/* 零宽测量标记：必须完全不参与排版，只保留 offsetLeft 语义 */
			.nyareader-end-marker {
				display: block;
				width: 0;
				height: 0;
				max-width: 0 !important;
				margin: 0 !important;
				padding: 0 !important;
				border: 0;
				overflow: hidden;
			}
			/* 追加内容暂存区：display:none 子树没有布局对象 ——
			   往里追加不会触发任何布局/重排（task-7 增量追加的关键） */
			.nyareader-stage { display: none !important; }
			/* 冷区（不参与分栏的章节）与逐章测量标记：都是零成本节点 */
			.nyareader-cold { display: none !important; }
			.nyar-chapter-end {
				display: block;
				width: 0;
				height: 0;
				max-width: 0 !important;
				margin: 0 !important;
				padding: 0 !important;
				border: 0;
				overflow: hidden;
				break-inside: avoid;
			}
			/* 分页页内图片：用真实页高变量限高，避免固定 44px 余量算错导致裁切 */
			.nyareader-columns img {
				max-height: var(--nyar-img-max-h) !important;
				width: auto;
			}
			/* 超长内容不把页面顶出边界：pre 强制换行、表格限宽 */
			.nyareader-columns pre {
				white-space: pre-wrap;
				word-break: break-word;
			}
			.nyareader-columns table {
				max-width: 100% !important;
			}
			/* 避免页中断造成的"半行/孤行"难看断点 */
			.nyareader-columns p, .nyareader-columns li, .nyareader-columns blockquote,
			.nyareader-columns h1, .nyareader-columns h2, .nyareader-columns h3,
			.nyareader-columns h4, .nyareader-columns figure {
				break-inside: avoid;
			}
			.nyareader-columns img, .nyareader-columns figure, .nyareader-columns table {
				break-inside: avoid;
			}
		`;
	}

	// ---------- 分页重排 ----------

	/** 合并连续 resize 抖动；尺寸未变化时 relayoutPages 内部会直接返回。 */
	private scheduleRelayout(): void {
		if (!this.isPaged() || this.destroyed || !this.docReady) return;
		// 有待落盘的补章内容：交给落盘流程一次完成（不要额外多插一次整篇重排）
		if (this.stagedPending) {
			this.scheduleStageFlush();
			return;
		}
		if (this.relayoutRaf) return;
		this.relayoutRaf = window.requestAnimationFrame(() => {
			this.relayoutRaf = 0;
			this.relayoutPages(true, this.pendingForceRelayout, false, "resize");
			this.pendingForceRelayout = false;
		});
	}

	/**
	 * 分页重排：更新页尺寸、测量页数、还原当前页并定位。
	 *
	 * @param emit 是否广播进度变化
	 * @param force 尺寸未变化时也强制重新测量（内容追加/图片加载后需要）
	 * @param keepPage 保持当前页码而不是按"旧百分比 × 新页数"重算。
	 *   内容只在末尾追加时（后台补章）必须用 true：
	 *   否则每次补章都会把当前页按新总页数放大，读者会被"越读越往后跳"，
	 *   进度百分比也会跟着漂移。
	 * @param reason 触发原因（用于上报 RelayoutState，视图据此显示提示）
	 */
	private relayoutPages(emit: boolean, force = false, keepPage = false, reason: RelayoutReason = "resize"): void {
		if (!this.isPaged() || !this.doc || !this.docReady || !this.paged || !this.columnsEl) return;
		const vw = this.iframe?.clientWidth ?? 0;
		const vh = this.iframe?.clientHeight ?? 0;
		// 尺寸未就绪：不测量（旧实现在这里算出 pages=1，之后所有翻页都坏掉）
		if (vw < 40 || vh < 40) return;

		const next = computePageLayout({ viewWidth: vw, viewHeight: vh, double: this.isDouble() });
		const sameLayout =
			next.pageWidth === this.layout.pageWidth &&
			next.pageHeight === this.layout.pageHeight &&
			next.gutter === this.layout.gutter &&
			next.pageMarginX === this.layout.pageMarginX &&
			next.double === this.layout.double;
		if (sameLayout && !force && this.pages > 0) return;

		this.emitLayoutState({ busy: true, reason });
		const startedAt = this.nowMs();

		this.layout = next;
		// 版式（页宽/页高/字号）变了：标记位移不再与"追加"可比，重置增量测量基准
		if (!sameLayout) this.lastMarkerLeft = null;
		// 只有几何真的变化（或容器刚重建）才写 CSS 变量/书窗尺寸。
		//
		// 为什么关键：--nyar-page-w / --nyar-cols-width 这些变量被整棵子树使用，
		// 对 documentElement **重复写同一个值**也会让浏览器重新做样式解析，
		// 进而在"纯末尾追加"这种几何没变的场景里白白触发一次整篇布局。
		// 补章落盘只需要"对新内容做布局"，不需要重新下发几何。
		if (!sameLayout || this.geometryStale) {
			const root = this.doc.documentElement;
			root.style.setProperty("--nyar-page-w", `${next.pageWidth}px`);
			root.style.setProperty("--nyar-page-h", `${next.pageHeight}px`);
			root.style.setProperty("--nyar-gutter", `${next.gutter}px`);
			root.style.setProperty("--nyar-page-margin-x", `${next.pageMarginX}px`);
			// 栏容器宽度/列数随步长变化：宽度必须与 (pageWidth+gutter) 整除，否则列距漂移
			root.style.setProperty("--nyar-cols-width", `${columnGridWidth(next)}px`);
			root.style.setProperty("--nyar-cols-count", String(columnGridCount(next)));
			this.paged.style.width = `${next.bookWidth + next.pageMarginX * 2}px`;
			this.paged.style.height = `${next.bookHeight}px`;
			this.geometryStale = false;
		}

		const prevPct = this.pages > 0 ? (this.currentPage - 0.5) / this.pages : 0;
		const prevPage = this.currentPage;
		const prevPages = this.pages;
		// 页数：窗口化分页 = 只测活动窗口那几章 + 其余章节按字符插值（task-10）；
		// 否则 = 整篇测量（旧行为，页数精确）。
		this.pages = this.windowedChapters() ? this.refreshWindowPagination() : this.measurePages();
		if (keepPage && prevPages > 0) {
			this.currentPage = clampPage(prevPage, this.pages);
		} else {
			this.currentPage = this.pages > 0 ? clampPage(Math.round(prevPct * this.pages) || 1, this.pages) : 1;
		}
		this.currentPage = alignSpreadPage(this.currentPage, next.double);
		this.activeChapterIdx = this.windowedChapters() ? chapterForPage(this.currentPage, this.pageOffsets()).chapter : this.activeChapterIdx;
		this.positionColumns();
		const elapsed = this.nowMs() - startedAt;
		this.lastRelayoutMs = elapsed;
		this.emitLayoutState({ busy: false, reason, elapsedMs: elapsed });
		// 重排完成点（stream-f 指定的挂载位置）：字号/行距/单双页/尺寸/补章落盘都会走到这里，
		// 此时正文 DOM 已就位，重新解析并重绘高亮 —— 这是"改字号/切单双页后高亮不丢"的保证。
		this.refreshHighlights();
		if (emit) this.emitProgress();
	}

	private nowMs(): number {
		return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
	}

	/** 上报重排状态（视图层"正在重新排版…"）；回调异常不影响引擎。 */
	private emitLayoutState(state: RelayoutState): void {
		const handler = this.layoutStateHandler;
		if (!handler) return;
		try {
			handler(state);
		} catch {
			/* 视图层问题不阻塞重排 */
		}
	}

	/**
	 * 测量总页数：O(1)，并顺带给出**增量**（相对上一次测量新增的页数）。
	 *
	 * 末尾零宽标记落在最后一列，它的 offsetLeft 除以"页宽+槽宽"即最后一列的序号。
	 * 注意：offsetLeft 是相对 offsetParent（.nyareader-columns，position:relative）的，
	 * 不受父级 transform 影响，所以不需要像旧实现那样"把 transform 置空再还原"。
	 * offsetParent 缺失时用 getBoundingClientRect 兜底（等价算术）。
	 *
	 * 关键成本说明（task-7 根因）：这个方法本身是 O(1) 的读数，但**读它会触发
	 * 整篇文档的同步布局** —— 所以"多久读一次"才是性能的决定因素：
	 * 旧实现每批补章都读一次（= 每批一次整篇布局，50 批线性叠加成秒级卡顿），
	 * 现在只在"落盘/版式变更/尺寸变化"时读一次。
	 */
	private measurePagesIncremental(): { pages: number; added: number } {
		const cols = this.columnsEl;
		const marker = this.endMarker;
		if (!cols || !marker) return { pages: 1, added: 0 };
		let markerLeft: number;
		if (marker.offsetParent === cols) {
			markerLeft = marker.offsetLeft;
		} else {
			markerLeft = marker.getBoundingClientRect().left - cols.getBoundingClientRect().left;
		}
		// 标记位于内容末尾之后：若内容正好排满整列，标记会落到下一列，
		// 此时它自身所在列就是内容占用后的"下一页"。因此用 round 而非 floor，
		// 并把"标记恰好落在列首"的情况也算作该列（见 paging-layout 单测）。
		const pages = pageCountFromMarker(markerLeft, this.layout);
		const prev = this.lastMarkerLeft;
		const added = prev === null ? 0 : appendedPageCount(prev, markerLeft, this.layout);
		this.lastMarkerLeft = markerLeft;
		this.pagesAddedLastMeasure = added;
		return { pages, added };
	}

	/** 测量总页数（O(1) 读数 + 增量信息）。 */
	private measurePages(): number {
		return this.measurePagesIncremental().pages;
	}

	/** 按当前页把对应列移入阅读窗口（窗口化分页时用"窗口内页号"）。 */
	private positionColumns(): void {
		if (!this.columnsEl) return;
		const page = this.windowedChapters() ? this.pageInWindow(this.currentPage) : this.currentPage;
		this.columnsEl.style.transform = `translateX(${columnOffsetPx(page, this.layout)}px)`;
	}

	/**
	 * 定位到某页（翻页/跳转共用）。双页模式下左页恒为奇数。
	 *
	 * 按章独立分页（task-10）：若目标页落在活动窗口之外，先把那一章激活
	 * （一次重排 + 一次高亮重放），再按"章内页号"定位 —— 这样翻页跨越章边界时
	 * 只会付出"重排 2–3 章"的成本，而不是整本书。
	 */
	private showPage(page: number, emit = true): void {
		// 翻页/跳转前先落地"待做的重排 + 待落盘的补章"：页码与总页数必须是最新的
		this.runPendingSettingsRelayout();
		this.flushPendingContent();
		if (this.pages < 1 || !this.columnsEl) {
			this.currentPage = Math.max(1, page);
			return;
		}
		let target = alignSpreadPage(clampPage(page, this.pages), this.layout.double);
		if (this.windowedChapters()) {
			const { chapter, pageInChapter } = chapterForPage(target, this.pageOffsets());
			this.activeChapterIdx = chapter;
			if (chapter < this.windowFrom || chapter > this.windowTo) {
				// 跨章：激活目标章（内部完成一次重排与逐章测量），再重算全局页号
				this.ensureWindow(chapter);
				target = alignSpreadPage(pageForChapter(chapter, pageInChapter, this.pageOffsets()), this.layout.double);
			}
		}
		this.currentPage = clampPage(target, this.pages);
		this.positionColumns();
		if (emit) this.emitProgress();
	}

	/**
	 * 滚动模式：↑/↓ 方向键滚动一个"鼠标滚轮档"。
	 *
	 * 手感约定（用户要求）：
	 * - **↑/↓ = 小范围滚动**（像滚轮滚一格，约 3 行文本，并夹住最大值）；
	 * - **←/→ = 大范围翻页**（换页/翻一屏，由 nextPage/prevPage 处理，见 onContentKeydown）。
	 *
	 * 旧实现只滚"一行"（fontSize × lineHeight ≈ 32px），实际手感几乎没动，用户会以为按键失灵。
	 */
	scrollStep(direction: 1 | -1): void {
		const win = this.iframe?.contentWindow;
		if (!win) return;
		const linePx = Math.max(1, this.effectiveFontSize() * this.settings.lineHeight);
		// 一个滚轮档 ≈ 3 行（与浏览器 wheel deltaY≈100px 的手感一致）
		const step = linePx * 3;
		win.scrollBy({ top: direction * step, behavior: "auto" });
	}

	getSelection(): { text: string; target?: AnnotationTarget } | null {
		const win = this.iframe.contentWindow;
		if (!win) return null;
		const sel = win.getSelection();
		if (!sel || sel.isCollapsed) return null;
		const text = normalizeSelectionText(sel.toString());
		if (!text) return null;
		const rects: AnnotationTarget["rects"] = [];
		for (let i = 0; i < sel.rangeCount; i++) {
			for (const r of Array.from(sel.getRangeAt(i).getClientRects())) {
				if (r.width && r.height) rects.push({ left: r.left, top: r.top, width: r.width, height: r.height });
			}
		}
		return {
			text,
			target: { location: this.currentLocation(), rects, selectedText: text },
		};
	}

	async showAnnotation(target: AnnotationTarget): Promise<void> {
		await this.goTo(target.location);
	}

	// ---------- 可见高亮 API（IReaderEngine 可选方法，批注 P0） ----------

	/**
	 * 全量设置高亮（打开书/重开书/增删改后调用）。
	 *
	 * 每条锚点按「章节锚点 + 章内字符区间 → 文本指纹 → 整篇指纹 → 进度兜底」解析；
	 * 解析结果通过 {@link getHighlightPlacements} 暴露（含降级原因），不静默失败。
	 */
	setHighlights(list: readonly EngineHighlight[]): void {
		const layer = this.ensureHighlightLayer();
		if (!layer) return;
		layer.setHighlights(list);
	}

	addHighlight(highlight: EngineHighlight): void {
		this.ensureHighlightLayer()?.addHighlight(highlight);
	}

	removeHighlight(id: string): void {
		this.ensureHighlightLayer()?.removeHighlight(id);
	}

	/** 点击高亮 → UI 打开编辑（CSS Highlight 路径下由 Mark 层用坐标做命中测试）。 */
	setHighlightClickHandler(handler: (id: string) => void): void {
		this.highlightClickHandler = handler;
		this.highlightLayer?.setClickHandler(handler);
	}

	/** 最近一次定位结果（`exact-range`/`quote-unique`/`quote-first`/`progression-only`）。 */
	getHighlightPlacements(): readonly EngineHighlightPlacement[] {
		return this.highlightLayer?.placements() ?? [];
	}

	/**
	 * 用当前选区生成锚点草稿（EPUB/MOBI 的结构定位 = 章节锚点 + 章内 UTF-16 偏移）。
	 *
	 * 章节锚点形如 `nyareader-epub-3`（EPUB）/ `nyareader-mobi-3`（MOBI），
	 * 与 {@link highlightRegions} 的区域 key 一致，因此定位时能直接命中。
	 * 拿不到章节信息时自述 `approximate`，由 Controller 决定如何降级。
	 */
	getSelectionAnchor(): SelectionAnchorDraft | null {
		const win = this.iframe?.contentWindow;
		if (!win) return null;
		const sel = win.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
		const range = sel.getRangeAt(0);
		const text = normalizeSelectionText(sel.toString());
		if (!text) return null;
		const startRegion = this.regionOfNode(range.startContainer);
		const endRegion = this.regionOfNode(range.endContainer) ?? startRegion;
		const progression = this.currentPercentage();
		if (!startRegion) {
			// 结构信息缺失（例如选区落在非正文节点上）：只给指纹 + 进度
			return { kind: "chapter", primary: this.currentLocation(), quote: quoteFromText(text), progression, text, approximate: true };
		}
		const regionText = startRegion.nodes.map((n) => n.textContent ?? "").join("");
		const charStart = this.offsetInNodes(startRegion, range.startContainer, range.startOffset);
		const sameRegion = endRegion === startRegion;
		const charEnd = sameRegion ? this.offsetInNodes(startRegion, range.endContainer, range.endOffset) : null;
		const quote =
			charStart !== null && charEnd !== null && charEnd > charStart
				? buildTextQuote(regionText, charStart, charEnd)
				: quoteFromText(text);
		const draft: SelectionAnchorDraft = {
			kind: "chapter",
			primary: startRegion.key,
			quote,
			progression,
			text,
		};
		if (charStart !== null && charEnd !== null && charEnd > charStart) {
			draft.charStart = charStart;
			draft.charEnd = charEnd;
		}
		draft.paraIndex = startRegion.paraIndex;
		if (charStart === null) draft.approximate = true;
		return draft;
	}

	/** 按"章节锚点 + 章内偏移"生成 Range；拿不到章节信息时返回 null（交给 Controller 降级）。 */
	private regionOfNode(node: Node | null): HighlightRegion | null {
		if (!node) return null;
		for (const region of this.highlightRegions()) {
			for (const root of region.nodes) {
				if (root === node || root.contains(node)) return region;
			}
		}
		return null;
	}

	/** 节点在"区域节点序列拼接文本"里的 UTF-16 偏移。 */
	private offsetInNodes(region: HighlightRegion, node: Node, nodeOffset: number): number | null {
		let acc = 0;
		for (const root of region.nodes) {
			if (root === node) return acc + nodeOffset;
			if (!root.contains(node)) {
				acc += root.textContent?.length ?? 0;
				continue;
			}
			const doc = this.doc;
			if (!doc) return null;
			const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			while (walker.nextNode()) {
				const t = walker.currentNode as Text;
				if (t === node) return acc + nodeOffset;
				acc += t.data.length;
			}
			return null;
		}
		return null;
	}

	/** 懒建高亮层（mount 之后 `doc` 才存在）。 */
	private ensureHighlightLayer(): HighlightLayer | null {
		if (!this.doc?.body) return null;
		if (!this.highlightLayer) {
			this.highlightLayer = new HighlightLayer({
				regions: () => this.highlightRegions(),
				documentRoot: () => this.liveHost() ?? this.doc!.body,
				structureStamp: () => this.highlightStamp,
				goToProgression: (progression) => this.goToFraction(progression),
			});
			if (this.highlightClickHandler) this.highlightLayer.setClickHandler(this.highlightClickHandler);
		}
		return this.highlightLayer;
	}

	/**
	 * 可定位区域 = 章节锚点分割出的顶层块序列。
	 *
	 * 为什么这样切：EPUB/MOBI 的正文是多栏容器里的**扁平**子节点，
	 * 章节边界靠 `<span id="nyareader-epub-N">` / `nyareader-mobi-N` 标记；
	 * 区域 = 从该标记起、到下一个标记前的所有同级节点（含标记自身，其文本为空）。
	 */
	private highlightRegions(): HighlightRegion[] {
		const host = this.liveHost();
		const doc = this.doc;
		if (!host || !doc) return [];
		const regions: HighlightRegion[] = [];
		let current: HighlightRegion | null = null;
		for (const child of Array.from(host.childNodes)) {
			if (child.nodeType === 1) {
				const el = child as HTMLElement;
				const id = el.id;
				const isChapterAnchor = /^nyareader-(epub|mobi)-\d+$/.test(id);
				if (isChapterAnchor) {
					if (current) regions.push(current);
					current = { key: id, nodes: [el], paraIndex: regions.length };
					continue;
				}
				// 多栏容器里的测量标记/暂存区不属于任何章节
				if (el.id === END_MARKER_ID || el.classList?.contains("nyareader-stage")) continue;
			}
			if (current) current.nodes.push(child);
		}
		if (current) regions.push(current);
		return regions;
	}

	/**
	 * 结构变化后让高亮层丢缓存并重新解析（无高亮时是零成本空操作）。
	 *
	 * **公开**：引擎自己会在重排/补章/切模式后调用它；按章布局/冷区章节激活一类的
	 * 外部结构调整也必须调一次（见 IReaderEngine.refreshHighlights）。
	 */
	refreshHighlights(): void {
		this.highlightStamp++;
		this.highlightLayer?.refresh();
	}

	/** 跳到某条高亮（面板"跳转"用）：能解析就滚到命中处，否则按进度兜底。 */
	focusHighlight(id: string): void {
		this.highlightLayer?.focus(id);
	}

	// ---------- 资源（zip 图片）按需解析 ----------

	/**
	 * 把文档里 data-nyar-asset 登记的图片解析为 blob: URL 并回填 src。
	 * 解析完成后强制重排一次（图片有了真实尺寸，页数可能变化）。
	 *
	 * 未注入 resolver 时也要给可见占位：否则这些 img 既没有 src 也没有占位样式，
	 * 在页面上表现为"图片凭空消失"（用户报告的问题之一）。
	 */
	private async resolvePendingAssets(): Promise<void> {
		const doc = this.doc;
		if (!doc) return;
		const pending = Array.from(doc.querySelectorAll<HTMLImageElement>("img[data-nyar-asset]"));
		if (!pending.length) return;
		const resolve = this.opts.resolveAsset;
		if (!resolve) {
			for (const img of pending) img.classList.add("nyareader-img-missing");
			return;
		}
		let applied = false;
		for (const img of pending) {
			const path = img.dataset.nyarAsset;
			if (!path) continue;
			img.removeAttribute("data-nyar-asset");
			const url = await this.resolveAssetOnce(path);
			if (this.destroyed) return;
			if (url) {
				img.src = url;
				img.classList.remove("nyareader-img-missing");
				applied = true;
			} else {
				img.classList.add("nyareader-img-missing");
			}
		}
		if (applied) this.pendingForceRelayout = true;
		if (this.isPaged()) this.scheduleRelayout();
	}

	private resolveAssetOnce(path: string): Promise<string | null> {
		const cached = this.assetTasks.get(path);
		if (cached) return cached;
		const task = (async () => {
			try {
				return (await this.opts.resolveAsset?.(path)) ?? null;
			} catch {
				return null;
			}
		})();
		this.assetTasks.set(path, task);
		return task;
	}

	private emitProgress(): void {
		this.emitter.emit("locationChanged", { location: this.currentLocation(), percentage: this.currentPercentage() });
	}

	destroy(): void {
		this.destroyed = true;
		this.unmount();
		this.emitter.clear();
	}
}
