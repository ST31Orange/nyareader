/**
 * 高亮渲染层：把「锚点 → 可见高亮」这件事从引擎里抽出来，做成一个**与具体引擎无关**的模块
 * （HtmlDocEngine 的 iframe 文档、TxtEngine 的虚拟滚动段落都能用同一套实现）。
 *
 * ## 渲染方案（依据 `docs/annotation-research.md` §4.3）
 * - **主方案**：CSS Custom Highlight API（`new Highlight(range)` + `CSS.highlights.set(...)`）。
 *   它**不改 DOM**，因此不影响引擎自己的分页测量 / 虚拟滚动 / 划词与翻译；
 * - **降级方案**：包裹 `<span class="nyar-hl" data-nyar-hl-id>`（浏览器不支持时）。
 *   包裹会切分文本节点但**不改变文本本身**，字符偏移语义保持稳定；
 *   每次重绘前会先 unwrap，避免嵌套包裹。
 *
 * ## "高亮不丢"的机制
 * 本层只保存**锚点**，不保存 DOM 引用：每次 `refresh()` 都从当前 DOM 重新解析
 * （结构定位 → 文本指纹 → 进度兜底）。所以改字号、切单双页、切滚动/分页、
 * 后台补章导致的重排之后，只要 `refresh()` 被调用，高亮就会回到同一句话上。
 *
 * ## 降级链可观测
 * 每条高亮的解析结果都记在 {@link placements} 里（`exact-range` / `quote-unique` /
 * `quote-first` / `progression-only` + `rendered`），UI 据此标注"位置可能不准"，
 * **不允许静默吞掉定位失败**。
 */
import { locateInText, type AnnotationAnchor } from "../../../annotations/AnnotationAnchor";
import type { HighlightColor } from "../../../annotations/AnnotationModel";
import type { EngineHighlight, EngineHighlightPlacement } from "../../IReaderEngine";

/** 一个可定位区域：EPUB/MOBI 一章通常由若干顶层节点组成；TXT 是一段。 */
export interface HighlightRegion {
	/** 稳定 key：与 `anchor.primary` 对应（章节锚点 id / 段落索引字符串） */
	key: string;
	/** 该区域在文档顺序上的根级节点（可多个） */
	nodes: Node[];
	/** 段落索引（TXT 段落 / EPUB 顶层块序号）；用于 `anchor.paraIndex` 快速定位 */
	paraIndex?: number;
}

/** 宿主引擎提供的最小上下文。 */
export interface HighlightHost {
	/** 当前 DOM 里的可定位区域（按文档顺序） */
	regions(): HighlightRegion[];
	/** 整篇正文根节点（跨章节指纹搜索的兜底）；不可用时返回 null */
	documentRoot(): Node | null;
	/**
	 * 结构版本号：追加章节 / 切模式 / 重建容器后必须变化。
	 * 用于丢弃缓存的区域文本与整篇文本索引（避免读到过期内容）。
	 */
	structureStamp?(): number;
	/** 进度兜底跳转（只在用户显式跳转时调用） */
	goToProgression(progression: number): void;
}

/** 六色背景（不透明度过低看不清，过高盖住文字）。 */
const COLOR_BG: Record<HighlightColor, string> = {
	yellow: "rgba(255, 226, 92, 0.55)",
	green: "rgba(126, 231, 152, 0.55)",
	blue: "rgba(126, 187, 255, 0.55)",
	pink: "rgba(255, 158, 194, 0.55)",
	purple: "rgba(196, 160, 255, 0.55)",
	orange: "rgba(255, 196, 120, 0.6)",
};

const COLOR_UNDERLINE: Record<HighlightColor, string> = {
	yellow: "#d9b800",
	green: "#1f9d4d",
	blue: "#2f6fd0",
	pink: "#d0447c",
	purple: "#7b52d3",
	orange: "#c97a12",
};

/**
 * 只声明本层用到的成员：TS 的 lib.dom 对 `Highlight` / `HighlightRegistry` 的声明不完整
 * （运行时它们分别是 `Set<AbstractRange>` 与 `Map<string, Highlight>`），
 * 所以这里用**结构化类型**，避免为了类型补丁去污染全局。
 */
