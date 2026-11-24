/**
 * Formatting + complexity limits for what the agent writes into Zotero:
 *
 * - Annotation comments: Zotero's reader only renders <b>, <i>, <sub>, <sup> in
 *   comments (no Markdown, no math). Markdown is converted to that subset and
 *   LaTeX to Unicode with <sub>/<sup>.
 * - Child notes: rendered by markdown-it with the note editor's math format
 *   elsewhere; here we only normalize and check complexity.
 *
 * Pure — unit-tested.
 */

// ---------------------------------------------------------------------------
// LaTeX → Unicode

const SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ",
  varsigma: "ς", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆", circ: "∘", bullet: "•", oplus: "⊕", otimes: "⊗", odot: "⊙",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", sim: "∼", simeq: "≃", equiv: "≡", cong: "≅", propto: "∝",
  ll: "≪", gg: "≫", prec: "≺", succ: "≻", coloneqq: "≔", triangleq: "≜",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇", cup: "∪", cap: "∩", setminus: "∖", emptyset: "∅", varnothing: "∅",
  forall: "∀", exists: "∃", neg: "¬", lnot: "¬", land: "∧", wedge: "∧", lor: "∨", vee: "∨",
  to: "→", rightarrow: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔",
  implies: "⇒", iff: "⇔", mapsto: "↦", uparrow: "↑", downarrow: "↓", longrightarrow: "⟶",
  infty: "∞", partial: "∂", nabla: "∇", sum: "∑", prod: "∏", int: "∫", oint: "∮", sqrt: "√",
  ldots: "…", cdots: "⋯", dots: "…", vdots: "⋮", ddots: "⋱", prime: "′", degree: "°", angle: "∠", perp: "⊥", parallel: "∥",
  langle: "⟨", rangle: "⟩", lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋", mid: "|", vert: "|", Vert: "‖", lVert: "‖", rVert: "‖",
  top: "⊤", dagger: "†", ell: "ℓ", hbar: "ħ", Re: "ℜ", Im: "ℑ", aleph: "ℵ",
  log: "log", ln: "ln", exp: "exp", sin: "sin", cos: "cos", tan: "tan", max: "max", min: "min", arg: "arg", argmax: "argmax",
  argmin: "argmin", lim: "lim", sup: "sup", inf: "inf", det: "det", Pr: "Pr", E: "E", KL: "KL",
  quad: " ", qquad: "  ", ",": " ", ";": " ", ":": " ", "!": "", " ": " ", "{": "{", "}": "}", "%": "%", "$": "$", "&": "&", "_": "_", "#": "#",
};

const BLACKBOARD: Record<string, string> = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", E: "𝔼", P: "ℙ" };
const ACCENTS: Record<string, string> = { hat: "̂", widehat: "̂", bar: "̄", overline: "̅", tilde: "̃", widetilde: "̃", vec: "⃗", dot: "̇", ddot: "̈" };
const STRIP_CMDS = new Set(["mathbf", "mathrm", "mathit", "mathsf", "mathtt", "boldsymbol", "bm", "text", "textbf", "textit", "textrm", "operatorname", "mathcal", "mathscr", "mathfrak", "displaystyle", "textstyle", "underbrace", "overbrace"]);

/** Read a {group} or a single token starting at i; returns [content, nextIndex]. */
function readArg(s: string, i: number): [string, number] {
  while (s[i] === " ") i++;
  if (s[i] === "{") {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === "{" && s[j - 1] !== "\\") depth++;
      else if (s[j] === "}" && s[j - 1] !== "\\") {
        depth--;
        if (depth === 0) return [s.slice(i + 1, j), j + 1];
      }
    }
    return [s.slice(i + 1), s.length];
  }
  if (s[i] === "\\") {
    const m = s.slice(i).match(/^\\([A-Za-z]+|.)/);
    if (m) return [m[0], i + m[0].length];
  }
  return [s[i] ?? "", i + 1];
}

/** Simple enough to show without parentheses in a fraction. */
function atomic(s: string): boolean {
  return /^[\p{L}\p{N}.′√\u0300-\u036f]+$/u.test(s) || /^<su[bp]>[^<]*<\/su[bp]>$/.test(s);
}

export function latexToUnicode(tex: string): string {
  const s = tex.replace(/\\left|\\right|\\big|\\Big|\\bigg|\\Bigg/g, "").replace(/\\\\(?=[A-Za-z])/g, "\\");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      const m = s.slice(i).match(/^\\([A-Za-z]+|.)/);
      if (!m) {
        i++;
        continue;
      }
      const name = m[1];
      i += m[0].length;
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const [a, j] = readArg(s, i);
        const [b, k] = readArg(s, j);
        i = k;
        const A = latexToUnicode(a);
        const B = latexToUnicode(b);
        out += `${atomic(A) ? A : `(${A})`}/${atomic(B) ? B : `(${B})`}`;
      } else if (name === "sqrt") {
        const [a, j] = readArg(s, i);
        i = j;
        const A = latexToUnicode(a);
        out += atomic(A) ? `√${A}` : `√(${A})`;
      } else if (name === "mathbb") {
        const [a, j] = readArg(s, i);
        i = j;
        out += [...a].map((c) => BLACKBOARD[c] || c).join("");
      } else if (ACCENTS[name]) {
        const [a, j] = readArg(s, i);
        i = j;
        const A = latexToUnicode(a);
        out += [...A].length === 1 ? A + ACCENTS[name] : `${A}${ACCENTS[name]}`;
      } else if (STRIP_CMDS.has(name)) {
        if (name === "displaystyle" || name === "textstyle") continue;
        const [a, j] = readArg(s, i);
        i = j;
        out += /^text/.test(name) ? a : latexToUnicode(a);
      } else if (name in SYMBOLS) {
        out += SYMBOLS[name];
      } else if (name === "begin" || name === "end") {
        const [, j] = readArg(s, i);
        i = j;
      } else {
        out += name; // unknown command: keep its name readable
      }
    } else if (ch === "^" || ch === "_") {
      const [a, j] = readArg(s, i + 1);
      i = j;
      const tag = ch === "^" ? "sup" : "sub";
      const A = a === "\\prime" ? "′" : latexToUnicode(a);
      out += tag === "sup" && /^′+$/.test(A) ? A : `<${tag}>${A}</${tag}>`;
    } else if (ch === "{" || ch === "}") {
      i++;
    } else if (ch === "&") {
      out += " ";
      i++;
    } else if (ch === "~") {
      out += " ";
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out.replace(/\s{2,}/g, " ").trim().normalize("NFC");
}

