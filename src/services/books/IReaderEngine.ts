/**
 * 阅读引擎统一接口。
 * 各格式（EPUB/PDF/MOBi/AZW3/TXT）实现此接口，视图层只与接口通信，
 * 保证引擎可替换、可单测。
 */
import type { BookModel, ReaderSettings, RelayoutState } from "../../types";
import type { HighlightColor } from "../annotations/AnnotationModel";
import type { AnchorKind, AnchorLocateQuality, AnnotationAnchor, TextQuote } from "../annotations/AnnotationAnchor";

/** 缩放模式：适应宽度 / 适应高度 / 自定义百分比 */
export type ZoomMode = "fit-width" | "fit-height" | "custom";

/** 引擎能力声明（视图层据此决定显示哪些控件，缺省视为不支持） */
export interface ReaderEngineCapabilities {
	/** 支持缩放 */
	zoom?: boolean;
	/** 支持按页导航（PDF 等分页格式） */
	pageNav?: boolean;
	/** 支持在滚动/分页两种模式间切换（EPUB/MOBI/AZW3/TXT 等文档式格式） */
	modeSwitch?: boolean;
	/** 支持单页/双页（双栏）布局切换（HTML 渲染的文档式格式） */
	layoutSwitch?: boolean;
}

/** 渲染引擎对外暴露的最小事件集合 */
export interface ReaderEngineEvents {
	/** 位置变化（翻页/滚动/跳转后触发），用于保存进度 */
	locationChanged: { location: string; percentage: number };
	/** 用户产生文本选区 */
	selection: { text: string; rect?: DOMRect };
	/** 渲染出错 */
	error: { message: string };
	/** 缩放变化（支持缩放的引擎发出），用于同步工具栏百分比显示 */
	zoomChanged: { mode: ZoomMode; percent: number };
}

export type ReaderEngineEventName = keyof ReaderEngineEvents;

export interface ReaderEngineEventListener {
	on<E extends ReaderEngineEventName>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void;
	off<E extends ReaderEngineEventName>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void;
}

/** 批注定位：引擎内唯一标识一个位置（如 CFI 或页码+quadpoints） */
export interface AnnotationTarget {
	/** 引擎内部定位符 */
	location: string;
	/** 页面内矩形（视口坐标系，用于定位/高亮） */
	rects?: Array<{ left: number; top: number; width: number; height: number }>;
	/** 高亮覆盖文本 */
	selectedText?: string;
	/**
	 * 生成 rects 时的 viewport 缩放比（CSS px / PDF pt）。
	 * 可选，用于缩放后按比例还原 overlay 高亮位置；旧数据缺省时按当前缩放显示。
	 */
	scale?: number;
}

/**
 * 引擎高亮输入：全量重放（`setHighlights`）与增量（`addHighlight`）共用同一形状。
 * 锚点是三层冗余模型（结构定位 + 文本指纹 + 进度兜底），见 `AnnotationAnchor`。
 */
export interface EngineHighlight {
	id: string;
	anchor: AnnotationAnchor;
	color: HighlightColor;
	hasNote: boolean;
	text: string;
}

/**
 * 单条高亮的实际定位结果 —— **降级链必须可观测**：
 * `quality` 取值 `exact-range` / `quote-unique` / `quote-first` / `progression-only`，
 * UI 据此把 `approximate` 的条目标出"位置可能不准"（不允许静默吞掉失败）。
 */
export interface EngineHighlightPlacement {
	id: string;
	quality: AnchorLocateQuality;
	approximate: boolean;
	reason: string;
	/**
	 * 是否已真的画出来。
	 * `false` 表示目标章节/段落当前不在 DOM 里（懒加载补章中 / TXT 虚拟窗口外），
	 * 补章或滚动回该处后会重新应用 —— 这不是"位置不准"，所以与 `approximate` 分开表达。
	 */
	rendered?: boolean;
}

