/**
 * 批注排序（纯函数，便于单测）。
 *
 * 为什么不放在 `AnnotationListModal.ts`：那里 import 了 `obsidian`，
 * 而 `obsidian` 是 Obsidian 运行时提供的虚拟包，单元测试环境无法解析。
 * 纯逻辑放这里，UI 与测试都引用它。
 */
import type { Annotation } from "../services/annotations/AnnotationModel";

export type AnnotationSortKey = "position" | "created" | "created-desc";

export const ANNOTATION_SORT_LABEL: Record<AnnotationSortKey, string> = {
	position: "按位置",
	created: "按时间（旧→新）",
	"created-desc": "按时间（新→旧）",
};

/** location 是否为纯数值（PDF 页码 / TXT 段索引 / HTML 百分比），否则 null。 */
export function numericLocation(a: Annotation): number | null {
	const raw = a.location;
	if (typeof raw !== "string" || !raw) return null;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : null;
}

/**
 * 批注排序。
 * - `position`：书内位置（location 数值升序；无位置信息的排最后并保持时间序）；
 * - `created` / `created-desc`：创建时间。
 *
 * 纯函数：不修改入参数组。
 */
export function sortAnnotations(list: readonly Annotation[], key: AnnotationSortKey): Annotation[] {
	const out = [...list];
	if (key === "created") return out.sort((a, b) => a.createdAt - b.createdAt);
	if (key === "created-desc") return out.sort((a, b) => b.createdAt - a.createdAt);
	return out.sort((a, b) => {
		const pa = numericLocation(a);
		const pb = numericLocation(b);
		if (pa === null && pb === null) return a.createdAt - b.createdAt;
		if (pa === null) return 1; // 无位置信息的排最后
		if (pb === null) return -1;
		if (pa !== pb) return pa - pb;
		return a.createdAt - b.createdAt;
	});
}
