/**
 * The plugin bootstrap sandbox only exposes a subset of web globals (fetch,
 * TextDecoder, URL, ...). pi-ai and the OpenAI SDK also need AbortController,
 * ReadableStream, Headers, etc. Borrow them from the hidden DOM window, which
 * lives for the whole app session (the main window can be closed on macOS).
 */
const NAMES = [
  "AbortController",
  "AbortSignal",
  "Headers",
  "Request",
  "Response",
  "FormData",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "TextDecoderStream",
  "TextEncoderStream",
  "Event",
  "EventTarget",
  "CustomEvent",
  "DOMException",
  "DOMParser",
  "XMLSerializer",
  "Blob",
  "File",
  "URL",
  "URLSearchParams",
  "structuredClone",
  "queueMicrotask",
  "performance",
  "navigator",
  "console",
  "crypto",
  "atob",
  "btoa",
];

let windowless: any = null;
const installed = new Set<string>();

/**
 * A long-lived DOM window to borrow constructors from: the hidden window when
 * the platform has one, else a private windowless browser, else the main window.
 */
function sourceWindow(): any {
  try {
    const w = Services.appShell.hiddenDOMWindow;
    if (w) return w;
  } catch {
    // not available on this platform
  }
  try {
    if (!windowless) windowless = Services.appShell.createWindowlessBrowser(true);
    const w = windowless.document?.defaultView;
    if (w) return w;
  } catch {
    // ignore
  }
  return Zotero.getMainWindow();
}

/** Fill in missing globals. Safe to call repeatedly (e.g. again once the main window exists). */
export function installPolyfills(win: any = sourceWindow()): void {
  if (!win) return;
  const g = globalThis as any;
  for (const name of NAMES) {
    if (typeof g[name] === "undefined" && typeof win[name] !== "undefined") {
      const v = win[name];
      g[name] = typeof v === "function" && /^[a-z]/.test(name) ? v.bind(win) : v;
      installed.add(name);
    }
  }
}

/** Remove what we installed (the sandbox is reused if the plugin is re-enabled). */
export function disposePolyfills(): void {
  const g = globalThis as any;
  for (const name of installed) delete g[name];
  installed.clear();
  try {
    windowless?.close();
  } catch {
    // ignore
  }
  windowless = null;
}
