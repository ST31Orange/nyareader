/**
 * ReaderController：阅读器编排层。
 * 职责：
 * - 打开书籍（解析 -> 构建 BookModel -> 按格式创建引擎 -> 恢复进度）
 * - 转发用户操作（翻页/跳转/主题/版式）到引擎
 * - 划词 -> 翻译（委托 NyaLingo）
 * - 划词 -> 批注（PDF 写文件+备份，其余写侧车）
 * - 进度持久化（BookIndexService）
 * 视图层只与本 Controller 通信。
 *
 * v0.5 打开链路重构（"大文件打开慢"的根因修复）：
 * 1) 指纹不再串行阻塞解析：sha256（WebCrypto 后台线程）与解析并行发起，解析器先用
 *    占位指纹，解析完成后立刻回填真实指纹并写索引（进度/批注主键语义不变）；
 * 2) 打开各阶段通过 events.onStage 上报，视图层可在首屏前显示"读取/解析/索引/排版"；
 * 3) EPUB 走"首章优先 + 后台补章"：首屏只渲染前 N 章（默认 2），其余由 EpubLazyLoader
 *    调用引擎的 notifyContentAppended 追加；跳转/进度恢复前按需补章；
 * 4) 懒加载下引擎百分比只覆盖"已加载前缀"，落盘前换算成整本书百分比（语义不变）；
 * 5) TXT 解析与渲染共用一次解码/切段（不再两份大字符串），关闭时主动释放缓存。
 */
import type { TFile } from "obsidian";
import type NyaReaderPlugin from "../main";
import type { BookModel, ReaderSettings, RelayoutState } from "../types";
import { formatFromExtension, sniffFormat, provisionalFingerprint, IBookParser } from "../services/books/Parser";
import type { AnnotationTarget, IReaderEngine } from "../services/books/IReaderEngine";
import { PdfParser } from "../services/books/formats/pdf/PdfParser";
import { PdfEngine } from "../services/books/formats/pdf/PdfEngine";
import { initPdfWorker } from "../services/books/formats/pdf/pdfWorker";
import { dropPdfHandoff } from "../services/books/formats/pdf/pdfHandoff";
import { EpubParser } from "../services/books/formats/epub/EpubParser";
import { EPUB_ANCHOR_PREFIX } from "../services/books/formats/epub/EpubZipCache";
import type { EpubSource } from "../services/books/formats/epub/EpubDocument";
import { DEFAULT_INITIAL_CHAPTERS } from "../services/books/formats/epub/EpubDocument";
import {
	EpubLazyLoader,
	chapterIndexForPercent,
} from "../services/books/formats/epub/EpubLazyLoader";
import type { MobiContentSource } from "../services/books/formats/mobi/MobiDocument";
import { TxtParser } from "../services/books/formats/txt/TxtParser";
import type { TxtContent } from "../services/books/formats/txt/TxtParser";
import { loadTxtContent, releaseTxtContent } from "../services/books/formats/txt/TxtParser";
import { TxtEngine } from "../services/books/formats/txt/TxtEngine";
import { MobiParser } from "../services/books/formats/mobi/MobiParser";
import { HtmlDocEngine } from "../services/books/formats/mobi/HtmlDocEngine";
import { PdfInlineAnnotationStore } from "../services/annotations/PdfInlineAnnotationStore";
import { PdfBackupService } from "../services/annotations/PdfBackupService";
import { SidecarAnnotationStore, anchorFromLegacy } from "../services/annotations/SidecarAnnotationStore";
import type { WriteAnnotationInput } from "../services/annotations/PdfAnnotationWriter";
import { isEncryptedPdfError } from "../services/annotations/PdfAnnotationWriter";
import { sha256Hex } from "../utils/hash";
import { debounce } from "../utils/debounce";
import { domRectToPdfRect, isWithinPage, mergeDomRects } from "../utils/pdf-coords";
import type { ViewportLike } from "../utils/pdf-coords";
import type { Annotation, AnnotationKind, HighlightColor } from "../services/annotations/AnnotationModel";
import { normalizeHighlightColor } from "../services/annotations/AnnotationModel";
import { createAnchor, quoteFromText, type AnnotationAnchor } from "../services/annotations/AnnotationAnchor";
import type { EngineHighlight } from "../services/books/IReaderEngine";

export interface ReaderControllerEvents {
	onBookOpened: (book: BookModel) => void;
	onError: (message: string) => void;
	onProgress: (percentage: number) => void;
	/**
	 * 打开阶段进度（视图层显示加载提示）。
	 * 阶段名：reading / parsing / index / rendering / done；detail 为已处理/总数（章节数等）。
	 */
	onStage?: (stage: string, detail?: { loaded: number; total: number }) => void;
	/**
	 * 重排状态（大文件改字号/版式时给出"正在重新排版…"反馈）。
	 * 由引擎的 setLayoutStateHandler 透传上来；未实现该方法的引擎不会触发。
	 */
	onRelayoutState?: (state: RelayoutState) => void;
	/**
	 * 点击了正文里的高亮（批注）→ UI 打开编辑面板。
	 * 由引擎的 `setHighlightClickHandler` 透传上来；未实现该方法的引擎不会触发。
	 */
	onAnnotationClick?: (id: string) => void;
	/**
	 * 读到了 v1 旧侧车并已迁移到内存（即将写成 v2 新文件，旧文件原样保留）。
	 * UI 可据此提示"已迁移 N 条旧批注，旧文件已保留"。
	 */
	onAnnotationMigration?: (count: number) => void;
}

/** 可选的控制器行为参数（默认值即线上行为，便于测试覆盖）。 */
export interface ReaderControllerOptions {
	/** EPUB 首屏构建章节数（其余后台补章） */
	epubInitialChapters?: number;
	/** EPUB 后台每批补章数（缺省自适应） */
	epubLazyBatchSize?: number;
	/** MOBI/AZW3 首屏构建块数（其余后台补块） */
	mobiInitialChapters?: number;
	/** MOBI/AZW3 后台每批补块数（缺省自适应） */
	mobiLazyBatchSize?: number;
	/**
	 * **按章独立分页**（task-10 / D 方案）开关，默认 true。
	 *
	 * true：分页模式下只让"当前章 ±1"参与分栏，改字号/版式只重排 2–3 章；
	 * 代价是总页数变成估计值（视图层用 `engine.isPageCountEstimated()` 显示 ≈）。
	 * false：一键回退到整本布局（页数精确、改字号慢），用于真机异常时立即回滚。
	 */
	chapterPagedPagination?: boolean;
}

/**
 * 懒加载跳转定位规则。
 *
 * 默认值即 **EPUB 原行为**（`#nyareader-epub-N` 锚点 + 0~10000 百分比），
 * 因此不传该参数的调用点（EPUB）与重构前语义逐字一致；其它格式可显式覆盖：
 * - `anchorPrefix`：该格式的章节锚点前缀；
 * - `resolveChapter`：格式自定义锚点（MOBI 的标题锚点 / filepos 锚点等）-> 块索引，
 *   返回 null 表示"不适用"，继续走默认规则。
 */
