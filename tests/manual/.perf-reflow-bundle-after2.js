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
      /** 本次重排的原因（写入 RelayoutState） */
      this.relayoutReason = "mount";
      /** 上一次测量到的标记偏移（增量测量的基准） */
      this.lastMarkerLeft = null;
      /** 上一次测量相对上上次新增的页数（增量测量结果，供诊断） */
      this.pagesAddedLastMeasure = 0;
      /** 重排状态回调（由 ReaderController 通过 setLayoutStateHandler 注入） */
      this.layoutStateHandler = null;
      this.resizeBound = () => {
        this.scheduleRelayout();
      };
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
        this.wrapPaged();
        await this.nextFrame();
        await this.nextFrame();
        if (this.destroyed) return;
        this.relayoutPages(true, true, false, "settings");
      } else {
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
        this.appendIntoLiveHost(html);
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
    }
    /** 当前生效的追加宿主（分页模式 = 挂在文档里的多栏容器；否则 body）。 */
    liveHost() {
      if (!this.isPaged()) return this.doc?.body ?? null;
      const cols = this.columnsEl;
      if (cols && cols.isConnected && this.paged?.contains(cols)) return cols;
      this.wrapPaged();
      return this.columnsEl ?? this.doc?.body ?? null;
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
     * 把暂存内容并入多栏容器：**只搬 DOM，不重排、不读布局**。
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
      const cols = this.columnsEl;
      const host = cols && this.paged?.contains(cols) ? cols : doc.body;
      if (!host) return false;
      const marker = this.endMarker;
      const frag = doc.createDocumentFragment();
      while (stage.firstChild) frag.appendChild(stage.firstChild);
      if (marker && marker.parentElement === host) host.insertBefore(frag, marker);
      else host.appendChild(frag);
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
    /** 锚点元素在第几页（分页模式）：按元素相对阅读窗口的横坐标反推列号。 */
    pageOfElement(el) {
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
    }
    /**
     * 把 body 内容搬进"阅读窗口 > 多栏容器"，进入分页模式。
     *
     * 宿主重建（shim 被外部摘掉）时**优先复用仍在的旧子树**：整本书的内容都在
     * 旧 shim 里，body 此刻可能是空的，直接"复位引用 + 新建"会把书清零。
     */
    wrapPaged() {
      if (this.paged && this.paged.isConnected && this.columnsEl && this.endMarker) return;
      const doc = this.doc;
      const body = doc?.body;
      if (!doc || !body) return;
      if (this.paged && this.columnsEl && this.paged.contains(this.columnsEl)) {
        body.appendChild(this.paged);
        if (this.endMarker && this.endMarker.parentElement !== this.columnsEl) this.columnsEl.appendChild(this.endMarker);
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
      while (body.firstChild) columns.appendChild(body.firstChild);
      if (stage) body.appendChild(stage);
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
    }
    /** 把内容搬回 body 正常流，退出分页模式。 */
    unwrapPaged() {
      const body = this.doc?.body;
      if (!body || !this.paged) return;
      if (this.endMarker) this.endMarker.remove();
      if (this.columnsEl) {
        while (this.columnsEl.firstChild) body.appendChild(this.columnsEl.firstChild);
      }
      this.paged.remove();
      this.paged = null;
      this.columnsEl = null;
      this.endMarker = null;
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
    /** 生成渲染文档的基础样式表（纯字符串，便于对比与审查）。 */
    buildBaseCss() {
      const paged = this.isPaged();
      const dark = this.settings.theme === "dark";
      const m = this.settings.margin;
      const lh = this.settings.lineHeight;
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
			html { font-size: ${this.effectiveFontSize()}px; overflow: ${paged ? "hidden" : "auto"}; }
			body {
				font-family: ${this.settings.fontFamily};
				line-height: ${lh};
				color: inherit;
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
      this.relayoutReason = reason;
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
      this.pages = this.measurePages();
      if (keepPage && prevPages > 0) {
        this.currentPage = clampPage(prevPage, this.pages);
      } else {
        this.currentPage = this.pages > 0 ? clampPage(Math.round(prevPct * this.pages) || 1, this.pages) : 1;
      }
      this.currentPage = alignSpreadPage(this.currentPage, next.double);
      this.positionColumns();
      const elapsed = this.nowMs() - startedAt;
      this.lastRelayoutMs = elapsed;
      this.emitLayoutState({ busy: false, reason, elapsedMs: elapsed });
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
    /** 按当前页把对应列移入阅读窗口。 */
    positionColumns() {
      if (!this.columnsEl) return;
      this.columnsEl.style.transform = `translateX(${columnOffsetPx(this.currentPage, this.layout)}px)`;
    }
    /** 定位到某页（翻页/跳转共用）。双页模式下左页恒为奇数。 */
    showPage(page, emit = true) {
      this.runPendingSettingsRelayout();
      this.flushPendingContent();
      if (this.pages < 1 || !this.columnsEl) {
        this.currentPage = Math.max(1, page);
        return;
      }
      this.currentPage = alignSpreadPage(clampPage(page, this.pages), this.layout.double);
      this.positionColumns();
      if (emit) this.emitProgress();
    }
    /** 滚动模式：↑/↓ 方向键按行滚动（保持原生文档手感，不整页翻）。 */
    scrollStep(direction) {
      const win = this.iframe.contentWindow;
      if (!win) return;
      const linePx = Math.max(1, this.effectiveFontSize() * this.settings.lineHeight);
      win.scrollBy({ top: direction * linePx, behavior: "auto" });
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