interface NyarHighlight {
	add(range: AbstractRange): void;
	clear(): void;
}

interface NyarHighlightRegistry {
	set(name: string, value: NyarHighlight): void;
	delete(name: string): void;
}

/** CSS Custom Highlight API 的能力探测（iframe 内用自己的 window/CSS）。 */
interface HighlightCapableWindow {
	Highlight?: new () => NyarHighlight;
	CSS?: { highlights?: NyarHighlightRegistry };
}

interface DocIndex {
	text: string;
	spans: Array<{ node: Text; start: number; end: number }>;
}

/** 已渲染的高亮片段：记录坐标系（区域内偏移 / 整篇偏移），用于命中测试与跳转。 */
interface ResolvedEntry {
	id: string;
	space: "region" | "doc";
	regionKey: string;
	start: number;
	end: number;
}

export class HighlightLayer {
	private doc: Document;
	private win: Window;
	private styleEl: HTMLStyleElement | null = null;
	private highlightCtor: HighlightCapableWindow["Highlight"] | null = null;
	private registry: NyarHighlightRegistry | null = null;
	private highlightsByColor = new Map<HighlightColor, NyarHighlight>();
	private items: EngineHighlight[] = [];
	private placementsById = new Map<string, EngineHighlightPlacement>();
	private order: string[] = [];
	private resolved: ResolvedEntry[] = [];
	private regionIndex = new Map<string, HighlightRegion>();
	private regionsCache: HighlightRegion[] = [];
	private textCache = new Map<string, string>();
	private docIndex: DocIndex | null = null;
	private stamp = -1;
	private clickHandler: ((id: string, click?: { x: number; y: number }) => void) | null = null;
	/** 渲染坐标系 → 父文档视口的偏移提供者（iframe 场景必需；同文档返回 null） */
	private offsetProvider: (() => { x: number; y: number } | null) | null = null;
	private disposed = false;

	private onDocClick = (e: MouseEvent): void => this.handleClick(e);

	constructor(private host: HighlightHost) {		const root = host.documentRoot();
		this.doc = root?.ownerDocument ?? document;
		this.win = (this.doc.defaultView ?? window) as Window;
		const capable = this.win as unknown as HighlightCapableWindow;
		this.highlightCtor = typeof capable.Highlight === "function" ? capable.Highlight : null;
		this.registry = capable.CSS?.highlights ?? null;
		if (!this.highlightCtor || !this.registry) {
			this.highlightCtor = null;
			this.registry = null;
		}
		this.installStyle();
		this.doc.addEventListener("click", this.onDocClick, true);
	}

	/** 是否走 CSS Custom Highlight API（否则为 span 包裹降级）。 */
	get usesHighlightApi(): boolean {
		return this.registry !== null && this.highlightCtor !== null;
	}

	setClickHandler(handler: ((id: string, click?: { x: number; y: number }) => void) | null): void {
		this.clickHandler = handler;
	}

	/**
	 * 设置"渲染坐标系 → 父文档视口"的偏移**提供者**。
	 *
	 * iframe 内的事件坐标是 iframe 自身坐标系，UI 的浮层在父文档里，
	 * 必须先加上 iframe 的位置才能把菜单放到高亮旁边（TXT 同文档时返回 null）。
	 *
	 * 用**回调**而不是快照：页面滚动 / 布局变化后 iframe 位置会变，
	 * 每次点击都要重新取，快照会让菜单定位越来越偏。
	 */
	setHostOffsetProvider(provider: (() => { x: number; y: number } | null) | null): void {
		this.offsetProvider = provider;
	}

	private currentOffset(): { x: number; y: number } {
		if (!this.offsetProvider) return { x: 0, y: 0 };
		try {
			return this.offsetProvider() ?? { x: 0, y: 0 };
		} catch {
			return { x: 0, y: 0 };
		}
	}

