import { test } from "node:test";
import assert from "node:assert/strict";
import { commentProblems, latexToUnicode, markdownToComment, normalizeNoteMarkdown, noteProblems } from "../src/shared/note-format.ts";

test("latexToUnicode: symbols, scripts, fractions, accents", () => {
  assert.equal(latexToUnicode("\\alpha + \\beta \\leq \\gamma"), "α + β ≤ γ");
  assert.equal(latexToUnicode("x_i^2"), "x<sub>i</sub><sup>2</sup>");
  assert.equal(latexToUnicode("\\hat{A}_t"), "Â<sub>t</sub>");
  assert.equal(latexToUnicode("\\frac{1}{2}"), "1/2");
  assert.equal(latexToUnicode("\\frac{a+b}{c}"), "(a+b)/c");
  assert.equal(latexToUnicode("\\sqrt{d_k}"), "√(d<sub>k</sub>)");
  assert.equal(latexToUnicode("\\mathbb{E}_{\\tau \\sim \\pi}[R]"), "𝔼<sub>τ ∼ π</sub>[R]");
  assert.equal(latexToUnicode("\\text{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d}}\\right)"), "softmax((QK<sup>⊤</sup>)/√d)");
  assert.equal(latexToUnicode("f'(x)"), "f'(x)");
  assert.equal(latexToUnicode("\\\\frac{1}{n}"), "1/n", "double-escaped commands");
});

test("markdownToComment keeps only b / i / sub / sup", () => {
  const c = markdownToComment("## 核心思想\n**PPO** 用 *clip* 限制更新：$r_t(\\theta) \\in [1-\\epsilon, 1+\\epsilon]$，见 [p. 5](page:5)。\n- 优点：稳定\n- 缺点：`超参` 敏感");
  assert.equal(
    c,
    "<b>核心思想</b>\n<b>PPO</b> 用 <i>clip</i> 限制更新：r<sub>t</sub>(θ) ∈ [1-ε, 1+ε]，见 p. 5。\n• 优点：稳定\n• 缺点：超参 敏感",
  );
});

test("markdownToComment leaves underscores inside math and words alone", () => {
  assert.equal(markdownToComment("snake_case_name and $a_b * c_d$"), "snake_case_name and a<sub>b</sub> * c<sub>d</sub>");
  assert.equal(markdownToComment("costs $5 and $10"), "costs $5 and $10");
  assert.equal(markdownToComment("a < b"), "a < b");
});

test("markdownToComment flattens tables and code fences", () => {
  assert.equal(markdownToComment("| a | b |\n|---|---|\n| 1 | 2 |"), "a | b\n1 | 2");
  assert.equal(markdownToComment("```\nx = 1\n```"), "x = 1");
});

test("commentProblems flags long or structured comments", () => {
  assert.deepEqual(commentProblems("简短的解释，含 $x^2$。"), []);
  assert.ok(commentProblems("长".repeat(400))[0].startsWith("too long"));
  const p = commentProblems("# Title\n| a | b |\n$$x$$");
  assert.ok(p.includes("no headings") && p.includes("no tables") && p.some((x) => x.startsWith("no display math")));
  assert.ok(commentProblems("- a\n  - b").includes("no nested lists"));
});

test("noteProblems flags mermaid, HTML, deep headings, length", () => {
  assert.deepEqual(noteProblems("## 要点\n- $E=mc^2$\n- `<tag>` in code is fine"), []);
  const p = noteProblems("#### deep\n<div>x</div>\n```mermaid\ngraph TD\n```");
  assert.equal(p.length, 3);
  assert.ok(noteProblems("字".repeat(3500))[0].startsWith("too long"));
});

test("normalizeNoteMarkdown fixes double-escaped LaTeX but keeps line breaks", () => {
  assert.equal(normalizeNoteMarkdown("$\\\\frac{a}{b}$\n\n\n\nx"), "$\\frac{a}{b}$\n\nx");
  assert.equal(normalizeNoteMarkdown("$$a \\\\ b$$"), "$$a \\\\ b$$");
});
