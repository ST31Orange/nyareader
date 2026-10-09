/**
 * 分块懒加载调度（v0.5 大文件重构）。
 *
 * 本调度器是**按接口编程**的：任何满足 `ChapterSource` 形状的数据源（EPUB 的 EpubSource、
 * MOBI/AZW3 的 MobiContentSource）都能直接复用同一套"首屏优先 + 后台补块 + 跳转前补块"契约。
 * 类名保留 `EpubLazyLoader` 是为了不破坏既有导入（`LazyChapterLoader` 是同一实现的中性别名）。
 *
 * 首屏只把前 N 章放进渲染文档；剩余章节在渲染完成后由"后台空闲切片"逐批追加：
 * - 每次追加调用引擎的 `notifyContentAppended(html)`（可选公共方法，引擎自己负责
 *   插到正文容器末尾并重排/回填资源），因此不会跨层碰引擎私有 DOM；
 * - 每片有时间预算（默认 16ms），预算用完就让出主线程，避免大书补章把界面顶住；
 * - 跳转/进度恢复需要"补到第 K 章"时走 ensureChaptersThrough（同一串行队列，
 *   与后台补章不会并发插入，章节顺序严格递增）。
 *
 * 纯函数（chapterIndexForPercent / toWholeBookPercent / toLoadedDocPercent）单独导出，
 * 便于单测：懒加载下"引擎文档内百分比"与"整本书百分比"需要显式换算。
 */

/** 懒加载所需的数据源（EpubSource 天然满足；MobiContentSource 同形状；测试可注入假实现）。 */
export interface EpubChapterSource {
	readonly chapterCount: number;
	buildChapterChunk(index: number): Promise<string>;
	/**
	 * 可选：各章"内容量"权重（建议用 zip 条目的未压缩字节数）。
	 * 用于把进度从"按章数"换成"按内容量"，否则前 5 章很短、后面 1 章很长的书，
	 * 进度条会在补章过程中明显回退。缺省时退化为每章等权。
	 */
	chapterWeights?(): number[];
}

export interface EpubLazyLoaderOptions {
	/** 首屏文档里已经包含的章节数（后台从该索引继续）。 */
	initialChapters?: number;
	/** 后台每批追加章节数；缺省按总章数自适应（4~64）。 */
	batchSize?: number;
	/** 预加载（跳转/进度恢复）每批章节数：更大以减少分页重排次数。 */
	preloadBatchSize?: number;
	/** 单片时间预算（ms），超出即让出主线程。 */
	sliceBudgetMs?: number;
	/** 追加回调（引擎 notifyContentAppended）；未提供时整个懒加载安全跳过。 */
	append?: (html: string, fromIndex: number) => void;
	/** 阶段上报（loaded/total 为章节数）。 */
	onStage?: (stage: string, detail?: { loaded: number; total: number }) => void;
	/**
	 * 单块失败上报（**不再静默**）。
	 *
	 * 背景（用户主诉「书断在中间、页数变少」的根因）：旧实现里 `slice()` 用
	 * `void this.enqueue(...)` 吞掉异常，而 `appendUpTo` 只在 append 成功后推进 `loaded`。
	 * 于是任意一块读取失败（真实书里常见：损坏/无法解压的条目、引擎追加抛错）都会让
	 * 该块被无限重试、`loaded` 永不前进、后台切片链不再排下一片 —— 懒加载静默停止，
	 * 页面数冻结在已加载前缀上，界面上就是"书断在中间"。
	 *
	 * 现在：失败块用占位内容跳过并继续推进；本回调让调用方知道"内容有缺口"。
	 */
	onError?: (info: { index: number; error: unknown }) => void;
	/** 后台调度器；缺省 requestIdleCallback（回退 setTimeout）。 */
	schedule?: (task: () => void) => void;
}

/** 单块读取失败时的可见占位块（保证块序/锚点不错位，且读者能看到缺口）。 */
export function failedChunkPlaceholder(index: number): string {
	const label = `（第 ${index + 1} 块内容读取失败，已跳过）`;
	return `<p class="nyareader-chunk-failed" data-nyar-chunk-failed="${index}">${label}</p>`;
}

