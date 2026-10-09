"use strict";
var NyarPdfViewport = (() => {
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

  // src/utils/pdf-viewport.ts
  var pdf_viewport_exports = {};
  __export(pdf_viewport_exports, {
    computeRowTops: () => computeRowTops,
    findVisibleRange: () => findVisibleRange,
    lowerBound: () => lowerBound,
    pageIndexAtMidpoint: () => pageIndexAtMidpoint,
    pageSizeFromViewport: () => pageSizeFromViewport,
    scrollTopForPage: () => scrollTopForPage,
    shiftTopsAfter: () => shiftTopsAfter
  });
  function computeRowTops(heights, layout) {
    const n = heights.length;
    const tops = new Array(n);
    const cols = Math.max(1, Math.floor(layout.cols));
    const gap = Math.max(0, layout.gap);
    let y = Math.max(0, layout.contentTop);
    for (let i = 0; i < n; i += cols) {
      let rowHeight = 0;
      for (let k = i; k < Math.min(n, i + cols); k++) rowHeight = Math.max(rowHeight, heights[k] || 0);
      for (let k = i; k < Math.min(n, i + cols); k++) tops[k] = y;
      y += rowHeight + gap;
    }
    return tops;
  }
  function shiftTopsAfter(tops, heights, changed, delta, layout) {
    const n = tops.length;
    if (changed < 0 || changed >= n || delta === 0) return 0;
    const cols = Math.max(1, Math.floor(layout.cols));
    const rowStart = changed - changed % cols;
    const rowEnd = Math.min(n, rowStart + cols);
    let affected = 0;
    for (let i = rowEnd; i < n; i++) {
      tops[i] += delta;
      affected++;
    }
    return affected;
  }
  function lowerBound(pages, y) {
    if (pages.length === 0) return 0;
    let lo = 0;
    let hi = pages.length - 1;
    let ans = pages.length - 1;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
      const page = pages[mid];
      if (page.top + page.height >= y) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return ans;
  }
  function findVisibleRange(pages, scrollTop, viewportHeight, margin) {
    if (pages.length === 0) return [0, -1];
    const top = scrollTop - margin;
    const bottom = scrollTop + viewportHeight + margin;
    const from = lowerBound(pages, top);
    let to = from;
    while (to + 1 < pages.length && pages[to + 1].top <= bottom) to++;
    return [from, to];
  }
  function pageIndexAtMidpoint(pages, scrollTop, viewportHeight) {
    if (pages.length === 0) return 0;
    return lowerBound(pages, scrollTop + viewportHeight / 2);
  }
  function scrollTopForPage(page, viewportHeight) {
    return Math.max(0, Math.round(page.top - Math.max(0, (viewportHeight - page.height) / 2)));
  }
  function pageSizeFromViewport(viewport, viewWidth, viewHeight) {
    const [x0, y0] = viewport.convertToPdfPoint(0, 0);
    const [x1, y1] = viewport.convertToPdfPoint(viewWidth, viewHeight);
    return { width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  }
  return __toCommonJS(pdf_viewport_exports);
})();
