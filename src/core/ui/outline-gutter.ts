/**
 * 文章脉络 navigator: a resident floating card on the left of the reader. It sits
 * in the blank margin left of the PDF pages when there is room (translucent) and
 * floats over the page edge otherwise; the user can collapse it to a small edge
 * tab. The outline is generated only when the user asks for it. Clicking a node
 * scrolls the PDF to the paragraph / figure and draws a translucent guide
 * (connector + soft box) that fades out by itself.
 */
import { getPref, getSettings, saveSettings, setPref, type QuickAction } from "../config";
import { saveRegionHighlight } from "../annotate";
import type { Selection } from "../quick";
import { getPageLabel } from "../reader-utils";
import type { ContextTracker, PaperContext } from "../context";
import { resolveAnchor, type AnchorRegion, type OutlineService, type OutlineState } from "../outline";
import { RELATION_LABELS, flattenOutline, type OutlineAnchor, type OutlineNode, type OutlineSection, type PaperOutline } from "../outline-schema";
import { paperKey } from "../paper";
import { findReader, waive } from "../reader-utils";
import { ensureStylesheet, h } from "./dom";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Navigator column width bounds (px). */
const MIN_W = 200;
const MAX_W = 640;
/** Narrowest PDF area we accept before floating over the page instead of reserving a column. */
const MIN_PDF_W = 380;

/**
 * Representative colour per role, taken from Zotero's standard annotation colours so the
 * one-click highlights can be filtered by colour in Zotero: 背景 blue · Gap red · 方法 purple ·
 * 结果 orange · 结论 green (plus gray / magenta / yellow for the remaining roles).
 */
const ZOTERO_COLORS = {
  yellow: "#ffd400",
  red: "#ff6666",
  green: "#5fb236",
  blue: "#2ea8e5",
  purple: "#a28ae5",
  magenta: "#e56eee",
  orange: "#f19837",
  gray: "#aaaaaa",
};

const SECTION_COLORS: Record<string, string> = {
  abstract: ZOTERO_COLORS.gray,
  background: ZOTERO_COLORS.blue,
  traditional: ZOTERO_COLORS.gray,
  related: ZOTERO_COLORS.magenta,
  gap: ZOTERO_COLORS.red,
  method: ZOTERO_COLORS.purple,
  experiment: ZOTERO_COLORS.yellow,
  results: ZOTERO_COLORS.orange,
  conclusion: ZOTERO_COLORS.green,
  scope: ZOTERO_COLORS.blue,
  evolution: ZOTERO_COLORS.magenta,
  taxonomy: ZOTERO_COLORS.purple,
  comparison: ZOTERO_COLORS.orange,
  challenges: ZOTERO_COLORS.red,
};

/** Abstract roles reuse the colour of the matching outline section. */
const ROLE_COLORS: Record<string, string> = {
  背景: SECTION_COLORS.background,
  问题: SECTION_COLORS.traditional,
  已有方法: SECTION_COLORS.related,
  Gap: SECTION_COLORS.gap,
  方法: SECTION_COLORS.method,
  实验: SECTION_COLORS.experiment,
  结果: SECTION_COLORS.results,
  结论: SECTION_COLORS.conclusion,
  领域: SECTION_COLORS.scope,
  动机: SECTION_COLORS.background,
  范围: SECTION_COLORS.scope,
  分类框架: SECTION_COLORS.taxonomy,
  主要发现: SECTION_COLORS.comparison,
  挑战与展望: SECTION_COLORS.challenges,
};

export interface OutlineHost {
  /** Run a selection quick action (explain / translate / …) on a passage. */
  runQuickAction(reader: any, action: QuickAction, sel: Selection, anchor: DOMRect | null): void;
  /** Quote a passage into the chat side panel. */
  askInPanel(text: string, pageLabel: string): void;
}

interface Guide {
  region: AnchorRegion;
  /** Representative colour of the node that was clicked (guide marks + one-click highlight). */
  color: string;
  raf: number;
  /** Highlight box and key-sentence line boxes in main-window coordinates (last frame). */
  box: Box | null;
  focus: Box[];
  /** Offset of the pdf.js document (to map viewer events to main-window coordinates). */
  ox: number;
  oy: number;
}

/** Something whose key sentence the hover popup acts on: the jump highlight or a key mark. */
interface PopTarget {
  region: AnchorRegion;
  color: string;
  /** Key-sentence line boxes in main-window coordinates (kept current by the owner's frame loop). */
  focus: Box[];
}

/** One key block (+ its key sentence) in the "show all key passages" layer. */
interface MarkItem extends PopTarget {
  nodeId: string;
  box: Box | null;
  els: { box: SVGElement; focus: SVGElement[]; lines: SVGElement[] };
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Geometry {
  /** The PDF scroll area. */
  view: Box;
  /** Left edge and width of the reader's view host (the area the column is carved from). */
  hostLeft: number;
  hostWidth: number;
  /** Offset of the pdf.js document in main-window coordinates. */
  ox: number;
  oy: number;
  app: any;
  pv: any;
}

/** docked: own column, PDF pushed right; floating: over the page edge (reader too narrow); pill: collapsed. */
type Mode = "docked" | "floating" | "pill" | "none";

export class OutlineGutter {
  private win: any;
  private doc: Document;
  private root!: HTMLElement;
  private gutter!: HTMLElement;
  private body!: HTMLElement;
  private pill!: HTMLElement;
  private guideSvg!: SVGSVGElement;
  private ctx: PaperContext | null = null;
  private reader: any = null;
  private outline: PaperOutline | null = null;
  private mode: Mode = "none";
  private loadingSince = 0;
  private resizer!: HTMLElement;
  private width = 0;
  private dragging = false;
  /** Readers whose PDF view we shrank to make room for the column. */
  private reserved = new Set<any>();
  private expanded = new Map<string, Set<string>>();
  private rows = new Map<string, HTMLElement>();
  /** Latest data per node id (handlers read from here, so streamed updates take effect). */
  private nodeData = new Map<string, OutlineNode>();
  /** Section ids already shown per paper (only first appearance auto-expands). */
  private seen = new Map<string, Set<string>>();
  private tree: HTMLElement | null = null;
  private treeKey = "";
  private headEl: HTMLElement | null = null;
  private headSig = "";
  private progress: { key: string; el: HTMLElement; stage: HTMLElement; skeleton: HTMLElement } | null = null;
  private think: { el: HTMLElement; body: HTMLElement } | null = null;
  private oneEl: HTMLElement | null = null;
  private activeId: string | null = null;
  private timer: any = null;
  private guide: Guide | null = null;
  private popTarget: PopTarget | null = null;
  /** Last pdf.js document offset in main-window coordinates (maps viewer events). */
  private vo = { ox: 0, oy: 0 };
  /** "Show all key passages" layer. */
  private marks: { key: string; items: MarkItem[]; svg: SVGSVGElement; clip: SVGElement; raf: number; sig: string } | null = null;
  private marksToken = 0;
  /** Zotero reader popups (annotation / selection / citation …) in main-window coordinates. */
  private popupBoxes: Box[] = [];
  private popupSig = "";
  private holeSig = "";
  private readerObs: { doc: any; mo: any } | null = null;
  private popupRaf = 0;
  private pop!: HTMLElement;
  private popOpen = false;
  private popTimer: any = null;
  private viewerWin: any = null;
  private resizeRaf = 0;
  private lastViewW = 0;
  private lastViewReader: any = null;
  private renderedKey = "";
  private unsubs: (() => void)[] = [];
  private lastPage = -1;

  constructor(
    win: any,
    private service: OutlineService,
    private context: ContextTracker,
    private host: OutlineHost,
  ) {
    this.win = win;
    this.doc = win.document;
    this.build();
    this.unsubs.push(
      context.changes.on((c) => this.attach(c)),
      service.changes.on((ch) => {
        if (this.ctx && ch.key === paperKey(this.ctx.ref)) this.render(ch.state);
      }),
    );
    this.timer = setInterval(() => this.tick(), 300);
    this.attach(context.get());
  }

  // ------------------------------------------------------------------ DOM

  private build(): void {
    const doc = this.doc;
    ensureStylesheet(doc, "zoteropi-outline-css", "chrome://zoteropi/content/outline.css");
    this.root = h(doc, "div", { class: "zpo-root" });
    this.gutter = h(doc, "div", { class: "zpo-gutter", hidden: "true" });
    this.body = h(doc, "div", { class: "zpo-body" });
    this.pill = h(doc, "div", { class: "zpo-pill", hidden: "true", title: "文章脉络" }, [
      h(doc, "span", { class: "zpo-pill-logo", text: "π" }),
      h(doc, "span", { class: "zpo-pill-text", text: "脉络" }),
    ]);
    this.pill.addEventListener("click", () => this.onPill());
    this.gutter.addEventListener("wheel", (e) => this.onWheel(e as WheelEvent), { passive: true });
    this.guideSvg = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    this.guideSvg.setAttribute("class", "zpo-guide");
    this.resizer = h(doc, "div", { class: "zpo-resizer", hidden: "true", title: "拖动调整脉络宽度（PDF 随之缩放）" });
    this.resizer.addEventListener("pointerdown", (e) => this.startResize(e as PointerEvent));
    this.resizer.addEventListener("dblclick", () => {
      this.width = 300;
      saveSettings({ outlineWidth: 300 });
      this.layout();
    });
    this.root.append(this.gutter, this.resizer, this.pill, this.guideSvg);
    this.buildPop();
    doc.documentElement.appendChild(this.root);
  }