	/** 渲染坐标系矩形 → 父文档视口矩形。 */
	private toHostRect(rect: DOMRect): { left: number; top: number; width: number; height: number } {
		const off = this.currentOffset();
		return {
			left: rect.left + off.x,
			top: rect.top + off.y,
			width: rect.width,
			height: rect.height,
		};
	}

	/** 某条高亮当前的矩形（父文档视口坐标）；未渲染/不在布局区返回 null。 */
	rectOf(id: string): { left: number; top: number; width: number; height: number } | null {
		const range = this.rangeOf(id);
		if (!range) return null;
		const rect = range.getBoundingClientRect();
		if (!rect || (rect.width === 0 && rect.height === 0)) return null;
		return this.toHostRect(rect);
	}

	/** 全量设置（重开书/增删改后调用）并立即重新解析、重绘。 */
	setHighlights(list: readonly EngineHighlight[]): void {
		this.items = list.map((h) => ({ ...h }));
		this.order = this.items.map((h) => h.id);
		this.render();
	}

	/** 增量添加（同 id 覆盖）。 */
	addHighlight(highlight: EngineHighlight): void {
		const idx = this.items.findIndex((h) => h.id === highlight.id);
		if (idx >= 0) this.items[idx] = { ...highlight };
		else {
			this.items.push({ ...highlight });
			this.order.push(highlight.id);
		}
		this.render();
	}

	removeHighlight(id: string): void {
		this.items = this.items.filter((h) => h.id !== id);
		this.order = this.order.filter((x) => x !== id);
		this.render();
	}

	/** 当前已设置的高亮（副本）。 */
	list(): EngineHighlight[] {
		return this.items.map((h) => ({ ...h }));
	}

	/** 最近一次解析结果（按设置顺序）。 */
	placements(): EngineHighlightPlacement[] {
		return this.order.map((id) => this.placementsById.get(id)).filter((p): p is EngineHighlightPlacement => !!p);
	}

	/** 当前渲染出的高亮片段数（诊断/测试断言用）。 */
	renderedCount(): number {
		return this.resolved.length;
	}

	/** 让缓存失效（结构变化后调用；`render()` 内部也会比对 `structureStamp`）。 */
	markStale(): void {
		this.regionsCache = [];
		this.regionIndex.clear();
		this.textCache.clear();
		this.docIndex = null;
	}

	/** 重新解析并重绘（改字号/切单双页/切滚动分页/补章之后调用）。 */
	refresh(): void {
		this.render();
	}

	/**
	 * 跳转到某条高亮：能解析就滚到命中位置，不能解析就按 `progression` 兜底。
	 * **只在用户显式跳转时调用** —— 渲染过程绝不自动跳转，否则几十条降级批注会互相抢视口。
	 */
	focus(id: string): void {
		const item = this.items.find((h) => h.id === id);
		if (!item) return;
		const placement = this.placementsById.get(id);
		if (placement && !placement.approximate) {
			const range = this.rangeOf(id);
			const el = range?.startContainer.parentElement ?? null;
			if (el) {
				el.scrollIntoView({ block: "center" });
				return;
			}
		}
		this.host.goToProgression(item.anchor.progression);
	}

	// ---------- 命中测试 ----------

	/** 把点击坐标换算成"区域 + 区域内字符偏移"。 */
	private caretAt(x: number, y: number): { regionKey: string; offset: number } | null {
		const doc = this.doc as Document & {
			caretRangeFromPoint?: (x: number, y: number) => Range | null;
			caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		};
		let node: Node | null = null;
		let offset = 0;
		if (typeof doc.caretRangeFromPoint === "function") {
			const r = doc.caretRangeFromPoint(x, y);
			if (r) {
				node = r.startContainer;
				offset = r.startOffset;
			}
		} else if (typeof doc.caretPositionFromPoint === "function") {
			const p = doc.caretPositionFromPoint(x, y);
			if (p) {
				node = p.offsetNode;
				offset = p.offset;
			}
		}
		if (!node) return null;
		for (const region of this.regionsCache) {
			if (!region.nodes.some((n) => n === node || n.contains(node))) continue;
			const within = this.offsetWithinRegion(region, node, offset);
			if (within !== null) return { regionKey: region.key, offset: within };
		}
		return null;
	}

