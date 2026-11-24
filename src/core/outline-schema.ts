/**
 * Paper outline ("文章脉络"): data model, LLM prompt, response parsing and
 * anchor validation. Pure — no Zotero dependencies, unit-tested.
 */
// .ts extension: this module is also loaded directly by node --test
import { normalizeForMatch, type Heading } from "./text.ts";

export type PaperKind = "research" | "survey";

/** Where a node lives in the paper. `page` is 1-based. */
export interface OutlineAnchor {
  page: number;
  /** Verbatim phrase from the paper (validated against the page text). */
  quote?: string;
  /** "Figure 3" / "Table 2" / "Eq. 4" */
  figure?: string;
  /** Start of the figure / table caption as it appears in the text (for locating). */
  caption?: string;
}

export interface OutlineNode {
  id: string;
  title: string;
  summary: string;
  /** Survey timeline stages: year or period ("2017", "2019–2021"). */
  period?: string;
  anchors: OutlineAnchor[];
  children: OutlineNode[];
}

export interface OutlineSection extends OutlineNode {
  key: string;
}

export type RelationType = "evolves" | "improves" | "combines" | "contrasts" | "addresses";

export interface OutlineRelation {
  from: string;
  to: string;
  type: RelationType;
  label?: string;
}

export interface PaperOutline {
  version: 1;
  kind: PaperKind;
  oneLine: string;
  sections: OutlineSection[];
  relations: OutlineRelation[];
  model: string;
  created: number;
}

export interface SectionDef {
  key: string;
  title: string;
  hint: string;
}

/** Role labels for the abstract breakdown (children of the "abstract" section use these as titles). */
export const ABSTRACT_ROLES = {
  research: ["背景", "问题", "已有方法", "Gap", "方法", "实验", "结果", "结论"],
  survey: ["领域", "动机", "范围", "分类框架", "主要发现", "挑战与展望"],
};

export const RESEARCH_SECTIONS: SectionDef[] = [
  {
    key: "abstract",
    title: "摘要拆解",
    hint: `the abstract broken down in the same logic — one child per role the abstract covers, in order, child title EXACTLY one of: ${ABSTRACT_ROLES.research.join(" / ")}; summary paraphrases that part; anchor quotes the matching abstract sentence verbatim`,
  },
  { key: "background", title: "任务背景", hint: "the task / problem setting and why it matters" },
  { key: "traditional", title: "传统方法及问题", hint: "classic / earlier approaches and their shortcomings" },
  {
    key: "related",
    title: "近期工作",
    hint: "recent lines of work (related work) — one child per line of work: what it tries, and what problem remains",
  },
  { key: "gap", title: "核心 Gap", hint: "the precise gap / open question this paper targets" },
  { key: "method", title: "本文方法", hint: "the proposed method — children = key components / ideas" },
  { key: "experiment", title: "实验设置", hint: "datasets / environments, baselines, metrics, protocol" },
  { key: "results", title: "数据结果", hint: "main quantitative results with key numbers, ablations" },
  { key: "conclusion", title: "结论", hint: "conclusions, limitations, future work" },
];

export const SURVEY_SECTIONS: SectionDef[] = [
  {
    key: "abstract",
    title: "摘要拆解",
    hint: `the abstract broken down — one child per role the abstract covers, in order, child title EXACTLY one of: ${ABSTRACT_ROLES.survey.join(" / ")}; summary paraphrases that part; anchor quotes the matching abstract sentence verbatim`,
  },
  { key: "scope", title: "领域与范围", hint: "the field, scope of the survey, and how it organizes the literature (taxonomy criteria)" },
  {
    key: "evolution",
    title: "发展脉络",
    hint: "chronological stages of the field — one child per stage with `period` (year range), the driving idea and representative works",
  },
  {
    key: "taxonomy",
    title: "研究分支",
    hint: "the taxonomy — one child per research branch (core idea + main limitation), grandchildren = sub-branches / representative methods",
  },
  { key: "comparison", title: "评测与对比", hint: "benchmarks, datasets, metrics and the survey's comparison findings" },
  { key: "challenges", title: "开放问题", hint: "open challenges and future directions" },
  { key: "conclusion", title: "结论", hint: "the survey's overall conclusions" },
];

export function sectionDefs(kind: PaperKind): SectionDef[] {
  return kind === "survey" ? SURVEY_SECTIONS : RESEARCH_SECTIONS;
}

export const RELATION_LABELS: Record<RelationType, string> = {
  evolves: "演进",
  improves: "改进",
  combines: "融合",
  contrasts: "对立",
  addresses: "解决",
};

