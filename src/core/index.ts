import "./polyfill-install";
import { disposePolyfills, installPolyfills } from "./polyfill";
import { getSettings, saveSettings, type QuickAction, type Settings } from "./config";
import { ContextTracker } from "./context";
import { globalEvents } from "./events";
import { listModels, testConnection, testModel } from "./llm";
import { agyPluginStatus, installAgyPlugin, uninstallAgyPlugin } from "./agents/agy";
import { detectCli, disposeCliProcesses } from "./agents/runner";
import type { CliProviderId } from "./agents/providers";
import * as workspaces from "./agents/workspace";
import { getItem, getMainAttachment, type PaperRef } from "./paper";
import { IMAGE_ACTIONS, QuickService, type Selection } from "./quick";
import { ensureReader, navigateToPage, selectReaderTab } from "./reader-utils";
import { SessionManager } from "./sessions";
import { closeStore, openStore } from "./store";
import { ChatPanel } from "./ui/panel";
import { OutlineService } from "./outline";
import { OutlineGutter } from "./ui/outline-gutter";
import { QuickCard } from "./ui/quickcard";
import { injectToolbarIntoOpenReaders, registerReaderHooks, removeToolbarFromReaders } from "./ui/reader-hooks";
import { registerDevEndpoint, unregisterDevEndpoint } from "./dev";
import { registerMcpEndpoint, unregisterMcpEndpoint } from "./mcp/bridge";
import { selectRegion } from "./ui/region-select";
import { BRAND, BRAND_ZH } from "./ui/mark";
import { renderRegion, type RenderedRegion } from "./vision";
import { findReader } from "./reader-utils";

class ZoteroPiAddon {
  readonly pluginID = __PLUGIN_ID__;
  readonly version = __PLUGIN_VERSION__;
  readonly events = globalEvents;
  readonly sessions = new SessionManager();
  readonly context = new ContextTracker();
  readonly quick = new QuickService(this.sessions);
  readonly outline = new OutlineService();
  panel: ChatPanel | null = null;
  gutter: OutlineGutter | null = null;
  card: QuickCard | null = null;
  private win: any = null;
  private menuItems: Element[] = [];
  private injectTimer: any = null;
  private onKey = (e: KeyboardEvent) => {
    const accel = Zotero.isMac ? e.metaKey : e.ctrlKey;
    if (accel && e.shiftKey && (e.key === "k" || e.key === "K")) {
      const reader = this.currentReader();
      if (reader) {
        e.preventDefault();
        this.startRegionAsk(reader);
      }
    }
  };
  private unsubs: (() => void)[] = [];

  async startup(): Promise<void> {
    await openStore();
    if (__DEV__) registerDevEndpoint(this);
    registerMcpEndpoint();
    registerReaderHooks(this);
    injectToolbarIntoOpenReaders(this);
    // Readers restored from the previous session may still be loading.
    this.injectTimer = setTimeout(() => injectToolbarIntoOpenReaders(this), 3000);
    try {
      await Zotero.PreferencePanes.register({
        pluginID: this.pluginID,
        src: rootURI + "content/prefs.xhtml",
        label: BRAND,
        image: rootURI + "content/icons/icon.svg",
      });
    } catch (e) {
      Zotero.logError(e);
    }
    this.context.start();
    this.unsubs.push(
      this.context.changes.on((ctx) => this.panel?.setTitle(ctx ? ctx.title : BRAND)),
      this.quick.changes.on((job) => {
        if (!job) this.card?.close();
      }),
    );
    const win = Zotero.getMainWindow();
    if (win?.document?.readyState === "complete") this.onMainWindowLoad(win);
  }

