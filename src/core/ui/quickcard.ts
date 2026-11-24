/**
 * Floating result card for selection quick actions, positioned near the
 * reader's selection popup. Content is chat.html?mode=quick.
 */
import { getPref, setPref } from "../config";
import { clamp, ensureStylesheet, h } from "./dom";

const MIN_W = 300;
const MIN_H = 180;
const FIT_MIN_W = 240;
const FIT_MIN_H = 96;
const HEADER_H = 28;

/** Initial size for a translation card from the source text length (CJK-aware width). */
function fitSize(chars: number): { w: number; h: number } {
  const w = chars < 40 ? 280 : chars < 160 ? 360 : chars < 500 ? 440 : 520;
  const perLine = (w - 36) / 7.2; // ~7px per Latin char at 13.5px
  const lines = Math.ceil(chars / perLine) * 2 + 2; // quote + translation
  return { w, h: HEADER_H + 40 + lines * 20 };
}

export class QuickCard {
  private doc: Document;
  private root: HTMLElement;
  private card: HTMLElement;
  private titleEl: HTMLElement;
  private frame: HTMLIFrameElement | null = null;
  /** Auto-fit mode (translations): size follows the content until the user resizes. */
  private fit = false;
  private fitTimer: any = null;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !this.card.hidden) this.close();
  };

  constructor(private win: any, private onClose: () => void, private onOpenPanel: () => void) {
    this.doc = win.document;
    ensureStylesheet(this.doc);
    this.root = h(this.doc, "div", { id: "zoteropi-quick-root", class: "zp-root" });
    this.titleEl = h(this.doc, "span", { class: "zp-title", text: "Pi" });
    const btn = (label: string, title: string, fn: () => void) => {
      const b = h(this.doc, "button", { class: "zp-btn", title, text: label });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      return b;
    };
    const header = h(this.doc, "div", { class: "zp-header" }, [
      h(this.doc, "span", { class: "zp-logo", text: "π" }),
      this.titleEl,
      btn("⇱", "在聊天面板中继续", () => {
        this.onOpenPanel();
      }),
      btn("✕", "关闭 (Esc)", () => this.close()),
    ]);
    header.addEventListener("pointerdown", (e) => this.startDrag(e as PointerEvent));
    const shield = h(this.doc, "div", { class: "zp-shield" });
    this.card = h(this.doc, "div", { class: "zp-card", hidden: "true" }, [header, shield]);
    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      const rh = h(this.doc, "div", { class: "zp-rh", "data-dir": dir });
      rh.addEventListener("pointerdown", (e) => this.startResize(e as PointerEvent, dir));
      this.card.append(rh);
    }
    this.root.append(this.card);
    this.doc.documentElement.appendChild(this.root);
    win.addEventListener("keydown", this.onKey, true);
  }

  /**
   * Show near an anchor rect (main-window coordinates). With `fitText` (translations) the card
   * is sized from the text length and then follows its content height, instead of reusing the
   * remembered size of the chat-style card.
   */
  open(title: string, anchor: { left: number; top: number; bottom: number } | null, opts?: { fitText?: number }): void {
    this.titleEl.textContent = title;
    if (!this.frame) {
      this.frame = h(this.doc, "iframe", { class: "zp-frame", src: "chrome://zoteropi/content/chat.html?mode=quick" }) as HTMLIFrameElement;
      this.card.append(this.frame);
    }
    const W = this.win.innerWidth;
    const H = this.win.innerHeight;
    this.stopFit();
    this.fit = !!opts?.fitText;
    const saved = this.fit ? fitSize(opts!.fitText!) : this.savedSize();
    const w = clamp(saved.w, this.fit ? FIT_MIN_W : MIN_W, W - 20);
    const hgt = clamp(saved.h, this.fit ? FIT_MIN_H : MIN_H, H - 20);
    this.card.classList.toggle("zp-card-fit", this.fit);
    let left = anchor ? anchor.left : W / 2 - w / 2;
    let top = anchor ? anchor.bottom + 8 : H / 3;
    if (anchor && top + hgt > H - 10) top = anchor.top - hgt - 8;
    left = clamp(left, 10, W - w - 10);
    top = clamp(top, 10, H - hgt - 10);
    Object.assign(this.card.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${hgt}px` });
    this.card.hidden = false;
    if (this.fit) {
      this.anchorTop = anchor ? { top: anchor.top, bottom: anchor.bottom } : null;
      this.fitTimer = setInterval(() => this.fitToContent(), 150);
    }
  }

  private anchorTop: { top: number; bottom: number } | null = null;

  private stopFit(): void {
    clearInterval(this.fitTimer);
    this.fitTimer = null;
  }

  /** Grow / shrink the card to its content (header + quote + translation + actions). */
  private fitToContent(): void {
    if (!this.fit || this.card.hidden) return this.stopFit();
    try {
      const doc = this.frame?.contentDocument;
      const app = doc?.querySelector(".app") as HTMLElement | null;
      if (!app) return;
      let content = 0;
      for (const c of Array.from(app.children) as HTMLElement[]) {
        content += c.classList.contains("scroll") ? c.scrollHeight : c.offsetHeight;
      }
      const H = this.win.innerHeight;
      const want = clamp(content + HEADER_H + 2, FIT_MIN_H, Math.round(H * 0.7));
      const r = this.card.getBoundingClientRect();
      if (Math.abs(want - r.height) < 3) return;
      let top = r.top;
      // Keep the card next to the passage: if it grows past the bottom, open above the anchor
      if (top + want > H - 10) top = this.anchorTop ? Math.max(10, this.anchorTop.top - want - 8) : Math.max(10, H - want - 10);
      this.card.style.height = `${want}px`;
      this.card.style.top = `${top}px`;
    } catch {
      // frame not ready
    }
  }

  private savedSize(): { w: number; h: number } {
    try {
      const v = JSON.parse(getPref<string>("cardSize") || "{}");
      if (v.w && v.h) return v;
    } catch {
      // ignore
    }
    return { w: 440, h: 380 };
  }

  private startResize(e: PointerEvent, dir: string): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    const r = this.card.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, l: r.left, t: r.top, w: r.width, h: r.height };
    target.setPointerCapture(e.pointerId);
    this.root.classList.add("zp-dragging");
    // A manual resize ends auto-fit; the fitted card never overwrites the chat-card size
    const fitted = this.fit;
    this.fit = false;
    this.stopFit();
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      let { l, t, w, h: hh } = start;
      if (dir.includes("e")) w = Math.max(MIN_W, start.w + dx);
      if (dir.includes("s")) hh = Math.max(MIN_H, start.h + dy);
      if (dir.includes("w")) {
        w = Math.max(MIN_W, start.w - dx);
        l = start.l + (start.w - w);
      }
      if (dir.includes("n")) {
        hh = Math.max(MIN_H, start.h - dy);
        t = start.t + (start.h - hh);
      }
      Object.assign(this.card.style, { left: `${l}px`, top: `${Math.max(0, t)}px`, width: `${w}px`, height: `${hh}px` });
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      this.root.classList.remove("zp-dragging");
      if (fitted) return;
      const fr = this.card.getBoundingClientRect();
      setPref("cardSize", JSON.stringify({ w: Math.round(fr.width), h: Math.round(fr.height) }));
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  get isOpen(): boolean {
    return !this.card.hidden;
  }

  close(): void {
    this.stopFit();
    if (this.card.hidden) return;
    this.card.hidden = true;
    this.onClose();
  }

  private startDrag(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.currentTarget as HTMLElement;
    const rect = this.card.getBoundingClientRect();
    const off = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    target.setPointerCapture(e.pointerId);
    this.root.classList.add("zp-dragging");
    const move = (ev: PointerEvent) => {
      this.card.style.left = `${clamp(ev.clientX - off.x, 0, this.win.innerWidth - 80)}px`;
      this.card.style.top = `${clamp(ev.clientY - off.y, 0, this.win.innerHeight - 30)}px`;
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      this.root.classList.remove("zp-dragging");
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  destroy(): void {
    this.stopFit();
    this.win.removeEventListener("keydown", this.onKey, true);
    this.root.remove();
  }
}
