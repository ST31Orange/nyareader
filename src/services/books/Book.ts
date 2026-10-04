/**
 * BookModel 工厂：由解析结果创建，持有书籍打开句柄。
 * 实际打开流程：Parser.parse -> BookModel；引擎随后按 format 创建。
 */
import type { BookModel } from "../../types";

export class Book {
	constructor(readonly model: BookModel) {}

	get title(): string {
		return this.model.title;
	}

	get format(): string {
		return this.model.format;
	}

	/** 依据目录条目构造跳转用的位置列表（供 TocPanel 展示）。 */
	tocLocations(): string[] {
		const out: string[] = [];
		const walk = (items: BookModel["toc"]) => {
			for (const item of items) {
				if (item.location) out.push(item.location);
				if (item.children) walk(item.children);
			}
		};
		walk(this.model.toc);
		return out;
	}
}
