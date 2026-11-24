import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOutlineInput,
  extractJson,
  findCaptionPage,
  findQuotePage,
  normalizeOutline,
  outlineToMarkdown,
  PageIndex,
  parseFigureLabel,
  validateAnchors,
} from "../src/core/outline-schema.ts";
import { figureRegion, isProseLine, paragraphRange, splitLines } from "../src/core/outline-geometry.ts";
import type { PdfChar } from "../src/core/text.ts";

const pages = [
  "Abstract\nWe study robot policies.\n1 Introduction\nVision-language-action models generalize poorly to unseen objects in cluttered scenes.",
  "2 Related Work\nPrior work fine-tunes VLAs with supervised data from scripted planners.\nFigure 2: Overview of the training pipeline with PPO.",
  "4 Experiments\nTable 1: Success rates on unseen tasks.\nOurs 72.1 58.3\nReferences\n[1] A. Author. Some paper. 2020.",
];

test("extractJson handles fences and trailing commas", () => {
  assert.deepEqual(extractJson('```json\n{"a": [1, 2,],}\n```'), { a: [1, 2] });
  assert.deepEqual(extractJson('Sure! {"kind": "survey"} done'), { kind: "survey" });
  assert.throws(() => extractJson("no json here"));
});

test("buildOutlineInput adds page markers and drops references", () => {
  const input = buildOutlineInput(pages, [{ title: "References", page: 2, offset: pages[2].indexOf("References") }]);
  assert.match(input, /<<<PAGE 1>>>/);
  assert.match(input, /<<<PAGE 3>>>\n4 Experiments/);
  assert.doesNotMatch(input, /A\. Author/);
});

test("buildOutlineInput trims to budget", () => {
  const big = Array.from({ length: 10 }, () => "x".repeat(5000));
  const input = buildOutlineInput(big, [], 20000);
  assert.ok(input.length < 24000, `length ${input.length}`);
  assert.match(input, /<<<PAGE 10>>>/);
});

test("normalizeOutline orders sections, clips text, assigns ids, filters relations", () => {
  const o = normalizeOutline(
    {
      kind: "survey",
      one_line: "A survey",
      sections: [
        { key: "taxonomy", summary: "branches", children: [{ id: "b1", title: "Branch one", summary: "s" }, { id: "b1", title: "Dup id", summary: "s" }] },
        { key: "scope", summary: "x".repeat(500), anchors: [{ page: 1, quote: "We study robot policies" }, { page: 99 }, null] },
        { key: "unknown", summary: "dropped" },
      ],
      relations: [
        { from: "b1", to: "n1", type: "improves", label: "fixes" },
        { from: "b1", to: "missing", type: "improves" },
        { from: "b1", to: "b1", type: "weird" },
      ],
    },
    3,
  );
  assert.equal(o.kind, "survey");
  assert.deepEqual(o.sections.map((s) => s.key), ["scope", "taxonomy"]);
  assert.equal(o.sections[0].title, "领域与范围");
  assert.ok(o.sections[0].summary.length <= 140);
  assert.equal(o.sections[0].anchors.length, 1, "out-of-range page without quote dropped");
  const ids = o.sections[1].children.map((c) => c.id);
  assert.equal(new Set(ids).size, 2);
  assert.equal(o.relations.length, 1);
  assert.equal(o.relations[0].to, ids[1]);
});

test("research outlines never keep relations", () => {
  const o = normalizeOutline({ kind: "research", sections: [{ key: "gap", summary: "g", children: [{ id: "a", title: "A" }, { id: "b", title: "B" }] }], relations: [{ from: "a", to: "b", type: "improves" }] }, 1);
  assert.equal(o.relations.length, 0);
  assert.throws(() => normalizeOutline({ kind: "research", sections: [] }, 1));
});