  /** The margin must not swallow scrolling: pass the wheel to the PDF when the outline can't scroll that way. */
  private onWheel(e: WheelEvent): void {
    const b = this.body;
    const canScroll = b.isConnected && (e.deltaY < 0 ? b.scrollTop > 0 : b.scrollTop + b.clientHeight < b.scrollHeight - 1);
    if (canScroll && b.contains(e.target as Node)) return;
    try {
      const pv = waive(waive(this.reader?._internalReader)?._primaryView);
      const container = waive(waive(waive(pv?._iframeWindow)?.PDFViewerApplication)?.pdfViewer?.container);
      const line = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? container.clientHeight : 1;
      container.scrollBy(e.deltaX * line, e.deltaY * line);
    } catch {
      // reader gone
    }
  }

  private btn(label: string, title: string, fn: () => void): HTMLElement {
    const b = h(this.doc, "button", { class: "zpo-btn", title, text: label });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  }

  // ------------------------------------------------------------------ context

  private attach(ctx: PaperContext | null): void {
    const reader = ctx?.source === "reader" && ctx.attachmentID ? findReader(ctx.attachmentID) : null;
    const isPdf = reader && (reader.type === "pdf" || reader._type === "pdf" || !reader.type);
    const sameKey = ctx && this.ctx && paperKey(ctx.ref) === paperKey(this.ctx.ref);
    this.ctx = isPdf ? ctx : null;
    this.reader = isPdf ? reader : null;
    if (!sameKey) {
      this.cancelGuide();
      this.removeMarks();
      this.renderedKey = "";
      this.lastPage = -1;
    }
    this.syncViewerListeners();
    if (!this.ctx) {
      this.outline = null;
      this.layout();
      return;
    }
    const ref = this.ctx.ref;
    this.render(this.service.state(ref));
    void this.service.load(ref).then((st) => {
      if (this.ctx && paperKey(this.ctx.ref) === paperKey(ref)) this.render(st);
    });
    this.layout();
  }

  // ------------------------------------------------------------------ geometry

  private geometry(): Geometry | null {
    const r = this.reader;
    if (!r) return null;
    try {
      const frame: Element | undefined = r._iframe;
      if (!frame || !(frame as any).isConnected) return null;
      const R = frame.getBoundingClientRect();
      if (R.width < 80 || R.height < 80) return null;
      const pv = waive(waive(r._internalReader)?._primaryView);
      const inner: Element | undefined = pv?._iframe;
      const host: Element | null | undefined = inner?.parentElement;
      const app = waive(waive(pv?._iframeWindow)?.PDFViewerApplication);
      const viewer = waive(app?.pdfViewer);
      if (!inner || !host || !viewer?.pagesCount) return null;
      const I = inner.getBoundingClientRect();
      const H = host.getBoundingClientRect();
      const container = waive(viewer.container);
      const C = container.getBoundingClientRect();
      const ox = R.left + I.left;
      const oy = R.top + I.top;
      const view = { left: ox + C.left, top: oy + C.top, right: ox + Math.min(C.right, I.width), bottom: oy + Math.min(C.bottom, I.height) };
      this.vo = { ox, oy };
      return { view, hostLeft: R.left + H.left, hostWidth: H.width, ox, oy, app, pv };
    } catch {
      return null;
    }
  }

  /**
   * Shrink (px > 0) or restore (px = 0) the reader's PDF view so the column doesn't cover the
   * page. Resizing the view iframe makes pdf.js / Zotero re-fit "page width" / "auto" zoom by
   * themselves, so the paper rescales together with the column.
   */
  private reserve(reader: any, px: number): void {
    try {
      const pv = waive(waive(reader?._internalReader)?._primaryView);
      const iframe = pv?._iframe as HTMLElement | undefined;
      const host = iframe?.parentElement as HTMLElement | null | undefined;
      if (!iframe || !host) return;
      const want = px > 0 ? `${Math.round(px)}px` : "";
      if (iframe.style.marginInlineStart === want) return;
      if (px > 0) {
        iframe.style.marginInlineStart = want;
        iframe.style.width = `calc(100% - ${want})`;
        iframe.style.flexShrink = "0";
        host.style.backgroundColor = viewerBackground(pv);
        this.reserved.add(reader);
      } else {
        iframe.style.marginInlineStart = "";
        iframe.style.width = "";
        iframe.style.flexShrink = "";
        host.style.backgroundColor = "";
        this.reserved.delete(reader);
      }
    } catch (e) {
      Zotero.debug(`[ZoteroPi] outline reserve: ${e}`);
    }
  }

  private releaseAll(except?: any): void {
    for (const r of [...this.reserved]) if (r !== except) this.reserve(r, 0);
  }

