export const HTML_NS = "http://www.w3.org/1999/xhtml";

export function h(doc: Document, tag: string, attrs: Record<string, string> = {}, children: (Node | string)[] = []): HTMLElement {
  const el = doc.createElementNS(HTML_NS, tag) as HTMLElement;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(c);
  return el;
}

export function ensureStylesheet(doc: Document, id = "zoteropi-css", href = "chrome://zoteropi/content/panel.css"): void {
  if (doc.getElementById(id)) return;
  // Versioned URL: the document caches sheets by URL, so an in-place plugin update would
  // otherwise keep showing the previous stylesheet until Zotero restarts.
  const link = h(doc, "link", { id, rel: "stylesheet", href: `${href}?v=${__BUILD_ID__}` });
  doc.documentElement.appendChild(link);
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