test("findQuotePage corrects wrong page numbers and tolerates line breaks", () => {
  const idx = new PageIndex(pages);
  assert.equal(findQuotePage(idx, "fine-tunes VLAs with supervised data", 0), 1);
  assert.equal(findQuotePage(idx, "generalize poorly to unseen\nobjects in cluttered", 2), 0);
  assert.equal(findQuotePage(idx, "this sentence is not in the paper at all", 0), -1);
});

test("figure captions are found by label", () => {
  assert.deepEqual(parseFigureLabel("Fig. 2b"), { kind: "figure", num: "2" });
  assert.deepEqual(parseFigureLabel("Table II"), { kind: "table", num: "II" });
  assert.equal(parseFigureLabel("Section 3"), null);
  assert.deepEqual(findCaptionPage(pages, "Figure 2", 0), { page: 1, caption: "Figure 2: Overview of the training pipeline with PPO." });
  assert.equal(findCaptionPage(pages, "Table 1", 0)?.page, 2);
  assert.equal(findCaptionPage(pages, "Figure 9", 0), null);
});

test("validateAnchors fixes pages and keeps page-only fallbacks", () => {
  const o = normalizeOutline(
    {
      kind: "research",
      sections: [
        {
          key: "method",
          summary: "PPO",
          anchors: [
            { page: 3, quote: "fine-tunes VLAs with supervised data from scripted planners" },
            { page: 1, figure: "Figure 2" },
            { page: 2, quote: "completely made up sentence that is nowhere" },
          ],
        },
      ],
    },
    3,
  );
  const stats = validateAnchors(o, pages);
  assert.deepEqual(stats, { total: 3, resolved: 2 });
  const a = o.sections[0].anchors;
  assert.equal(a[0].page, 2);
  assert.equal(a[1].page, 2);
  assert.match(a[1].caption!, /^Figure 2:/);
  assert.deepEqual(a[2], { page: 2 });
  assert.match(outlineToMarkdown(o), /1 本文方法: PPO \[p\.2\]/);
});

// ---------------------------------------------------------------------------
// Geometry

/** Lines of text at given y (top of line), x from 72; 5pt glyphs, 12pt lines. */
function page(lines: { text: string; y: number; x?: number; para?: boolean }[]): PdfChar[] {
  const chars: PdfChar[] = [];
  for (const l of lines) {
    let x = l.x ?? 72;
    for (const c of l.text) {
      if (c === " ") {
        if (chars.length) chars[chars.length - 1].spaceAfter = true;
        x += 2.5;
        continue;
      }
      chars.push({ c, u: c, rect: [x, l.y - 10, x + 5, l.y] });
      x += 5;
    }
    const last = chars[chars.length - 1];
    if (l.para) last.paragraphBreakAfter = true;
    else last.lineBreakAfter = true;
  }
  return chars;
}

const prose = "the quick brown fox jumps over the lazy dog and keeps running far away";

test("paragraphRange expands to paragraph breaks", () => {
  const chars = page([
    { text: "first paragraph ends here.", y: 700, para: true },
    { text: "second paragraph starts", y: 688 },
    { text: "and continues here.", y: 676, para: true },
  ]);
  const start = chars.map((c) => c.c).join("").indexOf("continues");
  const [s, e] = paragraphRange(chars, start, start + 3);
  assert.equal(chars[s].c, "s");
  assert.equal(chars[e].c, ".");
  assert.ok(chars[s - 1].paragraphBreakAfter);
});

test("isProseLine separates body text from figure labels", () => {
  const lines = splitLines(page([{ text: prose, y: 700 }, { text: "0.5 1.0 1.5", y: 680 }]));
  assert.equal(isProseLine(lines[0], 340), true);
  assert.equal(isProseLine(lines[1], 340), false);
});