// ---------------------------------------------------------------------------
// Markdown → Zotero comment (b / i / sub / sup only)

const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g;

function inline(md: string): string {
  // Protect math first so * and _ inside formulas are not treated as emphasis
  const math: string[] = [];
  let s = md.replace(MATH_RE, (_m, a, b, c, d) => {
    math.push(latexToUnicode(a ?? b ?? c ?? d ?? ""));
    return `\u0000${math.length - 1}\u0000`;
  });
  s = s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:page|annotation):[^)]*\)/gi, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+?)\*\*|__([^_]+?)__/g, (_m, a, b) => `<b>${a ?? b}</b>`)
    .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\w)|(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, (_m, a, b) => `<i>${a ?? b}</i>`)
    .replace(/~~([^~]+)~~/g, "$1");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, n) => math[Number(n)]);
}

/** Convert agent markdown to a Zotero annotation comment. */
export function markdownToComment(md: string): string {
  const lines = String(md ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => code.trimEnd())
    .split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    let line = raw.replace(/\s+$/, "");
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue; // table separator
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      out.push(`<b>${inline(heading[1].replace(/\s#+\s*$/, ""))}</b>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue; // horizontal rule
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const depth = Math.min(2, Math.floor(bullet[1].replace(/\t/g, "  ").length / 2));
      out.push(`${"  ".repeat(depth)}• ${inline(bullet[2])}`);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) line = quote[1];
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim())
        .join(" | ");
    }
    out.push(inline(line));
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Complexity limits

export const COMMENT_LIMIT = 300;
export const NOTE_LIMIT = 3000;

/** Visible length: CJK characters count double-ish relative to Latin words, so measure raw characters. */
function visibleLength(s: string): number {
  return s.replace(/<\/?(b|i|sub|sup)>/g, "").replace(/\s+/g, " ").trim().length;
}

/** Problems with an agent-written annotation comment (empty = OK). */
export function commentProblems(md: string): string[] {
  const p: string[] = [];
  const text = String(md ?? "");
  const len = visibleLength(markdownToComment(text));
  if (len > COMMENT_LIMIT) p.push(`too long (${len} characters, limit ${COMMENT_LIMIT})`);
  if (/^\s{0,3}#{1,6}\s/m.test(text)) p.push("no headings");
  if (/```/.test(text)) p.push("no code blocks");
  if (/^\s*\|.*\|\s*$/m.test(text)) p.push("no tables");
  if (/\$\$|\\\[|\\begin\{/.test(text)) p.push("no display math (inline $…$ only)");
  const bullets = (text.match(/^\s*([-*+]|\d+[.)])\s+/gm) || []).length;
  if (bullets > 5) p.push(`at most 5 bullet points (got ${bullets})`);
  if (/^\s{2,}([-*+]|\d+[.)])\s+/m.test(text)) p.push("no nested lists");
  return p;
}

/** Problems with an agent-written child note (empty = OK). */
export function noteProblems(md: string): string[] {
  const p: string[] = [];
  const text = String(md ?? "");
  const len = text.replace(/\s+/g, " ").trim().length;
  if (len > NOTE_LIMIT) p.push(`too long (${len} characters, limit ${NOTE_LIMIT}) — keep only the key points`);
  if (/```\s*mermaid/i.test(text)) p.push("mermaid diagrams are not rendered in Zotero notes — describe the structure in a short list instead");
  if (/<\/?[a-z][^>]*>/i.test(text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, ""))) p.push("no raw HTML");
  if (/^#{4,6}\s/m.test(text)) p.push("use at most 3 heading levels (#, ##, ###)");
  if (/^(\s{4,}|\t{2,})([-*+]|\d+[.)])\s+/m.test(text)) p.push("lists nested at most 2 levels");
  const tables = (text.match(/^\s*\|?\s*:?-{3,}:?\s*\|/gm) || []).length;
  if (tables > 2) p.push(`at most 2 tables (got ${tables})`);
  const display = (text.match(/\$\$|\\\[/g) || []).length / 2;
  if (display > 6) p.push(`at most 6 display equations (got ${Math.floor(display)})`);
  return p;
}

/** Fix common slips in agent markdown before rendering a note. */
export function normalizeNoteMarkdown(md: string): string {
  return String(md ?? "")
    .replace(/\r\n?/g, "\n")
    // Double-escaped LaTeX commands from JSON tool arguments (\\frac → \frac); keep \\ line breaks
    .replace(/\\\\(?=[A-Za-z]{2,})/g, "\\")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