/**
 * 按"内容量权重"计算已加载前缀在整本书里的占比。
 *
 * @param loadedPrefix 已经加载的章节数（0..n）
 * @param weights 各章权重（长度应为总章数；不足时按缺失部分用平均权重补齐）
 * @returns 0~1
 */
export function weightedLoadedFraction(loadedPrefix: number, weights: readonly number[]): number {
	const n = weights.length;
	if (n <= 0) return 1;
	const loaded = Math.max(0, Math.min(n, Math.floor(loadedPrefix)));
	if (loaded >= n) return 1;
	let total = 0;
	for (let i = 0; i < n; i++) total += sanitizeWeight(weights[i]);
	if (total <= 0) return loaded / n;
	let acc = 0;
	for (let i = 0; i < loaded; i++) acc += sanitizeWeight(weights[i]);
	return Math.min(1, Math.max(0, acc / total));
}

/**
 * `weightedDocPercentAbsolute` 的旧名（保留导出以免影响调用方）。
 *
 * 两者语义完全一致：整书进度 → 已加载前缀文档内进度 = `p × total / loadedWeight`。
 * 新代码请直接用 `weightedDocPercentAbsolute`（名字里带 Absolute 是为了强调
 * "分母是整本权重、与已加载多少章无关"这一关键性质）。
 *
 * @deprecated 使用 {@link weightedDocPercentAbsolute}
 */
export function weightedDocPercent(wholeBookPercent: number, loadedPrefix: number, weights: readonly number[]): number {
	return weightedDocPercentAbsolute(wholeBookPercent, loadedPrefix, weights);
}

/** 前 count 章的累计权重（count 会被夹到 [0, weights.length]）。 */
export function prefixWeight(count: number, weights: readonly number[]): number {
	const n = weights.length;
	const k = Math.max(0, Math.min(n, Math.floor(count)));
	let acc = 0;
	for (let i = 0; i < k; i++) acc += sanitizeWeight(weights[i]);
	return acc;
}

/** 全部章节的累计权重。 */
export function totalWeight(weights: readonly number[]): number {
	return prefixWeight(weights.length, weights);
}

/**
 * 把"已加载前缀文档内的相对进度 p"换算成**绝对整书进度**（0~1）。
 *
 * 模型（必须与引擎实际的 p 语义一致）：
 * 引擎的 p 是**整份已加载文档内**的相对位置（HtmlDocEngine 用页中心、
 * TxtEngine 用 scrollTop/可滚动高度），因此 p 在已加载前缀内是**线性**的。
 * 于是整书进度 = `p × 已加载前缀权重 / 整本权重`：
 * - 已加载全部章节时 `prefixWeight(n) === totalWeight` → 恒等返回 p；
 * - 补章时 p 与 loadedWeight 同向增长、比例稳定，同一阅读位置的整书进度**不漂移**；
 * - 与 weightedDocPercentAbsolute 严格互逆（两者都是"线性映射 + 同一权重序列"）。
 *
 * 反例（v0.5 曾写错并回归）：把 p 当成"最后一个已加载章内的位置"
 * （`(prefixWeight(loaded-1) + p×w[loaded-1]) / total`），在全部加载时
 * p=0.10 会返回 0.91 —— 与引擎语义不符，且与逆函数不互逆。
 *
 * @param percentageInDoc 引擎进度（已加载前缀文档内 0~1）
 * @param loadedPrefix 已加载章节数
 * @param weights 各章权重（长度 = 总章数）
 */
export function weightedWholeBookPercent(percentageInDoc: number, loadedPrefix: number, weights: readonly number[]): number {
	const n = weights.length;
	const p = Math.min(1, Math.max(0, Number.isFinite(percentageInDoc) ? percentageInDoc : 0));
	const total = totalWeight(weights);
	if (n <= 0 || total <= 0) return p;
	const loaded = Math.max(0, Math.min(n, Math.floor(loadedPrefix)));
	if (loaded <= 0) return 0;
	const loadedWeight = prefixWeight(loaded, weights);
	if (loadedWeight <= 0) return 0;
	return Math.min(1, Math.max(0, (p * loadedWeight) / total));
}

