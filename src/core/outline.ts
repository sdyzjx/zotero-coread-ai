/**
 * Paper outline service: generates the 文章脉络 with the LLM (one paper at a
 * time, in the background), caches it in the plugin database, and resolves
 * outline anchors to regions on PDF pages.
 */
import { getSettings } from "./config";
import { Emitter } from "./events";
import { clampThinking, completeText, getModel } from "./llm";
import {
  buildOutlineInput,
  buildOutlinePrompt,
  extractJson,
  normalizeOutline,
  parseFigureLabel,
  validateAnchors,
  type OutlineAnchor,
  type PaperOutline,
} from "./outline-schema";
import { figureRegion, paragraphRange, unionRects, type Rect } from "./outline-geometry";
import { getItem, getMainAttachment, getPaperText, paperKey, paperMetadata, type PaperRef } from "./paper";
import { getPageData } from "./reader-utils";
import { kvDelete, kvGet, kvSet } from "./store";
import { buildCharIndex, findQuote, getRangeRects } from "./text";

export type OutlineState =
  | { status: "idle" }
  | { status: "loading"; stage: string; started: number }
  | { status: "ready"; outline: PaperOutline }
  | { status: "error"; message: string };

export interface OutlineChange {
  key: string;
  state: OutlineState;
}

const KV_PREFIX = "outline:v1:";

export class OutlineService {
  readonly changes = new Emitter<OutlineChange>();
  private states = new Map<string, OutlineState>();
  private queue: { ref: PaperRef; force: boolean }[] = [];
  private running = false;
  private abort = new AbortController();

  state(ref: PaperRef): OutlineState {
    return this.states.get(paperKey(ref)) || { status: "idle" };
  }

  private set(ref: PaperRef, state: OutlineState): void {
    const key = paperKey(ref);
    this.states.set(key, state);
    this.changes.emit({ key, state });
  }

  /** Load a cached outline (memory → database). */
  async load(ref: PaperRef): Promise<OutlineState> {
    const cur = this.state(ref);
    if (cur.status !== "idle") return cur;
    try {
      const raw = await kvGet(KV_PREFIX + paperKey(ref));
      if (raw) {
        const outline = JSON.parse(raw) as PaperOutline;
        if (outline?.version === 1 && Array.isArray(outline.sections)) {
          // Don't clobber a generation that started while we were reading
          if (this.state(ref).status === "idle") this.set(ref, { status: "ready", outline });
        }
      }
    } catch (e) {
      Zotero.logError(e);
    }
    return this.state(ref);
  }

  /** Load or (if missing) queue generation. Used for auto-analysis on open. */
  async ensure(ref: PaperRef): Promise<void> {
    const st = await this.load(ref);
    if (st.status === "idle") this.generate(ref);
  }

  generate(ref: PaperRef, force = false): void {
    const key = paperKey(ref);
    if (this.queue.some((q) => paperKey(q.ref) === key)) return;
    const st = this.state(ref);
    if (st.status === "loading") return;
    this.set(ref, { status: "loading", stage: this.running ? "排队中…" : "读取全文…", started: Date.now() });
    // The paper the user is looking at goes first
    this.queue.unshift({ ref, force });
    void this.pump();
  }