	private offsetWithinRegion(region: HighlightRegion, node: Node, nodeOffset: number): number | null {
		let acc = 0;
		for (const root of region.nodes) {
			if (root === node) return acc + nodeOffset;
			if (!root.contains(node)) {
				acc += root.textContent?.length ?? 0;
				continue;
			}
			const walker = this.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			while (walker.nextNode()) {
				const t = walker.currentNode as Text;
				if (t === node) return acc + nodeOffset;
				acc += t.data.length;
			}
			return null;
		}
		return null;
	}

	private handleClick(e: MouseEvent): void {
		const handler = this.clickHandler;
		if (!handler) return;
		// 事件坐标是**渲染坐标系**（iframe 内或同文档），换算到父文档视口后交给 UI
		const off = this.currentOffset();
		const click = { x: e.clientX + off.x, y: e.clientY + off.y };
		// 降级路径：span 上有 id，直接命中
		const target = e.target as Element | null;
		const spanId = target && typeof target.closest === "function" ? target.closest(".nyar-hl")?.getAttribute("data-nyar-hl-id") : null;
		if (spanId) {
			handler(spanId, click);
			return;
		}
		// 主路径（CSS Custom Highlight 不改 DOM）：按坐标做命中测试
		if (!this.usesHighlightApi) return;
		const at = this.caretAt(e.clientX, e.clientY);
		if (!at) return;
		const hit = this.resolved.find((r) => r.space === "region" && r.regionKey === at.regionKey && at.offset >= r.start && at.offset < r.end);
		if (hit) handler(hit.id, click);
	}

	// ---------- 渲染 ----------

	private render(): void {
		if (this.disposed) return;
		const stamp = this.host.structureStamp?.() ?? 0;
		if (stamp !== this.stamp) {
			this.stamp = stamp;
			this.markStale();
		}
		this.clearVisuals();
		this.placementsById.clear();
		this.resolved = [];
		this.regionsCache = this.host.regions();
		this.regionIndex = new Map();
		for (const region of this.regionsCache) {
			if (!this.regionIndex.has(region.key)) this.regionIndex.set(region.key, region);
			if (region.paraIndex !== undefined) {
				const byPara = `#${region.paraIndex}`;
				if (!this.regionIndex.has(byPara)) this.regionIndex.set(byPara, region);
			}
		}

		for (const item of this.items) {
			const anchor = item.anchor;
			const region = this.findRegion(anchor);
			let placement: EngineHighlightPlacement | null = null;
			if (region) {
				const located = locateInText(this.regionText(region), anchor);
				if (located.start !== undefined && located.end !== undefined) {
					const range = this.rangeWithinRegion(region, located.start, located.end);
					if (range) {
						this.paint(item, range);
						this.resolved.push({ id: item.id, space: "region", regionKey: region.key, start: located.start, end: located.end });
						placement = { id: item.id, quality: located.quality, approximate: located.approximate, reason: located.reason, rendered: true };
					}
				} else {
					placement = { id: item.id, quality: located.quality, approximate: located.approximate, reason: located.reason, rendered: false };
				}
			}
			if (!placement) {
				// 目标章节/段落尚未加载（懒加载补章、TXT 虚拟窗口外）：跨整篇文本按指纹兜底
				const found = this.findInDocument(anchor);
				if (found) {
					this.paint(item, found.range);
					this.resolved.push({ id: item.id, space: "doc", regionKey: "#doc", start: found.start, end: found.end });
					placement = { id: item.id, quality: "quote-unique", approximate: false, reason: "目标章节不在当前布局区，已按整篇文本指纹命中", rendered: true };
				} else {
					placement = {
						id: item.id,
						quality: "progression-only",
						approximate: true,
						// "不在布局区"（按章独立分页的冷区）与"尚未加载"（懒加载）都要如实说明，
						// 并告诉调用方**怎么恢复**：补章 / 该章进入布局 / 滚动到该处，然后调 refresh()
						reason: "目标章节/段落当前不在布局区或尚未加载，暂时只能按进度定位（补章、该章进入布局或滚动到该处后会自动重新应用）",
						rendered: false,
					};
				}
			}
			this.placementsById.set(item.id, placement);
		}
	}

