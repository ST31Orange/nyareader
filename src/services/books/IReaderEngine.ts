/**
 * 阅读引擎统一接口。
 * 各格式（EPUB/PDF/MOBi/AZW3/TXT）实现此接口，视图层只与接口通信，
 * 保证引擎可替换、可单测。
 */
import type { BookModel, ReaderSettings } from "../../types";

/** 渲染引擎对外暴露的最小事件集合 */
export interface ReaderEngineEvents {
	/** 位置变化（翻页/滚动/跳转后触发），用于保存进度 */
	locationChanged: { location: string; percentage: number };
	/** 用户产生文本选区 */
	selection: { text: string; rect?: DOMRect };
	/** 渲染出错 */
	error: { message: string };
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
	/** 获取需要加载的附加资源（pdf worker 等），由主插件统一初始化 */
	on<E extends ReaderEngineEventName>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void;
	off<E extends ReaderEngineEventName>(event: E, handler: (payload: ReaderEngineEvents[E]) => void): void;
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