// ---------------------------------------------------------------------------
// Input text

export const OUTLINE_INPUT_BUDGET = 110_000;

const REFS = /^(\d+\.?\s*)?(references|bibliography|参考文献)\s*$/i;
const APPENDIX = /^((\d+|[A-Z])\.?\s*)?(appendix|appendices|supplementary|附录)/i;

/**
 * Paper text with page markers for the LLM. The reference list is dropped;
 * appendices are dropped too when the text exceeds the budget, then pages are
 * trimmed evenly.
 */
export function buildOutlineInput(pages: string[], headings: Heading[], budget = OUTLINE_INPUT_BUDGET): string {
  const refs = headings.find((h) => REFS.test(h.title.trim()));
  const appendix = refs ? headings.find((h) => APPENDIX.test(h.title.trim()) && (h.page > refs.page || (h.page === refs.page && h.offset > refs.offset))) : undefined;
  const cut = (keepAppendix: boolean): string[] =>
    pages.map((text, i) => {
      if (!refs || i < refs.page) return text;
      // On the refs page keep the part before the heading
      let keep = i === refs.page ? text.slice(0, refs.offset) : "";
      if (keepAppendix && appendix && i >= appendix.page) {
        keep += i === appendix.page ? text.slice(i === refs.page ? Math.max(appendix.offset, refs.offset) : appendix.offset) : text;
      }
      return keep;
    });
  let parts = cut(true);
  const size = (ps: string[]) => ps.reduce((n, p) => n + p.length + 16, 0);
  if (size(parts) > budget) parts = cut(false);
  const total = size(parts);
  if (total > budget) {
    const ratio = budget / total;
    parts = parts.map((p) => (p.length > 400 ? p.slice(0, Math.floor(p.length * ratio)) + " …" : p));
  }
  return parts
    .map((p, i) => (p.trim() ? `<<<PAGE ${i + 1}>>>\n${p.trim()}` : ""))
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Prompt

export function buildOutlinePrompt(opts: { title: string; abstract?: string; language: string; text: string }): string {
  const sec = (defs: SectionDef[]) => defs.map((d) => `  - "${d.key}" (${d.title}): ${d.hint}`).join("\n");
  return `You are analyzing an academic paper to build a compact, clickable reading outline ("文章脉络") shown in a narrow sidebar next to the PDF.

Paper title: ${opts.title}
${opts.abstract ? `Abstract: ${opts.abstract.slice(0, 1500)}\n` : ""}
## Step 1 — classify
"survey" if the paper is a survey / review / overview of a field; otherwise "research".

## Step 2 — fill the sections for that kind (in this order; skip a section only if the paper truly has nothing for it)
research:
${sec(RESEARCH_SECTIONS)}
survey:
${sec(SURVEY_SECTIONS)}

## Step 3 — survey only: relations
Between taxonomy branches / sub-branches (and evolution stages), list the important relations:
type ∈ "evolves" (A develops into B), "improves" (B fixes a weakness of A), "combines" (B merges A with something), "contrasts" (competing paradigms), "addresses" (A tackles a challenge B). 3–12 relations, each with a ≤8-character label.

## Style — keep it SHORT (it is a sidebar, not a summary)
- Write in ${opts.language}. Keep technical terms / method names in their original form.
- title: ≤ 12 characters (CJK) or ≤ 5 words. summary: ONE sentence, ≤ 40 CJK characters or ≤ 25 words, concrete (numbers, names), no filler.
- Depth ≤ 3 levels (section → child → grandchild). ≤ 6 children per node. A section may have no children if one summary suffices.
- Results: include the key numbers (e.g. "成功率 72.1% vs 58.3%").

## The "abstract" section
Split the paper's abstract (as printed in the PDF) sentence by sentence into those roles. Every child has exactly one anchor quoting its abstract sentence, so clicking it highlights that sentence. A sentence covering two roles goes to the more important one; don't invent roles the abstract doesn't state.

## Anchors — every node needs 1–3 anchors pointing into the paper
- {"page": N, "quote": "..."} — N is the page number from the <<<PAGE N>>> markers; quote is copied VERBATIM from that page (8–20 consecutive words, a single sentence fragment, no ellipsis, not translated, no LaTeX).
- {"page": N, "figure": "Figure 3", "caption": "Figure 3: first words of the caption"} — for figures / tables that illustrate the node (method overview figure, main results table…). caption must be copied verbatim from the caption text.
- Prefer the most specific passage (the paragraph that states the gap, the table with the main results).

## Output — ONLY a JSON object, no prose, no code fence
{
  "kind": "research" | "survey",
  "one_line": "the paper in one sentence (≤ 50 CJK chars)",
  "sections": [
    {"key": "background", "summary": "...", "anchors": [{"page": 1, "quote": "..."}],
     "children": [{"id": "n1", "title": "...", "summary": "...", "period": "2017–2019 (survey evolution only)", "anchors": [...], "children": [...]}]}
  ],
  "relations": [{"from": "b1", "to": "b2", "type": "improves", "label": "..."}]
}
Give every child a short unique id (e.g. "b1", "b1.2", "s3"); relations refer to these ids. "relations" is [] for research papers.

## Paper text
${opts.text}`;
}

// ---------------------------------------------------------------------------
// Parsing & normalization

const TITLE_MAX = 28;
const SUMMARY_MAX = 140;
const MAX_CHILDREN = 8;
const MAX_DEPTH = 3;
const MAX_ANCHORS = 3;

export function extractJson(text: string): any {
  let s = String(text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("模型没有返回 JSON");
  const body = s.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    // Common slip: trailing commas
    return JSON.parse(body.replace(/,\s*([}\]])/g, "$1"));
  }
}