	private findRegion(anchor: AnnotationAnchor): HighlightRegion | null {
		if (anchor.primary) {
			const byKey = this.regionIndex.get(anchor.primary);
			if (byKey) return byKey;
			const numeric = parseInt(anchor.primary, 10);
			if (Number.isFinite(numeric)) {
				const byNumber = this.regionIndex.get(`#${numeric}`) ?? this.regionIndex.get(String(numeric));
				if (byNumber) return byNumber;
			}
		}
		if (typeof anchor.paraIndex === "number") {
			const byPara = this.regionIndex.get(`#${anchor.paraIndex}`) ?? this.regionsCache[anchor.paraIndex];
			if (byPara) return byPara;
		}
		return null;
	}

	private regionText(region: HighlightRegion): string {
		const key = `t:${region.key}:${region.nodes.length}`;
		const cached = this.textCache.get(key);
		if (cached !== undefined) return cached;
		const text = region.nodes.map((n) => n.textContent ?? "").join("");
		this.textCache.set(key, text);
		return text;
	}

	/** 把「区域内字符偏移」换算成 DOM Range。 */
	private rangeWithinRegion(region: HighlightRegion, start: number, end: number): Range | null {
		const parts: Array<{ node: Text; start: number; end: number }> = [];
		let acc = 0;
		for (const root of region.nodes) {
			const walker = this.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			while (walker.nextNode()) {
				const t = walker.currentNode as Text;
				const len = t.data.length;
				if (len) parts.push({ node: t, start: acc, end: acc + len });
				acc += len;
			}
		}
		return this.rangeFromParts(parts, start, end);
	}

	private rangeFromParts(parts: Array<{ node: Text; start: number; end: number }>, start: number, end: number): Range | null {
		if (end <= start || !parts.length) return null;
		const startPart = parts.find((p) => start >= p.start && start < p.end) ?? parts.find((p) => start < p.start);
		if (!startPart) return null;
		const endPart = parts.find((p) => end > p.start && end <= p.end) ?? parts[parts.length - 1];
		const range = this.doc.createRange();
		try {
			range.setStart(startPart.node, Math.max(0, Math.min(startPart.node.data.length, start - startPart.start)));
			range.setEnd(endPart.node, Math.max(0, Math.min(endPart.node.data.length, end - endPart.start)));
		} catch {
			return null;
		}
		return range;
	}

	/** 跨整篇文本按指纹兜底（只在目标区域缺失时执行；索引按结构版本缓存）。 */
	private findInDocument(anchor: AnnotationAnchor): { range: Range; start: number; end: number } | null {
		const index = this.ensureDocIndex();
		if (!index) return null;
		const located = locateInText(index.text, anchor);
		if (located.start === undefined || located.end === undefined) return null;
		const range = this.rangeFromParts(index.spans, located.start, located.end);
		if (!range) return null;
		return { range, start: located.start, end: located.end };
	}

	private ensureDocIndex(): DocIndex | null {
		if (this.docIndex) return this.docIndex;
		const root = this.host.documentRoot();
		if (!root) return null;
		const spans: DocIndex["spans"] = [];
		let text = "";
		const walker = this.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		while (walker.nextNode()) {
			const t = walker.currentNode as Text;
			const len = t.data.length;
			if (!len) continue;
			spans.push({ node: t, start: text.length, end: text.length + len });
			text += t.data;
		}
		this.docIndex = { text, spans };
		return this.docIndex;
	}

	// ---------- 绘制 / 清理 ----------

	private paint(item: EngineHighlight, range: Range): void {
		if (this.usesHighlightApi) {
			const registry = this.registry!;
			let highlight = this.highlightsByColor.get(item.color);
			if (!highlight) {
				highlight = new this.highlightCtor!();
				this.highlightsByColor.set(item.color, highlight);
				registry.set(`nyar-hl-${item.color}`, highlight);
			}
			highlight.add(range);
		} else {
			this.wrapRange(range, item.id, item.color);
		}
	}

