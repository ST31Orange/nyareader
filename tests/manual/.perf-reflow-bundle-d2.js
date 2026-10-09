"use strict";
var NyarEngine = (() => {
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

  // src/services/books/formats/mobi/HtmlDocEngine.ts
  var HtmlDocEngine_exports = {};
  __export(HtmlDocEngine_exports, {
    HtmlDocEngine: () => HtmlDocEngine
  });

  // src/services/books/IReaderEngine.ts
  var SimpleReaderEmitter = class {
    constructor() {
      this.listeners = /* @__PURE__ */ new Map();
    }
    on(event, handler) {
      let set = this.listeners.get(event);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        this.listeners.set(event, set);
      }
      set.add(handler);
    }
    off(event, handler) {
      this.listeners.get(event)?.delete(handler);
    }
    emit(event, payload) {
      this.listeners.get(event)?.forEach((h) => h(payload));
    }
    clear() {
      this.listeners.clear();
    }
  };

  // src/types.ts
  var DEFAULT_READER_SETTINGS = {
    fontFamily: "system-ui",
    fontSize: 18,
    lineHeight: 1.8,
    margin: 24,
    theme: "light",
    layout: "single",
    scrollMode: false,
    // 正文栏宽上限（px）：420 在 900px 以上窗口一行只有约 27 个汉字，偏窄；
    // 640 约 40 汉字/行，接近业界 45–75 字符的舒适阅读区间。
    pageWidth: 640
  };

  // src/utils/text.ts
  function normalizeSelectionText(text) {
    return text.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").replace(/\n+/g, " ").replace(/[ \t]+/g, " ").trim();
  }

  // src/services/annotations/AnnotationAnchor.ts
  var ANCHOR_NORMALIZATION = "nyar-nfc-ws1-utf16-v1";
  var DEFAULT_QUOTE_CONTEXT = 32;
  var MIN_FUZZY_QUOTE_LENGTH = 8;
  var ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff]/;
  var WHITESPACE_RE = /\s/;
  var COMBINING_RE = /\p{M}/u;
  function clamp01(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }
  function normalizeAnchorText(input) {
    return normalizeWithIndex(input).text;
  }
  function normalizeWithIndex(input) {
    const starts = [];
    const ends = [];
    let out = "";
    let pendingSpace = false;
    let wsStart = 0;
    let wsEnd = 0;
    let i = 0;
    while (i < input.length) {
      const code = input.codePointAt(i);
      if (code === void 0) break;
      const size = code > 65535 ? 2 : 1;
      let groupEnd = i + size;
      while (groupEnd < input.length) {
        const next = input.codePointAt(groupEnd);
        if (next === void 0) break;
        const nextChar = String.fromCodePoint(next);
        if (!COMBINING_RE.test(nextChar)) break;
        groupEnd += nextChar.length;
      }
      const groupStart = i;
      const raw = input.slice(i, groupEnd);
      i = groupEnd;
      const nfc = raw.normalize("NFC");
      if (!nfc) continue;
      if (nfc.length === 1 && ZERO_WIDTH_RE.test(nfc)) continue;
      if (WHITESPACE_RE.test(nfc)) {
        if (pendingSpace) wsEnd = groupEnd;
        else {
          pendingSpace = true;
          wsStart = groupStart;
          wsEnd = groupEnd;
        }
        continue;
      }
      if (pendingSpace) {
        if (out.length > 0) {
          out += " ";
          starts.push(wsStart);
          ends.push(wsEnd);
        }
        pendingSpace = false;
      }
      for (let k = 0; k < nfc.length; k++) {
        out += nfc[k];
        starts.push(groupStart);
        ends.push(groupEnd);
      }
    }
    return { text: out, starts, ends };
  }
  function buildTextQuote(fullText, start, end, context = DEFAULT_QUOTE_CONTEXT) {
    const from = Math.max(0, Math.min(start, fullText.length));
    const to = Math.max(from, Math.min(end, fullText.length));
    const ctx = Math.max(0, context);
    return {
      exact: fullText.slice(from, to),
      prefix: fullText.slice(Math.max(0, from - ctx), from),
      suffix: fullText.slice(to, Math.min(fullText.length, to + ctx))
    };
  }
  function quoteFromText(text) {
    return { exact: text ?? "", prefix: "", suffix: "" };
  }
  function allOccurrences(haystack, needle) {
    const hits = [];
    if (!needle) return hits;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
      hits.push(at);
      if (hits.length > 64) break;
    }
    return hits;
  }
  function compactIndexOf(norm) {
    let out = "";
    const map = [];
    for (let i = 0; i < norm.text.length; i++) {
      const ch = norm.text[i];
      if (WHITESPACE_RE.test(ch)) continue;
      out += ch;
      map.push(i);
    }
    return { text: out, map };
  }
  function stripWhitespace(input) {
    let out = "";
    for (const ch of input) {
      if (!WHITESPACE_RE.test(ch)) out += ch;
    }
    return out;
  }
  var MIN_COMPACT_QUOTE_LENGTH = 4;
  function commonSuffixLen(a, b) {
    let n = 0;
    const max = Math.min(a.length, b.length);
    while (n < max && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }
  function commonPrefixLen(a, b) {
    let n = 0;
    const max = Math.min(a.length, b.length);
    while (n < max && a[n] === b[n]) n++;
    return n;
  }
  function contextScore(norm, hit, needleLen, prefix, suffix) {
    const before = norm.slice(0, hit);
    const after = norm.slice(hit + needleLen);
    return commonSuffixLen(prefix, before) + commonPrefixLen(suffix, after);
  }
  function fuzzyRange(haystack, needle, segLen) {
    const head = needle.slice(0, segLen);
    const tail = needle.slice(-segLen);
    const headAt = haystack.indexOf(head);
    if (headAt < 0) return null;
    const searchFrom = headAt + head.length;
    const windowEnd = Math.min(haystack.length, headAt + needle.length * 3 + DEFAULT_QUOTE_CONTEXT);
    const rel = haystack.slice(searchFrom, windowEnd).indexOf(tail);
    if (rel >= 0) return { start: headAt, end: searchFrom + rel + tail.length - 1, matchedTail: true };
    return { start: headAt, end: headAt + head.length - 1, matchedTail: false };
  }
  function mapCompactFuzzy(compact, needleCompact, segLen) {
    const hit = fuzzyRange(compact.text, needleCompact, segLen);
    if (!hit) return null;
    const s = compact.map[hit.start];
    const e = compact.map[hit.end];
    if (s === void 0 || e === void 0) return null;
    return { start: s, end: e, matchedTail: hit.matchedTail };
  }
  function locateInText(text, anchor, opts = {}) {
    const progression = clamp01(anchor.progression);
    const base = { progression, normalization: ANCHOR_NORMALIZATION };
    if (typeof text !== "string" || text.length === 0) {
      return { ...base, quality: "progression-only", approximate: true, reason: "\u76EE\u6807\u6587\u672C\u4E3A\u7A7A\uFF08\u7AE0\u8282/\u6BB5\u843D\u5C1A\u672A\u52A0\u8F7D\uFF09\uFF0C\u53EA\u80FD\u6309\u8FDB\u5EA6\u5B9A\u4F4D" };
    }
    const exact = normalizeAnchorText(anchor.quote?.exact ?? "");
    const start = anchor.charStart;
    const end = anchor.charEnd;
    if (typeof start === "number" && typeof end === "number" && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length) {
      const slice = text.slice(start, end);
      if (!exact || normalizeAnchorText(slice) === exact) {
        return {
          ...base,
          quality: "exact-range",
          approximate: false,
          reason: "\u7ED3\u6784\u5B9A\u4F4D\uFF08\u7AE0\u8282/\u6BB5\u843D\u5B57\u7B26\u533A\u95F4\uFF09\u76F4\u63A5\u547D\u4E2D",
          start,
          end,
          matchedText: slice
        };
      }
    }
    if (exact) {
      const norm = normalizeWithIndex(text);
      const rangeFromNorm = (s, e) => ({ start: norm.starts[s], end: norm.ends[e] });
      const compact = compactIndexOf(norm);
      const needleCompact = stripWhitespace(exact);
      const collect = () => {
        const hits2 = [];
        for (const at of allOccurrences(norm.text, exact)) {
          hits2.push({ normStart: at, normEnd: at + exact.length - 1, via: "exact" });
        }
        if (hits2.length) return hits2;
        if (needleCompact.length >= MIN_COMPACT_QUOTE_LENGTH) {
          for (const at of allOccurrences(compact.text, needleCompact)) {
            const last = at + needleCompact.length - 1;
            if (compact.map[at] === void 0 || compact.map[last] === void 0) continue;
            hits2.push({ normStart: compact.map[at], normEnd: compact.map[last], via: "compact" });
          }
        }
        return hits2;
      };
      const hits = collect();
      const describe = (hit) => hit.via === "compact" ? "\u6587\u672C\u6307\u7EB9\u552F\u4E00\u547D\u4E2D\uFF08\u5FFD\u7565\u7A7A\u767D\u5DEE\u5F02\uFF09" : "\u7ED3\u6784\u5B9A\u4F4D\u5931\u6548\uFF0C\u6587\u672C\u6307\u7EB9\u552F\u4E00\u547D\u4E2D";
      if (hits.length === 1) {
        const { start: s, end: e } = rangeFromNorm(hits[0].normStart, hits[0].normEnd);
        return {
          ...base,
          quality: "quote-unique",
          approximate: false,
          reason: describe(hits[0]),
          start: s,
          end: e,
          matchedText: text.slice(s, e)
        };
      }
      if (hits.length > 1) {
        const prefix = normalizeAnchorText(anchor.quote?.prefix ?? "");
        const suffix = normalizeAnchorText(anchor.quote?.suffix ?? "");
        let best = hits[0];
        let bestScore = -1;
        for (const hit of hits) {
          const score = contextScore(norm.text, hit.normStart, hit.normEnd - hit.normStart + 1, prefix, suffix);
          if (score > bestScore + 1e-9) {
            bestScore = score;
            best = hit;
          }
        }
        const { start: s, end: e } = rangeFromNorm(best.normStart, best.normEnd);
        return {
          ...base,
          quality: "quote-first",
          approximate: true,
          reason: `\u6587\u672C\u6307\u7EB9\u547D\u4E2D ${hits.length} \u5904\uFF0C\u6309\u524D\u540E\u6587\u6253\u5206\u53D6\u5176\u4E2D\u4E4B\u4E00\uFF08\u53EF\u80FD\u4E0D\u662F\u539F\u4F4D\u7F6E\uFF09`,
          start: s,
          end: e,
          matchedText: text.slice(s, e)
        };
      }
      if (opts.allowFuzzy !== false && exact.length >= MIN_FUZZY_QUOTE_LENGTH) {
        const fuzzy = fuzzyRange(norm.text, exact, MIN_FUZZY_QUOTE_LENGTH) ?? (needleCompact.length >= MIN_FUZZY_QUOTE_LENGTH ? mapCompactFuzzy(compact, needleCompact, MIN_FUZZY_QUOTE_LENGTH) : null);
        if (fuzzy) {
          const { start: s, end: e } = rangeFromNorm(fuzzy.start, fuzzy.end);
          return {
            ...base,
            quality: "quote-first",
            approximate: true,
            reason: fuzzy.matchedTail ? "\u6307\u7EB9\u672A\u5B8C\u5168\u547D\u4E2D\uFF0C\u6309\u9996\u5C3E\u7247\u6BB5\u6A21\u7CCA\u547D\u4E2D\uFF08\u539F\u6587\u53EF\u80FD\u5DF2\u88AB\u6539\u52A8\uFF09" : "\u6307\u7EB9\u672A\u547D\u4E2D\uFF0C\u4EC5\u9996\u7247\u6BB5\u547D\u4E2D\uFF08\u4F4D\u7F6E\u4E0D\u53EF\u9760\uFF09",
            start: s,
            end: e,
            matchedText: text.slice(s, e)
          };
        }
      }
    }
    return {
      ...base,
      quality: "progression-only",
      approximate: true,
      reason: exact ? "\u7ED3\u6784\u5B9A\u4F4D\u4E0E\u6587\u672C\u6307\u7EB9\u5747\u672A\u547D\u4E2D\uFF0C\u53EA\u80FD\u6309\u5168\u4E66\u8FDB\u5EA6\u8DF3\u8F6C\uFF08\u65E0\u6CD5\u753B\u9AD8\u4EAE\uFF09" : "\u65E0\u6587\u672C\u6307\u7EB9\uFF0C\u53EA\u80FD\u6309\u5168\u4E66\u8FDB\u5EA6\u8DF3\u8F6C\uFF08\u65E0\u6CD5\u753B\u9AD8\u4EAE\uFF09"
    };
  }

  // src/services/books/formats/html/HighlightLayer.ts
  var COLOR_BG = {
    yellow: "rgba(255, 226, 92, 0.55)",
    green: "rgba(126, 231, 152, 0.55)",
    blue: "rgba(126, 187, 255, 0.55)",
    pink: "rgba(255, 158, 194, 0.55)",
    purple: "rgba(196, 160, 255, 0.55)",
    orange: "rgba(255, 196, 120, 0.6)"
  };
  var COLOR_UNDERLINE = {
    yellow: "#d9b800",
    green: "#1f9d4d",
    blue: "#2f6fd0",
    pink: "#d0447c",
    purple: "#7b52d3",
    orange: "#c97a12"
  };
  var HighlightLayer = class {
    constructor(host) {
      this.host = host;
      this.styleEl = null;
      this.highlightCtor = null;
      this.registry = null;
      this.highlightsByColor = /* @__PURE__ */ new Map();
      this.items = [];
      this.placementsById = /* @__PURE__ */ new Map();
      this.order = [];
      this.resolved = [];
      this.regionIndex = /* @__PURE__ */ new Map();
      this.regionsCache = [];
      this.textCache = /* @__PURE__ */ new Map();
      this.docIndex = null;
      this.stamp = -1;
      this.clickHandler = null;
      this.disposed = false;
      this.onDocClick = (e) => this.handleClick(e);
      const root = host.documentRoot();
      this.doc = root?.ownerDocument ?? document;
      this.win = this.doc.defaultView ?? window;
      const capable = this.win;
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
    get usesHighlightApi() {
      return this.registry !== null && this.highlightCtor !== null;
    }
    setClickHandler(handler) {
      this.clickHandler = handler;
    }
    /** 全量设置（重开书/增删改后调用）并立即重新解析、重绘。 */
    setHighlights(list) {
      this.items = list.map((h) => ({ ...h }));
      this.order = this.items.map((h) => h.id);
      this.render();
    }
    /** 增量添加（同 id 覆盖）。 */
    addHighlight(highlight) {
      const idx = this.items.findIndex((h) => h.id === highlight.id);
      if (idx >= 0) this.items[idx] = { ...highlight };
      else {
        this.items.push({ ...highlight });
        this.order.push(highlight.id);
      }
      this.render();
    }
    removeHighlight(id) {
      this.items = this.items.filter((h) => h.id !== id);
      this.order = this.order.filter((x) => x !== id);
      this.render();
    }
    /** 当前已设置的高亮（副本）。 */
    list() {
      return this.items.map((h) => ({ ...h }));
    }
    /** 最近一次解析结果（按设置顺序）。 */
    placements() {
      return this.order.map((id) => this.placementsById.get(id)).filter((p) => !!p);
    }
    /** 当前渲染出的高亮片段数（诊断/测试断言用）。 */
    renderedCount() {
      return this.resolved.length;
    }
    /** 让缓存失效（结构变化后调用；`render()` 内部也会比对 `structureStamp`）。 */
    markStale() {
      this.regionsCache = [];
      this.regionIndex.clear();
      this.textCache.clear();
      this.docIndex = null;
    }
    /** 重新解析并重绘（改字号/切单双页/切滚动分页/补章之后调用）。 */
    refresh() {
      this.render();
    }
    /**
     * 跳转到某条高亮：能解析就滚到命中位置，不能解析就按 `progression` 兜底。
     * **只在用户显式跳转时调用** —— 渲染过程绝不自动跳转，否则几十条降级批注会互相抢视口。
     */
    focus(id) {
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
    caretAt(x, y) {
      const doc = this.doc;
      let node = null;
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
    offsetWithinRegion(region, node, nodeOffset) {
      let acc = 0;
      for (const root of region.nodes) {
        if (root === node) return acc + nodeOffset;
        if (!root.contains(node)) {
          acc += root.textContent?.length ?? 0;
          continue;
        }
        const walker = this.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const t = walker.currentNode;
          if (t === node) return acc + nodeOffset;
          acc += t.data.length;
        }
        return null;
      }
      return null;
    }
    handleClick(e) {
      const handler = this.clickHandler;
      if (!handler) return;
      const target = e.target;
      const spanId = target && typeof target.closest === "function" ? target.closest(".nyar-hl")?.getAttribute("data-nyar-hl-id") : null;
      if (spanId) {
        handler(spanId);
        return;
      }
      if (!this.usesHighlightApi) return;
      const at = this.caretAt(e.clientX, e.clientY);
      if (!at) return;
      const hit = this.resolved.find((r) => r.space === "region" && r.regionKey === at.regionKey && at.offset >= r.start && at.offset < r.end);
      if (hit) handler(hit.id);
    }
    // ---------- 渲染 ----------
    render() {
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
      this.regionIndex = /* @__PURE__ */ new Map();
      for (const region of this.regionsCache) {
        if (!this.regionIndex.has(region.key)) this.regionIndex.set(region.key, region);
        if (region.paraIndex !== void 0) {
          const byPara = `#${region.paraIndex}`;
          if (!this.regionIndex.has(byPara)) this.regionIndex.set(byPara, region);
        }
      }
      for (const item of this.items) {
        const anchor = item.anchor;
        const region = this.findRegion(anchor);
        let placement = null;
        if (region) {
          const located = locateInText(this.regionText(region), anchor);
          if (located.start !== void 0 && located.end !== void 0) {
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
          const found = this.findInDocument(anchor);
          if (found) {
            this.paint(item, found.range);
            this.resolved.push({ id: item.id, space: "doc", regionKey: "#doc", start: found.start, end: found.end });
            placement = { id: item.id, quality: "quote-unique", approximate: false, reason: "\u76EE\u6807\u7AE0\u8282\u4E0D\u5728\u5F53\u524D\u5E03\u5C40\u533A\uFF0C\u5DF2\u6309\u6574\u7BC7\u6587\u672C\u6307\u7EB9\u547D\u4E2D", rendered: true };
          } else {
            placement = {
              id: item.id,
              quality: "progression-only",
              approximate: true,
              // "不在布局区"（按章独立分页的冷区）与"尚未加载"（懒加载）都要如实说明，
              // 并告诉调用方**怎么恢复**：补章 / 该章进入布局 / 滚动到该处，然后调 refresh()
              reason: "\u76EE\u6807\u7AE0\u8282/\u6BB5\u843D\u5F53\u524D\u4E0D\u5728\u5E03\u5C40\u533A\u6216\u5C1A\u672A\u52A0\u8F7D\uFF0C\u6682\u65F6\u53EA\u80FD\u6309\u8FDB\u5EA6\u5B9A\u4F4D\uFF08\u8865\u7AE0\u3001\u8BE5\u7AE0\u8FDB\u5165\u5E03\u5C40\u6216\u6EDA\u52A8\u5230\u8BE5\u5904\u540E\u4F1A\u81EA\u52A8\u91CD\u65B0\u5E94\u7528\uFF09",
              rendered: false
            };
          }
        }
        this.placementsById.set(item.id, placement);
      }
    }
    findRegion(anchor) {
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
    regionText(region) {
      const key = `t:${region.key}:${region.nodes.length}`;
      const cached = this.textCache.get(key);
      if (cached !== void 0) return cached;
      const text = region.nodes.map((n) => n.textContent ?? "").join("");
      this.textCache.set(key, text);
      return text;
    }
    /** 把「区域内字符偏移」换算成 DOM Range。 */
    rangeWithinRegion(region, start, end) {
      const parts = [];
      let acc = 0;
      for (const root of region.nodes) {
        const walker = this.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const t = walker.currentNode;
          const len = t.data.length;
          if (len) parts.push({ node: t, start: acc, end: acc + len });
          acc += len;
        }
      }
      return this.rangeFromParts(parts, start, end);
    }
    rangeFromParts(parts, start, end) {
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
    findInDocument(anchor) {
      const index = this.ensureDocIndex();
      if (!index) return null;
      const located = locateInText(index.text, anchor);
      if (located.start === void 0 || located.end === void 0) return null;
      const range = this.rangeFromParts(index.spans, located.start, located.end);
      if (!range) return null;
      return { range, start: located.start, end: located.end };
    }
    ensureDocIndex() {
      if (this.docIndex) return this.docIndex;
      const root = this.host.documentRoot();
      if (!root) return null;
      const spans = [];
      let text = "";
      const walker = this.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const t = walker.currentNode;
        const len = t.data.length;
        if (!len) continue;
        spans.push({ node: t, start: text.length, end: text.length + len });
        text += t.data;
      }
      this.docIndex = { text, spans };
      return this.docIndex;
    }
    // ---------- 绘制 / 清理 ----------
    paint(item, range) {
      if (this.usesHighlightApi) {
        const registry = this.registry;
        let highlight = this.highlightsByColor.get(item.color);
        if (!highlight) {
          highlight = new this.highlightCtor();
          this.highlightsByColor.set(item.color, highlight);
          registry.set(`nyar-hl-${item.color}`, highlight);
        }
        highlight.add(range);
      } else {
        this.wrapRange(range, item.id, item.color);
      }
    }
    clearVisuals() {
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
    unwrapSpans() {
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
    wrapRange(range, id, color) {
      const container = range.commonAncestorContainer;
      const root = container.nodeType === 3 ? container.parentNode : container;
      if (!root) return;
      const nodes = [];
      const walker = this.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const t = walker.currentNode;
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
    rangeOf(id) {
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
    installStyle() {
      const style = this.doc.createElement("style");
      style.id = "nyar-hl-style";
      const rules = [];
      for (const color of Object.keys(COLOR_BG)) {
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
    dispose() {
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
    diagnostics() {
      const placements = this.placements();
      return {
        supportsHighlightApi: this.usesHighlightApi,
        items: this.items.length,
        rendered: this.resolved.length,
        approximate: placements.filter((p) => p.approximate).length,
        pending: placements.filter((p) => p.rendered === false).length
      };
    }
  };

  // src/services/books/formats/html/paging-layout.ts
  var GUTTER_SINGLE = 40;
  var GUTTER_DOUBLE = 30;
  var PAGE_MARGIN_X_SINGLE = 28;
  var PAGE_MARGIN_X_DOUBLE = 18;
  var BOOK_MARGIN = 10;
  var SAFETY = 4;
  var MIN_SPREAD_WIDTH = 640;
  var MIN_SPREAD_PAGE_WIDTH = 300;
  var MIN_PAGE_WIDTH = 120;
  var MAX_PAGE_WIDTH = 1400;
  var MIN_PAGE_HEIGHT = 120;
  var IMAGE_HEIGHT_RESERVE = 8;
  function computePageLayout(input) {
    const availW = Math.max(MIN_PAGE_WIDTH, Math.floor(input.viewWidth - (BOOK_MARGIN + SAFETY) * 2));
    const availH = Math.max(MIN_PAGE_HEIGHT, Math.floor(input.viewHeight - (BOOK_MARGIN + SAFETY) * 2));
    const widthForDouble = (availW - GUTTER_DOUBLE) / 2 - PAGE_MARGIN_X_DOUBLE * 2;
    const double = input.double && availW >= MIN_SPREAD_WIDTH && widthForDouble >= MIN_SPREAD_PAGE_WIDTH;
    const gutter = double ? GUTTER_DOUBLE : GUTTER_SINGLE;
    const pageMarginX = double ? PAGE_MARGIN_X_DOUBLE : PAGE_MARGIN_X_SINGLE;
    const rawWidth = double ? widthForDouble : availW - pageMarginX * 2;
    const pageWidth = clamp(Math.round(rawWidth), MIN_PAGE_WIDTH, Math.min(MAX_PAGE_WIDTH, availW));
    const pageHeight = clamp(Math.round(availH), MIN_PAGE_HEIGHT, availH);
    const bookWidth = double ? pageWidth * 2 + gutter : pageWidth;
    return {
      pageWidth,
      pageHeight,
      gutter,
      pageMarginX,
      bookWidth,
      bookHeight: pageHeight,
      double,
      columnStride: pageWidth + gutter
    };
  }
  function clamp(n, min, max) {
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }
  function columnOffsetPx(page, layout) {
    return -(Math.max(1, page) - 1) * layout.columnStride;
  }
  function alignSpreadPage(page, double) {
    const p = Math.max(1, Math.floor(page));
    if (!double) return p;
    return p % 2 === 0 ? p - 1 : p;
  }
  function pageStep(double) {
    return double ? 2 : 1;
  }
  function clampPage(page, total) {
    if (!Number.isFinite(page)) return 1;
    if (total <= 0) return 1;
    return Math.min(total, Math.max(1, Math.round(page)));
  }
  function pageFromPercent(percent, total) {
    if (!Number.isFinite(percent) || total <= 0) return 1;
    const raw = Math.round(percent / 1e4 * total) || 1;
    return clampPage(raw, total);
  }
  function percentFromPage(page, total) {
    if (total <= 0) return 0;
    const p = clampPage(page, total);
    if (p >= total) return 1e4;
    return Math.round((p - 0.5) / total * 1e4);
  }
  function pageCountFromMarker(markerLeft, layout) {
    if (!Number.isFinite(markerLeft) || layout.columnStride <= 0) return 1;
    return Math.max(1, Math.round(markerLeft / layout.columnStride) + 1);
  }
  function appendedPageCount(prevMarkerLeft, nextMarkerLeft, layout) {
    if (!Number.isFinite(prevMarkerLeft) || !Number.isFinite(nextMarkerLeft)) return 0;
    const prev = pageCountFromMarker(prevMarkerLeft, layout);
    const next = pageCountFromMarker(nextMarkerLeft, layout);
    return Math.max(0, next - prev);
  }
  function nextSettleDelayMs(now, firstPendingAt, settleMs, maxHoldMs) {
    if (!Number.isFinite(now) || !Number.isFinite(firstPendingAt) || firstPendingAt <= 0) return 0;
    const byHold = firstPendingAt + maxHoldMs - now;
    return Math.max(0, Math.min(settleMs, byHold));
  }
  function round2(n) {
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }
  function layoutFingerprint(key) {
    return [
      round2(key.fontSize),
      round2(key.lineHeight),
      String(key.fontFamily ?? ""),
      round2(key.pageWidth),
      round2(key.pageHeight),
      round2(key.gutter),
      round2(key.pageMarginX),
      key.double ? "d" : "s"
    ].join("|");
  }
  var FALLBACK_CHARS_PER_PAGE = 900;
  function estimatePagesFromChars(chars, charsPerPage) {
    const c = Number.isFinite(chars) && chars > 0 ? chars : 0;
    if (c <= 0) return 1;
    const per = Number.isFinite(charsPerPage) && charsPerPage > 0 ? charsPerPage : FALLBACK_CHARS_PER_PAGE;
    return Math.max(1, Math.round(c / per));
  }
  function charsPerPageFromMeasures(measures, chars, fingerprint) {
    let sumChars = 0;
    let sumPages = 0;
    for (let i = 0; i < measures.length; i++) {
      const m = measures[i];
      if (!m || m.fingerprint !== fingerprint || !(m.pages > 0)) continue;
      const c = Number.isFinite(chars[i]) && chars[i] > 0 ? chars[i] : m.chars;
      if (!(c > 0)) continue;
      sumChars += c;
      sumPages += m.pages;
    }
    if (sumChars <= 0 || sumPages <= 0) return FALLBACK_CHARS_PER_PAGE;
    return sumChars / sumPages;
  }
  function estimateTotalPages(measures, chars, fingerprint, chapterCount) {
    const n = chapterCount ?? Math.max(measures.length, chars.length);
    const charsPerPage = charsPerPageFromMeasures(measures, chars, fingerprint);
    let pages = 0;
    let measuredChapters = 0;
    let estimatedPages = 0;
    let estimatedChapters = 0;
    for (let i = 0; i < n; i++) {
      const m = measures[i];
      const c = Number.isFinite(chars[i]) && chars[i] > 0 ? chars[i] : m?.chars ?? 0;
      if (m && m.fingerprint === fingerprint && m.pages > 0) {
        pages += m.pages;
        measuredChapters++;
        continue;
      }
      const est = estimatePagesFromChars(c, charsPerPage);
      pages += est;
      estimatedPages += est;
      estimatedChapters++;
    }
    const total = Math.max(1, pages);
    return {
      pages: total,
      measuredChapters,
      estimatedChapters,
      estimatedFraction: Math.min(1, Math.max(0, estimatedPages / total)),
      charsPerPage: Math.round(charsPerPage * 100) / 100
    };
  }
  function chapterPageOffsets(pages) {
    const offsets = new Array(pages.length + 1);
    offsets[0] = 1;
    for (let i = 0; i < pages.length; i++) {
      const p = Number.isFinite(pages[i]) && pages[i] > 0 ? Math.floor(pages[i]) : 1;
      offsets[i + 1] = offsets[i] + p;
    }
    return offsets;
  }
  function chapterForPage(page, offsets) {
    const n = Math.max(0, offsets.length - 1);
    if (n === 0) return { chapter: 0, pageInChapter: 1 };
    const total = Math.max(1, offsets[n] - 1);
    const p = clampPage(page, total);
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (offsets[mid] <= p) lo = mid;
      else hi = mid - 1;
    }
    return { chapter: lo, pageInChapter: p - offsets[lo] + 1 };
  }
  function pageForChapter(chapter, pageInChapter, offsets) {
    const n = Math.max(0, offsets.length - 1);
    if (n === 0) return 1;
    const c = Math.max(0, Math.min(n - 1, Math.floor(chapter)));
    const len = Math.max(1, offsets[c + 1] - offsets[c]);
    const within = Math.max(1, Math.min(len, Math.floor(pageInChapter)));
    return offsets[c] + within - 1;
  }
  function activeWindowRange(active, chapterCount, radius = CHAPTER_WINDOW_RADIUS) {
    const n = Math.max(0, Math.floor(chapterCount));
    if (n === 0) return { from: 0, to: -1 };
    const a = Math.max(0, Math.min(n - 1, Math.floor(active)));
    const r = Math.max(0, Math.floor(radius));
    return { from: Math.max(0, a - r), to: Math.min(n - 1, a + r) };
  }
  var CHAPTER_WINDOW_RADIUS = 1;
  function columnIndexFromMarker(markerLeft, layout) {
    return Math.max(0, pageCountFromMarker(markerLeft, layout) - 1);
  }
  var MAX_COLUMNS = 2e4;
  var MAX_COLUMNS_WIDTH = 2e6;
  var BROWSER_COLUMN_LIMIT = 1e4;
  function columnGridWidth(layout) {
    const stride = Math.max(1, Math.floor(layout.columnStride));
    const gutter = Math.max(0, layout.gutter);
    const baseCount = Math.min(MAX_COLUMNS, BROWSER_COLUMN_LIMIT);
    const byCount = baseCount * stride - gutter;
    if (byCount <= MAX_COLUMNS_WIDTH) return byCount;
    const n = Math.max(1, Math.floor((MAX_COLUMNS_WIDTH + gutter) / stride));
    return n * stride - gutter;
  }
  function columnGridCount(layout) {
    const width = columnGridWidth(layout);
    const stride = Math.max(1, Math.floor(layout.columnStride));
    const gutter = Math.max(0, layout.gutter);
    return Math.max(1, Math.min(MAX_COLUMNS, Math.floor((width + gutter) / stride)));
  }

  // src/services/books/formats/mobi/HtmlDocEngine.ts
  var THEME_CSS = {
    light: "html { background:#f2f2f2; } body { color:#1f1f1f; }",
    dark: "html { background:#141416; } body { color:#cfcfcf; } a { color:#8ab4f8; }",
    sepia: "html { background:#e9e0cd; } body { color:#5b4636; }"
  };
  var END_MARKER_ID = "nyareader-end-marker";
  var LOAD_FAILSAFE_MS = 15e3;
  var APPEND_SETTLE_MS = 120;
  var APPEND_MAX_HOLD_MS = 1e3;
  var SLOW_RELAYOUT_MS = 120;
  var FONT_READY_TIMEOUT_MS = 1500;
  var CHAPTER_TAG_ATTR = "data-nyar-chapter";
  var CHAPTER_END_CLASS = "nyar-chapter-end";
  var COLD_CLASS = "nyareader-cold";
  var CHAPTER_ANCHOR_RE = /^nyareader-(epub|mobi|toc|fp|chapter)-\d+$/;
  var HtmlDocEngine = class {
    constructor(opts) {
      this.opts = opts;
      this.emitter = new SimpleReaderEmitter();
      // 默认版式与全局默认值同源（重构点：旧实现在 5 处各写一份字面量，容易漂移）
      this.settings = { ...DEFAULT_READER_SETTINGS };
      this.doc = null;
      this.destroyed = false;
      /** iframe 是否已完成 load（未完成前不测量、不重排） */
      this.docReady = false;
      /** 文本缩放系数（叠加在设置字号上），默认 100% */
      this.zoomScale = 1;
      // ---------- 分页状态 ----------
      /** 阅读窗口（可见页容器，overflow hidden，居中） */
      this.paged = null;
      /** 多栏容器（一栏一页） */
      this.columnsEl = null;
      /** 栏容器末尾的零宽测量标记（O(1) 测页数） */
      this.endMarker = null;
      /** 已注入样式元素（缓存，避免反复重建） */
      this.styleEl = null;
      /** 上一次写入的样式文本，用于跳过无变化写入 */
      this.lastStyleText = "";
      /** 当前版式（由 paging-layout 纯函数算出） */
      this.layout = computePageLayout({ viewWidth: 800, viewHeight: 600, double: false });
      this.pages = 0;
      /** 当前第几页（双页模式下恒为奇数，表示对开的左页） */
      this.currentPage = 1;
      /** 监听 iframe 元素尺寸变化（父文档实测，比 iframe 内部 resize 更可靠） */
      this.iframeObserver = null;
      /** 重排 rAF 句柄（合并连续 resize 抖动） */
      this.relayoutRaf = 0;
      /** 强制下一次重排（内容追加/图片就绪后页数会变） */
      this.pendingForceRelayout = false;
      /** 已解析/正在解析的资源，避免重复请求 */
      this.assetTasks = /* @__PURE__ */ new Map();
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
      this.stageEl = null;
      /** 暂存容器里是否有待落盘内容 */
      this.stagedPending = false;
      /** 第一批待落盘内容的出现时间（0 = 当前没有待落盘内容） */
      this.stageFirstPendingAt = 0;
      /** 落盘定时器句柄（0 = 未排定） */
      this.stageTimer = 0;
      /** 版式重排的合并句柄与待办（B 步：同一帧内多次字号变更只重排一次） */
      this.settingsRelayoutRaf = 0;
      /** rAF 被节流时的兜底定时器（保证重排一定落地） */
      this.settingsRelayoutTimer = 0;
      this.pendingSettingsRelayout = null;
      /** 上一次重排耗时（ms，用于"预测这次是否慢"） */
      this.lastRelayoutMs = 0;
      /** 几何变量待重新下发（容器刚重建时必须写一次） */
      this.geometryStale = true;
      /** 上一次测量到的标记偏移（增量测量的基准） */
      this.lastMarkerLeft = null;
      /** 上一次测量相对上上次新增的页数（增量测量结果，供诊断） */
      this.pagesAddedLastMeasure = 0;
      // ---------- 按章独立分页（task-10 / D 方案）----------
      /**
       * 章节登记表：一章 = 多栏容器里**连续的一段顶层节点**，从章节锚点开始
       * （锚点在 DOM 里保持顶层同级节点，这样 stream-i 的 highlightRegions() 仍然可用）。
       *
       * 分页模式下只有活动窗口 `[active-1, active+1]` 的章节留在 `.nyareader-columns`
       * 里参与分栏，其余章节的节点被搬到冷区（display:none）：整篇布局的成本从
       * "已加载全部内容"降到"2–3 章" —— 这正是改字号从 13.7–15.1s 降到亚秒级的原因。
       */
      this.chapters = [];
      /** 每章的测量缓存（与 chapters 等长；fingerprint 不匹配视为未测） */
      this.chapterMeasures = [];
      /** 每章末尾的零宽测量标记（只在窗口里有意义） */
      this.chapterEndMarkers = /* @__PURE__ */ new Map();
      /** 冷区容器（display:none）：不参与分栏的章节 */
      this.coldEl = null;
      /** 当前活动窗口（闭区间，已包含在 chapters 范围内） */
      this.windowFrom = 0;
      this.windowTo = -1;
      /** 当前阅读所在的章节（窗口以它为中心） */
      this.activeChapterIdx = 0;
      /** 章节页数前缀和缓存（pageOffsets()[i] = 第 i 章第一页的全局页号） */
      this.pageOffsetsCache = [1];
      /** 全书页数是否为估计值（视图层据此显示 ≈） */
      this.pagesEstimated = false;
      /** 最近一次估计的明细（诊断/上报用） */
      this.lastPagesEstimate = null;
      /** 总页数信息缓存（getTotalPagesInfo 直接返回它） */
      this.totalPagesInfoCache = null;
      /** 最近一批落盘追加的章节区间（用于判断是否触碰活动窗口） */
      this.lastAppendRange = null;
      /** 锚点 id → 章节索引（目录跳转 O(1) 定位） */
      this.anchorToChapter = /* @__PURE__ */ new Map();
      /** 重排状态回调（由 ReaderController 通过 setLayoutStateHandler 注入） */
      this.layoutStateHandler = null;
      // ---------- 可见高亮（批注 P0） ----------
      /**
       * 高亮渲染层（CSS Custom Highlight API 主方案 / span 包裹降级）。
       * 只保存**锚点**，不保存 DOM 引用：重排、切模式、补章之后 `refreshHighlights()` 会
       * 按当前 DOM 重新解析，所以"改字号/切单双页/切滚动分页/后台补章后高亮不丢"。
       */
      this.highlightLayer = null;
      this.highlightClickHandler = null;
      /** 内容结构版本号：并入新内容 / 重建容器时递增，让高亮层丢掉区域文本缓存 */
      this.highlightStamp = 0;
      this.resizeBound = () => {
        this.scheduleRelayout();
      };
      this.hostThemeCache = null;
    }
    get format() {
      return this.opts.formatLabel ?? "html";
    }
    /**
     * 能力恒定：分页/滚动/单双页切换是本引擎的内建能力，与当前模式无关。
     * （旧实现让 pageNav 跟随 isPaged()，切换瞬间视图层会读到 false 而隐藏按钮。）
     */
    get capabilities() {
      return { zoom: true, pageNav: true, modeSwitch: true, layoutSwitch: true };
    }
    on(event, handler) {
      this.emitter.on(event, handler);
    }
    off(event, handler) {
      this.emitter.off(event, handler);
    }
    /**
     * 注入重排状态回调（C 步）。视图层据此显示"正在重新排版…"。
     * 回调抛错不影响引擎；注入 null 可取消。
     */
    setLayoutStateHandler(handler) {
      this.layoutStateHandler = handler;
    }
    /** 诊断快照（性能 harness / 排查用）：引擎内部的重排与增量测量数字。 */
    getLayoutDiagnostics() {
      return {
        lastRelayoutMs: Math.round(this.lastRelayoutMs),
        pagesAddedLastMeasure: this.pagesAddedLastMeasure,
        stagedPending: this.stagedPending,
        pages: this.pages
      };
    }
    /** 注入（或替换）zip 资源解析器；注入后立即回填当前文档中待解析的图片。 */
    setAssetResolver(resolve) {
      this.opts.resolveAsset = resolve;
      void this.resolvePendingAssets();
    }
    async mount(container) {
      this.container = container;
      this.iframe = container.createEl("iframe", {
        cls: "nyareader-html-iframe",
        attr: { sandbox: "allow-same-origin", title: "NyaReader" }
      });
      this.iframe.style.width = "100%";
      this.iframe.style.height = "100%";
      this.iframe.style.border = "none";
      this.iframe.style.display = "block";
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        this.iframe.addEventListener("load", done, { once: true });
        window.setTimeout(done, LOAD_FAILSAFE_MS);
        this.iframe.srcdoc = this.opts.html;
      });
      if (this.destroyed) return;
      this.doc = this.iframe.contentDocument;
      if (!this.doc) {
        this.emitter.emit("error", { message: "HTML \u6587\u6863\u65E0\u6CD5\u8BBF\u95EE\uFF08CSP \u9650\u5236\uFF09\u3002" });
        return;
      }
      this.docReady = true;
      this.applyBaseStyle();
      if (this.isPaged()) {
        this.registerInitialContent();
        this.wrapPaged();
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
    nextFrame() {
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
    awaitFontsReady() {
      const fonts = this.doc?.fonts;
      if (!fonts || typeof fonts.ready?.then !== "function") return;
      let done = false;
      const relayout = () => {
        if (done || this.destroyed) return;
        done = true;
        this.relayoutPages(true, true, true, "settings");
      };
      window.setTimeout(relayout, FONT_READY_TIMEOUT_MS);
      void fonts.ready.then(() => {
        relayout();
      }).catch(() => void 0);
    }
    /** iframe 内容窗口上的交互监听（滚轮、按键、选区、滚动进度）。 */
    attachContentListeners() {
      const win = this.iframe.contentWindow;
      if (!win) return;
      win.addEventListener?.("mouseup", () => {
        const sel = this.getSelection();
        if (sel) this.emitter.emit("selection", { text: sel.text });
      });
      win.addEventListener?.(
        "wheel",
        (e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            this.nudgeZoom(e.deltaY > 0 ? 1 / 1.1 : 1.1);
            return;
          }
          if (this.isPaged()) {
            e.preventDefault();
            if (e.deltaY !== 0) void (e.deltaY > 0 ? this.nextPage() : this.prevPage());
          }
        },
        { passive: false }
      );
      win.addEventListener?.("keydown", (e) => this.onContentKeydown(e));
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
    isPaged() {
      return this.settings.scrollMode === false;
    }
    /** 双页对开 = 分页模式 + layout==="double"（是否真正生效见 layout.double）。 */
    isDouble() {
      return this.settings.layout === "double";
    }
    // ---------- 键盘（iframe 内容窗口内） ----------
    onContentKeydown(e) {
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
    setZoom(mode, value) {
      if (mode === "fit-width" || mode === "fit-height") {
        this.zoomScale = 1;
      } else if (typeof value === "number" && value >= 0.4 && value <= 4) {
        this.zoomScale = value;
      }
      if (!this.doc) return;
      this.applySettings(this.settings, "zoom");
      this.emitter.emit("zoomChanged", { mode: "custom", percent: Math.round(this.zoomScale * 100) });
    }
    getZoom() {
      return { mode: "custom", scale: this.zoomScale, percent: Math.round(this.zoomScale * 100) };
    }
    nudgeZoom(factor) {
      const next = Math.min(4, Math.max(0.4, this.getZoom().scale * factor));
      this.setZoom("custom", next);
    }
    effectiveFontSize() {
      return Math.round(this.settings.fontSize * this.zoomScale * 10) / 10;
    }
    unmount() {
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
    notifyContentAppended(html) {
      if (this.destroyed || !this.doc?.body) return;
      if (!this.isPaged()) {
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
    appendIntoLiveHost(html) {
      const host = this.liveHost();
      if (!host) return;
      host.insertAdjacentHTML("beforeend", html);
      const marker = this.endMarker;
      if (this.isPaged() && marker && marker.parentElement !== host) host.appendChild(marker);
      this.refreshHighlights();
    }
    /** 当前生效的追加宿主（分页模式 = 挂在文档里的多栏容器；否则 body）。 */
    liveHost() {
      if (!this.isPaged()) return this.doc?.body ?? null;
      const cols = this.columnsEl;
      if (cols && cols.isConnected && this.paged?.contains(cols)) return cols;
      this.wrapPaged();
      return this.columnsEl ?? this.doc?.body ?? null;
    }
    // ---------- 按章独立分页：登记 / 窗口 / 测量（task-10）----------
    /** 是否启用按章独立分页（默认开；`chapterPagedPagination:false` 一键回退整本布局）。 */
    chapterPagedEnabled() {
      return this.opts.chapterPagedPagination !== false;
    }
    /** 当前是否处于"窗口化分页"状态（分页模式 + 开关开启 + 真的有章节可切）。 */
    windowedChapters() {
      return this.isPaged() && this.chapterPagedEnabled() && this.chapters.length > 0;
    }
    /** 判定一个 id 是否章节锚点（显式前缀优先，其次通用正则）。 */
    isChapterAnchorId(id) {
      if (!id) return false;
      const prefix = this.opts.chapterAnchorPrefix;
      if (prefix && id.startsWith(prefix)) {
        const rest = id.slice(prefix.length);
        return /^\d+$/.test(rest);
      }
      return CHAPTER_ANCHOR_RE.test(id);
    }
    /** 冷区容器（display:none；分页模式下不参与布局的章节放这里）。 */
    ensureColdEl() {
      const doc = this.doc;
      if (!doc?.body) return null;
      if (this.coldEl && this.coldEl.isConnected) return this.coldEl;
      if (this.coldEl) {
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
    chapterEndMarkerFor(index) {
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
    slotChars(nodes) {
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
    slotAnchors(nodes) {
      const ids = [];
      for (const n of nodes) {
        if (n.nodeType !== 1) continue;
        const el = n;
        if (el.id?.startsWith("nyar")) ids.push(el.id);
        for (const inner of Array.from(el.querySelectorAll?.('[id^="nyar"]') ?? [])) {
          const id = inner.id;
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
    registerNodes(nodes, target) {
      const from = this.chapters.length;
      if (!this.chapterPagedEnabled()) {
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
          const slot = { nodes: nodes.slice(), chars: this.slotChars(nodes), anchorIds: this.slotAnchors(nodes) };
          this.chapters.push(slot);
          for (const id of slot.anchorIds) this.anchorToChapter.set(id, 0);
        }
        this.refreshPageOffsets();
        return { from: 0, to: this.chapters.length - 1 };
      }
      let run = [];
      const flush = () => {
        if (!run.length) return;
        for (const n of run) target.appendChild(n);
        const index = this.chapters.length;
        const slot = { nodes: run, chars: this.slotChars(run), anchorIds: this.slotAnchors(run) };
        this.chapters.push(slot);
        for (const id of slot.anchorIds) this.anchorToChapter.set(id, index);
        this.tagChapterStart(index);
        run = [];
      };
      for (const node of nodes) {
        const el = node.nodeType === 1 ? node : null;
        if (el && this.isChapterAnchorId(el.id)) {
          flush();
        }
        run.push(node);
      }
      flush();
      this.refreshPageOffsets();
      return { from, to: this.chapters.length - 1 };
    }
    /** 给每章的第一个元素节点打标记，供"元素 → 章节"反查（高亮/锚点定位用）。 */
    tagChapterStart(index) {
      const slot = this.chapters[index];
      if (!slot) return;
      const first = slot.nodes.find((n) => n.nodeType === 1);
      if (first) first.setAttribute(CHAPTER_TAG_ATTR, String(index));
    }
    /** 元素/文本节点 → 章节索引（-1 = 不属于任何章节，例如测量标记）。 */
    chapterIndexOfNode(node) {
      let el = node ? node.nodeType === 1 ? node : node.parentElement : null;
      let cursor = el;
      while (cursor) {
        const tag = cursor.getAttribute?.(CHAPTER_TAG_ATTR);
        if (tag !== null && tag !== void 0) {
          const index = parseInt(tag, 10);
          if (Number.isFinite(index) && index >= 0 && index < this.chapters.length) return index;
        }
        cursor = cursor.parentElement;
      }
      const cols = this.columnsEl;
      const cold = this.coldEl;
      if (el && el.parentElement && (el.parentElement === cols || el.parentElement === cold)) {
        cursor = el.previousElementSibling;
        while (cursor) {
          const tag = cursor.getAttribute?.(CHAPTER_TAG_ATTR);
          if (tag !== null && tag !== void 0) {
            const index = parseInt(tag, 10);
            if (Number.isFinite(index) && index >= 0 && index < this.chapters.length) return index;
          }
          cursor = cursor.previousElementSibling;
        }
      }
      const id = el?.id || "";
      if (id) return this.chapterIndexForAnchor(id);
      return -1;
    }
    /** 锚点定位符（"#id" 或 id）→ 章节索引（-1 = 找不到）。 */
    chapterIndexForAnchor(location) {
      const id = location.startsWith("#") ? location.slice(1) : location;
      if (!id) return -1;
      const cached = this.anchorToChapter.get(id);
      if (cached !== void 0) return cached;
      for (let i = 0; i < this.chapters.length; i++) {
        if (this.chapters[i].anchorIds.includes(id)) return i;
      }
      return -1;
    }
    /** 章节页数前缀和（缓存；chapters/测量变化时刷新）。 */
    pageOffsets() {
      if (this.pageOffsetsCache.length !== this.chapters.length + 1) this.refreshPageOffsets();
      return this.pageOffsetsCache;
    }
    /** 重算章节页数前缀和 + 全书页数估计。 */
    refreshPageOffsets() {
      const fingerprint = this.currentFingerprint();
      const chars = this.chapters.map((c) => c.chars);
      const estimate = estimateTotalPages(this.chapterMeasures, chars, fingerprint, this.chapters.length);
      const perChapter = new Array(this.chapters.length);
      for (let i = 0; i < this.chapters.length; i++) {
        const m = this.chapterMeasures[i];
        if (m && m.fingerprint === fingerprint && m.pages >= 0) perChapter[i] = m.pages;
        else perChapter[i] = Math.max(1, Math.round((chars[i] || 0) / Math.max(1, estimate.charsPerPage)));
      }
      const sum = perChapter.reduce((s, v) => s + v, 0) || 1;
      if (sum !== estimate.pages && this.chapters.length > 0) {
        perChapter[this.chapters.length - 1] = Math.max(0, perChapter[this.chapters.length - 1] + (estimate.pages - sum));
      }
      this.pageOffsetsCache = chapterPageOffsets(perChapter);
      this.pages = Math.max(1, this.pageOffsetsCache[this.pageOffsetsCache.length - 1] - 1);
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
        windowTo: this.windowTo
      };
    }
    /** 当前版式指纹（字号/行距/字体/页尺寸/单双页） */
    currentFingerprint() {
      return layoutFingerprint({
        fontSize: this.effectiveFontSize(),
        lineHeight: this.settings.lineHeight,
        fontFamily: this.settings.fontFamily,
        pageWidth: this.layout.pageWidth,
        pageHeight: this.layout.pageHeight,
        gutter: this.layout.gutter,
        pageMarginX: this.layout.pageMarginX,
        double: this.layout.double
      });
    }
    /** 把章节节点搬到冷区（保持顺序）。 */
    moveChapterToCold(index) {
      const slot = this.chapters[index];
      const cold = this.ensureColdEl();
      if (!slot || !cold) return;
      for (const node of slot.nodes) if (node.parentNode !== cold) cold.appendChild(node);
      const marker = this.chapterEndMarkers.get(index);
      if (marker && marker.parentNode !== cold) cold.appendChild(marker);
    }
    /** 把章节节点搬进多栏容器（插在末尾测量标记之前，保持窗口内顺序）。 */
    moveChapterToWindow(index) {
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
    applyWindow(range) {
      if (!this.windowedChapters() || !this.columnsEl) return;
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
    ensureWindow(index, reason = "append") {
      if (!this.windowedChapters()) return;
      const clamped = Math.max(0, Math.min(this.chapters.length - 1, Math.floor(index)));
      this.activeChapterIdx = clamped;
      const range = activeWindowRange(clamped, this.chapters.length, CHAPTER_WINDOW_RADIUS);
      if (range.from === this.windowFrom && range.to === this.windowTo) return;
      this.applyWindow(range);
      this.geometryStale = false;
      this.relayoutPages(true, true, true, reason);
      this.refreshHighlights();
    }
    /**
     * 窗口内逐章测量 + 全书页数估计。
     *
     * 一次布局读 N 个标记（第一个读触发同步布局，之后都是廉价读数），
     * 得到窗口内每章的精确页数；窗口外章节沿用旧指纹下的测量或插值。
     */
    refreshWindowPagination() {
      const fingerprint = this.currentFingerprint();
      const cols = this.columnsEl;
      if (!cols) return this.pages;
      let prevCol = null;
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
    readMarkerLeftOf(marker, cols) {
      if (marker.offsetParent === cols) return marker.offsetLeft;
      const rect = marker.getBoundingClientRect();
      const colsRect = cols.getBoundingClientRect();
      if (!rect || !colsRect) return null;
      return rect.left - colsRect.left;
    }
    /** 窗口内页码（1-based；窗口第一页 = 1）。 */
    pageInWindow(page) {
      if (!this.windowedChapters()) return page;
      const base = this.pageOffsets()[this.windowFrom] ?? 1;
      return Math.max(1, page - base + 1);
    }
    /** 暂存容器（display:none，挂在 iframe body 下）。 */
    ensureStageEl() {
      const doc = this.doc;
      if (!doc?.body) return null;
      if (this.stageEl) {
        if (this.stageEl.isConnected) return this.stageEl;
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
    scheduleStageFlush() {
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
    absorbStagedContent() {
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
      const nodes = [];
      while (stage.firstChild) nodes.push(stage.removeChild(stage.firstChild));
      if (!nodes.length) return false;
      if (this.isPaged() && this.chapterPagedEnabled()) {
        const cold = this.ensureColdEl();
        if (cold) {
          this.lastAppendRange = this.registerNodes(nodes, cold);
          this.refreshPageOffsets();
          this.refreshHighlights();
          return true;
        }
      }
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
      this.refreshHighlights();
      return true;
    }
    /** 落盘 + 一次重排（keepPage=true：纯末尾追加不移动当前页）。 */
    flushStaged(emit = true) {
      const moved = this.absorbStagedContent();
      if (!moved) return;
      const pending = this.pendingSettingsRelayout;
      if (pending) {
        this.pendingSettingsRelayout = { emit: pending.emit || emit, reason: pending.reason };
        this.runPendingSettingsRelayout();
        return;
      }
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
    flushPendingContent() {
      if (this.stagedPending) this.flushStaged(true);
    }
    // ---------- 跳转 ----------
    async goTo(location) {
      this.runPendingSettingsRelayout();
      this.flushPendingContent();
      if (location.startsWith("#")) {
        const doc = this.iframe?.contentDocument;
        const target = doc?.getElementById(location.slice(1));
        if (target && "getBoundingClientRect" in target) {
          if (this.isPaged()) this.showPage(this.pageOfElement(target));
          else target.scrollIntoView({ block: "start" });
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
      win.scrollTo(0, pct / 1e4 * max);
      this.emitProgress();
    }
    /**
     * 锚点元素在第几页（分页模式）：按元素相对阅读窗口的横坐标反推列号。
     *
     * 按章独立分页（task-10）：目标章可能正躺在冷区（display:none，没有几何），
     * 因此先激活它（一次"重排 2–3 章"），再按列号换算 —— 目录跳远章节因此不再
     * 需要"整本书都参与布局"。
     */
    pageOfElement(el) {
      if (this.windowedChapters()) {
        const index = this.chapterIndexOfNode(el);
        if (index >= 0 && (index < this.windowFrom || index > this.windowTo)) {
          this.ensureWindow(index);
        }
      }
      const bookRect = this.paged?.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      if (!bookRect || this.layout.columnStride <= 0) return this.currentPage;
      const x = elRect.left - bookRect.left - this.layout.pageMarginX;
      const col = Math.round(x / this.layout.columnStride);
      return clampPage(this.currentPage - 1 + col + 1, this.pages);
    }
    async nextPage() {
      if (this.isPaged()) {
        this.showPage(this.currentPage + pageStep(this.layout.double));
        return;
      }
      this.flushPendingContent();
      this.iframe.contentWindow?.scrollBy({ top: this.iframe.clientHeight * 0.9, behavior: "smooth" });
    }
    async prevPage() {
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
    goToFraction(fraction) {
      this.runPendingSettingsRelayout();
      this.flushPendingContent();
      const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
      if (this.isPaged()) {
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
    getTotalPages() {
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
    isPageCountEstimated() {
      this.flushPendingContent();
      return this.isPaged() ? this.pagesEstimated : false;
    }
    /** 总页数明细（页码来源、窗口、估计占比）——视图层与诊断用。 */
    getTotalPagesInfo() {
      this.flushPendingContent();
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
          windowTo: this.windowTo
        };
      }
      return this.totalPagesInfoCache ?? {
        pages: this.pages,
        estimated: this.pagesEstimated,
        chapters: this.chapters.length,
        measuredChapters: 0,
        estimatedChapters: this.chapters.length,
        estimatedFraction: 0,
        charsPerPage: 0,
        windowFrom: this.windowFrom,
        windowTo: this.windowTo
      };
    }
    currentLocation() {
      this.runPendingSettingsRelayout();
      this.flushPendingContent();
      if (this.isPaged()) return String(percentFromPage(this.currentPage, this.pages));
      return String(Math.round(this.currentPercentage() * 1e4));
    }
    currentPercentage() {
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
    applySettings(settings, reason = "settings") {
      this.settings = { ...settings };
      if (!this.doc) return;
      this.hostThemeCache = null;
      this.applyBaseStyle();
      if (this.isPaged()) {
        this.wrapPaged();
        this.scheduleSettingsRelayout(false, reason);
      } else {
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
    scheduleSettingsRelayout(emit, reason) {
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
      if (this.settingsRelayoutTimer) window.clearTimeout(this.settingsRelayoutTimer);
      this.settingsRelayoutTimer = window.setTimeout(() => {
        this.settingsRelayoutTimer = 0;
        this.runPendingSettingsRelayout();
      }, SLOW_RELAYOUT_MS * 2);
    }
    /** 立即执行待做的版式重排（若有）。 */
    runPendingSettingsRelayout() {
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
    switchMode(scrollMode) {
      const pct = this.currentPercentage();
      this.settings = { ...this.settings, scrollMode };
      if (!this.doc) return;
      this.applySettings(this.settings);
      this.runPendingSettingsRelayout();
      this.flushPendingContent();
      if (this.isPaged()) {
        this.showPage(pageFromPercent(Math.round(pct * 1e4), this.pages || 1), false);
      } else {
        const win = this.iframe.contentWindow;
        if (win) {
          const d = win.document;
          const max = Math.max(1, d.documentElement.scrollHeight - win.innerHeight);
          win.scrollTo(0, pct * max);
        }
      }
      this.emitProgress();
      this.refreshHighlights();
    }
    /**
     * 把 body 里的初始内容按章节锚点登记成"章"，并统一搬进冷区。
     *
     * 此时 body 的顶层节点就是渲染文档的初始正文（首屏那几章）；登记后由
     * {@link populatePagedContainer} 决定哪几章进入多栏容器参与分栏。
     */
    registerInitialContent() {
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
      this.windowTo = -1;
      this.refreshPageOffsets();
    }
    /**
     * 决定哪些章进入多栏容器：窗口化 = 当前章 ±1；回退模式 = 全部。
     * 只搬 DOM，不读布局（随后的重排会统一布局一次）。
     */
    populatePagedContainer() {
      if (!this.columnsEl) return;
      if (this.windowedChapters()) {
        const range = activeWindowRange(this.activeChapterIdx, this.chapters.length, CHAPTER_WINDOW_RADIUS);
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
    wrapPaged() {
      if (this.paged && this.paged.isConnected && this.columnsEl && this.endMarker) {
        this.populatePagedContainer();
        return;
      }
      const doc = this.doc;
      const body = doc?.body;
      if (!doc || !body) return;
      if (this.paged && this.columnsEl && this.paged.contains(this.columnsEl)) {
        body.appendChild(this.paged);
        if (this.endMarker && this.endMarker.parentElement !== this.columnsEl) this.columnsEl.appendChild(this.endMarker);
        this.populatePagedContainer();
        return;
      }
      this.paged = null;
      this.columnsEl = null;
      this.endMarker = null;
      const shim = doc.createElement("div");
      shim.className = "nyareader-book";
      const columns = doc.createElement("div");
      columns.className = "nyareader-columns";
      const strays = Array.from(doc.querySelectorAll(`[id="${END_MARKER_ID}"]`));
      for (const stray of strays) stray.remove();
      const stage = this.stageEl;
      if (stage && stage.parentElement === body) body.removeChild(stage);
      const cold = this.coldEl;
      if (cold && cold.parentElement === body) body.removeChild(cold);
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
    unwrapPaged() {
      const doc = this.doc;
      const body = doc?.body;
      if (!doc || !body) return;
      const strays = Array.from(doc.querySelectorAll(`#${END_MARKER_ID}, .${CHAPTER_END_CLASS}`));
      for (const stray of strays) stray.remove();
      this.chapterEndMarkers.clear();
      const stage = this.stageEl;
      const cold = this.coldEl;
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
    applyBaseStyle() {
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
    scrollMeasure() {
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
    scrollModeBackground() {
      if (this.isPaged()) return "";
      if (this.settings.theme !== "light") return "";
      return this.hostTheme().background ?? "transparent";
    }
    /** 滚动模式下的正文前景色（同理，默认跟随宿主 `--text-normal`）。 */
    scrollModeForeground() {
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
    hostTheme() {
      if (this.hostThemeCache) return this.hostThemeCache;
      let out = {};
      try {
        const el = this.container;
        const win = el?.ownerDocument?.defaultView;
        if (el && win) {
          const cs = win.getComputedStyle(el);
          const bg = cs.getPropertyValue("--background-primary").trim();
          const fg = cs.getPropertyValue("--text-normal").trim();
          out = { background: bg || void 0, text: fg || void 0 };
        }
      } catch {
        out = {};
      }
      this.hostThemeCache = out;
      return out;
    }
    /** 生成渲染文档的基础样式表（纯字符串，便于对比与审查）。 */
    buildBaseCss() {
      const paged = this.isPaged();
      const dark = this.settings.theme === "dark";
      const m = this.settings.margin;
      const lh = this.settings.lineHeight;
      const bg = this.scrollModeBackground();
      const fg = this.scrollModeForeground();
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
				/* \u6EDA\u52A8\u6A21\u5F0F\uFF1A\u80CC\u666F\u8DDF\u968F\u5BBF\u4E3B\u4E3B\u9898\uFF08\u89C1 scrollModeBackground \u6CE8\u91CA\uFF09\uFF0C\u5206\u9875\u6A21\u5F0F\u4FDD\u7559\u4E66\u9875\u8272 */
				${bg ? `background: ${bg};` : ""}
			}
			body {
				font-family: ${this.settings.fontFamily};
				line-height: ${lh};
				color: ${fg};
				margin: ${paged ? 0 : `${m}px auto`};
				/*
				 * \u884C\u5BBD\u4E0A\u9650\uFF08measure\uFF09\uFF1A
				 * - \u5206\u9875\u6A21\u5F0F\uFF1A\u9875\u5BBD\u7531\u591A\u680F\u5217\u5BBD\u51B3\u5B9A\uFF0C\u7EDD\u4E0D\u80FD\u518D\u52A0 max-width\uFF0C\u5426\u5219\u5185\u5BB9\u6324\u5728\u680F\u5185\u4E00\u4FA7\uFF1B
				 * - \u6EDA\u52A8\u6A21\u5F0F\uFF1A\u7528\u8BBE\u7F6E\u91CC\u7684 pageWidth \u4F5C\u4E3A\u6B63\u6587\u680F\u5BBD\u5E76\u5C45\u4E2D\uFF0C
				 *   \u907F\u514D\u8D85\u5BBD\u7A97\u53E3\u4E0B\u4E00\u884C 150+ \u5B57\u7B26\uFF08\u65E7\u5B9E\u73B0\u6CA1\u6709\u8FD9\u4E2A\u7EA6\u675F\uFF09\u3002
				 */
				max-width: ${paged ? "none" : `${this.scrollMeasure()}px`};
				overflow: ${paged ? "hidden" : "auto"};
				/* \u957F\u5355\u8BCD/URL \u4E0D\u6491\u7834\u884C\u5BBD\uFF08\u6392\u7248\u6EA2\u51FA\u7684\u76F4\u63A5\u539F\u56E0\u4E4B\u4E00\uFF09 */
				overflow-wrap: break-word;
				word-break: break-word;
			}
			${paged ? "" : `
			/* \u6EDA\u52A8\u6A21\u5F0F\uFF1A\u6B63\u6587\u5BBD\u5EA6\u4E25\u683C\u7B49\u4E8E\u8BBE\u7F6E\u91CC\u7684 pageWidth\uFF08border-box + auto margin\uFF09\u3002
			   \u53EA\u5728\u300C\u5BB9\u5668\u5BBD < \u680F\u5BBD + \u5DE6\u53F3 margin\u300D\u65F6\u8865\u6700\u591A 24px \u7684\u5DE6\u53F3\u547C\u5438\u7A7A\u95F4\uFF0C
			   \u907F\u514D"\u8BBE\u7F6E 640 \u5374\u88AB padding \u6491\u5230 664"\u7684\u53E0\u52A0\u95EE\u9898\u3002 */
			body { box-sizing: border-box; }
			@supports (padding: max(0px)) {
				body {
					padding-inline: max(0px, min(24px, calc((${this.scrollMeasure() + m * 2}px - 100%) / 2)));
				}
			}`}
			p { margin: 0 0 0.8em 0; }
			h1, h2, h3, h4 { break-after: avoid; }
			/* KF8 \u5185\u5D4C\u8D44\u6E90\uFF08kindle:embed:/flow:\uFF09\u65E0\u6CD5\u5728\u6D4F\u89C8\u5668\u89E3\u6790\uFF0C\u9690\u85CF\u907F\u514D\u7834\u56FE */
			img[src^="kindle:"], image[src^="kindle:"] { display: none; }
			a[href^="kindle:"] { pointer-events: none; }
			* { user-select: text; }
			/* \u56FE\u7247\uFF1A\u7B49\u6BD4\u7F29\u653E\uFF0C\u65E2\u4E0D\u6EA2\u51FA\u9875\u5BBD\u4E5F\u4E0D\u8D85\u51FA\u9875\u9AD8\uFF1B\u4E0D\u518D\u6709"\u8D85\u9650\u5373\u9690\u85CF"\u7684\u7B56\u7565 */
			img, svg, video, picture > img {
				max-width: 100% !important;
				height: auto !important;
				object-fit: contain;
			}
			/* \u7F3A\u5931\u8D44\u6E90\uFF1A\u7ED9\u53EF\u89C1\u5360\u4F4D\u800C\u4E0D\u662F\u6E05\u7A7A src \u9020\u6210\u7A7A\u6D1E */
			img.nyareader-img-missing {
				display: inline-block;
				min-width: 96px;
				min-height: 72px;
				background: ${dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)"};
				border: 1px dashed ${dark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.18)"};
			}
			/* \u5206\u9875\u7248\u5F0F\uFF1A\u9605\u8BFB\u7A97\u53E3 + \u591A\u680F\uFF08\u4E00\u680F\u4E00\u9875\uFF09 */
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
				 * \u5BBD\u5EA6\u5FC5\u987B\u662F\u300C\u6B65\u957F \xD7 \u5217\u6570 \u2212 \u4E00\u4E2A\u69FD\u5BBD\u300D\uFF1A\u6D4F\u89C8\u5668\u53EA\u6709\u5728
				 * (width + gap) \u80FD\u88AB (pageWidth + gap) \u6574\u9664\u65F6\uFF0C\u5B9E\u9645\u5217\u8DDD\u624D\u7CBE\u786E\u7B49\u4E8E
				 * pageWidth + gap\u3002\u65E7\u5B9E\u73B0\u5199\u6B7B 2000000px\uFF0C\u5728 2200px \u7A97\u53E3\u4E0B\u6BCF\u5217\u591A
				 * 0.951px\uFF0C\u7D2F\u79EF\u5230\u672B\u9875\u53F3\u7F18\u8D85\u51FA 219.69px \u88AB overflow:hidden \u88C1\u6389\u3002
				 * \u5BBD\u5EA6\u4E0E\u5217\u6570\u7531 columnGridWidth()/columnGridCount()\uFF08paging-layout \u7EAF\u51FD\u6570\uFF09\u63A8\u5BFC\u3002
				 */
				width: var(--nyar-cols-width);
				height: 100%;
				/*
				 * column-width \u5FC5\u987B\u663E\u5F0F\u7ED9\u51FA\uFF08= \u9875\u5BBD\uFF09\uFF1A\u53EA\u5199 column-count \u65F6\u6D4F\u89C8\u5668\u4F1A\u628A
				 * \u5BB9\u5668\u5BBD\u5EA6\u6309\u5217\u6570\u5747\u5206\uFF082_000_000 / 10000 = 200px\uFF09\uFF0C\u4E0E\u9875\u5BBD\u65E0\u5173\uFF0C
				 * \u4E00\u9875\u91CC\u4F1A\u585E\u8FDB\u591A\u4E2A\u7A84\u680F \u2014\u2014 \u8FD9\u662F\u5FC5\u987B\u4FDD\u7559\u7684\u4E00\u6761\uFF0C\u53BB\u6389\u5373\u56DE\u5F52\u3002
				 */
				column-width: var(--nyar-page-w);
				column-count: var(--nyar-cols-count);
				column-gap: var(--nyar-gutter);
				column-fill: auto;
				overflow-wrap: break-word;
				word-break: break-word;
			}
			/* \u9876\u5C42\u5143\u7D20\u4E0D\u80FD\u8D85\u51FA\u9875\u5BBD\uFF1A\u907F\u514D width:100% \u88AB\u591A\u680F\u5BB9\u5668(\u6781\u5BBD)\u6491\u7206 */
			.nyareader-columns > * {
				max-width: var(--nyar-page-w) !important;
				box-sizing: border-box;
			}
			/* \u96F6\u5BBD\u6D4B\u91CF\u6807\u8BB0\uFF1A\u5FC5\u987B\u5B8C\u5168\u4E0D\u53C2\u4E0E\u6392\u7248\uFF0C\u53EA\u4FDD\u7559 offsetLeft \u8BED\u4E49 */
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
			/* \u8FFD\u52A0\u5185\u5BB9\u6682\u5B58\u533A\uFF1Adisplay:none \u5B50\u6811\u6CA1\u6709\u5E03\u5C40\u5BF9\u8C61 \u2014\u2014
			   \u5F80\u91CC\u8FFD\u52A0\u4E0D\u4F1A\u89E6\u53D1\u4EFB\u4F55\u5E03\u5C40/\u91CD\u6392\uFF08task-7 \u589E\u91CF\u8FFD\u52A0\u7684\u5173\u952E\uFF09 */
			.nyareader-stage { display: none !important; }
			/* \u51B7\u533A\uFF08\u4E0D\u53C2\u4E0E\u5206\u680F\u7684\u7AE0\u8282\uFF09\u4E0E\u9010\u7AE0\u6D4B\u91CF\u6807\u8BB0\uFF1A\u90FD\u662F\u96F6\u6210\u672C\u8282\u70B9 */
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
			/* \u5206\u9875\u9875\u5185\u56FE\u7247\uFF1A\u7528\u771F\u5B9E\u9875\u9AD8\u53D8\u91CF\u9650\u9AD8\uFF0C\u907F\u514D\u56FA\u5B9A 44px \u4F59\u91CF\u7B97\u9519\u5BFC\u81F4\u88C1\u5207 */
			.nyareader-columns img {
				max-height: var(--nyar-img-max-h) !important;
				width: auto;
			}
			/* \u8D85\u957F\u5185\u5BB9\u4E0D\u628A\u9875\u9762\u9876\u51FA\u8FB9\u754C\uFF1Apre \u5F3A\u5236\u6362\u884C\u3001\u8868\u683C\u9650\u5BBD */
			.nyareader-columns pre {
				white-space: pre-wrap;
				word-break: break-word;
			}
			.nyareader-columns table {
				max-width: 100% !important;
			}
			/* \u907F\u514D\u9875\u4E2D\u65AD\u9020\u6210\u7684"\u534A\u884C/\u5B64\u884C"\u96BE\u770B\u65AD\u70B9 */
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
    scheduleRelayout() {
      if (!this.isPaged() || this.destroyed || !this.docReady) return;
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
    relayoutPages(emit, force = false, keepPage = false, reason = "resize") {
      if (!this.isPaged() || !this.doc || !this.docReady || !this.paged || !this.columnsEl) return;
      const vw = this.iframe?.clientWidth ?? 0;
      const vh = this.iframe?.clientHeight ?? 0;
      if (vw < 40 || vh < 40) return;
      const next = computePageLayout({ viewWidth: vw, viewHeight: vh, double: this.isDouble() });
      const sameLayout = next.pageWidth === this.layout.pageWidth && next.pageHeight === this.layout.pageHeight && next.gutter === this.layout.gutter && next.pageMarginX === this.layout.pageMarginX && next.double === this.layout.double;
      if (sameLayout && !force && this.pages > 0) return;
      this.emitLayoutState({ busy: true, reason });
      const startedAt = this.nowMs();
      this.layout = next;
      if (!sameLayout) this.lastMarkerLeft = null;
      if (!sameLayout || this.geometryStale) {
        const root = this.doc.documentElement;
        root.style.setProperty("--nyar-page-w", `${next.pageWidth}px`);
        root.style.setProperty("--nyar-page-h", `${next.pageHeight}px`);
        root.style.setProperty("--nyar-gutter", `${next.gutter}px`);
        root.style.setProperty("--nyar-page-margin-x", `${next.pageMarginX}px`);
        root.style.setProperty("--nyar-cols-width", `${columnGridWidth(next)}px`);
        root.style.setProperty("--nyar-cols-count", String(columnGridCount(next)));
        this.paged.style.width = `${next.bookWidth + next.pageMarginX * 2}px`;
        this.paged.style.height = `${next.bookHeight}px`;
        this.geometryStale = false;
      }
      const prevPct = this.pages > 0 ? (this.currentPage - 0.5) / this.pages : 0;
      const prevPage = this.currentPage;
      const prevPages = this.pages;
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
      this.refreshHighlights();
      if (emit) this.emitProgress();
    }
    nowMs() {
      return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
    }
    /** 上报重排状态（视图层"正在重新排版…"）；回调异常不影响引擎。 */
    emitLayoutState(state) {
      const handler = this.layoutStateHandler;
      if (!handler) return;
      try {
        handler(state);
      } catch {
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
    measurePagesIncremental() {
      const cols = this.columnsEl;
      const marker = this.endMarker;
      if (!cols || !marker) return { pages: 1, added: 0 };
      let markerLeft;
      if (marker.offsetParent === cols) {
        markerLeft = marker.offsetLeft;
      } else {
        markerLeft = marker.getBoundingClientRect().left - cols.getBoundingClientRect().left;
      }
      const pages = pageCountFromMarker(markerLeft, this.layout);
      const prev = this.lastMarkerLeft;
      const added = prev === null ? 0 : appendedPageCount(prev, markerLeft, this.layout);
      this.lastMarkerLeft = markerLeft;
      this.pagesAddedLastMeasure = added;
      return { pages, added };
    }
    /** 测量总页数（O(1) 读数 + 增量信息）。 */
    measurePages() {
      return this.measurePagesIncremental().pages;
    }
    /** 按当前页把对应列移入阅读窗口（窗口化分页时用"窗口内页号"）。 */
    positionColumns() {
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
    showPage(page, emit = true) {
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
    scrollStep(direction) {
      const win = this.iframe?.contentWindow;
      if (!win) return;
      const linePx = Math.max(1, this.effectiveFontSize() * this.settings.lineHeight);
      const step = linePx * 3;
      win.scrollBy({ top: direction * step, behavior: "auto" });
    }
    getSelection() {
      const win = this.iframe.contentWindow;
      if (!win) return null;
      const sel = win.getSelection();
      if (!sel || sel.isCollapsed) return null;
      const text = normalizeSelectionText(sel.toString());
      if (!text) return null;
      const rects = [];
      for (let i = 0; i < sel.rangeCount; i++) {
        for (const r of Array.from(sel.getRangeAt(i).getClientRects())) {
          if (r.width && r.height) rects.push({ left: r.left, top: r.top, width: r.width, height: r.height });
        }
      }
      return {
        text,
        target: { location: this.currentLocation(), rects, selectedText: text }
      };
    }
    async showAnnotation(target) {
      await this.goTo(target.location);
    }
    // ---------- 可见高亮 API（IReaderEngine 可选方法，批注 P0） ----------
    /**
     * 全量设置高亮（打开书/重开书/增删改后调用）。
     *
     * 每条锚点按「章节锚点 + 章内字符区间 → 文本指纹 → 整篇指纹 → 进度兜底」解析；
     * 解析结果通过 {@link getHighlightPlacements} 暴露（含降级原因），不静默失败。
     */
    setHighlights(list) {
      const layer = this.ensureHighlightLayer();
      if (!layer) return;
      layer.setHighlights(list);
    }
    addHighlight(highlight) {
      this.ensureHighlightLayer()?.addHighlight(highlight);
    }
    removeHighlight(id) {
      this.ensureHighlightLayer()?.removeHighlight(id);
    }
    /** 点击高亮 → UI 打开编辑（CSS Highlight 路径下由 Mark 层用坐标做命中测试）。 */
    setHighlightClickHandler(handler) {
      this.highlightClickHandler = handler;
      this.highlightLayer?.setClickHandler(handler);
    }
    /** 最近一次定位结果（`exact-range`/`quote-unique`/`quote-first`/`progression-only`）。 */
    getHighlightPlacements() {
      return this.highlightLayer?.placements() ?? [];
    }
    /**
     * 用当前选区生成锚点草稿（EPUB/MOBI 的结构定位 = 章节锚点 + 章内 UTF-16 偏移）。
     *
     * 章节锚点形如 `nyareader-epub-3`（EPUB）/ `nyareader-mobi-3`（MOBI），
     * 与 {@link highlightRegions} 的区域 key 一致，因此定位时能直接命中。
     * 拿不到章节信息时自述 `approximate`，由 Controller 决定如何降级。
     */
    getSelectionAnchor() {
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
        return { kind: "chapter", primary: this.currentLocation(), quote: quoteFromText(text), progression, text, approximate: true };
      }
      const regionText = startRegion.nodes.map((n) => n.textContent ?? "").join("");
      const charStart = this.offsetInNodes(startRegion, range.startContainer, range.startOffset);
      const sameRegion = endRegion === startRegion;
      const charEnd = sameRegion ? this.offsetInNodes(startRegion, range.endContainer, range.endOffset) : null;
      const quote = charStart !== null && charEnd !== null && charEnd > charStart ? buildTextQuote(regionText, charStart, charEnd) : quoteFromText(text);
      const draft = {
        kind: "chapter",
        primary: startRegion.key,
        quote,
        progression,
        text
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
    regionOfNode(node) {
      if (!node) return null;
      for (const region of this.highlightRegions()) {
        for (const root of region.nodes) {
          if (root === node || root.contains(node)) return region;
        }
      }
      return null;
    }
    /** 节点在"区域节点序列拼接文本"里的 UTF-16 偏移。 */
    offsetInNodes(region, node, nodeOffset) {
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
          const t = walker.currentNode;
          if (t === node) return acc + nodeOffset;
          acc += t.data.length;
        }
        return null;
      }
      return null;
    }
    /** 懒建高亮层（mount 之后 `doc` 才存在）。 */
    ensureHighlightLayer() {
      if (!this.doc?.body) return null;
      if (!this.highlightLayer) {
        this.highlightLayer = new HighlightLayer({
          regions: () => this.highlightRegions(),
          documentRoot: () => this.liveHost() ?? this.doc.body,
          structureStamp: () => this.highlightStamp,
          goToProgression: (progression) => this.goToFraction(progression)
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
    highlightRegions() {
      const host = this.liveHost();
      const doc = this.doc;
      if (!host || !doc) return [];
      const regions = [];
      let current = null;
      for (const child of Array.from(host.childNodes)) {
        if (child.nodeType === 1) {
          const el = child;
          const id = el.id;
          const isChapterAnchor = /^nyareader-(epub|mobi)-\d+$/.test(id);
          if (isChapterAnchor) {
            if (current) regions.push(current);
            current = { key: id, nodes: [el], paraIndex: regions.length };
            continue;
          }
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
    refreshHighlights() {
      this.highlightStamp++;
      this.highlightLayer?.refresh();
    }
    /** 跳到某条高亮（面板"跳转"用）：能解析就滚到命中处，否则按进度兜底。 */
    focusHighlight(id) {
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
    async resolvePendingAssets() {
      const doc = this.doc;
      if (!doc) return;
      const pending = Array.from(doc.querySelectorAll("img[data-nyar-asset]"));
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
    resolveAssetOnce(path) {
      const cached = this.assetTasks.get(path);
      if (cached) return cached;
      const task = (async () => {
        try {
          return await this.opts.resolveAsset?.(path) ?? null;
        } catch {
          return null;
        }
      })();
      this.assetTasks.set(path, task);
      return task;
    }
    emitProgress() {
      this.emitter.emit("locationChanged", { location: this.currentLocation(), percentage: this.currentPercentage() });
    }
    destroy() {
      this.destroyed = true;
      this.unmount();
      this.emitter.clear();
    }
  };
  return __toCommonJS(HtmlDocEngine_exports);
})();