  onMainWindowLoad(win: any): void {
    if (this.win === win) return;
    if (this.win) this.onMainWindowUnload(this.win);
    this.win = win;
    installPolyfills(win); // fills anything still missing if no other source window existed
    this.panel = new ChatPanel(win);
    this.panel.setTitle(this.context.get()?.title || BRAND);
    this.card = new QuickCard(
      win,
      () => this.quick.cancel(),
      () => {
        const job = this.quick.job;
        this.panel?.show();
        if (job?.sessionId) this.panel?.postToFrame({ type: "zoteropi-open-session", sessionId: job.sessionId });
        this.card?.close();
      },
    );
    this.gutter = new OutlineGutter(win, this.outline, this.context, {
      runQuickAction: (reader, action, sel, anchor) => this.runQuickAction(reader, action, sel, anchor),
      askInPanel: (text, pageLabel) => {
        this.panel?.show();
        this.panel?.postToFrame({ type: "zoteropi-insert-quote", text, pageLabel });
      },
    });
    this.addMenu(win);
    win.addEventListener("keydown", this.onKey, true);
  }

  onMainWindowUnload(win: any): void {
    if (this.win !== win) return;
    win.removeEventListener("keydown", this.onKey, true);
    this.panel?.destroy();
    this.card?.destroy();
    this.gutter?.destroy();
    this.gutter = null;
    for (const m of this.menuItems) m.remove();
    this.menuItems = [];
    this.panel = null;
    this.card = null;
    this.win = null;
  }

  private addMenu(win: any): void {
    const popup = win.document.getElementById("menu_ToolsPopup");
    if (!popup) return;
    const sep = win.document.createXULElement("menuseparator");
    const toggle = win.document.createXULElement("menuitem");
    toggle.setAttribute("label", `${BRAND} 聊天面板`);
    toggle.addEventListener("command", () => this.togglePanel());
    const outline = win.document.createXULElement("menuitem");
    outline.setAttribute("label", `${BRAND} 文章脉络`);
    outline.addEventListener("command", () => this.toggleOutline());
    const settings = win.document.createXULElement("menuitem");
    settings.setAttribute("label", `${BRAND} 设置…`);
    settings.addEventListener("command", () => this.openSettings());
    popup.append(sep, toggle, outline, settings);
    this.menuItems = [sep, toggle, outline, settings];
  }

  async shutdown(): Promise<void> {
    for (const u of this.unsubs) u();
    clearTimeout(this.injectTimer);
    try {
      removeToolbarFromReaders();
    } catch (e) {
      Zotero.logError(e);
    }
    this.quick.cancel();
    this.outline.dispose();
    this.context.stop();
    if (this.win) this.onMainWindowUnload(this.win);
    this.sessions.dispose();
    disposeCliProcesses();
    globalEvents.clear();
    for (const w of Services.wm.getEnumerator("zoteropi:settings")) w.close();
    if (__DEV__) unregisterDevEndpoint();
    unregisterMcpEndpoint();
    disposePolyfills();
    await closeStore();
  }

  // ------------------------------------------------------------------ API used by the web UI

  getSettings(): Settings {
    return getSettings();
  }

  saveSettings(patch: Partial<Settings>): void {
    saveSettings(JSON.parse(JSON.stringify(patch)));
    this.sessions.refreshAll();
    globalEvents.emit({ type: "settings-changed" });
  }

  /** Models of all configured sources; `override` previews unsaved settings. */
  listModels(override?: Partial<Settings>) {
    return listModels(override ? JSON.parse(JSON.stringify(override)) : undefined);
  }

  testConnection() {
    return testConnection();
  }

  testModel(id: string) {
    return testModel(String(id));
  }

  /** CLI agents and their workspaces (settings page). */
  readonly cli = {
    detect: (provider: CliProviderId) => detectCli(provider),
    agyStatus: () => agyPluginStatus(),
    installAgy: () => installAgyPlugin(this.version),
    uninstallAgy: () => uninstallAgyPlugin(),
    workspaceRoot: () => workspaces.workspaceRoot(),
    defaultWorkspaceRoot: () => workspaces.defaultWorkspaceRoot(),
    listWorkspaces: () => workspaces.listWorkspaces(),
    reveal: (dir?: string) => workspaces.revealWorkspace(dir || workspaces.workspaceRoot()),
    removeWorkspace: (dir: string) => workspaces.removeWorkspace(String(dir)),
    cleanOrphans: () => workspaces.cleanOrphanWorkspaces(),
    pruneAttachments: (days = 30) => workspaces.pruneAttachments(days),
  };

  imageActions() {
    return IMAGE_ACTIONS;
  }

