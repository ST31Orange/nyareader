"use strict";
var NyarTxtLayout = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/services/books/formats/txt/TxtLayout.ts
  var TxtLayout_exports = {};
  __export(TxtLayout_exports, {
    FALLBACK_CHAR_WIDTH_RATIO: () => FALLBACK_CHAR_WIDTH_RATIO,
    clampParagraphIndex: () => clampParagraphIndex,
    createHeights: () => createHeights,
    createMeasured: () => createMeasured,
    createPrefix: () => createPrefix,
    estimateParagraphHeight: () => estimateParagraphHeight,
    fillEstimatedHeights: () => fillEstimatedHeights,
    indexAtOffset: () => indexAtOffset,
    measureCharWidthRatio: () => measureCharWidthRatio,
    rebuildPrefixFrom: () => rebuildPrefixFrom,
    totalHeight: () => totalHeight
  });
  function estimateParagraphHeight(textLength, charsPerLine, lineHeightPx, spacingPx) {
    const perLine = charsPerLine > 0 ? charsPerLine : 1;
    const lines = Math.max(1, Math.ceil(textLength / perLine));
    return lines * lineHeightPx + spacingPx;
  }
  var FALLBACK_CHAR_WIDTH_RATIO = 0.62;
  function measureCharWidthRatio(fontFamily, fontSizePx) {
    const fallback = FALLBACK_CHAR_WIDTH_RATIO;
    if (!(fontSizePx > 0)) return fallback;
    try {
      const doc = typeof document !== "undefined" ? document : null;
      if (!doc) return fallback;
      const canvas = doc.createElement("canvas");
      const ctx = canvas.getContext?.("2d");
      if (!ctx) return fallback;
      ctx.font = `${fontSizePx}px ${fontFamily || "system-ui"}`;
      const sample = "\u4E2D\u6587\u6B63\u6587\u6D4B\u8BD5\u6837\u672C\u6587\u5B57\u5185\u5BB9abc123\uFF0C\u3002\uFF01";
      const width = ctx.measureText(sample).width;
      if (!(width > 0)) return fallback;
      const perChar = width / sample.length / fontSizePx;
      return Math.min(1.4, Math.max(0.3, perChar));
    } catch {
      return fallback;
    }
  }
  function createHeights(count) {
    return new Float64Array(Math.max(0, count));
  }
  function createPrefix(count) {
    return new Float64Array(Math.max(0, count) + 1);
  }
  function createMeasured(count) {
    return new Uint8Array(Math.max(0, count));
  }
  function fillEstimatedHeights(paragraphs, heights, charsPerLine, lineHeightPx, spacingPx) {
    const n = Math.min(paragraphs.length, heights.length);
    for (let i = 0; i < n; i++) {
      heights[i] = estimateParagraphHeight(paragraphs[i].length, charsPerLine, lineHeightPx, spacingPx);
    }
  }
  function rebuildPrefixFrom(heights, prefix, count, from) {
    const start = Math.max(0, Math.min(count, Math.floor(from)));
    prefix[0] = 0;
    for (let i = start; i < count; i++) {
      prefix[i + 1] = prefix[i] + heights[i];
    }
  }
  function totalHeight(prefix, count) {
    if (count <= 0) return 0;
    return prefix[count] ?? 0;
  }
  function indexAtOffset(prefix, count, offset) {
    if (count <= 0) return 0;
    let lo = 0;
    let hi = count - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
      if ((prefix[mid] ?? 0) <= offset) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }
  function clampParagraphIndex(index, count) {
    if (count <= 0) return 0;
    if (!Number.isFinite(index)) return 0;
    return Math.max(0, Math.min(count - 1, Math.floor(index)));
  }
  return __toCommonJS(TxtLayout_exports);
})();