	private clearVisuals(): void {
		if (this.registry) {
			for (const [color, highlight] of this.highlightsByColor) {
				this.registry.delete(`nyar-hl-${color}`);
				highlight.clear();
			}
		}
		this.highlightsByColor.clear();
		this.unwrapSpans();
	}

	/** 去掉本层包裹的 span，并合并相邻文本节点（恢复原 DOM 文本结构）。 */
	private unwrapSpans(): void {
		const root = this.host.documentRoot();
		if (!root) return;
		const spans = Array.from(this.doc.querySelectorAll("span.nyar-hl"));
		for (const span of spans) {
			const parent = span.parentNode;
			if (!parent) continue;
			while (span.firstChild) parent.insertBefore(span.firstChild, span);
			parent.removeChild(span);
			parent.normalize();
		}
	}

	/** 降级路径：把 Range 覆盖的每个文本节点片段包进 span。 */
	private wrapRange(range: Range, id: string, color: HighlightColor): void {
		const container = range.commonAncestorContainer;
		const root = container.nodeType === 3 ? container.parentNode : container;
		if (!root) return;
		const nodes: Text[] = [];
		const walker = this.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		while (walker.nextNode()) {
			const t = walker.currentNode as Text;
			if (range.intersectsNode(t)) nodes.push(t);
		}
		for (const textNode of nodes) {
			const start = textNode === range.startContainer ? range.startOffset : 0;
			const end = textNode === range.endContainer ? range.endOffset : textNode.data.length;
			if (end <= start) continue;
			let target = textNode;
			if (start > 0) target = target.splitText(start);
			if (end - start < target.data.length) target.splitText(end - start);
			const parent = target.parentNode;
			if (!parent) continue;
			const span = this.doc.createElement("span");
			span.className = `nyar-hl nyar-hl-${color}`;
			span.setAttribute("data-nyar-hl-id", id);
			parent.insertBefore(span, target);
			span.appendChild(target);
		}
	}

	/** 重建某条高亮的 Range（跳转/诊断用）。 */
	private rangeOf(id: string): Range | null {
		const entry = this.resolved.find((r) => r.id === id);
		if (!entry) return null;
		if (entry.space === "doc") {
			const index = this.docIndex;
			return index ? this.rangeFromParts(index.spans, entry.start, entry.end) : null;
		}
		const region = this.regionIndex.get(entry.regionKey);
		return region ? this.rangeWithinRegion(region, entry.start, entry.end) : null;
	}

	// ---------- 样式 ----------

	private installStyle(): void {
		const style = this.doc.createElement("style");
		style.id = "nyar-hl-style";
		const rules: string[] = [];
		for (const color of Object.keys(COLOR_BG) as HighlightColor[]) {
			rules.push(`::highlight(nyar-hl-${color}) { background-color: ${COLOR_BG[color]}; }`);
			rules.push(
				`.nyar-hl-${color} { background-color: ${COLOR_BG[color]}; box-shadow: inset 0 -2px 0 ${COLOR_UNDERLINE[color]}; border-radius: 2px; }`
			);
		}
		rules.push(".nyar-hl { box-decoration-break: clone; -webkit-box-decoration-break: clone; }");
		style.textContent = rules.join("\n");
		const head = this.doc.head ?? this.doc.documentElement;
		head?.appendChild(style);
		this.styleEl = style;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.doc.removeEventListener("click", this.onDocClick, true);
		this.clearVisuals();
		this.styleEl?.remove();
		this.styleEl = null;
		this.items = [];
		this.order = [];
		this.placementsById.clear();
		this.resolved = [];
		this.markStale();
	}

	/** 诊断快照（测试/排查用）。 */
	diagnostics(): { supportsHighlightApi: boolean; items: number; rendered: number; approximate: number; pending: number } {
		const placements = this.placements();
		return {
			supportsHighlightApi: this.usesHighlightApi,
			items: this.items.length,
			rendered: this.resolved.length,
			approximate: placements.filter((p) => p.approximate).length,
			pending: placements.filter((p) => p.rendered === false).length,
		};
	}
}