  togglePanel(): void {
    this.panel?.toggle();
  }

  toggleOutline(): void {
    this.gutter?.toggle();
  }

  openSettings(): void {
    const existing = Services.wm.getMostRecentWindow("zoteropi:settings");
    if (existing) {
      existing.focus();
      return;
    }
    Zotero.getMainWindow()?.openDialog(
      "chrome://zoteropi/content/settings.html",
      "zoteropi-settings",
      "chrome,centerscreen,resizable,dialog=no,width=780,height=860",
    );
  }

  launchURL(url: string): void {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) Zotero.launchURL(url);
  }

  async openPage(ref: PaperRef, pageNumber: number): Promise<void> {
    const att = await getMainAttachment(getItem(ref));
    if (!att) return;
    const reader = await ensureReader(att.id);
    selectReaderTab(reader);
    await navigateToPage(reader, Math.max(0, pageNumber - 1));
  }

  async openAnnotation(libraryID: number, key: string): Promise<void> {
    const ann = Zotero.Items.getByLibraryAndKey(libraryID, key);
    if (!ann?.isAnnotation?.()) return;
    await Zotero.Reader.open(ann.parentItemID, { annotationID: key });
  }

  private currentReader(): any {
    const ctx = this.context.get();
    return ctx?.attachmentID ? findReader(ctx.attachmentID) : null;
  }

  /** 框图提问: drag a box on the PDF, then choose what to ask in the quick card. */
  async startRegionAsk(reader?: any): Promise<void> {
    reader = reader || this.currentReader();
    if (!reader || !this.win) return;
    this.card?.close();
    try {
      const sel = await selectRegion(this.win, reader);
      if (!sel) return;
      const img = await renderRegion(reader, sel.pageIndex, sel.rect);
      this.card?.open(`框图提问 · ${BRAND_ZH}`, { left: sel.screen.left, top: sel.screen.top, bottom: sel.screen.bottom });
      this.quick.startImage(reader.itemID, img);
    } catch (e) {
      Zotero.logError(e);
    }
  }

  /** Context menu on an existing image annotation. */
  async askImageAnnotation(reader: any, key: string): Promise<void> {
    const ann = Zotero.Items.getByLibraryAndKey(Zotero.Items.get(reader.itemID).libraryID, key);
    if (!ann) return;
    try {
      const pos = JSON.parse(ann.annotationPosition);
      const img = await renderRegion(reader, pos.pageIndex, pos.rects?.[0]);
      this.card?.open(`图片批注 · ${BRAND_ZH}`, null);
      this.quick.startImage(reader.itemID, img, key);
    } catch (e) {
      Zotero.logError(e);
    }
  }

  /** For the chat panel's 📷 button: capture a region of the open PDF. */
  async captureRegion(): Promise<RenderedRegion | null> {
    const reader = this.currentReader();
    if (!reader || !this.win) return null;
    const sel = await selectRegion(this.win, reader);
    if (!sel) return null;
    return renderRegion(reader, sel.pageIndex, sel.rect);
  }

  /** Called from the reader selection popup. */
  runQuickAction(reader: any, action: QuickAction | "ask" | "quote", sel: Selection, anchor: DOMRect | null): void {
    if (action === "quote") {
      this.panel?.show();
      this.panel?.postToFrame({ type: "zoteropi-insert-quote", text: sel.text, pageLabel: sel.pageLabel || "" });
      return;
    }
    const a = action === "ask" ? ({ id: "ask", label: "问 AI", mode: "ask", prompt: "" } as const) : action;
    // Translations get a card sized to the text instead of the remembered chat-card size
    this.card?.open(
      `${a.label} · ${BRAND_ZH}`,
      anchor ? { left: anchor.left, top: anchor.top, bottom: anchor.bottom } : null,
      a.mode === "translate" ? { fitText: sel.text.length } : undefined,
    );
    void this.quick.start(a as any, reader.itemID, sel).catch((e) => Zotero.logError(e));
  }
}

// Expose for chat.html / settings.html (chrome pages) and bootstrap.js
const addon = new ZoteroPiAddon();
Zotero.ZoteroPi = addon;
export type { ZoteroPiAddon };