/**
 * weightedWholeBookPercent 的严格逆：整书进度 → 已加载前缀文档内的相对进度。
 *
 * 与 weightedWholeBookPercent 使用**同一**模型（p 在已加载前缀内线性）：
 * - 目标落在已加载范围内：`docPercent = 目标绝对权重 / 已加载前缀权重`；
 * - 目标超出已加载范围：钳到 1（调用方会先补章到该位置）；
 * - 已加载全部章节时与 p 恒等（loadedWeight === totalWeight）。
 */
export function weightedDocPercentAbsolute(wholeBookPercent: number, loadedPrefix: number, weights: readonly number[]): number {
	const n = weights.length;
	const p = Math.min(1, Math.max(0, Number.isFinite(wholeBookPercent) ? wholeBookPercent : 0));
	const total = totalWeight(weights);
	if (n <= 0 || total <= 0) return p;
	const loaded = Math.max(0, Math.min(n, Math.floor(loadedPrefix)));
	if (loaded <= 0) return 0;
	const loadedWeight = prefixWeight(loaded, weights);
	if (loadedWeight <= 0) return 0;
	return Math.min(1, Math.max(0, (p * total) / loadedWeight));
}

function sanitizeWeight(w: number): number {
	return Number.isFinite(w) && w > 0 ? w : 1;
}

/**
 * 把"整本书百分比"换算成需要预加载到的章节索引（0-based，闭区间）。
 *
 * 注意：这里仍按**章数**（而不是字节权重）估算边界，属于有意的保守取舍——
 * 按章数会略微多预加载一点内容，但保证不会少加载（少加载会让跳转落空）；
 * 字节权重只用于**进度显示**的换算（见 weightedDocPercent）。
 */
export function chapterIndexForPercent(percent: number, total: number): number {
	if (total <= 0) return 0;
	const p = Math.min(1, Math.max(0, Number.isFinite(percent) ? percent : 0));
	return Math.min(total - 1, Math.max(0, Math.ceil(p * total) - 1));
}

/** 引擎进度（"已加载前缀文档"内 0~1）-> 整本书进度（0~1）。 */
export function toWholeBookPercent(percentageInDoc: number, loadedFraction: number): number {
	const p = Math.min(1, Math.max(0, Number.isFinite(percentageInDoc) ? percentageInDoc : 0));
	const f = Math.min(1, Math.max(0, Number.isFinite(loadedFraction) ? loadedFraction : 1));
	return Math.min(1, Math.max(0, p * f));
}

/** 整本书进度（0~1）-> 在"已加载前缀文档"里的百分比（0~1），用于恢复阅读位置。 */
export function toLoadedDocPercent(wholeBookPercent: number, loadedFraction: number): number {
	const p = Math.min(1, Math.max(0, Number.isFinite(wholeBookPercent) ? wholeBookPercent : 0));
	const f = Math.min(1, Math.max(0, Number.isFinite(loadedFraction) ? loadedFraction : 0));
	if (f <= 0) return 0;
	return Math.min(1, Math.max(0, p / f));
}