  private startResize(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = this.resizer;
    const startX = e.clientX;
    const startW = this.width;
    el.setPointerCapture(e.pointerId);
    this.dragging = true;
    this.root.classList.add("zpo-resizing");
    let raf = 0;
    const move = (ev: PointerEvent) => {
      this.width = startW + (ev.clientX - startX);
      if (!raf) {
        raf = this.win.requestAnimationFrame(() => {
          raf = 0;
          this.layout();
        });
      }
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      this.dragging = false;
      this.root.classList.remove("zpo-resizing");
      this.layout();
      saveSettings({ outlineWidth: Math.round(this.width) });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  private tick(): void {
    this.syncViewerListeners();
    this.layout();
    this.updatePopups();
    this.updateReadingPosition();
    const el = this.gutter.querySelector(".zpo-elapsed");
    if (el && this.loadingSince) el.textContent = `${Math.round((Date.now() - this.loadingSince) / 1000)}s`;
  }

  private layout(): void {
    const g = this.ctx ? this.geometry() : null;
    const settings = getSettings();
    const visible = settings.outlineVisible;
    if (!this.dragging) this.width = this.width || settings.outlineWidth || 300;
    let mode: Mode = "none";
    let width = 0;
    if (g) {
      const maxW = Math.max(MIN_W, Math.min(MAX_W, g.hostWidth * 0.55));
      width = Math.max(MIN_W, Math.min(maxW, this.width));
      this.width = width;
      if (!visible) mode = "pill";
      else if (g.hostWidth - width >= MIN_PDF_W) mode = "docked";
      else mode = "floating";
    }
    // Only the current reader keeps its column; others go back to full width
    this.releaseAll(mode === "docked" ? this.reader : undefined);
    if (mode === "docked") this.reserve(this.reader, width);
    else if (this.reader) this.reserve(this.reader, 0);
    this.keepViewport();

    if (mode !== this.mode) {
      this.mode = mode;
      this.root.setAttribute("data-mode", mode);
      if (mode === "none") this.cancelGuide();
    }
    const showCard = mode === "docked" || mode === "floating";
    this.gutter.hidden = !showCard;
    this.resizer.hidden = !showCard;
    this.pill.hidden = mode !== "pill";
    if (!g) return;
    const top = g.view.top + 8;
    const height = g.view.bottom - g.view.top - 16;
    if (showCard) {
      const left = g.hostLeft + 6;
      const cardW = mode === "docked" ? width - 12 : Math.min(width, g.hostWidth - 24);
      this.place(this.gutter, left, top, cardW, height);
      const r = this.gutter.getBoundingClientRect();
      Object.assign(this.resizer.style, { left: `${Math.round(left + cardW + 1)}px`, top: `${Math.round(top)}px`, height: `${Math.round(Math.max(r.height, 60))}px` });
    } else if (mode === "pill") {
      this.pill.style.left = `${g.hostLeft + 6}px`;
      this.pill.style.top = `${g.view.top + 48}px`;
      this.pill.setAttribute("data-hidden-pref", String(!visible));
    }
  }

  private place(el: HTMLElement, left: number, top: number, width: number, height: number): void {
    const s = el.style;
    const px = (n: number) => `${Math.round(n)}px`;
    if (s.left !== px(left)) s.left = px(left);
    if (s.top !== px(top)) s.top = px(top);
    if (s.width !== px(width)) s.width = px(width);
    // Shrink to content; scroll inside when taller than the view
    if (s.maxHeight !== px(height)) s.maxHeight = px(height);
  }

  private onPill(): void {
    this.setExpanded(true);
  }

  private setExpanded(expanded: boolean): void {
    saveSettings({ outlineVisible: expanded });
    this.layout();
  }

  /** Toolbar / menu toggle: expand or collapse the navigator. */
  toggle(): void {
    this.setExpanded(!getSettings().outlineVisible);
  }

  // ------------------------------------------------------------------ render

  private render(state: OutlineState): void {
    const pk = this.ctx ? paperKey(this.ctx.ref) : "";
    const detail =
      state.status === "ready"
        ? state.outline.created
        : state.status === "loading"
          ? `${state.stage}|${state.rev || 0}|${state.thinking?.length || 0}`
          : state.status === "error"
            ? state.message
            : "";
    const key = `${pk}|${state.status}|${detail}`;
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    const doc = this.doc;
    const streaming = state.status === "loading";
    this.outline = state.status === "ready" ? state.outline : streaming ? state.partial || null : null;
    this.loadingSince = streaming ? state.started : 0;
    this.pill.setAttribute("data-state", state.status);
    this.pill.title = streaming ? "正在生成文章脉络…（点击展开）" : "展开文章脉络";
    const o = this.outline;
    const hasNodes = !!o?.sections.length;

    // Header: rebuilt only when its buttons / badge change
    const headSig = `${pk}|${state.status}|${o?.kind || ""}|${this.marksOn()}`;
    if (this.headSig !== headSig || !this.headEl) {
      this.headSig = headSig;
      const head = h(doc, "div", { class: "zpo-head" }, [
        h(doc, "span", { class: "zpo-logo", text: "π" }),
        h(doc, "span", { class: "zpo-heading", text: "文章脉络" }),
      ]);
      if (o) head.append(h(doc, "span", { class: "zpo-kind", text: o.kind === "survey" ? "综述" : "研究" }));
      head.append(h(doc, "span", { class: "zpo-spacer" }));
      if (state.status === "ready") {
        const on = this.marksOn();
        const t = this.btn("重点", on ? "隐藏文中所有重点块与重点句" : "在文中显示所有重点块（浅色底）与重点句", () => this.toggleMarks());
        t.classList.add("zpo-btn-text");
        t.setAttribute("data-on", String(on));
        head.append(t);
        head.append(this.btn("⊟", "全部折叠 / 展开", () => this.toggleAll()));
      }
      if (state.status === "ready" || state.status === "error") {
        head.append(this.btn("↻", "重新分析文章脉络", () => this.ctx && this.service.generate(this.ctx.ref, true)));
      }
      head.append(this.btn("‹", "收起（点击左边缘的「π 脉络」标签或阅读器工具栏 π≡ 重新展开）", () => this.setExpanded(false)));
      this.headEl = head;
    }

    // Status line: one persistent element while generating, text updated in place
    let status: HTMLElement | null = null;
    if (streaming) {
      if (!this.progress || this.progress.key !== pk) {
        const cancel = h(doc, "button", { class: "zpo-link", text: "取消" });
        cancel.addEventListener("click", () => this.ctx && this.service.cancel(this.ctx.ref));
        const stage = h(doc, "span");
        const skeleton = h(doc, "div", { class: "zpo-skeleton" }, [1, 2, 3, 4, 5].map(() => h(doc, "div", { class: "zpo-skel-line" })));
        const el = h(doc, "div", { class: "zpo-status" }, [
          h(doc, "div", { class: "zpo-progress" }, [
            h(doc, "div", { class: "zpo-spinner" }),
            stage,
            h(doc, "span", { class: "zpo-elapsed", text: "0s" }),
            h(doc, "span", { class: "zpo-spacer" }),
            cancel,
          ]),
          skeleton,
        ]);
        this.progress = { key: pk, el, stage, skeleton };
      }
      const p = this.progress;
      if (p.stage.textContent !== state.stage) p.stage.textContent = state.stage || "正在分析…";
      p.el.classList.toggle("zpo-status-compact", hasNodes);
      // Placeholder lines only until there is something to show (thinking or nodes)
      p.skeleton.hidden = hasNodes || !!state.thinking;
      status = p.el;
    } else {
      this.progress = null;
      if (state.status === "error") {
        status = h(doc, "div", { class: "zpo-status zpo-error" }, [h(doc, "div", { text: state.message })]);
      } else if (state.status === "idle") {
        const go = h(doc, "button", { class: "zpo-go", text: "生成文章脉络" });
        go.addEventListener("click", () => this.ctx && this.service.generate(this.ctx.ref));
        status = h(doc, "div", { class: "zpo-status" }, [
          h(doc, "div", { text: "梳理摘要 → 背景 → 问题 → 相关工作 → Gap → 方法 → 实验 → 结果 → 结论，点击即可跳转到原文。" }),
          go,
        ]);
      }
    }

    // Thinking window: while waiting for the first node only
    let think: HTMLElement | null = null;
    if (streaming && !hasNodes && state.thinking) {
      think = this.thinkBox(state.thinking);
    } else {
      this.think = null;
    }

    // One-line summary
    if (o?.oneLine) {
      if (!this.oneEl) this.oneEl = h(doc, "div", { class: "zpo-one" });
      if (this.oneEl.textContent !== o.oneLine) this.oneEl.textContent = o.oneLine;
    } else this.oneEl = null;

    // Tree: kept across updates so streamed nodes grow in place
    if (hasNodes) {
      if (this.treeKey !== pk || !this.tree) {
        this.rows.clear();
        this.body = h(doc, "div", { class: "zpo-body" });
        this.tree = h(doc, "div", { class: "zpo-tree" });
        this.body.append(this.tree);
        this.treeKey = pk;
      }
      this.reconcile(o!, streaming);
      this.body.classList.toggle("zpo-streaming", streaming);
    } else {
      this.rows.clear();
      this.tree = null;
      this.treeKey = "";
    }

    const parts = [this.headEl, status, think, this.oneEl, hasNodes ? this.body : null].filter(Boolean) as HTMLElement[];
    this.setParts(parts);
    this.applyActive();
    if (o?.relations.length) this.win.requestAnimationFrame(() => this.drawArcs());
    this.syncMarks();
  }

  /** Put `parts` in order without detaching elements that are already in place (no restarts). */
  private setParts(parts: HTMLElement[]): void {
    const g = this.gutter;
    parts.forEach((p, i) => {
      if (g.children[i] !== p) g.insertBefore(p, g.children[i] || null);
    });
    while (g.children.length > parts.length) g.lastElementChild!.remove();
  }

  /** Fixed-height, collapsible window streaming the model's reasoning. */
  private thinkBox(text: string): HTMLElement {
    const doc = this.doc;
    if (!this.think) {
      const body = h(doc, "div", { class: "zpo-think-body" });
      const chevron = h(doc, "span", { class: "zpo-think-chevron", text: "›" });
      const headRow = h(doc, "div", { class: "zpo-think-head", title: "展开 / 收起思考过程" }, [
        h(doc, "span", { class: "zpo-think-dot" }),
        h(doc, "span", { text: "思考过程" }),
        h(doc, "span", { class: "zpo-spacer" }),
        chevron,
      ]);
      const el = h(doc, "div", { class: "zpo-think" }, [headRow, body]);
      el.classList.toggle("zpo-think-collapsed", !!getPref<boolean>("outlineThinkCollapsed"));
      headRow.addEventListener("click", () => {
        const collapsed = !el.classList.contains("zpo-think-collapsed");
        el.classList.toggle("zpo-think-collapsed", collapsed);
        setPref("outlineThinkCollapsed", collapsed);
        if (!collapsed) body.scrollTop = body.scrollHeight;
      });
      this.think = { el, body };
    }
    const { el, body } = this.think;
    // Follow the newest text unless the user scrolled up to read
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
    if (body.textContent !== text) body.textContent = text;
    if (atBottom) body.scrollTop = body.scrollHeight;
    return el;
  }

  private expandedSet(): Set<string> {
    const key = this.ctx ? paperKey(this.ctx.ref) : "";
    let set = this.expanded.get(key);
    if (!set) {
      set = new Set();
      this.expanded.set(key, set);
    }
    return set;
  }

  /** Sync the tree DOM with the outline; new nodes get the grow animation while streaming. */
  private reconcile(o: PaperOutline, animate: boolean): void {
    this.nodeData.clear();
    for (const f of flattenOutline(o)) this.nodeData.set(f.node.id, f.node);
    const tree = this.tree!;
    tree.classList.toggle("zpo-has-arcs", o.relations.length > 0);
    this.reconcileList(tree, o.sections, 0, "", "", animate);
    let arcs = this.body.querySelector(".zpo-arcs");
    if (o.relations.length && !arcs) {
      arcs = this.doc.createElementNS(SVG_NS, "svg");
      arcs.setAttribute("class", "zpo-arcs");
      this.body.append(arcs);
    } else if (!o.relations.length && arcs) arcs.remove();
  }

  private reconcileList(container: HTMLElement, nodes: OutlineNode[], depth: number, prefix: string, sectionKey: string, animate: boolean): void {
    const pk = this.ctx ? paperKey(this.ctx.ref) : "";
    let seen = this.seen.get(pk);
    if (!seen) this.seen.set(pk, (seen = new Set()));
    nodes.forEach((n, i) => {
      const num = depth === 0 ? String(i + 1) : `${prefix}.${i + 1}`;
      const section = depth === 0 ? (n as OutlineSection).key : sectionKey;
      let el = this.rows.get(n.id);
      if (!el || el.parentElement !== container) {
        el?.remove();
        el = this.createNode(n.id, depth, section);
        // Sections start expanded the first time they appear
        if (depth === 0 && !seen!.has(n.id)) this.expandedSet().add(n.id);
        seen!.add(n.id);
        if (animate) {
          const grown = el;
          grown.classList.add("zpo-grow");
          grown.addEventListener("animationend", () => grown.classList.remove("zpo-grow"), { once: true });
        }
        this.rows.set(n.id, el);
      }
      if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
      this.updateNode(el, n, depth, num, section);
      const kids = el.querySelector(":scope > .zpo-children") as HTMLElement;
      this.reconcileList(kids, n.children, depth + 1, num, section, animate);
    });
    while (container.children.length > nodes.length) {
      const last = container.lastElementChild as HTMLElement;
      const id = last.getAttribute("data-id");
      if (id) this.rows.delete(id);
      last.remove();
    }
  }

  /** Static skeleton of a node; handlers read the latest data from nodeData. */
  private createNode(id: string, depth: number, section: string): HTMLElement {
    const doc = this.doc;
    const el = h(doc, "div", { class: `zpo-node zpo-d${depth}`, "data-id": id, "data-section": section });
    const twisty = h(doc, "span", { class: "zpo-twisty" });
    twisty.addEventListener("click", (e) => {
      e.stopPropagation();
      const n = this.nodeData.get(id);
      if (n?.children.length) this.setOpen(id, !this.expandedSet().has(id));
    });
    const title = h(doc, "div", { class: "zpo-title" }, [h(doc, "span", { class: "zpo-num" }), h(doc, "span", { class: "zpo-title-text" })]);
    const text = h(doc, "div", { class: "zpo-text" }, [title, h(doc, "div", { class: "zpo-sum", hidden: "true" }), h(doc, "div", { class: "zpo-anchors" }), h(doc, "div", { class: "zpo-rels" })]);
    const row = h(doc, "div", { class: "zpo-row" }, [twisty, text]);
    row.addEventListener("click", () => {
      const n = this.nodeData.get(id);
      if (!n) return;
      this.select(id);
      if (n.children.length && !this.expandedSet().has(id)) this.setOpen(id, true);
      const a = n.anchors.find((x) => x.quote || x.figure) || n.anchors[0];
      if (a) void this.jump(a, row, this.colorOf(id));
    });
    row.addEventListener("mouseenter", () => this.hoverArcs(id, true));
    row.addEventListener("mouseleave", () => this.hoverArcs(id, false));
    el.append(row, h(doc, "div", { class: "zpo-children" }));
    return el;
  }

  private updateNode(el: HTMLElement, n: OutlineNode, depth: number, num: string, section: string): void {
    const doc = this.doc;
    const hasKids = n.children.length > 0;
    el.classList.toggle("zpo-has-kids", hasKids);
    el.classList.toggle("zpo-open", this.expandedSet().has(n.id));
    if (depth === 0) el.style.setProperty("--sec", SECTION_COLORS[section] || "#6d5bd0");
    else if (section === "abstract" && depth === 1) el.style.setProperty("--role", ROLE_COLORS[n.title] || "#8a8f98");
    const row = el.firstElementChild as HTMLElement;
    const setText = (sel: string, v: string) => {
      const x = row.querySelector(sel) as HTMLElement;
      if (x.textContent !== v) x.textContent = v;
      return x;
    };
    setText(".zpo-twisty", hasKids ? "›" : "");
    setText(".zpo-num", depth < 2 ? num : "·");
    setText(".zpo-title-text", n.title);
    const title = row.querySelector(".zpo-title") as HTMLElement;
    let period = title.querySelector(".zpo-period") as HTMLElement | null;
    if (n.period) {
      if (!period) title.append((period = h(doc, "span", { class: "zpo-period" })));
      if (period.textContent !== n.period) period.textContent = n.period;
    } else period?.remove();
    const sum = row.querySelector(".zpo-sum") as HTMLElement;
    const sumText = n.summary && n.summary !== n.title ? n.summary : "";
    if (sum.textContent !== sumText) {
      if (sumText && sum.hidden) {
        sum.classList.add("zpo-sum-in");
        sum.addEventListener("animationend", () => sum.classList.remove("zpo-sum-in"), { once: true });
      }
      sum.textContent = sumText;
      sum.hidden = !sumText;
    }

    // Anchor chips and relation chips: rebuild only when they change
    const rels = this.relationsOf(n.id);
    const sig = JSON.stringify([n.anchors, rels.map((r) => [r.dir, r.type, r.partner.id, r.partner.title, r.label])]);
    if (el.getAttribute("data-sig") === sig) return;
    el.setAttribute("data-sig", sig);
    const chips = row.querySelector(".zpo-anchors") as HTMLElement;
    chips.textContent = "";
    for (const a of n.anchors) {
      const chip = h(doc, "span", { class: "zpo-chip", text: anchorLabel(a), title: a.quote ? `“${a.quote}”` : a.caption || `第 ${a.page} 页` });
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        this.select(n.id);
        void this.jump(a, row, this.colorOf(n.id));
      });
      chips.append(chip);
    }
    const box = row.querySelector(".zpo-rels") as HTMLElement;
    box.textContent = "";
    for (const r of rels) {
      const chip = h(doc, "span", { class: `zpo-rel zpo-rel-${r.type}`, text: `${r.dir === "out" ? "→" : "←"} ${RELATION_LABELS[r.type]} · ${r.partner.title}`, title: r.label || "" });
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        this.reveal(r.partner.id);
      });
      box.append(chip);
    }
  }

  private relationsOf(id: string) {
    const o = this.outline;
    if (!o?.relations.length) return [];
    const nodes = new Map(flattenOutline(o).map((f) => [f.node.id, f.node]));
    const out: { dir: "in" | "out"; type: keyof typeof RELATION_LABELS; label?: string; partner: OutlineNode }[] = [];
    for (const r of o.relations) {
      if (r.from === id && nodes.get(r.to)) out.push({ dir: "out", type: r.type, label: r.label, partner: nodes.get(r.to)! });
      else if (r.to === id && nodes.get(r.from)) out.push({ dir: "in", type: r.type, label: r.label, partner: nodes.get(r.from)! });
    }
    return out.slice(0, 4);
  }

  private setOpen(id: string, open: boolean): void {
    const set = this.expandedSet();
    if (open) set.add(id);
    else set.delete(id);
    this.rows.get(id)?.classList.toggle("zpo-open", open);
    this.drawArcs();
  }

  private toggleAll(): void {
    if (!this.outline) return;
    const set = this.expandedSet();
    const all = flattenOutline(this.outline).filter((f) => f.node.children.length);
    const anyClosed = all.some((f) => !set.has(f.node.id));
    for (const f of all) this.setOpen(f.node.id, anyClosed);
  }

  /** Expand ancestors, scroll the gutter to a node and flash it. */
  private reveal(id: string): void {
    const el = this.rows.get(id);
    if (!el) return;
    let p = el.parentElement;
    while (p && p !== this.body) {
      const pid = p.classList.contains("zpo-node") ? p.getAttribute("data-id") : null;
      if (pid) this.setOpen(pid, true);
      p = p.parentElement;
    }
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.classList.remove("zpo-flash");
    void el.offsetWidth;
    el.classList.add("zpo-flash");
    this.select(id);
  }

  private select(id: string): void {
    this.activeId = id;
    this.applyActive();
  }

  private applyActive(): void {
    for (const [id, el] of this.rows) el.classList.toggle("zpo-active", id === this.activeId);
  }

  // ------------------------------------------------------------------ reading position

  private updateReadingPosition(): void {
    if (!this.outline || this.mode !== "docked") return;
    let page = -1;
    try {
      const viewer = waive(waive(waive(waive(this.reader._internalReader)._primaryView)._iframeWindow).PDFViewerApplication.pdfViewer);
      page = viewer.currentPageNumber;
    } catch {
      return;
    }
    if (page === this.lastPage) return;
    this.lastPage = page;
    // Section whose earliest anchor page is the latest one not after the current page
    let best: string | null = null;
    let bestPage = -1;
    for (const s of this.outline.sections) {
      const pages = flattenOutline({ ...this.outline, sections: [s] }).flatMap((f) => f.node.anchors.map((a) => a.page)).filter(Boolean);
      if (!pages.length) continue;
      const min = Math.min(...pages);
      if (min <= page && min >= bestPage) {
        bestPage = min;
        best = s.id;
      }
    }
    for (const s of this.outline.sections) this.rows.get(s.id)?.classList.toggle("zpo-reading", s.id === best);
  }

  // ------------------------------------------------------------------ survey relation arcs

  private visibleRow(id: string): HTMLElement | null {
    let el: HTMLElement | null = this.rows.get(id) || null;
    // Climb to the nearest ancestor whose row is visible (not inside a collapsed node)
    while (el) {
      let hidden = false;
      let p = el.parentElement;
      while (p && p !== this.body) {
        if (p.classList.contains("zpo-node") && !p.classList.contains("zpo-open")) hidden = true;
        p = p.parentElement;
      }
      if (!hidden) return el.querySelector(":scope > .zpo-row");
      el = el.parentElement?.closest(".zpo-node") as HTMLElement | null;
    }
    return null;
  }

  private drawArcs(): void {
    const arcs = this.body.querySelector(".zpo-arcs");
    if (!arcs || !this.outline) return;
    arcs.textContent = "";
    const height = this.body.scrollHeight;
    arcs.setAttribute("height", String(height));
    arcs.setAttribute("width", "22");
    const base = this.body.getBoundingClientRect().top - this.body.scrollTop;
    const lanes: number[] = [];
    for (const r of this.outline.relations) {
      const a = this.visibleRow(r.from);
      const b = this.visibleRow(r.to);
      if (!a || !b || a === b) continue;
      const y1 = a.getBoundingClientRect().top - base + 11;
      const y2 = b.getBoundingClientRect().top - base + 11;
      const span = Math.abs(y2 - y1);
      const lane = lanes.filter((l) => l > 0).length % 3;
      lanes.push(span);
      const d = Math.min(18, 6 + span / 40 + lane * 3);
      const path = this.doc.createElementNS(SVG_NS, "path");
      path.setAttribute("d", `M 21 ${y1} C ${21 - d} ${y1}, ${21 - d} ${y2}, 21 ${y2}`);
      path.setAttribute("class", `zpo-arc zpo-rel-${r.type}`);
      path.setAttribute("data-from", r.from);
      path.setAttribute("data-to", r.to);
      if (r.type === "contrasts") path.setAttribute("stroke-dasharray", "3 3");
      arcs.append(path);
      const dot = this.doc.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", "21");
      dot.setAttribute("cy", String(y2));
      dot.setAttribute("r", "2");
      dot.setAttribute("class", `zpo-arc-dot zpo-rel-${r.type}`);
      dot.setAttribute("data-from", r.from);
      dot.setAttribute("data-to", r.to);
      arcs.append(dot);
    }
  }

  private hoverArcs(id: string, on: boolean): void {
    const arcs = this.body.querySelector(".zpo-arcs");
    if (!arcs) return;
    arcs.classList.toggle("zpo-focus", on);
    for (const el of Array.from(arcs.children)) {
      const hit = el.getAttribute("data-from") === id || el.getAttribute("data-to") === id;
      el.classList.toggle("zpo-hot", on && hit);
      if (on && hit) {
        const other = el.getAttribute("data-from") === id ? el.getAttribute("data-to") : el.getAttribute("data-from");
        if (other) this.rows.get(other)?.classList.add("zpo-related");
      }
    }
    if (!on) for (const el of this.rows.values()) el.classList.remove("zpo-related");
  }

  // ------------------------------------------------------------------ jump + guide

  /** Representative colour of a node: abstract roles by role, everything else by section. */
  private colorOf(id: string): string {
    const el = this.rows.get(id);
    const n = this.nodeData.get(id);
    const section = el?.getAttribute("data-section") || "";
    if (section === "abstract" && n && ROLE_COLORS[n.title]) return ROLE_COLORS[n.title];
    return SECTION_COLORS[section] || ZOTERO_COLORS.purple;
  }

  private async jump(anchor: OutlineAnchor, rowEl: HTMLElement, color = ZOTERO_COLORS.purple): Promise<void> {
    const reader = this.reader;
    if (!reader) return;
    const region = await resolveAnchor(reader, anchor);
    if (!region || reader !== this.reader) return;
    const g = this.geometry();
    if (!g) return;
    const viewWin = waive(g.pv._iframeWindow);
    try {
      if (region.box && typeof g.pv.navigateToPosition === "function") {
        g.pv.navigateToPosition(
          Components.utils.cloneInto({ pageIndex: region.pageIndex, rects: [region.box] }, viewWin),
          Components.utils.cloneInto({ block: "center" }, viewWin),
        );
      } else {
        waive(g.app.pdfViewer).scrollPageIntoView(Components.utils.cloneInto({ pageNumber: region.pageIndex + 1 }, viewWin));
      }
    } catch (e) {
      Zotero.logError(e);
      return;
    }
    this.showGuide(region, rowEl, color);
  }

  private cancelGuide(): void {
    if (!this.guide) return;
    this.win.cancelAnimationFrame(this.guide.raf);
    this.guideSvg.textContent = "";
    if (this.popTarget === this.guide) {
      this.hidePop(true);
      this.popTarget = null;
    }
    this.guide = null;
  }

  // ------------------------------------------------------------------ all key passages

  private marksOn(): boolean {
    return !!getPref<boolean>("outlineMarksVisible");
  }

  private toggleMarks(): void {
    setPref("outlineMarksVisible", !this.marksOn());
    this.headSig = ""; // refresh the toggle button state
    this.renderedKey = "";
    if (this.ctx) this.render(this.service.state(this.ctx.ref));
  }

  /** Show / update / remove the marks layer to match the toggle and the current outline. */
  private syncMarks(): void {
    const o = this.outline;
    const ready = !!this.ctx && !!o && this.service.state(this.ctx.ref).status === "ready";
    if (!ready || !this.marksOn() || !this.reader) {
      this.removeMarks();
      return;
    }
    const key = `${paperKey(this.ctx!.ref)}|${o!.created}`;
    if (this.marks?.key === key) return;
    this.removeMarks();
    void this.buildMarks(key, o!);
  }

  private removeMarks(): void {
    this.marksToken++;
    if (!this.marks) return;
    this.win.cancelAnimationFrame(this.marks.raf);
    if (this.popTarget && this.marks.items.includes(this.popTarget as MarkItem)) {
      this.hidePop(true);
      this.popTarget = null;
    }
    this.marks.svg.remove();
    this.marks = null;
  }

  /**
   * Resolve every node's anchors to key blocks + key sentences (in outline order). A block that
   * overlaps one already shown is skipped, so a repeated passage shows its first node only.
   */
  private async buildMarks(key: string, o: PaperOutline): Promise<void> {
    const token = ++this.marksToken;
    const reader = this.reader;
    const found: { region: AnchorRegion; color: string; nodeId: string }[] = [];
    for (const f of flattenOutline(o)) {
      for (const a of f.node.anchors) {
        if (!a.quote && !a.figure) continue;
        const region = await resolveAnchor(reader, a);
        if (token !== this.marksToken || reader !== this.reader) return;
        if (!region?.box) continue;
        const dup = found.some((x) => x.region.pageIndex === region.pageIndex && overlapRatio(x.region.box!, region.box!) > 0.5);
        if (dup) continue;
        found.push({ region, color: this.colorOf(f.node.id), nodeId: f.node.id });
      }
    }
    if (token !== this.marksToken) return;
    const doc = this.doc;
    const mk = (tag: string, attrs: Record<string, string> = {}) => {
      const el = doc.createElementNS(SVG_NS, tag) as SVGElement;
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    };
    const svg = mk("svg", { class: "zpo-marks" }) as SVGSVGElement;
    const clipId = "zpo-marks-clip";
    const clip = mk("rect");
    const cp = mk("clipPath", { id: clipId });
    cp.append(clip);
    const defs = mk("defs");
    defs.append(cp);
    const holes = mk("mask", { id: "zpo-marks-holes", maskUnits: "userSpaceOnUse" });
    defs.append(holes);
    const layer = mk("g", { "clip-path": `url(#${clipId})`, mask: "url(#zpo-marks-holes)" });
    svg.append(defs, layer);
    const items: MarkItem[] = found.map((f) => {
      const g = mk("g", { class: "zpo-mark-item" });
      g.style.setProperty("--zpo-guide", f.color);
      const box = mk("rect", { class: "zpo-mark-block", rx: "4", ry: "4" });
      const focus = f.region.focus.slice(0, 16).map(() => mk("rect", { class: "zpo-mark-focus", rx: "2", ry: "2" }));
      const lines = f.region.focus.slice(0, 16).map(() => mk("line", { class: "zpo-mark-line" }));
      g.append(box, ...focus, ...lines);
      layer.append(g);
      return { ...f, box: null, focus: [], els: { box, focus, lines } };
    });
    // Under the jump guide so a fresh jump stays on top
    this.root.insertBefore(svg, this.guideSvg);
    this.marks = { key, items, svg, clip, raf: 0, sig: "" };
    const frame = () => {
      const m = this.marks;
      if (!m || m.svg !== svg) return;
      m.raf = this.win.requestAnimationFrame(frame);
      const sig = this.viewSignature();
      if (sig === m.sig) return;
      m.sig = sig;
      const g = this.geometry();
      svg.style.display = g && this.mode !== "none" ? "" : "none";
      if (!g) return;
      clip.setAttribute("x", String(g.view.left));
      clip.setAttribute("y", String(g.view.top));
      clip.setAttribute("width", String(Math.max(0, g.view.right - g.view.left)));
      clip.setAttribute("height", String(Math.max(0, g.view.bottom - g.view.top)));
      this.fillHoles(holes);
      for (const it of m.items) {
        const b = this.regionBox(g, it.region, it.region.box);
        // Skip pages far outside the view
        const near = !!b && b.bottom > g.view.top - 400 && b.top < g.view.bottom + 400;
        (it.els.box.parentNode as SVGElement).style.display = near ? "" : "none";
        it.box = near ? b : null;
        it.focus = [];
        if (!near || !b) continue;
        const pad = 3;
        it.els.box.setAttribute("x", String(b.left - pad));
        it.els.box.setAttribute("y", String(b.top - pad));
        it.els.box.setAttribute("width", String(b.right - b.left + pad * 2));
        it.els.box.setAttribute("height", String(b.bottom - b.top + pad * 2));
        it.region.focus.slice(0, 16).forEach((r, i) => {
          const fb = this.regionBox(g, it.region, r);
          if (!fb) return;
          it.focus.push(fb);
          const f = it.els.focus[i];
          f.setAttribute("x", String(fb.left - 1.5));
          f.setAttribute("y", String(fb.top - 1));
          f.setAttribute("width", String(fb.right - fb.left + 3));
          f.setAttribute("height", String(fb.bottom - fb.top + 2));
          const l = it.els.lines[i];
          l.setAttribute("x1", String(fb.left));
          l.setAttribute("x2", String(fb.right));
          l.setAttribute("y1", String(fb.bottom + 1.5));
          l.setAttribute("y2", String(fb.bottom + 1.5));
        });
      }
      if (this.popOpen && this.popTarget && m.items.includes(this.popTarget as MarkItem)) this.placePop();
    };
    this.marks.raf = this.win.requestAnimationFrame(frame);
  }

  /** Box of a region in main-window coordinates (null if its page isn't laid out). */
  private regionBox(g: Geometry, region: AnchorRegion, rect: number[] | null): Box | null {
    try {
      const page = waive(waive(g.app.pdfViewer)._pages?.[region.pageIndex] ?? waive(g.app.pdfViewer).getPageView(region.pageIndex));
      const div = waive(page.div);
      const D = div.getBoundingClientRect();
      if (!rect) return { left: g.ox + D.left, top: g.oy + D.top, right: g.ox + D.right, bottom: g.oy + D.bottom };
      const vp = waive(page.viewport);
      const p1 = Array.from(waive(vp.convertToViewportPoint(rect[0], rect[1])) as number[]);
      const p2 = Array.from(waive(vp.convertToViewportPoint(rect[2], rect[3])) as number[]);
      return {
        left: g.ox + D.left + Math.min(p1[0], p2[0]),
        top: g.oy + D.top + Math.min(p1[1], p2[1]),
        right: g.ox + D.left + Math.max(p1[0], p2[0]),
        bottom: g.oy + D.top + Math.max(p1[1], p2[1]),
      };
    } catch {
      return null;
    }
  }

  /** Cheap fingerprint of everything that moves the highlight (scroll, zoom, layout). */
  private viewSignature(): string {
    try {
      const pv = waive(waive(this.reader._internalReader)._primaryView);
      const viewer = waive(waive(waive(pv._iframeWindow).PDFViewerApplication).pdfViewer);
      const c = waive(viewer.container);
      const f = (this.reader._iframe as Element).getBoundingClientRect();
      return `${c.scrollTop}|${c.scrollLeft}|${c.clientWidth}|${c.clientHeight}|${viewer.currentScale}|${f.left}|${f.top}|${f.width}|${this.popupSig}`;
    } catch {
      return "";
    }
  }

  /**
   * Highlight the jump target: a soft box around the paragraph / figure with the key sentence
   * marked (tint + underline), plus a connector from the outline node that fades after a few
   * seconds. The highlight itself stays until the user clicks elsewhere in the paper.
   */
  private showGuide(region: AnchorRegion, from: HTMLElement, color: string): void {
    this.cancelGuide();
    const doc = this.doc;
    const svg = this.guideSvg;
    svg.textContent = "";
    const mk = (tag: string, attrs: Record<string, string>) => {
      const el = doc.createElementNS(SVG_NS, tag) as SVGElement;
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    };
    const clipId = "zpo-guide-clip";
    const defs = mk("defs", {});
    const clip = mk("clipPath", { id: clipId });
    const clipRect = mk("rect", {});
    clip.append(clipRect);
    defs.append(clip);
    const holes = mk("mask", { id: "zpo-guide-holes", maskUnits: "userSpaceOnUse" });
    defs.append(holes);
    const group = mk("g", { "clip-path": `url(#${clipId})`, mask: "url(#zpo-guide-holes)" });
    group.style.setProperty("--zpo-guide", color);
    const box = mk("rect", { class: "zpo-guide-box", rx: "6", ry: "6" });
    const focusRects = region.focus.slice(0, 16);
    const focus = focusRects.map(() => mk("rect", { class: "zpo-guide-focus", rx: "2", ry: "2" }));
    const marks = focusRects.map(() => mk("line", { class: "zpo-guide-mark" }));
    const path = mk("path", { class: "zpo-guide-line" });
    const dot = mk("circle", { class: "zpo-guide-dot", r: "3" });
    const start = mk("circle", { class: "zpo-guide-start", r: "2.5" });
    group.append(box, ...focus, ...marks, path, dot, start);
    svg.append(defs, group);

    const LINE_HOLD = 2600;
    const FADE = 800;
    const guide: Guide = { region, color, raf: 0, box: null, focus: [], ox: 0, oy: 0 };
    this.guide = guide;
    const t0 = this.win.performance.now();
    let sig = "";
    let lineGone = false;

    const frame = () => {
      if (this.guide !== guide) return;
      guide.raf = this.win.requestAnimationFrame(frame);
      const t = this.win.performance.now() - t0;
      const animating = t < LINE_HOLD + FADE + 50;
      // Once the connector is gone, only recompute when the view actually moved
      if (!animating) {
        const next = this.viewSignature();
        if (next === sig && lineGone) return;
        sig = next;
      }
      const g = this.geometry();
      const target = g ? this.regionBox(g, region, region.box) : null;
      if (!g || !target) return;
      guide.ox = g.ox;
      guide.oy = g.oy;
      this.fillHoles(holes);
      clipRect.setAttribute("x", String(g.hostLeft));
      clipRect.setAttribute("y", String(g.view.top));
      clipRect.setAttribute("width", String(Math.max(0, g.view.right - g.hostLeft)));
      clipRect.setAttribute("height", String(Math.max(0, g.view.bottom - g.view.top)));

      const appear = String(Math.min(1, t / 220));
      const pad = region.box ? 5 : 0;
      const bx = target.left - pad;
      const by = target.top - pad;
      const bw = target.right - target.left + pad * 2;
      const bh = region.box ? target.bottom - target.top + pad * 2 : Math.min(60, target.bottom - target.top);
      box.setAttribute("x", String(bx));
      box.setAttribute("y", String(by));
      box.setAttribute("width", String(bw));
      box.setAttribute("height", String(bh));
      box.style.opacity = appear;
      guide.box = { left: bx, top: by, right: bx + bw, bottom: by + bh };
      guide.focus = [];
      focusRects.forEach((r, i) => {
        const fb = this.regionBox(g, region, r);
        if (!fb) return;
        guide.focus.push(fb);
        focus[i].setAttribute("x", String(fb.left - 2));
        focus[i].setAttribute("y", String(fb.top - 1.5));
        focus[i].setAttribute("width", String(fb.right - fb.left + 4));
        focus[i].setAttribute("height", String(fb.bottom - fb.top + 3));
        focus[i].style.opacity = appear;
        marks[i].setAttribute("x1", String(fb.left - 1));
        marks[i].setAttribute("x2", String(fb.right + 1));
        marks[i].setAttribute("y1", String(fb.bottom + 2));
        marks[i].setAttribute("y2", String(fb.bottom + 2));
        marks[i].style.opacity = appear;
      });
      if (this.popOpen) this.placePop();

      if (lineGone) return;
      const lo = t < 220 ? t / 220 : t < LINE_HOLD ? 1 : Math.max(0, 1 - (t - LINE_HOLD) / FADE);
      if (lo <= 0) {
        lineGone = true;
        path.remove();
        dot.remove();
        start.remove();
        return;
      }
      const fr = from.getBoundingClientRect();
      const sx = fr.right + 3;
      const sy = Math.max(g.view.top + 4, Math.min(g.view.bottom - 4, fr.top + Math.min(11, fr.height / 2)));
      const ex = bx - 3;
      const ey = Math.max(by + 4, Math.min(by + bh - 4, Math.max(g.view.top + 12, Math.min(g.view.bottom - 12, by + Math.min(14, bh / 2)))));
      const dx = Math.max(24, (ex - sx) * 0.5);
      path.setAttribute("d", `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`);
      const draw = Math.min(1, t / 420);
      if (draw < 1) {
        const len = (path as any).getTotalLength?.() || Math.hypot(ex - sx, ey - sy);
        path.setAttribute("stroke-dasharray", `${len} ${len}`);
        path.setAttribute("stroke-dashoffset", String(len * (1 - draw)));
      } else if (path.hasAttribute("stroke-dasharray")) {
        path.removeAttribute("stroke-dasharray");
        path.removeAttribute("stroke-dashoffset");
      }
      path.style.opacity = String(lo);
      start.setAttribute("cx", String(sx));
      start.setAttribute("cy", String(sy));
      start.style.opacity = String(lo);
      dot.setAttribute("cx", String(ex));
      dot.setAttribute("cy", String(ey));
      dot.style.opacity = draw >= 1 ? String(lo) : "0";
    };
    guide.raf = this.win.requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ viewer events

  /** Keep listeners on the pdf.js window of the current reader (it can be replaced). */
  private syncViewerListeners(): void {
    let win: any = null;
    try {
      const raw = waive(waive(waive(this.reader?._internalReader)?._primaryView)?._iframeWindow);
      win = raw ? Components.utils.unwaiveXrays(raw) : null;
    } catch {
      win = null;
    }
    this.syncReaderObserver();
    if (win === this.viewerWin) return;
    this.detachViewer();
    if (!win) return;
    this.viewerWin = win;
    win.addEventListener("pointerdown", this.onViewerDown, true);
    win.addEventListener("mousemove", this.onViewerMove, true);
    win.addEventListener("resize", this.onViewerResize);
    this.lastViewW = 0;
    this.keepViewport();
  }

  private detachViewer(): void {
    const win = this.viewerWin;
    this.viewerWin = null;
    if (!win) return;
    try {
      win.removeEventListener("pointerdown", this.onViewerDown, true);
      win.removeEventListener("mousemove", this.onViewerMove, true);
      win.removeEventListener("resize", this.onViewerResize);
    } catch {
      // window already gone
    }
  }

  // ------------------------------------------------------------------ yield to Zotero's popups

  /** Watch the reader document so we notice Zotero's popups as soon as they open / close. */
  private syncReaderObserver(): void {
    let doc: any = null;
    try {
      doc = this.reader?._iframeWindow?.document || null;
    } catch {
      doc = null;
    }
    if (this.readerObs?.doc === doc) return;
    try {
      this.readerObs?.mo.disconnect();
    } catch {
      // gone
    }
    this.readerObs = null;
    if (!doc?.body) {
      this.updatePopups();
      return;
    }
    const mo = new doc.defaultView.MutationObserver(() => this.schedulePopupCheck());
    mo.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    this.readerObs = { doc, mo };
    this.updatePopups();
  }

  private schedulePopupCheck(): void {
    if (this.popupRaf) return;
    this.popupRaf = this.win.requestAnimationFrame(() => {
      this.popupRaf = 0;
      this.updatePopups();
    });
  }

  /**
   * Our layers sit above the reader, so they would cover its popups. Instead of hiding, the
   * navigator (and its tab, resize handle, our action bar) gets a hole cut where a popup is:
   * the popup appears in front of it and receives the clicks, the rest stays usable. Page
   * marks leave a hole there too.
   */
  private updatePopups(): void {
    const boxes: Box[] = [];
    try {
      const doc = this.readerObs?.doc;
      const frame = this.reader?._iframe as Element | undefined;
      if (doc && frame && this.mode !== "none") {
        const R = frame.getBoundingClientRect();
        for (const p of Array.from(doc.querySelectorAll(".view-popup, .dialog-popup-overlay")) as Element[]) {
          const r = p.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          boxes.push({ left: R.left + r.left, top: R.top + r.top, right: R.left + r.right, bottom: R.top + r.bottom });
        }
      }
    } catch {
      // reader closing
    }
    const sig = boxes.map((b) => `${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.right)},${Math.round(b.bottom)}`).join(";");
    // Our own elements move / resize too, so their geometry is part of the check
    const els = [this.gutter, this.resizer, this.pill, this.pop];
    const elSig = els.map((el) => (el.hidden ? "-" : rectSig(el.getBoundingClientRect()))).join(";");
    if (sig === this.popupSig && elSig === this.holeSig) return;
    this.popupSig = sig;
    this.holeSig = elSig;
    this.popupBoxes = boxes;
    for (const el of els) cutHoles(el, el.hidden ? [] : boxes);
  }

  /** Cut the reader popups out of a mask (white = draw, black = hole). */
  private fillHoles(mask: SVGElement): void {
    const NS = SVG_NS;
    const sig = this.popupSig;
    if (mask.getAttribute("data-sig") === sig && mask.firstChild) return;
    mask.setAttribute("data-sig", sig);
    mask.textContent = "";
    const all = this.doc.createElementNS(NS, "rect");
    for (const [k, v] of Object.entries({ x: "-10000", y: "-10000", width: "30000", height: "30000", fill: "white" })) all.setAttribute(k, v);
    mask.append(all);
    for (const b of this.popupBoxes) {
      const r = this.doc.createElementNS(NS, "rect");
      for (const [k, v] of Object.entries({ x: String(b.left - 4), y: String(b.top - 4), width: String(b.right - b.left + 8), height: String(b.bottom - b.top + 8), rx: "8", fill: "black" })) r.setAttribute(k, v);
      mask.append(r);
    }
  }

  private inside(b: Box | null, x: number, y: number, m = 0): boolean {
    return !!b && x >= b.left - m && x <= b.right + m && y >= b.top - m && y <= b.bottom + m;
  }

  /** Clicking anywhere in the paper outside the highlighted block dismisses the highlight. */
  private onViewerDown = (e: PointerEvent) => {
    const x = this.vo.ox + e.clientX;
    const y = this.vo.oy + e.clientY;
    // Clicking a key sentence of the marks layer points to its node in the outline
    const hit = this.marks?.items.find((it) => it.focus.some((b) => this.inside(b, x, y, 2)));
    if (hit) {
      this.reveal(hit.nodeId);
    }
    const gd = this.guide;
    if (gd && !this.inside(gd.box, x, y, 4)) this.cancelGuide();
  };

  /** Hovering a key sentence (jump highlight or marks layer) offers quick actions. */
  private onViewerMove = (e: MouseEvent) => {
    const x = this.vo.ox + e.clientX;
    const y = this.vo.oy + e.clientY;
    const over = (t: PopTarget | null | undefined) => !!t && !!t.region.text && t.focus.some((b) => this.inside(b, x, y, 3));
    let target: PopTarget | null = null;
    if (over(this.guide)) target = this.guide;
    else target = this.marks?.items.find((it) => over(it)) || null;
    if (target) {
      if (this.popOpen && this.popTarget !== target) this.hidePop(true);
      this.popTarget = target;
      this.showPop();
    } else if (this.popOpen) this.hidePop(false);
  };

  private onViewerResize = () => {
    if (this.resizeRaf) return;
    this.resizeRaf = this.win.requestAnimationFrame(() => {
      this.resizeRaf = 0;
      this.keepViewport();
    });
  };

  // ------------------------------------------------------------------ keep the paper fitted

  /**
   * When the reading area changes width (outline column, chat panel, window), scale the paper
   * with it: fit modes (page width / auto) are re-fitted by pdf.js itself; a fixed zoom is
   * scaled proportionally but never beyond page width, so lines are never cut off. The point
   * at the vertical centre of the view stays at the centre and the page stays horizontally centred.
   */
  private keepViewport(): void {
    try {
      const pv = waive(waive(this.reader?._internalReader)?._primaryView);
      const viewer = waive(waive(waive(pv?._iframeWindow)?.PDFViewerApplication)?.pdfViewer);
      if (!viewer?.pagesCount) return;
      const c = waive(viewer.container);
      const w = c.clientWidth;
      if (!w) return;
      if (this.lastViewReader !== this.reader || !this.lastViewW) {
        this.lastViewReader = this.reader;
        this.lastViewW = w;
        return;
      }
      if (Math.abs(w - this.lastViewW) < 2) return;
      const ratio = w / this.lastViewW;
      this.lastViewW = w;
      const preset = String(viewer.currentScaleValue);
      if (preset === "page-width" || preset === "page-fit" || preset === "auto") return;
      const cur = Number(viewer.currentScale) || 1;
      const page = waive(viewer.getPageView(viewer.currentPageNumber - 1));
      const widthAt1 = (Number(page?.width) || 0) / cur;
      if (!widthAt1) return;
      const fit = (w - 40) / widthAt1; // same padding pdf.js uses for "page width"
      const next = Math.max(0.25, Math.min(fit, cur * ratio, 8));
      if (Math.abs(next - cur) < 0.004) return;
      // Remember the PDF point at the vertical centre of the view
      const cy = c.scrollTop + c.clientHeight / 2;
      let anchor: { idx: number; y: number } | null = null;
      for (let i = 0; i < viewer.pagesCount; i++) {
        const div = waive(waive(viewer.getPageView(i)).div);
        if (cy >= div.offsetTop && cy < div.offsetTop + div.offsetHeight) {
          const pt = Array.from(waive(waive(waive(viewer.getPageView(i)).viewport).convertToPdfPoint(0, cy - div.offsetTop)) as number[]);
          anchor = { idx: i, y: pt[1] };
          break;
        }
      }
      viewer.currentScale = next;
      if (anchor) {
        const pv2 = waive(viewer.getPageView(anchor.idx));
        const vy = (Array.from(waive(waive(pv2.viewport).convertToViewportPoint(0, anchor.y)) as number[]))[1];
        c.scrollTop = waive(pv2.div).offsetTop + vy - c.clientHeight / 2;
      }
      c.scrollLeft = Math.max(0, (c.scrollWidth - c.clientWidth) / 2);
    } catch (e) {
      Zotero.debug(`[ZoteroPi] keepViewport: ${e}`);
    }
  }

  // ------------------------------------------------------------------ key-sentence actions

  private buildPop(): void {
    const doc = this.doc;
    this.pop = h(doc, "div", { class: "zpo-pop", hidden: "true" });
    this.pop.addEventListener("mouseenter", () => this.showPop());
    this.pop.addEventListener("mouseleave", () => this.hidePop(false));
    this.root.append(this.pop);
  }

  private renderPop(): void {
    const doc = this.doc;
    this.pop.textContent = "";
    const add = (label: string, title: string, fn: (b: HTMLElement) => void, cls = "") => {
      const b = h(doc, "button", { class: "zpo-pop-btn" + (cls ? ` ${cls}` : ""), text: label, title });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn(b);
      });
      this.pop.append(b);
    };
    this.pop.append(h(doc, "span", { class: "zpo-pop-logo", text: "π" }));
    for (const a of getSettings().quickActions) {
      add(a.label, a.mode === "translate" ? "翻译这句话" : a.prompt.slice(0, 80), () => this.runAction(a));
    }
    add("问 AI", "把这句话引用到右侧 AI 侧栏，输入你的问题", () => this.askPanel());
    add("划重点", "用本节的代表颜色把这句话保存为高亮批注", (b) => void this.highlightSentence(b), "zpo-pop-mark");
    const mark = this.pop.querySelector(".zpo-pop-mark") as HTMLElement;
    mark.style.setProperty("--zpo-mark", this.popTarget?.color || ZOTERO_COLORS.purple);
  }

  private showPop(): void {
    clearTimeout(this.popTimer);
    if (this.popOpen) return;
    this.renderPop();
    this.pop.hidden = false;
    this.popOpen = true;
    this.placePop();
  }

  private hidePop(now: boolean): void {
    clearTimeout(this.popTimer);
    const hide = () => {
      this.pop.hidden = true;
      this.popOpen = false;
    };
    if (now) hide();
    else this.popTimer = setTimeout(hide, 350);
  }

  /** Below the key sentence (above it if there is no room), inside the reader view. */
  private placePop(): void {
    const gd = this.popTarget;
    const g = this.geometry();
    if (!gd || !gd.focus.length || !g) return;
    const first = gd.focus[0];
    const last = gd.focus[gd.focus.length - 1];
    const pw = this.pop.offsetWidth || 260;
    const ph = this.pop.offsetHeight || 30;
    let left = Math.min(last.right - pw, g.view.right - pw - 8);
    left = Math.max(g.view.left + 8, Math.max(left, Math.min(first.left, last.left)));
    let top = last.bottom + 8;
    if (top + ph > g.view.bottom - 6) top = first.top - ph - 8;
    this.pop.style.left = `${Math.round(left)}px`;
    this.pop.style.top = `${Math.round(top)}px`;
  }

  private selectionOf(region: AnchorRegion): Selection | null {
    if (!region.text || !region.focus.length) return null;
    return { text: region.text, position: { pageIndex: region.pageIndex, rects: region.focus }, pageLabel: String(region.pageIndex + 1) };
  }

  private popAnchor(): DOMRect | null {
    const r = this.pop.getBoundingClientRect();
    return new this.win.DOMRect(r.left, r.top, r.width, r.height);
  }

  private runAction(a: QuickAction): void {
    const sel = this.popTarget && this.selectionOf(this.popTarget.region);
    if (!sel || !this.reader) return;
    const anchor = this.popAnchor();
    this.hidePop(true);
    this.host.runQuickAction(this.reader, a, sel, anchor);
  }

  private askPanel(): void {
    const sel = this.popTarget && this.selectionOf(this.popTarget.region);
    if (!sel) return;
    this.hidePop(true);
    this.host.askInPanel(sel.text, sel.pageLabel || "");
  }

  private async highlightSentence(btn: HTMLElement): Promise<void> {
    const gd = this.popTarget;
    const region = gd?.region;
    if (!region?.text || !region.viewBox || region.start === undefined || !this.reader) return;
    btn.setAttribute("disabled", "true");
    btn.textContent = "标注中…";
    try {
      const attachment = Zotero.Items.get(this.reader.itemID);
      await saveRegionHighlight(attachment, {
        pageIndex: region.pageIndex,
        rects: region.focus,
        text: region.text,
        start: region.start,
        viewBox: region.viewBox,
        pageLabel: await getPageLabel(this.reader, region.pageIndex),
      }, gd!.color);
      btn.textContent = "✓ 已划重点";
    } catch (e: any) {
      Zotero.logError(e);
      btn.textContent = "标注失败";
      btn.removeAttribute("disabled");
    }
  }

  // ------------------------------------------------------------------ teardown

  destroy(): void {
    clearInterval(this.timer);
    try {
      this.readerObs?.mo.disconnect();
    } catch {
      // gone
    }
    this.readerObs = null;
    this.removeMarks();
    clearTimeout(this.popTimer);
    this.detachViewer();
    this.releaseAll();
    this.cancelGuide();
    for (const u of this.unsubs) u();
    this.root.remove();
    this.doc.getElementById("zoteropi-outline-css")?.remove();
  }
}