test("figureRegion spans from caption up to the previous body paragraph", () => {
  const chars = page([
    { text: prose, y: 720 },
    { text: prose, y: 708, para: true },
    { text: "accuracy", y: 650, x: 120 },
    { text: "0.2 0.4 0.6", y: 560, x: 100 },
    { text: "Figure 3: Results on the benchmark suite across all tasks and seeds.", y: 540, para: true },
    { text: prose, y: 520 },
  ]);
  const capStart = chars.findIndex((c, i) => c.c === "F" && chars[i + 1].c === "i");
  const r = figureRegion(chars, capStart, capStart + 5, "figure")!;
  assert.ok(r, "region");
  assert.ok(r[3] <= 698 + 0.01 && r[3] >= 690, `top ${r[3]} should be just below the prose line bottom (698)`);
  assert.ok(r[1] <= 530 && r[1] >= 525, `bottom ${r[1]} should be at the caption bottom`);
});

test("figureRegion for tables walks downward", () => {
  const chars = page([
    { text: prose, y: 720, para: true },
    { text: "Table 1: Success rates of all methods on unseen tasks and scenes.", y: 690, para: true },
    { text: "Method SR", y: 670 },
    { text: "Ours 72.1", y: 655 },
    { text: "PPO 58.3", y: 640 },
    { text: prose, y: 600 },
  ]);
  const capStart = chars.findIndex((c, i) => c.c === "T" && chars[i + 1].c === "a");
  const r = figureRegion(chars, capStart, capStart + 5, "table")!;
  assert.ok(r[1] >= 600 && r[1] <= 604, `bottom ${r[1]} above next prose line top (600)`);
  assert.ok(r[3] >= 690, `top ${r[3]} includes caption`);
});

test("abstract breakdown is the first section for both kinds", () => {
  for (const kind of ["research", "survey"]) {
    const o = normalizeOutline(
      { kind, sections: [{ key: "conclusion", summary: "c" }, { key: "abstract", summary: "a", children: [{ title: "背景", summary: "b", anchors: [{ page: 1, quote: "We study robot policies" }] }] }] },
      3,
    );
    assert.equal(o.sections[0].key, "abstract");
    assert.equal(o.sections[0].title, "摘要拆解");
    assert.equal(o.sections[0].children[0].title, "背景");
  }
});

test("parsePartialJson parses streamed prefixes", async () => {
  const { parsePartialJson } = await import("../src/core/outline-schema.ts");
  const full = JSON.stringify({ kind: "research", one_line: "x", sections: [{ key: "abstract", summary: "摘要", children: [{ id: "a1", title: "背景", summary: "VLA \"quoted\" text" }] }] });
  let lastSections = 0;
  for (let i = 1; i <= full.length; i++) {
    const v = parsePartialJson(full.slice(0, i));
    if (v && Array.isArray(v.sections)) {
      assert.ok(v.sections.length >= lastSections, "monotonic");
      lastSections = v.sections.length;
    }
  }
  assert.deepEqual(parsePartialJson(full), JSON.parse(full));
  assert.deepEqual(parsePartialJson('{"kind": "survey", "sections": [{"key": "scope", "summ'), { kind: "survey", sections: [{ key: "scope" }] });
  assert.deepEqual(parsePartialJson('```json\n{"a": "partial str'), { a: "partial str" });
  assert.equal(parsePartialJson("no json"), null);
  const o = normalizeOutline(parsePartialJson('{"kind":"research","sections":[{"key":"gap","summary":"g"},{"key":"method","summ'), 3, "", true);
  assert.deepEqual(o.sections.map((s) => s.key), ["gap", "method"], "a section shows as soon as its key arrives");
  assert.equal(normalizeOutline({ kind: "research", sections: [] }, 1, "", true).sections.length, 0);
});

test("parsePartialJson can hide unfinished strings", async () => {
  const { parsePartialJson } = await import("../src/core/outline-schema.ts");
  assert.deepEqual(parsePartialJson('{"a": "done", "b": "half wri', { completeStringsOnly: true }), { a: "done" });
  assert.deepEqual(parsePartialJson('{"sections": [{"key": "gap", "summary": "no', { completeStringsOnly: true }), { sections: [{ key: "gap" }] });
  assert.deepEqual(parsePartialJson('{"sections": [{"ke', { completeStringsOnly: true }), { sections: [{}] });
});