/**
 * 选区锚点草稿：**引擎最懂 DOM**，由它给出章节/块锚点 + 字符区间 + 指纹前后文；
 * `quote` 由 Controller/引擎用同一套归一化函数补全（见 `AnnotationAnchor`）。
 */
export interface SelectionAnchorDraft {
	kind: AnchorKind;
	primary: string;
	charStart?: number;
	charEnd?: number;
	paraIndex?: number;
	cssSelector?: string;
	progression?: number;
	quote?: TextQuote;
	/** 选中原文（拿不到结构化 quote 时兜底 exact） */
	text?: string;
	/** 引擎自述结构信息缺失（只能靠指纹/进度兜底） */
	approximate?: boolean;
}

export interface IReaderEngine {
	readonly format: string;
	/** 挂载到容器；容器尺寸变化时引擎应自动重排 */
	mount(container: HTMLElement): void;
	unmount(): void;
	/** 渲染指定位置（打开书/跳转） */
	goTo(location: string): void;
	nextPage(): void;
	prevPage(): void;
	/** 当前定位符（用于保存进度） */
	currentLocation(): string;
	/** 相对进度 0~1 */
	currentPercentage(): number;
	/** 应用版式设置（字体/字号/行距/主题/单双栏/滚动模式） */
	applySettings(settings: ReaderSettings): void;
	/** 获取当前选中文本及定位，供批注/翻译使用 */
	getSelection(): { text: string; target?: AnnotationTarget } | null;
	/** 在指定位置创建可见高亮（批注跳转用），返回是否成功 */
	showAnnotation(target: AnnotationTarget): void;
	/** 可选：隐藏指定批注的可见高亮（删除批注时用） */
	hideAnnotation?(target: AnnotationTarget): void;
	/**
	 * 可选：**全量设置高亮**（打开书/重开书/增删改后调用）。
	 * 引擎按 `anchor` 解析可见范围（结构定位 → 文本指纹 → 进度兜底）；
	 * 解析失败只按 `progression` 跳转、不抛异常，并把原因写入 {@link getHighlightPlacements}。
	 */
	setHighlights?(list: readonly EngineHighlight[]): void;
	/** 可选：增量添加一条高亮（不必全量重放） */
	addHighlight?(highlight: EngineHighlight): void;
	/** 可选：移除一条高亮 */
	removeHighlight?(id: string): void;
	/**
	 * 可选：点击高亮 → UI 显示就地小菜单（CSS Custom Highlight API 路径下由引擎自建命中检测）。
	 *
	 * `click` 为**父文档视口坐标**（引擎负责从 iframe 坐标系换算），UI 据此把菜单放在高亮旁；
	 * 换算不出来时为 undefined，UI 回退到 `getHighlightRect()`。
	 */
	setHighlightClickHandler?(handler: (id: string, click?: { x: number; y: number }) => void): void;
	/**
	 * 可选：某条高亮当前的矩形（**父文档视口坐标**；未渲染或不在布局区时为 null）。
	 * 用于把就地小菜单定位到高亮处。
	 */
	getHighlightRect?(id: string): { left: number; top: number; width: number; height: number } | null;
	/** 可选：最近一次定位的降级结果（UI 标注"位置可能不准"） */
	getHighlightPlacements?(): readonly EngineHighlightPlacement[];
	/**
	 * 可选：**内容/布局结构变化后重新解析并重绘高亮**。
	 *
	 * 引擎自己会在重排/补章/切模式后调用；外部（例如"按章独立分页"把章节移入布局区、
	 * 或激活某个冷区章节之后）也必须调一次，否则那些章节里的高亮不会自动出现。
	 */
	refreshHighlights?(): void;
	/** 可选：跳到某条高亮（能解析就滚到命中处，否则按 `progression` 兜底） */
	focusHighlight?(id: string): void;
	/** 可选：用当前选区生成锚点草稿（引擎提供章节/段落 + 字符偏移 + 前后文） */
	getSelectionAnchor?(): SelectionAnchorDraft | null;
	/** 获取需要加载的附加资源（pdf worker 等），由主插件统一初始化 */
	on<E extends ReaderEngineEventName>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void;
	off<E extends ReaderEngineEventName>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void;
	/** 可选：引擎能力；视图层据此决定工具栏显示哪些控件 */
	readonly capabilities?: ReaderEngineCapabilities;
	/** 可选：设置缩放（支持缩放的引擎实现） */
	setZoom?(mode: ZoomMode, value?: number): void;
	/** 可选：读取当前缩放状态 */
	getZoom?(): { mode: ZoomMode; scale: number; percent: number };
	/** 可选：分页式显示时的总页数（滚动式格式在分页模式下用） */
	getTotalPages?(): number;
	/**
	 * 可选：`getTotalPages()` 是否为**估计值**。
	 *
	 * 按章独立分页后，只有"当前章 ±1"参与真实分栏布局，其余章节的页数按字符数插值
	 * （实测偏差约 +6%，随阅读逐章收敛）。调用方据此在页码上标 `≈`，
	 * 避免把估计值当成精确值展示。
	 */
	isPageCountEstimated?(): boolean;
	/**
	 * 可选：当前是否处于**分页**模式（false = 连续滚动模式）。
	 *
	 * 为什么不能只看 `capabilities.pageNav`：`pageNav` 是"这个引擎是否**能**分页"的静态能力，
	 * 而按键路由需要知道"**现在**是不是分页"。两者混用会让 EPUB/MOBI/AZW3 在滚动模式下
	 * 把 ↑/↓ 当成翻页（因为它们的 pageNav 恒为 true），于是"逐行滚动"永远走不到。
	 */
	isPagedMode?(): boolean;