function rectSig(r: DOMRect): string {
  return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
}

/**
 * Clip holes into an element where reader popups overlap it (evenodd path), so the popup shows
 * in front and clicks there fall through to it. Removes the clip when nothing overlaps.
 */
function cutHoles(el: HTMLElement, boxes: Box[]): void {
  const r = el.getBoundingClientRect();
  const pad = 6; // leave room for the popup's shadow
  const holes = boxes
    .map((b) => ({
      x: Math.max(0, b.left - pad - r.left),
      y: Math.max(0, b.top - pad - r.top),
      x2: Math.min(r.width, b.right + pad - r.left),
      y2: Math.min(r.height, b.bottom + pad - r.top),
    }))
    .filter((h) => h.x2 > h.x && h.y2 > h.y);
  if (!holes.length) {
    if (el.style.clipPath) el.style.clipPath = "";
    return;
  }
  const f = (n: number) => Math.round(n * 10) / 10;
  let d = `M0 0 H${f(r.width)} V${f(r.height)} H0 Z`;
  for (const h of holes) d += ` M${f(h.x)} ${f(h.y)} H${f(h.x2)} V${f(h.y2)} H${f(h.x)} Z`;
  el.style.clipPath = `path(evenodd, "${d}")`;
}

/** Intersection area over the smaller box's area (rects in PDF space). */
function overlapRatio(a: number[], b: number[]): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const hh = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || hh <= 0) return 0;
  const area = (r: number[]) => Math.max(1e-6, (r[2] - r[0]) * (r[3] - r[1]));
  return (w * hh) / Math.min(area(a), area(b));
}

/** Background of the pdf.js viewer, used for the strip the column occupies. */
function viewerBackground(pv: any): string {
  try {
    const win = waive(pv._iframeWindow);
    const doc = waive(win.document);
    for (const el of [doc.getElementById("viewerContainer"), doc.getElementById("mainContainer"), doc.body, doc.documentElement]) {
      if (!el) continue;
      const bg = win.getComputedStyle(el).backgroundColor;
      if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
    }
  } catch {
    // fall through
  }
  return "";
}

function anchorLabel(a: OutlineAnchor): string {
  if (a.figure) {
    const short = a.figure.replace(/^figure\s*/i, "图 ").replace(/^fig\.?\s*/i, "图 ").replace(/^table\s*/i, "表 ").replace(/^tab\.?\s*/i, "表 ");
    return `${short} · p.${a.page}`;
  }
  return a.quote ? `¶ p.${a.page}` : `p.${a.page}`;
}
