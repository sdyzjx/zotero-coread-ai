/**
 * Geometry for outline anchors on a PDF page (PDF user space: origin bottom-left,
 * rects are [x1, y1, x2, y2] with y2 the top). Pure — unit-tested.
 */
import type { PdfChar } from "./text";

export type Rect = number[];

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let [x1, y1, x2, y2] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rects) {
    x1 = Math.min(x1, r[0], r[2]);
    y1 = Math.min(y1, r[1], r[3]);
    x2 = Math.max(x2, r[0], r[2]);
    y2 = Math.max(y2, r[1], r[3]);
  }
  return [x1, y1, x2, y2];
}

/** Expand [start, end] to the surrounding paragraph (bounded by paragraphBreakAfter), capped in length. */
export function paragraphRange(chars: PdfChar[], start: number, end: number, maxChars = 1400): [number, number] {
  let s = start;
  while (s > 0 && !chars[s - 1].paragraphBreakAfter && start - s < maxChars / 2) s--;
  let e = end;
  while (e < chars.length - 1 && !chars[e].paragraphBreakAfter && e - end < maxChars / 2) e++;
  return [s, e];
}

export interface Line {
  start: number;
  end: number;
  rect: Rect;
  text: string;
}

export function splitLines(chars: PdfChar[]): Line[] {
  const lines: Line[] = [];
  let s = 0;
  let text = "";
  const rects: Rect[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (!ch.ignorable) {
      text += ch.u ?? ch.c ?? "";
      if (ch.spaceAfter) text += " ";
      rects.push(ch.rect);
    }
    if (ch.lineBreakAfter || ch.paragraphBreakAfter || i === chars.length - 1) {
      const rect = unionRects(rects);
      if (rect && text.trim()) lines.push({ start: s, end: i, rect, text: text.trim() });
      s = i + 1;
      text = "";
      rects.length = 0;
    }
  }
  return lines;
}

/** Body-text line (as opposed to axis labels, table cells, equation pieces). */
export function isProseLine(line: Line, columnWidth: number): boolean {
  const width = line.rect[2] - line.rect[0];
  if (width < columnWidth * 0.6) return false;
  const t = line.text;
  const cjk = (t.match(/[一-鿿]/g) || []).length;
  if (cjk >= 18) return true;
  const letters = (t.match(/[a-z]/g) || []).length;
  const words = t.split(/\s+/).filter((w) => /[a-z]{2,}/i.test(w)).length;
  const dense = t.replace(/\s/g, "").length || 1;
  return t.length >= 45 && words >= 7 && letters / dense >= 0.55;
}

/** Text column containing [x1, x2]: left / right half of a two-column page or the full width. */
export function columnBounds(chars: PdfChar[], x1: number, x2: number): [number, number] {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const ch of chars) {
    if (ch.ignorable) continue;
    minX = Math.min(minX, ch.rect[0]);
    maxX = Math.max(maxX, ch.rect[2]);
  }
  if (!isFinite(minX)) return [x1, x2];
  const mid = (minX + maxX) / 2;
  const slack = (maxX - minX) * 0.03;
  if (x2 <= mid + slack) return [minX, mid];
  if (x1 >= mid - slack) return [mid, maxX];
  return [minX, maxX];
}

/**
 * Region of a figure / table given its caption char range: walk away from the
 * caption (up for figures, down for tables, with the other direction as fallback)
 * over non-prose lines until body text is reached.
 */
export function figureRegion(chars: PdfChar[], capStart: number, capEnd: number, kind: "figure" | "table"): Rect | null {
  const [ps, pe] = paragraphRange(chars, capStart, capEnd, 900);
  const capRects: Rect[] = [];
  for (let i = ps; i <= pe; i++) if (!chars[i].ignorable) capRects.push(chars[i].rect);
  const cap = unionRects(capRects);
  if (!cap) return null;
  const [cx1, cx2] = columnBounds(chars, cap[0], cap[2]);
  const colW = cx2 - cx1;
  const lines = splitLines(chars).filter((l) => (l.start < ps || l.start > pe) && l.rect[2] > cx1 + 2 && l.rect[0] < cx2 - 2);

  let pageTop = -Infinity;
  let pageBottom = Infinity;
  for (const ch of chars) {
    if (ch.ignorable) continue;
    pageTop = Math.max(pageTop, ch.rect[3]);
    pageBottom = Math.min(pageBottom, ch.rect[1]);
  }

  const walk = (dir: "up" | "down"): Rect | null => {
    const cand =
      dir === "up"
        ? lines.filter((l) => l.rect[1] >= cap[3] - 1).sort((a, b) => a.rect[1] - b.rect[1])
        : lines.filter((l) => l.rect[3] <= cap[1] + 1).sort((a, b) => b.rect[3] - a.rect[3]);
    let edge = dir === "up" ? pageTop : pageBottom;
    const inside: Rect[] = [];
    for (const l of cand) {
      if (isProseLine(l, colW)) {
        edge = dir === "up" ? l.rect[1] - 2 : l.rect[3] + 2;
        break;
      }
      inside.push(l.rect);
    }
    const height = dir === "up" ? edge - cap[3] : cap[1] - edge;
    if (height < 24) return null;
    const u = unionRects(inside);
    const x1 = Math.max(cx1 - 4, Math.min(cap[0], u ? u[0] : cap[0]) - 4);
    const x2 = Math.min(cx2 + 4, Math.max(cap[2], u ? u[2] : cap[2]) + 4);
    // Graphics can be wider than their text; prefer the column width if the caption spans most of it
    const wide = cap[2] - cap[0] > colW * 0.5;
    return dir === "up"
      ? [wide ? cx1 - 4 : x1, cap[1] - 2, wide ? cx2 + 4 : x2, edge]
      : [wide ? cx1 - 4 : x1, edge, wide ? cx2 + 4 : x2, cap[3] + 2];
  };

  const order: ("up" | "down")[] = kind === "table" ? ["down", "up"] : ["up", "down"];
  for (const dir of order) {
    const r = walk(dir);
    if (r) return r.map((v) => Math.round(v * 100) / 100);
  }
  return cap.map((v) => Math.round(v * 100) / 100);
}