export interface LazyJumpTarget {
	anchorPrefix?: string;
	resolveChapter?: (location: string) => number | null;
}

/** 默认跳转定位规则 = EPUB 原锚点前缀 + 原（百分比）解析方式。 */
const DEFAULT_LAZY_JUMP_TARGET: LazyJumpTarget = { anchorPrefix: EPUB_ANCHOR_PREFIX };

/**
 * PDF 写回节流窗口（ms）。
 *
 * 现状是"每加一条批注就整体重写一次 PDF 文件"（大 PDF 卡顿、外部同步反复上传整本）。
 * P0 先做**合并**：窗口内的多次写回攒成一批，一次读 + 一次写 + 一次备份。
 */
const PDF_WRITE_THROTTLE_MS = 1500;

/** 一批待写回的 PDF 批注（带自己的文件路径，避免切书后写错文件）。 */
interface PendingPdfWrite {
	path: string;
	annotation: Annotation;
	input: WriteAnnotationInput;
}

/** 单调时钟（诊断计时用；无 performance 时退回 Date.now）。 */
function nowMs(): number {
	return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/**
 * 打开阶段计时器（诊断"大文件打开要几十秒"到底花在哪）。
 *
 * 每条 openBook 一个实例，`mark()` 打印"本阶段耗时 + 累计耗时"：
 * `[NyaReader] openBook#3 initialHtml +0.5ms (累计 74.8ms)`。
 * 只走 console.debug（不弹 Notice、不写盘），发布版本里保留以便用户按需排查。
 */
class OpenStageTimer {
	private last = nowMs();
	private readonly startedAt = this.last;
	constructor(private readonly seq: number) {}

	mark(stage: string): void {
		const t = nowMs();
		const stageMs = t - this.last;
		const totalMs = t - this.startedAt;
		try {
			// eslint-disable-next-line no-console
			console.debug(`[NyaReader] openBook#${this.seq} ${stage} +${stageMs.toFixed(1)}ms（累计 ${totalMs.toFixed(1)}ms）`);
		} catch {
			/* 诊断日志失败不影响打开 */
		}
		this.last = t;
	}
}

export class ReaderController {
	/** 最近一次划词（鼠标划出后点标题栏按钮时选区常已被点击清空，用它兜底） */
	private lastSelection: { text: string; target?: AnnotationTarget } | null = null;
	private book: BookModel | null = null;
	private buffer: ArrayBuffer | null = null;
	private engine: IReaderEngine | null = null;
	private file: TFile | null = null;
	private pdfInline: PdfInlineAnnotationStore | null = null;
	private sidecar: SidecarAnnotationStore;
	/**
	 * 当前书全部批注的内存镜像。
	 * 它是"高亮重放"的唯一输入（`setHighlights` 全量下发），也让列表 UI 立刻拿到
	 * 带 `anchor`/`approximate` 的新模型，而不必每次读盘。
	 */
	private annotations: Annotation[] = [];
	/** PDF 写回节流：窗口内的多次写回攒成一批（见 PDF_WRITE_THROTTLE_MS） */
	private pdfWriteTimer: ReturnType<typeof setTimeout> | null = null;
	private pdfPending: PendingPdfWrite[] = [];
	private pdfWriting = false;
	/** EPUB 渲染数据源（懒加载期间持有 zip，关闭时释放 blob URL 与缓存） */
	private epubSource: EpubSource | null = null;
	/** MOBI/AZW3 渲染数据源（懒加载期间持有正文记录索引，关闭时释放 blob URL 与结构缓存） */
	private mobiSource: MobiContentSource | null = null;
	/** 分章懒加载调度器（引擎不支持追加时为 null，退回旧的全量构建） */
	private lazyLoader: EpubLazyLoader | null = null;
	/** 未包装的引擎 goTo（懒加载跳转钩子安装前的原方法），供"已完成补章"的内部跳转直接调用 */
	private engineGoToRaw: ((location: string) => void) | null = null;
	/**
	 * 打开序号（并发保护 / "最后一次打开胜出"）。
	 *
	 * 根因（用户主诉「切走再回来书断在中间 / 进度回不去」的一部分）：`openBook` 内部有多个
	 * await（读文件、解析、挂载 iframe…），而视图层在"活动文件变化"时会再次调用 `openBook`。
	 * 两次打开交错时，旧的那次会在新的那次之后继续写 `this.book/this.engine/this.lazyLoader`
	 * 并把新引擎 destroy 掉，于是出现"引擎与 book/fingerprint 不匹配、进度按错误的书落盘、
	 * 界面停在只加载了首屏那几章的那份文档上"。
	 *
	 * 现在每次 openBook 领一个自增序号，每个 await 之后都检查自己是否已过期；过期的调用
	 * **不再写任何状态**（并把自己已经建好的引擎销毁），保证只有最后一次打开能落地。
	 */
	private openSeq = 0;
	/**
	 * 重排进行中（task-7 B 步）：压住**后台**补章的调度。
	 *
	 * 这里不改 EpubLazyLoader：它在构造时就支持注入 `schedule`（后台切片调度器），
	 * 我们把"重排期间的任务"暂存起来，重排结束（或 250ms 兜底）再放行。
	 * 跳转预加载（ensureChaptersThrough）走的是 loader 内部串行队列，不受影响 ——
	 * 用户主动跳转必须立刻补章。
	 */
	private layoutBusy = false;
	private deferredLazyTasks: Array<() => void> = [];
	private layoutReleaseTimer: ReturnType<typeof setTimeout> | null = null;

	private onEngineError = (payload: { message: string }): void => {
		this.events.onError(payload.message);
	};

	/** 进度持久化防抖：滚动时 locationChanged 高频触发，直接写盘会卡界面 */
	private pendingProgress: { location: string; percentage: number } | null = null;
	private saveProgressDebounced = debounce((location: string, percentage: number) => {
		this.pendingProgress = null;
		void this.saveProgress(location, percentage);
	}, 1200);

	private queueProgress(location: string, percentage: number): void {
		this.pendingProgress = { location, percentage };
		this.saveProgressDebounced(location, percentage);
	}

	/** 切书/关窗前把未落盘的进度立即写入，避免防抖期间丢失。 */
	private flushProgress(): void {
		if (!this.pendingProgress) return;
		const p = this.pendingProgress;
		this.pendingProgress = null;
		void this.saveProgress(p.location, p.percentage);
	}

	constructor(
		private plugin: NyaReaderPlugin,
		private events: ReaderControllerEvents,
		private options: ReaderControllerOptions = {}
	) {
		this.sidecar = new SidecarAnnotationStore(
			{
				read: (p) => this.plugin.app.vault.adapter.read(p),
				write: (p, d) => this.plugin.app.vault.adapter.write(p, d),
				exists: (p) => this.plugin.app.vault.adapter.exists(p),
				mkdir: (p) => this.plugin.app.vault.adapter.mkdir(p),
			},
			this.plugin.settings.annotationSidecarSuffix
		);
	}

	get currentBook(): BookModel | null {
		return this.book;
	}

	get currentEngine(): IReaderEngine | null {
		return this.engine;
	}

	/** 阶段上报：视图层回调异常不影响打开流程。 */
	private emitStage(stage: string, detail?: { loaded: number; total: number }): void {
		try {
			this.events.onStage?.(stage, detail);
		} catch {
			/* 视图层的问题不阻塞打开 */
		}
	}

	// ---------- 重排期间压住后台补章（task-7 B 步） ----------

	/** 引擎开始一次（可能很慢的）重排：暂停后台补章的调度。 */
	private holdLazyLoading(): void {
		this.layoutBusy = true;
		if (this.layoutReleaseTimer) clearTimeout(this.layoutReleaseTimer);
		// 兜底：引擎异常没发 busy:false 时也要放行，不能让补章永久停住
		this.layoutReleaseTimer = setTimeout(() => this.releaseLazyLoading(), 250);
	}

	/** 重排结束：放行被压住的后台补章任务。 */
	private releaseLazyLoading(): void {
		if (this.layoutReleaseTimer) {
			clearTimeout(this.layoutReleaseTimer);
			this.layoutReleaseTimer = null;
		}
		if (!this.layoutBusy && !this.deferredLazyTasks.length) return;
		this.layoutBusy = false;
		const pending = this.deferredLazyTasks;
		this.deferredLazyTasks = [];
		for (const task of pending) this.scheduleIdle(task);
	}

	/** 后台调度（requestIdleCallback 优先，回退 setTimeout）——与 loader 默认行为一致。 */
	private scheduleIdle(task: () => void): void {
		const g = globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
		if (typeof g.requestIdleCallback === "function") {
			g.requestIdleCallback(task, { timeout: 250 });
			return;
		}
		setTimeout(task, 0);
	}

	/**
	 * 传给 EpubLazyLoader 的后台调度器：重排进行中先攒着，重排结束再跑。
	 * 绑成字段（箭头函数）以便 `this` 稳定。
	 */
	private lazySchedule = (task: () => void): void => {
		if (this.layoutBusy) {
			this.deferredLazyTasks.push(task);
			return;
		}
		this.scheduleIdle(task);
	};

	/** 打开一本书：读取 -> 并行指纹/解析 -> 建引擎 -> 挂载 -> 恢复进度。 */
	async openBook(file: TFile, mountContainer: HTMLElement): Promise<void> {
		let format: BookModel["format"] | null = null;
		// 本轮打开的序号：任何 await 之后都要用 isStale 检查，过期即放弃（最后一次打开胜出）
		const seq = ++this.openSeq;
		const stages = new OpenStageTimer(seq);
		try {
			this.flushProgress();
			this.lastSelection = null;
			// 切书前把上一本书待写回的 PDF 批注落盘（不能因为切书就丢写回）
			await this.flushPdfWrites();
			// 先销毁旧引擎再解析新书：PDF 开着时解析 EPUB/TXT 会明显卡顿
			this.teardownEngine();
			this.book = null;
			this.buffer = null;
			this.file = null;
			this.emitStage("reading");
			const buffer = await this.plugin.app.vault.adapter.readBinary(file.path);
			if (this.isStale(seq)) return;
			stages.mark("readBinary");
			format = this.detectFormat(file.name, buffer);
			if (format === "unknown") {
				this.events.onError("不支持的电子书格式。");
				return;
			}
			// PDF 解析（PdfParser.parse）也会调用 pdfjs.getDocument，必须先初始化
			// workerSrc，否则会抛 "No GlobalWorkerOptions.workerSrc specified"。
			if (format === "pdf") {
				await initPdfWorker(this.plugin);
				if (this.isStale(seq)) return;
				stages.mark("initPdfWorker");
			}
			const parser = this.parserFor(format);
			if (!parser) {
				this.events.onError(`格式 ${format} 的解析器尚未实现（规划中）。`);
				return;
			}
			// 指纹与解析并行：SHA-256 走 WebCrypto（后台线程），不再"读完文件先等全量哈希"。
			// 解析器先拿占位指纹，解析完成后立刻回填真实指纹（进度/批注/每书版式主键不变）。
			const provisional = provisionalFingerprint(file.path, buffer.byteLength);
			const fingerprintPromise = sha256Hex(buffer);
			// pdf.js 会把传入的 ArrayBuffer 转移（detach）给 worker：PDF 用**一份规范副本**，
			// 解析器与渲染引擎共用同一引用，PdfParser 的文档交接（按 buffer 身份匹配）才生效；
			// 其它格式不复制，省掉一次整本（40MB 级）拷贝。
			const working = format === "pdf" ? buffer.slice(0) : buffer;
			this.emitStage("parsing");
			const book = await parser.parse({ fingerprint: provisional, path: file.path, format, buffer: working });
			if (this.isStale(seq)) return;
			stages.mark(`parse(${format})`);
			this.emitStage("index");
			const fingerprint = await fingerprintPromise.catch(() => provisional);
			if (this.isStale(seq)) return;
			stages.mark("sha256(indexKey)");
			book.fingerprint = fingerprint;
			// 记录/更新索引
			const entry = this.plugin.bookIndex.get(fingerprint);
			await this.plugin.bookIndex.upsert({
				fingerprint,
				path: file.path,
				format,
				title: book.title,
				author: book.author,
				lastOpenedAt: Date.now(),
				progress: entry?.progress,
			});
			if (this.isStale(seq)) return;
			stages.mark("indexUpsert");

			this.book = book;
			this.buffer = working;
			this.file = file;
			this.events.onBookOpened(book);

			// 创建并挂载引擎
			this.emitStage("rendering");
			await this.mountEngine(format, file.path, mountContainer, seq, stages);
			if (this.isStale(seq)) return;
			stages.mark("mountEngine");

			// 恢复进度（EPUB 懒加载下需要先把目标章节补进文档，再按已加载前缀换算）
			const saved = this.plugin.bookIndex.get(fingerprint)?.progress;
			if (saved?.location) {
				if (this.lazyLoader) await this.restoreLazyProgress(saved.location, saved.percentage);
				else this.engine?.goTo(saved.location);
				if (this.isStale(seq)) return;
				stages.mark("restoreProgress");
			}
			// 首屏已就绪，剩余章节转后台空闲补章
			this.lazyLoader?.start();
			this.emitStage("done");
			stages.mark("firstScreenReady");
		} catch (e) {
			// 过期的那次打开：异常不对外报（用户已经打开了别的书）
			if (this.isStale(seq)) return;
			// 打开失败/中途异常：放弃尚未被引擎取走的 PDF 文档交接，避免 worker 常驻
			if (format === "pdf") dropPdfHandoff();
			this.events.onError(e instanceof Error ? e.message : String(e));
		}
	}

	/** 本轮打开是否已过期（有更新的 openBook / close 开始）。 */
	private isStale(seq: number): boolean {
		return seq !== this.openSeq;
	}

	/** 引擎百分比 -> 整本书百分比（懒加载下引擎只覆盖已加载前缀；无懒加载时原样返回）。 */
	private toBookProgress(percentageInDoc: number): number {
		const loader = this.lazyLoader;
		if (!loader) return percentageInDoc;
		// 有内容量权重时按字节加权（更贴近真实阅读进度），否则退回章数口径
		return loader.wholeBookPercent(percentageInDoc);
	}

	/** EPUB 懒加载下的进度恢复：补章到目标位置，再换算成"已加载前缀文档"内的百分比。 */
	private async restoreLazyProgress(location: string, percentage: number): Promise<void> {
		const loader = this.lazyLoader;
		if (!loader) return;
		const fromLocation = parseInt(location, 10);
		const bookPercent = Number.isFinite(percentage) && percentage > 0 ? percentage : Number.isFinite(fromLocation) ? fromLocation / 10000 : 0;
		await loader.ensureChaptersThrough(chapterIndexForPercent(bookPercent, loader.totalChapters));
		const docPercent = Math.round(Math.min(1, Math.max(0, loader.loadedDocPercent(bookPercent))) * 10000);
		// 用未包装的 goTo：补章已完成，不能再让跳转钩子按"整本书百分比"重算一次目标（会重复补章）
		this.goToEngineRaw(String(docPercent));
	}

	/** 直接调用引擎 goTo（跳过懒加载跳转钩子）。 */
	private goToEngineRaw(location: string): void {
		if (this.engineGoToRaw) {
			this.engineGoToRaw(location);
			return;
		}
		this.engine?.goTo(location);
	}

	/**
	 * 按**整本书进度**（0~1）跳转，供底部可拖动进度条调用。
	 *
	 * 懒加载下：先把目标章节补进文档（否则跳到未加载区域会落空），
	 * 再把整书进度换算成"已加载文档内进度"后交给引擎；
	 * 无懒加载时直接按整书进度跳转（语义一致）。
	 *
	 * @returns 目标是否已就绪（跳转后即生效）
	 */
	async seekToBookPercent(bookPercent: number): Promise<void> {
		const p = Math.min(1, Math.max(0, Number.isFinite(bookPercent) ? bookPercent : 0));
		const loader = this.lazyLoader;
		const engine = this.engine;
		if (!engine) return;
		if (loader) {
			// 拖到未加载区域：按整书进度补章到目标块（MOBI 的 source 不叫 epubSource，故只判断 loader）
			const targetChapter = chapterIndexForPercent(p, loader.totalChapters);
			await loader.ensureChaptersThrough(targetChapter);
			const docFraction = loader.loadedDocPercent(p);
			if (typeof engine.goToFraction === "function") engine.goToFraction(docFraction);
			else this.goToEngineRaw(String(Math.round(docFraction * 10000)));
			return;
		}
		if (typeof engine.goToFraction === "function") engine.goToFraction(p);
		else if (this.book?.format === "pdf") engine.goTo(String(Math.max(1, Math.round(p * Math.max(1, engine.getTotalPages?.() ?? 1)))));
		else this.goToEngineRaw(String(Math.round(p * 10000)));
	}

	/** 当前整本书进度（0~1），供进度条显示。 */
	currentBookPercent(): number {
		const engine = this.engine;
		if (!engine) return 0;
		return this.toBookProgress(engine.currentPercentage());
	}

	/**
	 * 懒加载下的跳转前置钩子：目录锚点/百分比跳转若落在尚未补入的章节上，先补章再交给引擎，
	 * 避免"点了目录没反应"。只包装本 Controller 持有的引擎实例，不改引擎实现、不改接口。
	 *
	 * @param target 定位规则；缺省 = EPUB 原行为（见 DEFAULT_LAZY_JUMP_TARGET）。
	 */
	private installLazyJumpHook(
		engine: IReaderEngine,
		loader: EpubLazyLoader,
		target: LazyJumpTarget = DEFAULT_LAZY_JUMP_TARGET
	): void {
		const originalGoTo = engine.goTo.bind(engine);
		this.engineGoToRaw = originalGoTo;
		engine.goTo = async (location: string): Promise<void> => {
			await this.ensureJumpTargetLoaded(location, loader, target);
			originalGoTo(location);
		};
	}

	private async ensureJumpTargetLoaded(
		location: string,
		loader: EpubLazyLoader,
		target: LazyJumpTarget = DEFAULT_LAZY_JUMP_TARGET
	): Promise<void> {
		if (typeof location !== "string" || !location) return;
		// 1) 格式自定义锚点（MOBI 的标题锚点 / filepos 锚点等）
		const custom = target.resolveChapter?.(location);
		if (typeof custom === "number" && Number.isFinite(custom)) {
			await loader.ensureChaptersThrough(custom);
			return;
		}
		// 2) 默认规则：章节锚点前缀（EPUB 原行为）
		const prefix = target.anchorPrefix ?? EPUB_ANCHOR_PREFIX;
		if (prefix && location.startsWith(`#${prefix}`)) {
			const index = parseInt(location.slice(prefix.length + 1), 10);
			if (Number.isFinite(index)) await loader.ensureChaptersThrough(index);
			return;
		}
		// 3) 默认规则：百分比定位
		const pct = parseInt(location, 10);
		if (Number.isFinite(pct) && pct > 0) {
			await loader.ensureChaptersThrough(chapterIndexForPercent(pct / 10000, loader.totalChapters));
		}
	}

	private teardownEngine(): void {
		this.lazyLoader?.dispose();
		this.lazyLoader = null;
		this.engineGoToRaw = null;
		// 待写回的 PDF 批注：不能丢（切书/关窗前必须落盘）
		if (this.pdfWriteTimer) {
			clearTimeout(this.pdfWriteTimer);
			this.pdfWriteTimer = null;
		}
		if (this.pdfPending.length) void this.flushPdfWrites();
		// 批注内存镜像属于"当前这本书"
		this.annotations = [];
		// 重排期间的补章暂存队列：换书/关窗时一并释放（否则旧任务会跑在新书上）
		if (this.layoutReleaseTimer) {
			clearTimeout(this.layoutReleaseTimer);
			this.layoutReleaseTimer = null;
		}
		this.layoutBusy = false;
		this.deferredLazyTasks = [];
		this.engine?.destroy();
		this.engine = null;
		this.pdfInline = null;
		// 释放与"当前这本书"绑定的缓存：zip/结构、blob URL、TXT 段落数组、MOBI 正文记录索引、未取走的 PDF 交接
		const buffer = this.buffer;
		this.epubSource?.dispose();
		this.epubSource = null;
		this.mobiSource?.dispose();
		this.mobiSource = null;
		if (buffer) {
			releaseTxtContent(buffer);
			dropPdfHandoff();
		}
	}

	private detectFormat(name: string, buffer: ArrayBuffer): BookModel["format"] {
		const sniffed = sniffFormat(buffer);
		if (sniffed) return sniffed;
		return formatFromExtension(name);
	}

	private parserFor(format: BookModel["format"]): IBookParser | null {
		switch (format) {
			case "pdf":
				return new PdfParser();
			case "epub":
				return new EpubParser();
			case "txt":
				return new TxtParser();
			case "mobi":
			case "azw3":
				return new MobiParser();
			default:
				return null;
		}
	}

	private async mountEngine(
		format: BookModel["format"],
		filePath: string,
		container: HTMLElement,
		seq: number,
		stages: OpenStageTimer
	): Promise<void> {
		// 过期的那次打开绝不能销毁/覆盖当前引擎（否则"切走再回来"会在新旧两本书之间打架）
		if (this.isStale(seq)) return;
		if (this.engine) {
			this.lazyLoader?.dispose();
			this.lazyLoader = null;
			this.engineGoToRaw = null;
			this.engine.destroy();
			this.engine = null;
		}
		if (!this.book || !this.buffer) return;
		const attach = (engine: IReaderEngine): void => {
			engine.on("error", this.onEngineError);
			// 重排状态（task-7 C 步）：视图层显示"正在重新排版…"；
			// 同时用它把**后台补章**压住 —— 重排期间不再插入新的补章批次，
			// 避免"改字号的大重排"和"补章落盘的大重排"挤在同一帧里。
			engine.setLayoutStateHandler?.((state) => {
				if (state.busy) this.holdLazyLoading();
				else this.releaseLazyLoading();
				try {
					this.events.onRelayoutState?.(state);
				} catch {
					/* 视图层问题不影响重排 */
				}
			});
			engine.on("locationChanged", (payload) => {
				// 懒加载下引擎百分比只覆盖"已加载前缀"，对外/落盘统一换算成整本书百分比
				const bookPercent = this.toBookProgress(payload.percentage);
				this.events.onProgress(bookPercent);
				this.queueProgress(this.lazyLoader ? String(Math.round(bookPercent * 10000)) : payload.location, bookPercent);
			});
			engine.on("selection", (payload) => {
				// 划词自动翻译由视图层完成；这里缓存选区，供标题栏「高亮/笔记」在
				// 鼠标点击按钮清空 DOM 选区后仍然可用。
				if (payload.text?.trim()) this.lastSelection = payload;
			});
			// 点击正文高亮 → UI 打开该条批注（引擎自己负责命中测试）
			engine.setHighlightClickHandler?.((id) => {
				try {
					this.events.onAnnotationClick?.(id);
				} catch {
					/* 视图层问题不影响阅读 */
				}
			});
		};
		/**
		 * 懒加载失败上报（单块读取/追加失败）：不再静默 —— 用户控制台能看到缺了哪一块。
		 * 不弹 Notice：单块缺口不应打断阅读；缺口本身在正文里也有可见占位。
		 */
		const onLazyError = (info: { index: number; error: unknown }): void => {
			try {
				// eslint-disable-next-line no-console
				console.debug(
					`[NyaReader] ${format} 第 ${info.index + 1} 块补块失败（已跳过并继续）：${info.error instanceof Error ? info.error.message : String(info.error)}`
				);
			} catch {
				/* 诊断日志失败不影响补块 */
			}
		};
		switch (format) {
			case "pdf": {
				this.pdfInline = new PdfInlineAnnotationStore(this.plugin, new PdfBackupService(this.plugin));
				await this.pdfInline.load();
				if (this.isStale(seq)) return;
				stages.mark("pdfAnnotationsLoad");
				const engine = new PdfEngine({ plugin: this.plugin, book: this.book, buffer: this.buffer });
				attach(engine);
				await engine.mount(container);
				if (this.isStale(seq)) {
					engine.destroy();
					return;
				}
				this.engine = engine;
				stages.mark("engineMount");
				engine.applySettings(this.currentReaderSettings());
				// 读取批注（PDF 走内联索引）+ 统一重放可见高亮（修复"非 PDF 重开书完全不渲染"）
				await this.loadAnnotations();
				if (this.isStale(seq)) return;
				stages.mark("annotationsReplay");
				for (const a of this.annotations) {
					void engine.showAnnotation(a.target);
				}
				this.applyHighlights();
				break;
			}
			case "epub": {
				const { openEpubSource } = await import("../services/books/formats/epub/EpubDocument");
				const source = await openEpubSource(this.buffer, this.book.title || "EPUB");
				if (this.isStale(seq)) {
					source.dispose();
					return;
				}
				stages.mark("openEpubSource(JSZip+OPF)");
				// 引擎支持追加时首屏只建前 N 章；不支持时退回整本构建（功能不退化）
				const supportsAppend = typeof HtmlDocEngine.prototype.notifyContentAppended === "function";
				const initialChapters = supportsAppend
					? Math.max(1, Math.floor(this.options.epubInitialChapters ?? DEFAULT_INITIAL_CHAPTERS))
					: source.chapterCount;
				const html = await source.buildInitialHtml(initialChapters);
				if (this.isStale(seq)) {
					source.dispose();
					return;
				}
				stages.mark(`initialHtml(${Math.min(initialChapters, source.chapterCount)}章)`);
				// 图片不内联 base64：引擎按 data-nyar-asset 登记态调用本回调按需解析为 blob: URL
				const resolveAsset = (path: string): Promise<string | null> => source.resolveAssetUrl(path);
				const engineOptions = {
					book: this.book,
					html,
					formatLabel: "epub",
					resolveAsset,
					// 按章独立分页（task-10 / D 方案）：只有活动窗口参与分栏。
					// 传 false 一键回退整本布局（真机异常时不用重新发版）。
					chapterPagedPagination: this.options.chapterPagedPagination,
					chapterAnchorPrefix: EPUB_ANCHOR_PREFIX,
				};
				const engine = new HtmlDocEngine(engineOptions);
				attach(engine);
				await engine.mount(container);
				if (this.isStale(seq)) {
					engine.destroy();
					source.dispose();
					return;
				}
				this.engine = engine;
				this.epubSource = source;
				stages.mark("engineMount(iframe解析)");
				engine.applySettings(this.currentReaderSettings());
				if (supportsAppend) {
					const loader = new EpubLazyLoader(source, {
						initialChapters: Math.min(initialChapters, source.chapterCount),
						batchSize: this.options.epubLazyBatchSize,
						append: (chunk) => engine.notifyContentAppended?.(chunk),
						onStage: (stage, detail) => this.emitStage(stage, detail),
						onError: onLazyError,
						// 重排期间压住后台补章（不阻塞用户主动跳转的预加载）
						schedule: this.lazySchedule,
					});
					this.lazyLoader = loader;
					this.installLazyJumpHook(engine, loader);
				}
				// 重开书必须重放批注：以前只有 PDF 分支做这件事，EPUB/MOBI 的高亮"打开就不见了"
				await this.loadAnnotations();
				if (this.isStale(seq)) return;
				stages.mark("annotationsReplay");
				this.applyHighlights();
				break;
			}
			case "txt": {
				const content = await this.parseTxt();
				if (this.isStale(seq)) return;
				if (!content) throw new Error("TXT 解析失败。");
				stages.mark("txtContent");
				const engine = new TxtEngine({ book: this.book, content });
				attach(engine);
				await engine.mount(container);
				if (this.isStale(seq)) {
					engine.destroy();
					return;
				}
				this.engine = engine;
				stages.mark("engineMount");
				engine.applySettings(this.currentReaderSettings());
				await this.loadAnnotations();
				if (this.isStale(seq)) return;
				stages.mark("annotationsReplay");
				this.applyHighlights();
				break;
			}
			case "mobi":
			case "azw3": {
				// 结构与渲染共用同一次解压 + 单趟扫描（解析期已缓存），这里只建首屏前 N 块
				const { openMobiSource, DEFAULT_MOBI_INITIAL_CHAPTERS, MOBI_ANCHOR_PREFIX } = await import(
					"../services/books/formats/mobi/MobiDocument"
				);
				const source = await openMobiSource(this.buffer, this.book.title || "MOBI");
				if (this.isStale(seq)) {
					source.dispose();
					return;
				}
				stages.mark("openMobiSource(解压+扫描)");
				const supportsAppend = typeof HtmlDocEngine.prototype.notifyContentAppended === "function";
				const initialChapters = supportsAppend
					? Math.max(1, Math.floor(this.options.mobiInitialChapters ?? DEFAULT_MOBI_INITIAL_CHAPTERS))
					: source.chapterCount;
				const html = await source.buildInitialHtml(initialChapters);
				if (this.isStale(seq)) {
					source.dispose();
					return;
				}
				stages.mark(`initialHtml(${Math.min(initialChapters, source.chapterCount)}块)`);
				// 内嵌图片不隐藏/不清空：引擎按 data-nyar-asset 登记态调用本回调按需解析为 blob: URL
				const resolveAsset = (key: string): Promise<string | null> => source.resolveAssetUrl(key);
				const engine = new HtmlDocEngine({
					book: this.book,
					html,
					formatLabel: format === "azw3" ? "azw3" : "mobi",
					resolveAsset,
					// 按章独立分页（task-10 / D 方案）；false = 一键回退整本布局
					chapterPagedPagination: this.options.chapterPagedPagination,
					chapterAnchorPrefix: MOBI_ANCHOR_PREFIX,
				});
				attach(engine);
				await engine.mount(container);
				if (this.isStale(seq)) {
					engine.destroy();
					source.dispose();
					return;
				}
				this.engine = engine;
				this.mobiSource = source;
				stages.mark("engineMount(iframe解析)");
				engine.applySettings(this.currentReaderSettings());
				if (supportsAppend) {
					// 关键：把带 chapterWeights() 的 MobiContentSource 直接交给同一个懒加载调度器，
					// 进度换算（整书百分比 ↔ 已加载文档百分比）才会按"内容量"加权而不是按块数。
					const loader = new EpubLazyLoader(source, {
						initialChapters: Math.min(initialChapters, source.chapterCount),
						batchSize: this.options.mobiLazyBatchSize,
						append: (chunk) => engine.notifyContentAppended?.(chunk),
						onStage: (stage, detail) => this.emitStage(stage, detail),
						onError: onLazyError,
						// 重排期间压住后台补章（与 EPUB 分支同一策略）
						schedule: this.lazySchedule,
					});
					this.lazyLoader = loader;
					// 标题锚点（#nyareader-toc-N）/ filepos 锚点（#nyareader-fp-N）/ 块锚点都能先补块再跳
					this.installLazyJumpHook(engine, loader, {
						anchorPrefix: MOBI_ANCHOR_PREFIX,
						resolveChapter: (location) => source.chapterIndexForAnchor(location),
					});
				}
				await this.loadAnnotations();
				if (this.isStale(seq)) return;
				stages.mark("annotationsReplay");
				this.applyHighlights();
				break;
			}
			default:
				throw new Error(`格式 ${format} 暂不支持。`);
		}
	}

	// ---------- 批注：读取 / 重放 / 生成锚点（批注 P0） ----------

	/**
	 * 读取当前书的批注到内存镜像。
	 * - PDF：插件目录内联索引（行为不变）；
	 * - 其余：**侧车 v2 优先，v1 只读兼容**。读到 v1 时先在内存里升级，
	 *   再显式写成 v2 新文件（`<书名>.<原扩展名>.annotations.json`），
	 *   **旧文件永不删除、永不改写**。
	 */
	private async loadAnnotations(): Promise<void> {
		const book = this.book;
		const file = this.file;
		if (!book || !file) return;
		if (book.format === "pdf" && this.pdfInline) {
			this.annotations = await this.pdfInline.list(book.fingerprint);
			return;
		}
		const result = await this.sidecar.readWithReport(file.path, book.fingerprint);
		this.annotations = result.annotations;
		if (result.source === "v1-migrated" && result.migrated > 0) {
			try {
				await this.sidecar.ensureV2(file.path, result.annotations, book.fingerprint);
			} catch (e) {
				// 写 v2 失败不影响阅读：内存里已有可用的批注，旧文件也没被碰过
				console.debug("[NyaReader] 生成 v2 侧车失败（旧批注文件保持原样）", e);
			}
			try {
				this.events.onAnnotationMigration?.(result.migrated);
			} catch {
				/* 视图层问题不影响阅读 */
			}
		}
	}

	/** 把内存镜像里的批注转成引擎高亮输入。 */
	private toEngineHighlight(annotation: Annotation): EngineHighlight {
		return {
			id: annotation.id,
			anchor: annotation.anchor ?? anchorFromLegacy(annotation.location, annotation.text),
			color: normalizeHighlightColor(annotation.color),
			hasNote: !!annotation.note,
			text: annotation.text,
		};
	}

	/**
	 * 全量重放高亮（打开书/增删改后调用），并把引擎的**定位降级结果**回写到批注上
	 * （`approximate` / `anchorResolvedBy`），供面板标注"位置可能不准"。
	 */
	private applyHighlights(): void {
		const engine = this.engine;
		if (!engine?.setHighlights) return;
		engine.setHighlights(this.annotations.map((a) => this.toEngineHighlight(a)));
		const placements = engine.getHighlightPlacements?.() ?? [];
		if (!placements.length) return;
		const byId = new Map(placements.map((p) => [p.id, p]));
		for (const annotation of this.annotations) {
			const placement = byId.get(annotation.id);
			if (!placement) continue;
			annotation.approximate = placement.approximate;
			annotation.anchorResolvedBy = placement.quality;
		}
	}

	/**
	 * 用当前选区生成锚点（三层冗余）。
	 *
	 * 首选引擎的 `getSelectionAnchor()`（引擎最懂 DOM：章节锚点 / 段落索引 / 字符区间）；
	 * 引擎不支持或拿不到结构信息时降级为「纯文本指纹 + 进度」，并把 `approximate` 标出来。
	 */
	private buildSelectionAnchor(
		sel: { text: string; target?: AnnotationTarget },
		pageIndexHint?: number,
		progression?: number
	): { anchor: AnnotationAnchor; approximate: boolean } {
		const engine = this.engine;
		const draft = engine?.getSelectionAnchor?.() ?? null;
		if (draft) {
			return {
				anchor: createAnchor({
					...draft,
					progression: draft.progression ?? progression ?? engine?.currentPercentage() ?? 0,
				}),
				approximate: draft.approximate === true,
			};
		}
		if (this.book?.format === "pdf" && pageIndexHint !== undefined) {
			// PDF：结构定位是页码；几何坐标已由 target.rects 另行保存（PdfEngine overlay 用）
			return {
				anchor: createAnchor({
					kind: "pdf",
					primary: String(pageIndexHint + 1),
					quote: quoteFromText(sel.text),
					progression: progression ?? 0,
				}),
				approximate: false,
			};
		}
		// 兜底：没有结构定位，只能靠指纹 + 进度（重开书后靠指纹在正文里搜回来）
		return {
			anchor: createAnchor({
				kind: "chapter",
				primary: engine?.currentLocation() ?? "",
				quote: quoteFromText(sel.text),
				progression: progression ?? engine?.currentPercentage() ?? 0,
			}),
			approximate: true,
		};
	}

	/**
	 * TXT 渲染内容：复用解析阶段已完成的解码/切段结果（loadTxtContent 按 buffer 身份缓存），
	 * 不再出现"解析器一份 + 引擎一份"的两份大字符串与两个段落数组。
	 */
	private async parseTxt(): Promise<TxtContent | null> {
		if (!this.buffer) return null;
		const loaded = loadTxtContent(this.buffer);
		return { title: this.book?.title || loaded.title, paragraphs: loaded.paragraphs, chapters: loaded.chapters };
	}

	currentReaderSettings(): ReaderSettings {
		const base = this.plugin.settings.reader;
		if (this.book && this.plugin.settings.bookOverrides[this.book.fingerprint]) {
			return { ...base, ...this.plugin.settings.bookOverrides[this.book.fingerprint] };
		}
		return base;
	}

	/** 划词翻译：委托 NyaLingo 共享翻译服务，并记录翻译历史。 */
	async translateSelection(text: string, to?: string): Promise<string> {
		const result = await this.plugin.lingo.translate(text, { to });
		try {
			await this.plugin.history.add({
				sourceText: text,
				translatedText: result,
				from: this.plugin.settings.translation.sourceLanguage,
				to: to ?? this.plugin.settings.translation.targetLanguage,
				provider: "nyalingo",
				bookFingerprint: this.book?.fingerprint,
			});
		} catch {
			// 历史写入失败不影响翻译结果
		}
		return result;
	}

	/**
	 * 划词批注：PDF 写文件本体（节流合并 + 加密兜底）；其他格式写侧车 v2。
	 *
	 * @param color 六色高亮（默认 yellow）；旧调用点不传也兼容
	 */
	async addAnnotation(kind: AnnotationKind, note?: string, color: HighlightColor = "yellow"): Promise<Annotation | null> {
		if (!this.engine || !this.book || !this.file) return null;
		const sel = this.engine.getSelection() ?? this.lastSelection;
		if (!sel || !sel.text.trim()) {
			this.events.onError("请先选中要批注的文本。");
			return null;
		}
		const resolvedColor = normalizeHighlightColor(color);
		if (this.book.format === "pdf" && this.pdfInline && this.buffer) {
			return this.addPdfAnnotation(kind, note, sel.target, sel.text, resolvedColor);
		}
		const file = this.file;
		// 统一锚点：结构定位 + 文本指纹 + 进度兜底（选区内拿不到结构信息时标 approximate）
		const { anchor, approximate } = this.buildSelectionAnchor(sel, undefined, this.currentBookPercent());
		const annotation = await this.sidecar.addForBook(
			file.path,
			{
				bookFingerprint: this.book.fingerprint,
				location: this.engine.currentLocation(),
				target: sel.target ?? { location: this.engine.currentLocation(), rects: [], selectedText: sel.text },
				text: sel.text,
				kind,
				note,
				color: resolvedColor,
				anchor,
				approximate,
				anchorResolvedBy: approximate ? "progression-only" : "exact-range",
				source: "sidecar-v2",
			},
			this.book.fingerprint
		);
		this.annotations.push(annotation);
		// 立刻在正文里显示（增量添加，不必全量重放）
		this.engine.addHighlight?.(this.toEngineHighlight(annotation));
		return annotation;
	}

	/** 列出当前书籍的全部批注（PDF 用内联索引，其余用侧车；优先返回内存镜像） */
	async listAnnotations(): Promise<Annotation[]> {
		const { book, file } = this;
		if (!book || !file) return [];
		if (book.format === "pdf" && this.pdfInline) {
			return this.pdfInline.list(book.fingerprint);
		}
		if (this.annotations.length) return [...this.annotations];
		return this.sidecar.readForBook(file.path, book.fingerprint);
	}

	/** 删除批注：PDF 从文件本体移除并隐藏高亮；侧车格式从 JSON 移除。 */
	async removeAnnotation(id: string): Promise<void> {
		const { book, file } = this;
		if (!book || !file) return;
		if (book.format === "pdf" && this.pdfInline) {
			// 先把待写回的批注落盘，否则 deleteInPlace 读到的是"还没带上新批注"的文件
			await this.flushPdfWrites();
			const ann = (await this.pdfInline.list(book.fingerprint)).find((a) => a.id === id);
			if (!ann) return;
			await this.pdfInline.deleteInPlace(file.path, ann);
			this.engine?.hideAnnotation?.(ann.target);
			this.annotations = this.annotations.filter((a) => a.id !== id);
			return;
		}
		await this.sidecar.removeForBook(file.path, id, book.fingerprint);
		this.annotations = this.annotations.filter((a) => a.id !== id);
		// 侧车格式：从正文里撤掉可见高亮
		this.engine?.removeHighlight?.(id);
	}

	/** 修改笔记内容（旧入口，保留兼容）。 */
	async updateAnnotationNote(id: string, note?: string): Promise<void> {
		await this.updateAnnotation(id, { note });
	}

	/**
	 * 更新批注（笔记 / 颜色）。
	 *
	 * - 侧车格式：写 v2 侧车，并**增量更新**正文高亮（颜色变了立刻可见）；
	 * - PDF：只更新插件内联索引的元数据；PDF 文件里的 `/C` 需要重写整本，
	 *   P0 不做（与 research §4.5 的 P1 项一致），列表里仍显示新颜色。
	 */
	async updateAnnotation(id: string, patch: { note?: string; color?: HighlightColor }): Promise<void> {
		const { book, file } = this;
		if (!book || !file) return;
		const nextPatch: Partial<Pick<Annotation, "note" | "color">> = {};
		if (patch.note !== undefined) nextPatch.note = patch.note;
		if (patch.color !== undefined) nextPatch.color = normalizeHighlightColor(patch.color);
		if (book.format === "pdf" && this.pdfInline) {
			await this.pdfInline.update(id, nextPatch);
			const inMemory = this.annotations.find((a) => a.id === id);
			if (inMemory) Object.assign(inMemory, nextPatch, { updatedAt: Date.now() });
			return;
		}
		await this.sidecar.updateForBook(file.path, id, nextPatch);
		const inMemory = this.annotations.find((a) => a.id === id);
		if (inMemory) {
			Object.assign(inMemory, nextPatch, { updatedAt: Date.now() });
			this.engine?.addHighlight?.(this.toEngineHighlight(inMemory));
		}
	}

	private async addPdfAnnotation(
		kind: AnnotationKind,
		note: string | undefined,
		target: NonNullable<ReturnType<IReaderEngine["getSelection"]>>["target"],
		text: string,
		color: HighlightColor
	): Promise<Annotation | null> {
		if (!target) {
			this.events.onError("无法定位批注位置。");
			return null;
		}
		const id = `nyar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const pageIndex = (parseInt(target.location, 10) || 1) - 1;
		// 使用引擎已渲染的 viewport 与页尺寸（避免重复解析 PDF）
		const geo = this.engineGeometry();
		if (!geo) {
			this.events.onError("无法获取页面几何信息。");
			return null;
		}
		const { viewport, pageSize } = geo;
		const merged = mergeDomRects(target.rects ?? []);
		const { quad, rect } = domRectToPdfRect(merged, viewport);
		if (!isWithinPage(rect, pageSize.width, pageSize.height)) {
			this.events.onError("选中区域超出页面范围。");
			return null;
		}
		const { anchor } = this.buildSelectionAnchor({ text, target }, pageIndex, this.currentBookPercent());
		const annotation: Annotation = {
			id,
			bookFingerprint: this.book!.fingerprint,
			location: target.location,
			target,
			text,
			kind,
			note,
			color,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			anchor,
			source: "pdf-inline",
		};
		// 立即在 overlay 上显示（用户马上看到），写回文件走节流队列
		this.engine?.showAnnotation(annotation.target);
		this.pdfPending.push({
			path: this.file!.path,
			annotation,
			input: {
				id,
				pageIndex,
				kind,
				quad,
				pageWidth: pageSize.width,
				pageHeight: pageSize.height,
				text,
				note,
				color,
				author: "NyaReader",
			},
		});
		this.schedulePdfFlush();
		return annotation;
	}

	/** 排定 PDF 写回（同一本书 {@link PDF_WRITE_THROTTLE_MS} 内的多次写回合并成一批）。 */
	private schedulePdfFlush(): void {
		if (this.pdfWriteTimer) return;
		this.pdfWriteTimer = setTimeout(() => {
			this.pdfWriteTimer = null;
			void this.flushPdfWrites();
		}, PDF_WRITE_THROTTLE_MS);
	}

	/**
	 * 把待写回的 PDF 批注合并成一批写盘（一次备份 + 一次读 + 一次写）。
	 *
	 * 失败处理（数据安全优先）：
	 * - `EncryptedPDFError`（pdf-lib 对加密文档的能力硬限制）→ **不写文件**，
	 *   改存侧车（`<PDF 文件名>.annotations.json`）并明确提示用户；
	 * - 其它错误 → 不写文件、不更新索引，提示"批注暂未写入文件"，overlay 仍在。
	 */
	private async flushPdfWrites(): Promise<void> {
		if (this.pdfWriting) return;
		const batch = this.pdfPending.splice(0, this.pdfPending.length);
		if (!batch.length) return;
		const store = this.pdfInline;
		const path = batch[0].path;
		if (!store) return;
		// 切书竞态保护：写回是异步的，期间用户可能已经打开了别的书；
		// 完成回调里只在"仍然是同一本书"时更新内存镜像。
		const owner = this.book?.fingerprint ?? "";
		const sameBook = (): boolean => !!owner && this.book?.fingerprint === owner;
		this.pdfWriting = true;
		try {
			await store.applyBatchAndWrite(path, batch.map((b) => b.input));
			for (const item of batch) {
				await store.add(item.annotation);
				if (sameBook() && !this.annotations.some((a) => a.id === item.annotation.id)) this.annotations.push(item.annotation);
			}
		} catch (e) {
			if (this.isEncryptedPdfError(e)) {
				// 加密 PDF：改存侧车，行为可见、数据不丢
				let saved = 0;
				for (const item of batch) {
					try {
						const fallback = await this.sidecar.addForBook(
							path,
							{
								bookFingerprint: item.annotation.bookFingerprint,
								location: item.annotation.location,
								target: item.annotation.target,
								text: item.annotation.text,
								kind: item.annotation.kind,
								note: item.annotation.note,
								color: normalizeHighlightColor(item.annotation.color),
								anchor: item.annotation.anchor,
								approximate: item.annotation.approximate,
								anchorResolvedBy: item.annotation.anchorResolvedBy,
								source: "sidecar-v2",
							},
							item.annotation.bookFingerprint
						);
						if (sameBook() && !this.annotations.some((a) => a.id === fallback.id)) this.annotations.push(fallback);
						saved++;
					} catch {
						/* 单条落侧车失败不影响其它条目 */
					}
				}
				this.events.onError(`该 PDF 已加密，无法写入批注，已改存侧车（${saved} 条，${path}.annotations.json）。`);
			} else {
				const message = e instanceof Error ? e.message : String(e);
				this.events.onError(`PDF 批注写回失败：${message}（文件未改动，批注暂未写入 PDF）`);
			}
		} finally {
			this.pdfWriting = false;
			if (this.pdfPending.length) this.schedulePdfFlush();
		}
	}

	/** 加密 PDF 判定：pdf-lib 抛 `EncryptedPDFError`（纯函数实现见 PdfAnnotationWriter）。 */
	private isEncryptedPdfError(e: unknown): boolean {
		return isEncryptedPdfError(e);
	}

	/** 依赖 PdfEngine 已渲染当前页，直接取其 viewport 与页尺寸（pt）。 */
	private engineGeometry(): { viewport: ViewportLike; pageSize: { width: number; height: number } } | null {
		const engine = this.engine as PdfEngine | null;
		if (!engine) return null;
		const viewport = engine.getViewport();
		const pageSize = engine.getPageSizePt();
		if (!viewport || !pageSize) return null;
		return { viewport: viewport as unknown as ViewportLike, pageSize };
	}

	private async saveProgress(location: string, percentage: number): Promise<void> {
		if (!this.book) return;
		const existing = this.plugin.bookIndex.get(this.book.fingerprint);
		// 位置没变不写盘：滚动产生的重复事件不再触发磁盘写入
		if (existing?.progress?.location === location) return;
		await this.plugin.bookIndex.updateProgress(this.book.fingerprint, {
			fingerprint: this.book.fingerprint,
			format: this.book.format,
			location,
			percentage,
			updatedAt: Date.now(),
		});
	}

	async close(): Promise<void> {
		// 让仍在进行中的 openBook 全部过期（否则它会在关闭后把引擎/书籍状态又写回来）
		this.openSeq++;
		this.flushProgress();
		// 关窗前把待写回的 PDF 批注落盘（最后一道数据保护）
		await this.flushPdfWrites();
		this.teardownEngine();
		this.book = null;
		this.buffer = null;
		this.file = null;
	}
}
