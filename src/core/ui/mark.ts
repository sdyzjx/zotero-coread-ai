/**
 * CoRead AI mark as inline SVG (open book, highlighted line, AI spark), drawn in
 * currentColor so it inherits the surrounding text colour. Built with DOM
 * calls rather than an <img>, so it works in chrome, reader and XUL documents
 * alike without loading anything.
 */
const NS = "http://www.w3.org/2000/svg";

export const BRAND = "CoRead AI";
export const BRAND_ZH = "AI 伴读";

export function logoMark(doc: any, size = 14): any {
  const svg = doc.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("style", "display:inline-block;vertical-align:middle;flex:none;overflow:visible");
  const path = (d: string, attrs: Record<string, string>) => {
    const p = doc.createElementNS(NS, "path");
    p.setAttribute("d", d);
    for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
    svg.append(p);
  };
  // pages + spine
  path("M12 8.2C10 6.9 7.4 6.4 3.6 6.7v11.6c3.8-.3 6.4.2 8.4 1.5 2-1.3 4.6-1.8 8.4-1.5V6.7c-3.8-.3-6.4.2-8.4 1.5zM12 8.2v11.6", {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linejoin": "round",
  });
  // highlighted line on the shared page
  path("M13.7 10.6c1.7-.7 3.6-1 5.2-.9v2.8c-1.6-.1-3.5.2-5.2.9z", { fill: "currentColor" });
  // AI spark
  path("M19 .9l.75 1.95 1.95.75-1.95.75L19 6.3l-.75-1.95-1.95-.75 1.95-.75z", { fill: "currentColor" });
  return svg;
}