  async clear(ref: PaperRef): Promise<void> {
    await kvDelete(KV_PREFIX + paperKey(ref));
    this.set(ref, { status: "idle" });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const { ref } = this.queue.shift()!;
        try {
          const outline = await this.run(ref);
          await kvSet(KV_PREFIX + paperKey(ref), JSON.stringify(outline));
          this.set(ref, { status: "ready", outline });
        } catch (e: any) {
          if (this.abort.signal.aborted) return;
          Zotero.logError(e);
          this.set(ref, { status: "error", message: String(e?.message || e) });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async run(ref: PaperRef): Promise<PaperOutline> {
    const item = getItem(ref);
    if (!item) throw new Error("找不到该文献");
    const stage = (s: string) => this.set(ref, { status: "loading", stage: s, started: Date.now() });
    stage("读取全文…");
    const text = await getPaperText(item);
    if (!text.pages.some((p) => p.trim())) throw new Error("没有可读取的全文（需要带文字层的 PDF）");
    const meta = paperMetadata(item);
    const settings = getSettings();
    const modelId = settings.outlineModel || settings.quickModel;
    const prompt = buildOutlinePrompt({
      title: meta.title || "",
      abstract: meta.abstract,
      language: settings.replyLanguage || "简体中文",
      text: buildOutlineInput(text.pages, text.headings),
    });
    let lastErr: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      stage(attempt ? "重新梳理…" : "梳理文章脉络…");
      const reply = await completeText(
        { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        {
          model: modelId,
          reasoning: clampThinking(getModel(modelId), attempt ? "low" : "high"),
          signal: this.abort.signal,
          maxTokens: 24000,
        },
      );
      try {
        const outline = normalizeOutline(extractJson(reply), text.totalPages || text.pages.length, modelId);
        stage("定位段落…");
        validateAnchors(outline, text.pages);
        return outline;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`脉络生成失败：${lastErr?.message || lastErr}`);
  }

  dispose(): void {
    this.abort.abort();
    this.queue = [];
    this.changes.clear();
  }
}

/** Cached outline without touching the service state (for agent tools). */
export async function loadCachedOutline(ref: PaperRef): Promise<PaperOutline | null> {
  try {
    const raw = await kvGet(KV_PREFIX + paperKey(ref));
    const o = raw ? (JSON.parse(raw) as PaperOutline) : null;
    return o?.version === 1 ? o : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Locating anchors on the page

export interface AnchorRegion {
  pageIndex: number;
  /** Box around the paragraph / figure (PDF user space), null = whole page. */
  box: Rect | null;
  /** Finer rects to emphasise inside the box (the quoted lines). */
  focus: Rect[];
}

const regionCache = new WeakMap<any, Map<string, AnchorRegion>>();

export async function resolveAnchor(reader: any, anchor: OutlineAnchor): Promise<AnchorRegion | null> {
  if (!anchor.page) return null;
  const pageIndex = anchor.page - 1;
  const key = `${pageIndex}|${anchor.quote || ""}|${anchor.figure || ""}|${anchor.caption || ""}`;
  let cache = regionCache.get(reader);
  if (!cache) regionCache.set(reader, (cache = new Map()));
  const hit = cache.get(key);
  if (hit) return hit;

  let region: AnchorRegion = { pageIndex, box: null, focus: [] };
  try {
    const data = await getPageData(reader, pageIndex);
    const chars = data.chars;
    if (chars.length) {
      const index = buildCharIndex(chars);
      const fig = anchor.figure ? parseFigureLabel(anchor.figure) : null;
      const cap = anchor.caption ? findQuote(chars, anchor.caption.slice(0, 60), index) : null;
      if (fig && cap) {
        const box = figureRegion(chars, cap[0], cap[1], fig.kind);
        if (box) region = { pageIndex, box, focus: [] };
      } else if (anchor.quote) {
        const m = findQuote(chars, anchor.quote, index);
        if (m) {
          const [ps, pe] = paragraphRange(chars, m[0], m[1]);
          const lines = getRangeRects(chars, ps, pe);
          region = { pageIndex, box: unionRects(lines), focus: getRangeRects(chars, m[0], m[1]) };
        }
      }
    }
  } catch (e) {
    Zotero.debug(`[ZoteroPi] outline anchor: ${e}`);
  }
  cache.set(key, region);
  return region;
}

/** Attachment item ID of the paper's PDF, if any. */
export async function pdfAttachmentID(ref: PaperRef): Promise<number | null> {
  const att = await getMainAttachment(getItem(ref));
  return att?.isPDFAttachment?.() ? att.id : null;
}