	/** 可选：在滚动/分页模式间切换并保持当前阅读位置（文档式格式实现） */
	switchMode?(scrollMode: boolean): void;
	/** 可选：按方向键逐行滚动（滚动模式下 ↑/↓ 用；方向 1=向下，-1=向上） */
	scrollStep?(direction: 1 | -1): void;
	/**
	 * 可选：文档式引擎的"追加内容"入口（大文件分章懒加载用）。
	 * 实现方负责把 html 追加到正文末尾、必要时重排并保持当前阅读位置；
	 * 未实现时调用方必须用可选链安全跳过。
	 */
	notifyContentAppended?(html: string): void;
	/**
	 * 可选：按**文档内相对进度**（0~1）跳转，用于底部可拖动进度条。
	 *
	 * 与 goTo(location) 的区别：这里的入参语义与 currentPercentage() 严格互逆，
	 * 不依赖"总页数已知"，因此在大文件只加载了部分内容时也能正确定位。
	 * 未实现时调用方退回 goTo(百分比定位符)。
	 */
	goToFraction?(fraction: number): void;
	/**
	 * 可选：注册「正在重新排版」状态回调（大文件改字号/版式时用于给出反馈）。
	 * 引擎应在阻塞性重排**开始前**发 busy:true、结束后发 busy:false（带耗时）。
	 */
	setLayoutStateHandler?(handler: (state: RelayoutState) => void): void;
	destroy(): void;
}

/** 轻量事件发射器实现，供各引擎复用。 */
export class SimpleReaderEmitter implements ReaderEngineEventListener {
	private listeners = new Map<ReaderEngineEventName, Set<(payload: never) => void>>();

	on<E extends ReaderEngineEventName>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(handler as (payload: never) => void);
	}

	off<E extends ReaderEngineEventName>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void {
		this.listeners.get(event)?.delete(handler as (payload: never) => void);
	}

	emit<E extends ReaderEngineEventName>(event: E, payload: ReaderEngineEvents[E]): void {
		this.listeners.get(event)?.forEach((h) => h(payload as never));
	}

	clear(): void {
		this.listeners.clear();
	}
}