function nowMs(): number {
	return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function defaultSchedule(task: () => void): void {
	const globalWithIdle = globalThis as {
		requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
	};
	if (typeof globalWithIdle.requestIdleCallback === "function") {
		globalWithIdle.requestIdleCallback(task, { timeout: 250 });
		return;
	}
	if (typeof setTimeout === "function") {
		setTimeout(task, 0);
		return;
	}
	task();
}

function adaptiveBatchSize(total: number): number {
	if (total <= 32) return 1;
	return Math.max(4, Math.min(64, Math.ceil(total / 240)));
}

export class EpubLazyLoader {
	private loaded: number;
	/** 串行队列：后台补章与跳转预加载不会交错插入。 */
	private chain: Promise<void> = Promise.resolve();
	private disposed = false;
	private readonly batchSize: number;
	/** 内容量权重缓存（undefined = 未读取；null = 数据源不支持） */
	private weightsCache: number[] | null | undefined = undefined;

	constructor(
		private readonly source: EpubChapterSource,
		private readonly opts: EpubLazyLoaderOptions = {}
	) {
		const total = source.chapterCount;
		this.loaded = Math.max(0, Math.min(total, Math.floor(opts.initialChapters ?? 0)));
		this.batchSize = Math.max(1, Math.floor(opts.batchSize ?? adaptiveBatchSize(total)));
	}

	get totalChapters(): number {
		return this.source.chapterCount;
	}

	get loadedChapters(): number {
		return this.loaded;
	}

	/**
	 * 已加载章节占全书比例。
	 * 内容量权重可用时按**字节权重**计算（更接近真实阅读进度：
	 * 前几章很短、后面一章很长的书，按章数算会让进度条在补章时明显回退）；
	 * 权重不可用时退化为按章数。
	 */
	get loadedFraction(): number {
		const total = this.totalChapters;
		if (total <= 0) return 1;
		const weights = this.weights;
		if (weights) return weightedLoadedFraction(this.loaded, weights);
		return Math.min(1, this.loaded / total);
	}

	/** 各章内容量权重（惰性读取一次；数据源未提供则为 null）。 */
	private get weights(): number[] | null {
		if (this.weightsCache !== undefined) return this.weightsCache;
		try {
			const w = this.source.chapterWeights?.();
			this.weightsCache = w && w.length ? w : null;
		} catch {
			this.weightsCache = null;
		}
		return this.weightsCache;
	}

	/**
	 * 引擎进度（"已加载前缀文档"内 0~1）→ 整本书进度（0~1）。
	 *
	 * 有权重时用**绝对**字节权重（分母=整本权重），因此进度不随补章漂移；
	 * 无权重时退回 `p × 已加载占比` 的章数口径（与 loadedDocPercent 互逆）。
	 */
	wholeBookPercent(percentageInDoc: number): number {
		const weights = this.weights;
		if (!weights) return toWholeBookPercent(percentageInDoc, this.loadedFraction);
		return weightedWholeBookPercent(percentageInDoc, this.loaded, weights);
	}

	/**
	 * 整本书进度（0~1）→ 已加载文档内百分比（0~1），用于恢复阅读位置。
	 * 有字节权重时用与 wholeBookPercent 严格互逆的绝对口径；否则退回章数口径。
	 */
	loadedDocPercent(wholeBookPercent: number): number {
		const weights = this.weights;
		if (!weights) return toLoadedDocPercent(wholeBookPercent, this.loadedFraction);
		return weightedDocPercentAbsolute(wholeBookPercent, this.loaded, weights);
	}

	/** 引擎是否支持追加（未实现 notifyContentAppended 时整个懒加载跳过）。 */
	private get canAppend(): boolean {
		return typeof this.opts.append === "function";
	}

	/** 确保 0..index 章都已追加（目录锚点跳转/进度恢复前调用）。 */
	ensureChaptersThrough(index: number): Promise<void> {
		if (!this.canAppend || this.disposed) return Promise.resolve();
		const target = Math.max(0, Math.min(this.totalChapters, Math.floor(index) + 1));
		if (target <= this.loaded) return Promise.resolve();
		return this.enqueue(() => this.appendUpTo(target, this.preloadBatchSize));
	}

	/** 后台开始补章（不阻塞调用方）。 */
	start(): void {
		if (!this.canAppend || this.disposed || this.loaded >= this.totalChapters) return;
		this.scheduleStep();
	}

	dispose(): void {
		this.disposed = true;
	}

	private get preloadBatchSize(): number {
		return Math.max(1, Math.floor(this.opts.preloadBatchSize ?? Math.max(this.batchSize, 32)));
	}

	private get schedule(): (task: () => void) => void {
		return this.opts.schedule ?? defaultSchedule;
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const next = this.chain.then(task, task);
		this.chain = next.then(
			() => undefined,
			() => undefined
		);
		return next;
	}

	private scheduleStep(): void {
		if (!this.canAppend || this.disposed || this.loaded >= this.totalChapters) return;
		this.schedule(() => {
			void this.enqueue(() => this.slice());
		});
	}

	/** 一个后台切片：在时间预算内尽量多追加，超出预算再排下一片。 */
	private async slice(): Promise<void> {
		const budget = this.opts.sliceBudgetMs ?? 16;
		const startedAt = nowMs();
		try {
			while (!this.disposed && this.loaded < this.totalChapters) {
				await this.appendUpTo(Math.min(this.totalChapters, this.loaded + this.batchSize), this.batchSize);
				if (this.disposed) return;
				if (nowMs() - startedAt >= budget) break;
			}
		} catch (e) {
			// 兜底：appendUpTo 内部已逐块容错，这里只可能是意料之外的错误。
			// 绝不让异常打断调度链（旧实现 `void enqueue(...)` 会静默死链）。
			this.reportError(this.loaded, e);
		}
		if (!this.disposed && this.loaded < this.totalChapters) this.scheduleStep();
	}

	/**
	 * 追加到 target（不含）为止；章节顺序严格递增。
	 *
	 * 容错契约（禁止回退）：
	 * - 单块构建失败 → 用占位块跳过 + `onError`，`loaded` 继续推进（缺一块不影响整本）；
	 * - 引擎追加回调失败 → 重试一次；仍失败则上报并继续（不能让整本卡在同一块上）；
	 * - 本方法**不抛异常**，因此 `ensureChaptersThrough` 的 promise 永远会 resolve。
	 */
	private async appendUpTo(target: number, batch: number): Promise<void> {
		while (!this.disposed && this.loaded < target) {
			const end = Math.min(target, this.loaded + Math.max(1, batch));
			const from = this.loaded;
			let html = "";
			for (let i = from; i < end; i++) {
				try {
					html += await this.source.buildChapterChunk(i);
				} catch (e) {
					this.reportError(i, e);
					html += failedChunkPlaceholder(i);
				}
			}
			if (this.disposed) return;
			if (!this.appendWithRetry(html, from)) {
				// 追加失败：内容缺口无法补，但必须继续推进，否则整本永久停在这里
				html = `${html}${failedChunkPlaceholder(from)}`;
			}
			this.loaded = end;
			this.opts.onStage?.("rendering", { loaded: this.loaded, total: this.totalChapters });
		}
	}

	/** 追加一次，失败重试一次；返回是否成功（不再抛异常）。 */
	private appendWithRetry(html: string, from: number): boolean {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				this.opts.append?.(html, from);
				return true;
			} catch (e) {
				if (attempt === 1) {
					this.reportError(from, e);
					return false;
				}
			}
		}
		return false;
	}

	private reportError(index: number, error: unknown): void {
		try {
			this.opts.onError?.({ index, error });
		} catch {
			/* 上报本身失败不影响补章 */
		}
	}
}

// ---------- 中性别名（供 MOBI/AZW3 等其它格式复用同一调度器） ----------

/**
 * 分块数据源（中性别名）：`chapterCount` / `buildChapterChunk(index)` / `chapterWeights?()`。
 * EPUB 的 EpubSource 与 MOBI/AZW3 的 MobiContentSource 都满足此形状。
 */
export type ChapterSource = EpubChapterSource;

/** 懒加载调度选项（中性别名，与 EpubLazyLoaderOptions 同类型）。 */
export type LazyLoaderOptions = EpubLazyLoaderOptions;

/**
 * 懒加载调度器（中性别名，与 `EpubLazyLoader` 是**同一个类**）。
 * 命名中性化便于非 EPUB 格式复用；EPUB 侧的导入与行为完全不变。
 */
export { EpubLazyLoader as LazyChapterLoader };