/** Scan JSON text: whether it ends inside a string and the stack of open containers. */
function scanJson(s: string): { inString: boolean; escape: boolean; stack: string[]; strStart: number } {
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  let strStart = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      strStart = i;
    } else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }
  return { inString, escape, stack, strStart };
}

/**
 * Parse the prefix of a streamed JSON object: close an open string, drop a dangling key /
 * comma, and close open containers. Returns null when the prefix isn't parseable yet.
 */
export function parsePartialJson(text: string, opts: { completeStringsOnly?: boolean } = {}): any | null {
  let s = String(text || "");
  const fence = s.indexOf("```");
  if (fence !== -1 && s.indexOf("{") > fence) s = s.slice(s.indexOf("{"));
  const start = s.indexOf("{");
  if (start === -1) return null;
  s = s.slice(start).replace(/```\s*$/, "");
  const first = scanJson(s);
  if (first.inString) {
    if (opts.completeStringsOnly) {
      // Drop the unfinished string so text only ever appears whole (no typewriter jitter)
      s = s.slice(0, first.strStart);
    } else {
      if (first.escape) s = s.slice(0, -1);
      s += '"';
    }
  }
  // Trailing junk: dangling `"key":`, `"key"` right after { or , (an unfinished key), or a comma
  for (let k = 0; k < 4; k++) {
    const before = s;
    s = s
      .replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, "")
      .replace(/([{,])\s*"(?:[^"\\]|\\.)*"\s*$/, "$1")
      .replace(/,\s*$/, "")
      .replace(/:\s*$/, "");
    if (s === before) break;
  }
  const { stack } = scanJson(s);
  const closed = s + stack.reverse().map((c) => (c === "{" ? "}" : "]")).join("");
  try {
    return JSON.parse(closed);
  } catch {
    return null;
  }
}

function clipText(s: any, n: number): string {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function normAnchor(a: any, totalPages: number): OutlineAnchor | null {
  if (!a || typeof a !== "object") return null;
  const page = Math.round(Number(a.page));
  const out: OutlineAnchor = { page: page >= 1 && page <= Math.max(1, totalPages) ? page : 0 };
  if (typeof a.quote === "string" && a.quote.trim()) out.quote = a.quote.trim().slice(0, 300);
  if (typeof a.figure === "string" && a.figure.trim()) out.figure = clipText(a.figure, 24);
  if (typeof a.caption === "string" && a.caption.trim()) out.caption = a.caption.trim().slice(0, 200);
  if (!out.page && !out.quote && !out.figure) return null;
  return out;
}

/** `partial`: a streamed prefix — no error for missing sections. */
export function normalizeOutline(raw: any, totalPages: number, model = "", partial = false): PaperOutline {
  if (!raw || typeof raw !== "object") throw new Error("脉络格式无效");
  const kind: PaperKind = raw.kind === "survey" ? "survey" : "research";
  const defs = sectionDefs(kind);
  const used = new Set<string>();
  let auto = 0;
  const uniqueId = (id: any): string => {
    let s = String(id ?? "").trim().slice(0, 24);
    if (!s || used.has(s)) {
      do s = `n${++auto}`;
      while (used.has(s));
    }
    used.add(s);
    return s;
  };
  const node = (n: any, depth: number): OutlineNode | null => {
    if (!n || typeof n !== "object") return null;
    const title = clipText(n.title, TITLE_MAX);
    const summary = clipText(n.summary, SUMMARY_MAX);
    if (!title && !summary) return null;
    const anchors = (Array.isArray(n.anchors) ? n.anchors : [])
      .map((a: any) => normAnchor(a, totalPages))
      .filter(Boolean)
      .slice(0, MAX_ANCHORS) as OutlineAnchor[];
    const children =
      depth < MAX_DEPTH && Array.isArray(n.children)
        ? (n.children.map((c: any) => node(c, depth + 1)).filter(Boolean) as OutlineNode[]).slice(0, MAX_CHILDREN)
        : [];
    const out: OutlineNode = { id: uniqueId(n.id), title: title || clipText(summary, 14), summary, anchors, children };
    if (n.period) out.period = clipText(n.period, 16);
    return out;
  };

  const rawSections: any[] = Array.isArray(raw.sections) ? raw.sections : [];
  const sections: OutlineSection[] = [];
  for (const def of defs) {
    const r = rawSections.find((s) => s && String(s.key).toLowerCase() === def.key);
    if (!r) continue;
    const n = node({ ...r, id: `sec:${def.key}`, title: r.title || def.title }, 1);
    if (!n) continue;
    n.title = def.title;
    sections.push({ ...n, key: def.key });
  }
  if (!sections.length && !partial) throw new Error("模型没有返回任何章节");

  const ids = new Set<string>();
  const walk = (n: OutlineNode) => {
    ids.add(n.id);
    n.children.forEach(walk);
  };
  sections.forEach(walk);
  const types: RelationType[] = ["evolves", "improves", "combines", "contrasts", "addresses"];
  const relations: OutlineRelation[] = (Array.isArray(raw.relations) ? raw.relations : [])
    .filter((r: any) => r && ids.has(String(r.from)) && ids.has(String(r.to)) && String(r.from) !== String(r.to))
    .map((r: any) => ({
      from: String(r.from),
      to: String(r.to),
      type: types.includes(r.type) ? r.type : "evolves",
      ...(r.label ? { label: clipText(r.label, 12) } : {}),
    }))
    .slice(0, 20);

  return {
    version: 1,
    kind,
    oneLine: clipText(raw.one_line ?? raw.oneLine, 120),
    sections,
    relations: kind === "survey" ? relations : [],
    model,
    created: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Anchor validation against the extracted page text

/** Normalized page text plus a map back to raw offsets, built lazily. */
export class PageIndex {
  private norm: (string | undefined)[] = [];
  readonly pages: string[];
  constructor(pages: string[]) {
    this.pages = pages;
  }
  get(i: number): string {
    let n = this.norm[i];
    if (n === undefined) n = this.norm[i] = normalizeForMatch(this.pages[i] || "").replace(/-/g, "");
    return n;
  }
}

function quoteFound(hay: string, q: string): boolean {
  if (hay.includes(q)) return true;
  // Tolerate small differences in the middle: anchor on head and tail
  const n = Math.max(10, Math.floor(q.length * 0.35));
  if (n >= q.length) return false;
  const h = hay.indexOf(q.slice(0, n));
  if (h === -1) return false;
  const t = hay.indexOf(q.slice(-n), h + n);
  return t !== -1 && t + n - h <= q.length * 1.5;
}

/** Page (0-based) containing the quote, searching the hint page first, then outward. */
export function findQuotePage(index: PageIndex, quote: string, hint: number): number {
  const q = normalizeForMatch(quote).replace(/-/g, "").replace(/…|\.\.\./g, "");
  if (q.length < 8) return -1;
  const total = index.pages.length;
  const order: number[] = [];
  if (hint >= 0 && hint < total) order.push(hint);
  for (let d = 1; d < total; d++) {
    if (hint - d >= 0) order.push(hint - d);
    if (hint + d < total) order.push(hint + d);
    if (hint < 0 || hint >= total) order.push(d - 1);
  }
  if (!order.includes(total - 1) && total) order.push(total - 1);
  for (const p of order) if (quoteFound(index.get(p), q)) return p;
  return -1;
}

const FIG_WORDS: Record<string, string> = { figure: "(?:figure|fig\\.?)", table: "(?:table|tab\\.?)", 图: "图", 表: "表" };

/** Parse "Figure 3" / "Fig. 3a" / "Table II" / "图 3" into kind + number. */
export function parseFigureLabel(label: string): { kind: "figure" | "table"; num: string } | null {
  const m = String(label)
    .trim()
    .match(/^(figure|fig\.?|table|tab\.?|图|表)\s*([0-9]+|[IVXLC]+)/i);
  if (!m) return null;
  const w = m[1].toLowerCase();
  return { kind: w.startsWith("t") || w === "表" ? "table" : "figure", num: m[2] };
}

/** Regex matching the start of a caption line for the label. */
export function captionRegex(label: string): RegExp | null {
  const p = parseFigureLabel(label);
  if (!p) return null;
  const words = p.kind === "table" ? `(?:${FIG_WORDS.table}|${FIG_WORDS.表})` : `(?:${FIG_WORDS.figure}|${FIG_WORDS.图})`;
  return new RegExp(`(^|\\n)\\s*${words}\\s*${p.num}\\s*[:.:：|]`, "i");
}

/** Page (0-based) with the caption for the figure label; prefers the hint page. */
export function findCaptionPage(pages: string[], label: string, hint: number): { page: number; caption: string } | null {
  const re = captionRegex(label);
  if (!re) return null;
  const order = [hint, ...pages.map((_, i) => i).filter((i) => i !== hint)].filter((i) => i >= 0 && i < pages.length);
  for (const p of order) {
    const m = pages[p].match(re);
    if (m) {
      const start = (m.index || 0) + m[1].length;
      const line = pages[p].slice(start).split("\n")[0].trim();
      return { page: p, caption: line.slice(0, 90) };
    }
  }
  return null;
}

/** Fix anchor pages against the real text; drop anchors that can't be found. Returns stats. */
export function validateAnchors(outline: PaperOutline, pages: string[]): { total: number; resolved: number } {
  const index = new PageIndex(pages);
  let total = 0;
  let resolved = 0;
  const fix = (n: OutlineNode) => {
    const out: OutlineAnchor[] = [];
    for (const a of n.anchors) {
      total++;
      const hint = a.page ? a.page - 1 : -1;
      if (a.figure) {
        const hit = findCaptionPage(pages, a.figure, hint);
        if (hit) {
          out.push({ page: hit.page + 1, figure: a.figure, caption: hit.caption });
          resolved++;
          continue;
        }
      }
      if (a.quote) {
        const p = findQuotePage(index, a.quote, hint);
        if (p !== -1) {
          out.push({ page: p + 1, quote: a.quote, ...(a.figure ? { figure: a.figure } : {}) });
          resolved++;
          continue;
        }
      }
      if (a.caption) {
        const p = findQuotePage(index, a.caption, hint);
        if (p !== -1) {
          out.push({ page: p + 1, figure: a.figure, caption: a.caption });
          resolved++;
          continue;
        }
      }
      // Page-only fallback keeps the node clickable
      if (a.page) out.push({ page: a.page, ...(a.figure ? { figure: a.figure } : {}) });
    }
    // de-duplicate
    const seen = new Set<string>();
    n.anchors = out.filter((a) => {
      const k = `${a.page}|${a.quote || ""}|${a.figure || ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    n.children.forEach(fix);
  };
  outline.sections.forEach(fix);
  return { total, resolved };
}

/** All nodes in display order with their depth (for search / navigation). */
export function flattenOutline(outline: PaperOutline): { node: OutlineNode; depth: number; section: string }[] {
  const out: { node: OutlineNode; depth: number; section: string }[] = [];
  const walk = (n: OutlineNode, depth: number, section: string) => {
    out.push({ node: n, depth, section });
    n.children.forEach((c) => walk(c, depth + 1, section));
  };
  for (const s of outline.sections) walk(s, 0, s.key);
  return out;
}

/** Compact markdown rendering of the outline (for the agent / export). */
export function outlineToMarkdown(outline: PaperOutline): string {
  const lines: string[] = [`**${outline.kind === "survey" ? "综述" : "研究"}** · ${outline.oneLine}`];
  const walk = (n: OutlineNode, depth: number, num: string) => {
    const pages = [...new Set(n.anchors.map((a) => a.page).filter(Boolean))].map((p) => `p.${p}`).join(", ");
    const head = `${"  ".repeat(depth)}- ${num} ${n.title}${n.period ? ` (${n.period})` : ""}`;
    lines.push(`${head}: ${n.summary}${pages ? ` [${pages}]` : ""}`);
    n.children.forEach((c, i) => walk(c, depth + 1, `${num}.${i + 1}`));
  };
  outline.sections.forEach((s, i) => walk(s, 0, String(i + 1)));
  if (outline.relations.length) {
    const title = new Map(flattenOutline(outline).map((f) => [f.node.id, f.node.title]));
    lines.push("", "关系：");
    for (const r of outline.relations) lines.push(`- ${title.get(r.from)} →(${RELATION_LABELS[r.type]}${r.label ? `: ${r.label}` : ""}) ${title.get(r.to)}`);
  }
  return lines.join("\n");
}
