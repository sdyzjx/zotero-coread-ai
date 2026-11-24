/**
 * 文章脉络 navigator: a resident floating card on the left of the reader. It sits
 * in the blank margin left of the PDF pages when there is room (translucent) and
 * floats over the page edge otherwise; the user can collapse it to a small edge
 * tab. The outline is generated only when the user asks for it. Clicking a node
 * scrolls the PDF to the paragraph / figure and draws a translucent guide
 * (connector + soft box) that fades out by itself.
 */
import { getSettings, saveSettings } from "../config";
import type { ContextTracker, PaperContext } from "../context";
import { resolveAnchor, type AnchorRegion, type OutlineService, type OutlineState } from "../outline";
import { RELATION_LABELS, flattenOutline, type OutlineAnchor, type OutlineNode, type PaperOutline } from "../outline-schema";
import { paperKey } from "../paper";
import { findReader, waive } from "../reader-utils";
import { ensureStylesheet, h } from "./dom";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Navigator column width bounds (px). */
const MIN_W = 200;
const MAX_W = 640;
/** Narrowest PDF area we accept before floating over the page instead of reserving a column. */
const MIN_PDF_W = 380;

const SECTION_COLORS: Record<string, string> = {
  background: "#7c8db5",
  traditional: "#a08c7a",
  related: "#4f9a9c",
  gap: "#d0695f",
  method: "#6d5bd0",
  experiment: "#7fa070",
  results: "#c49a1f",
  conclusion: "#8c7bb5",
  scope: "#7c8db5",
  evolution: "#4f9a9c",
  taxonomy: "#6d5bd0",
  comparison: "#c49a1f",
  challenges: "#d0695f",
};

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
  private activeId: string | null = null;
  private timer: any = null;
  private guideStop: (() => void) | null = null;
  private renderedKey = "";
  private unsubs: (() => void)[] = [];
  private lastPage = -1;

  constructor(
    win: any,
    private service: OutlineService,
    private context: ContextTracker,
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
      this.renderedKey = "";
      this.lastPage = -1;
    }
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
    this.layout();
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
    const key = this.ctx ? `${paperKey(this.ctx.ref)}|${state.status}|${state.status === "ready" ? state.outline.created : state.status === "loading" ? state.stage : state.status === "error" ? state.message : ""}` : "";
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    const doc = this.doc;
    this.gutter.textContent = "";
    this.rows.clear();
    this.outline = state.status === "ready" ? state.outline : null;
    this.loadingSince = state.status === "loading" ? state.started : 0;
    this.pill.setAttribute("data-state", state.status);
    this.pill.title = state.status === "loading" ? "正在生成文章脉络…（点击展开）" : "展开文章脉络";

    const head = h(doc, "div", { class: "zpo-head" }, [
      h(doc, "span", { class: "zpo-logo", text: "π" }),
      h(doc, "span", { class: "zpo-heading", text: "文章脉络" }),
    ]);
    if (this.outline) head.append(h(doc, "span", { class: "zpo-kind", text: this.outline.kind === "survey" ? "综述" : "研究" }));
    head.append(h(doc, "span", { class: "zpo-spacer" }));
    if (this.outline) {
      head.append(this.btn("⊟", "全部折叠 / 展开", () => this.toggleAll()));
    }
    if (state.status === "ready" || state.status === "error") {
      head.append(this.btn("↻", "重新分析文章脉络", () => this.ctx && this.service.generate(this.ctx.ref, true)));
    }
    head.append(this.btn("‹", "收起（点击左边缘的「π 脉络」标签或阅读器工具栏 π≡ 重新展开）", () => this.setExpanded(false)));
    this.gutter.append(head);

    if (state.status === "loading") {
      const cancel = h(doc, "button", { class: "zpo-link", text: "取消" });
      cancel.addEventListener("click", () => this.ctx && this.service.cancel(this.ctx.ref));
      this.gutter.append(
        h(doc, "div", { class: "zpo-status" }, [
          h(doc, "div", { class: "zpo-progress" }, [
            h(doc, "div", { class: "zpo-spinner" }),
            h(doc, "span", { text: state.stage || "正在分析…" }),
            h(doc, "span", { class: "zpo-elapsed", text: `${Math.round((Date.now() - state.started) / 1000)}s` }),
            h(doc, "span", { class: "zpo-spacer" }),
            cancel,
          ]),
          h(doc, "div", { class: "zpo-skeleton" }, [1, 2, 3, 4, 5].map(() => h(doc, "div", { class: "zpo-skel-line" }))),
        ]),
      );
      return;
    }
    if (state.status === "error") {
      this.gutter.append(h(doc, "div", { class: "zpo-status zpo-error" }, [h(doc, "div", { text: state.message })]));
      return;
    }
    if (state.status === "idle") {
      const go = h(doc, "button", { class: "zpo-go", text: "生成文章脉络" });
      go.addEventListener("click", () => this.ctx && this.service.generate(this.ctx.ref));
      this.gutter.append(
        h(doc, "div", { class: "zpo-status" }, [
          h(doc, "div", { text: "梳理背景 → 问题 → 相关工作 → Gap → 方法 → 实验 → 结果 → 结论，点击即可跳转到原文。" }),
          go,
        ]),
      );
      return;
    }

    const o = state.outline;
    if (o.oneLine) this.gutter.append(h(doc, "div", { class: "zpo-one", text: o.oneLine }));
    this.body = h(doc, "div", { class: "zpo-body" });
    const tree = h(doc, "div", { class: "zpo-tree" + (o.relations.length ? " zpo-has-arcs" : "") });
    o.sections.forEach((s, i) => tree.append(this.renderNode(s, 0, String(i + 1), s.key)));
    this.body.append(tree);
    if (o.relations.length) {
      const arcs = doc.createElementNS(SVG_NS, "svg");
      arcs.setAttribute("class", "zpo-arcs");
      this.body.append(arcs);
    }
    this.gutter.append(this.body);
    this.applyActive();
    this.win.requestAnimationFrame(() => this.drawArcs());
  }

  private expandedSet(): Set<string> {
    const key = this.ctx ? paperKey(this.ctx.ref) : "";
    let set = this.expanded.get(key);
    if (!set) {
      set = new Set(this.outline?.sections.map((s) => s.id) || []);
      this.expanded.set(key, set);
    }
    return set;
  }

  private renderNode(n: OutlineNode, depth: number, num: string, section: string): HTMLElement {
    const doc = this.doc;
    const expanded = this.expandedSet();
    const hasKids = n.children.length > 0;
    const el = h(doc, "div", {
      class: `zpo-node zpo-d${depth}` + (hasKids ? " zpo-has-kids" : "") + (expanded.has(n.id) ? " zpo-open" : ""),
      "data-id": n.id,
      "data-section": section,
    });
    if (depth === 0) el.setAttribute("style", `--sec: ${SECTION_COLORS[section] || "#6d5bd0"}`);

    const twisty = h(doc, "span", { class: "zpo-twisty", text: hasKids ? "›" : "" });
    twisty.addEventListener("click", (e) => {
      e.stopPropagation();
      if (hasKids) this.setOpen(n.id, !expanded.has(n.id));
    });
    const title = h(doc, "div", { class: "zpo-title" }, [h(doc, "span", { class: "zpo-num", text: depth < 2 ? num : "·" }), h(doc, "span", { class: "zpo-title-text", text: n.title })]);
    if (n.period) title.append(h(doc, "span", { class: "zpo-period", text: n.period }));
    const text = h(doc, "div", { class: "zpo-text" }, [title]);
    if (n.summary && n.summary !== n.title) text.append(h(doc, "div", { class: "zpo-sum", text: n.summary }));

    if (n.anchors.length) {
      const chips = h(doc, "div", { class: "zpo-anchors" });
      for (const a of n.anchors) {
        const chip = h(doc, "span", { class: "zpo-chip", text: anchorLabel(a), title: a.quote ? `“${a.quote}”` : a.caption || `第 ${a.page} 页` });
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          this.select(n.id);
          void this.jump(a, row);
        });
        chips.append(chip);
      }
      text.append(chips);
    }

    const rels = this.relationsOf(n.id);
    if (rels.length) {
      const box = h(doc, "div", { class: "zpo-rels" });
      for (const r of rels) {
        const chip = h(doc, "span", { class: `zpo-rel zpo-rel-${r.type}`, text: `${r.dir === "out" ? "→" : "←"} ${RELATION_LABELS[r.type]} · ${r.partner.title}`, title: r.label || "" });
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          this.reveal(r.partner.id);
        });
        box.append(chip);
      }
      text.append(box);
    }

    const row = h(doc, "div", { class: "zpo-row" }, [twisty, text]);
    row.addEventListener("click", () => {
      this.select(n.id);
      if (hasKids && !expanded.has(n.id)) this.setOpen(n.id, true);
      const a = n.anchors.find((x) => x.quote || x.figure) || n.anchors[0];
      if (a) void this.jump(a, row);
    });
    row.addEventListener("mouseenter", () => this.hoverArcs(n.id, true));
    row.addEventListener("mouseleave", () => this.hoverArcs(n.id, false));
    this.rows.set(n.id, el);
    el.append(row);
    if (hasKids) {
      const kids = h(doc, "div", { class: "zpo-children" });
      n.children.forEach((c, i) => kids.append(this.renderNode(c, depth + 1, `${num}.${i + 1}`, section)));
      el.append(kids);
    }
    return el;
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

  private async jump(anchor: OutlineAnchor, rowEl: HTMLElement): Promise<void> {
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
    this.showGuide(region, rowEl);
  }

  private cancelGuide(): void {
    this.guideStop?.();
    this.guideStop = null;
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

  private showGuide(region: AnchorRegion, from: HTMLElement): void {
    this.cancelGuide();
    const doc = this.doc;
    const svg = this.guideSvg;
    svg.textContent = "";
    const mk = (tag: string, attrs: Record<string, string>) => {
      const el = doc.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    };
    const clipId = "zpo-guide-clip";
    const defs = mk("defs", {});
    const clip = mk("clipPath", { id: clipId });
    const clipRect = mk("rect", {});
    clip.append(clipRect);
    defs.append(clip);
    const group = mk("g", { "clip-path": `url(#${clipId})` });
    const box = mk("rect", { class: "zpo-guide-box", rx: "6", ry: "6" });
    const focus = region.focus.slice(0, 12).map(() => mk("rect", { class: "zpo-guide-focus", rx: "2", ry: "2" }));
    const path = mk("path", { class: "zpo-guide-line" });
    const dot = mk("circle", { class: "zpo-guide-dot", r: "3" });
    const start = mk("circle", { class: "zpo-guide-start", r: "2.5" });
    group.append(box, ...focus, path, dot, start);
    svg.append(defs, group);

    const t0 = this.win.performance.now();
    const LINE_HOLD = 2600;
    const BOX_HOLD = 3800;
    const FADE = 800;
    let raf = 0;
    let stopped = false;
    const fade = (t: number, hold: number) => (t < 220 ? t / 220 : t < hold ? 1 : Math.max(0, 1 - (t - hold) / FADE));

    const frame = () => {
      if (stopped) return;
      const t = this.win.performance.now() - t0;
      const g = this.geometry();
      const target = g ? this.regionBox(g, region, region.box) : null;
      if (!g || !target || t > BOX_HOLD + FADE) {
        stop();
        return;
      }
      // Clip to the reader view (incl. the gutter) so nothing paints over the toolbar
      clipRect.setAttribute("x", String(g.hostLeft));
      clipRect.setAttribute("y", String(g.view.top));
      clipRect.setAttribute("width", String(Math.max(0, g.view.right - g.hostLeft)));
      clipRect.setAttribute("height", String(Math.max(0, g.view.bottom - g.view.top)));

      const pad = region.box ? 5 : 0;
      const bx = target.left - pad;
      const by = target.top - pad;
      const bw = target.right - target.left + pad * 2;
      const bh = region.box ? target.bottom - target.top + pad * 2 : Math.min(60, target.bottom - target.top);
      box.setAttribute("x", String(bx));
      box.setAttribute("y", String(by));
      box.setAttribute("width", String(bw));
      box.setAttribute("height", String(bh));
      box.style.opacity = String(fade(t, BOX_HOLD));
      region.focus.slice(0, 12).forEach((r, i) => {
        const fb = this.regionBox(g, region, r);
        if (!fb) return;
        focus[i].setAttribute("x", String(fb.left - 1));
        focus[i].setAttribute("y", String(fb.top - 1));
        focus[i].setAttribute("width", String(fb.right - fb.left + 2));
        focus[i].setAttribute("height", String(fb.bottom - fb.top + 2));
        (focus[i] as SVGElement).style.opacity = String(fade(t, BOX_HOLD));
      });

      const fr = from.getBoundingClientRect();
      const sx = fr.right + 3;
      const sy = Math.max(g.view.top + 4, Math.min(g.view.bottom - 4, fr.top + Math.min(11, fr.height / 2)));
      const ex = bx - 3;
      const ey = Math.max(by + 4, Math.min(by + bh - 4, Math.max(g.view.top + 12, Math.min(g.view.bottom - 12, by + Math.min(14, bh / 2)))));
      const dx = Math.max(24, (ex - sx) * 0.5);
      path.setAttribute("d", `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`);
      const len = (path as any).getTotalLength?.() || Math.hypot(ex - sx, ey - sy);
      const draw = Math.min(1, t / 420);
      path.setAttribute("stroke-dasharray", `${len} ${len}`);
      path.setAttribute("stroke-dashoffset", String(len * (1 - draw)));
      const lo = String(fade(t, LINE_HOLD));
      (path as SVGElement).style.opacity = lo;
      start.setAttribute("cx", String(sx));
      start.setAttribute("cy", String(sy));
      (start as SVGElement).style.opacity = lo;
      dot.setAttribute("cx", String(ex));
      dot.setAttribute("cy", String(ey));
      (dot as SVGElement).style.opacity = draw >= 1 ? lo : "0";
      raf = this.win.requestAnimationFrame(frame);
    };
    const stop = () => {
      stopped = true;
      this.win.cancelAnimationFrame(raf);
      svg.textContent = "";
      if (this.guideStop === stop) this.guideStop = null;
    };
    this.guideStop = stop;
    // Let the scroll start (smooth scroll / page render) before the first frame
    raf = this.win.requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ teardown

  destroy(): void {
    clearInterval(this.timer);
    this.releaseAll();
    this.cancelGuide();
    for (const u of this.unsubs) u();
    this.root.remove();
    this.doc.getElementById("zoteropi-outline-css")?.remove();
  }
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
