/**
 * Workspaces for CLI agents. Every paper gets its own directory that serves as
 * the CLI's working directory (stable, so Claude Code / Codex / agy can resume
 * their own sessions), holding the agent instructions, paper metadata and
 * images the user attached. Per chat session we remember which CLI session it
 * maps to, so switching models or restarting Zotero continues the right thread.
 *
 * Layout:
 *   <root>/
 *     papers/<libraryID>_<itemKey>/
 *       AGENTS.md          instructions (Codex reads it; others get it inline)
 *       paper.json         metadata of the Zotero item
 *       attachments/       images sent with messages (for CLIs that take files)
 *     agy-plugin/zotero-pi/  Antigravity plugin registering the MCP bridge
 */
import { getSettings } from "../config";
import { getItem, paperMetadata, paperTitle, type PaperRef } from "../paper";
import * as store from "../store";

export interface WorkspaceInfo {
  dir: string;
  name: string;
  libraryID: number;
  itemKey: string;
  title: string;
  /** The Zotero item no longer exists. */
  orphan: boolean;
  bytes: number;
  files: number;
  modified: number;
}

/** The CLI session a chat session continues. */
export interface CliSessionState {
  provider: string;
  nativeId: string;
  /** Visible transcript length already known to the CLI session. */
  synced: number;
}

export function defaultWorkspaceRoot(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, "zoteropi");
}

export function workspaceRoot(): string {
  return getSettings().cliWorkspaceRoot.trim() || defaultWorkspaceRoot();
}

function papersDir(): string {
  return PathUtils.join(workspaceRoot(), "papers");
}

export function paperDirName(ref: PaperRef): string {
  return `${ref.libraryID}_${String(ref.itemKey).replace(/[^A-Za-z0-9]/g, "")}`;
}

export function paperWorkspaceDir(ref: PaperRef): string {
  return PathUtils.join(papersDir(), paperDirName(ref));
}

async function mkdirp(path: string): Promise<void> {
  await IOUtils.makeDirectory(path, { createAncestors: true, ignoreExisting: true });
}

async function writeIfChanged(path: string, text: string): Promise<void> {
  try {
    if ((await IOUtils.readUTF8(path)) === text) return;
  } catch {
    // missing: write it
  }
  await IOUtils.writeUTF8(path, text);
}

/** Create / refresh a paper's workspace and return its directory. */
export async function ensurePaperWorkspace(ref: PaperRef, instructions: string): Promise<string> {
  const dir = paperWorkspaceDir(ref);
  await mkdirp(PathUtils.join(dir, "attachments"));
  const item = getItem(ref);
  const meta = item ? paperMetadata(item) : {};
  await writeIfChanged(
    PathUtils.join(dir, "paper.json"),
    JSON.stringify({ libraryID: ref.libraryID, itemKey: ref.itemKey, title: item ? paperTitle(item) : "", ...meta }, null, 2) + "\n",
  );
  await writeIfChanged(PathUtils.join(dir, "AGENTS.md"), instructions.trim() + "\n");
  return dir;
}

/** Save a base64 image into the workspace; returns its absolute path. */
export async function saveAttachment(dir: string, img: { data: string; mimeType: string }): Promise<string> {
  const ext = /jpe?g/.test(img.mimeType) ? "jpg" : img.mimeType.includes("webp") ? "webp" : "png";
  const path = PathUtils.join(dir, "attachments", `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
  const bin = atob(img.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  await IOUtils.write(path, bytes);
  return path;
}

async function dirUsage(path: string): Promise<{ bytes: number; files: number; modified: number }> {
  let bytes = 0;
  let files = 0;
  let modified = 0;
  const walk = async (p: string, depth: number) => {
    let children: string[] = [];
    try {
      children = await IOUtils.getChildren(p);
    } catch {
      return;
    }
    for (const c of children) {
      const st = await IOUtils.stat(c).catch(() => null);
      if (!st) continue;
      modified = Math.max(modified, st.lastModified || 0);
      if (st.type === "directory") {
        if (depth < 6) await walk(c, depth + 1);
      } else {
        bytes += st.size || 0;
        files++;
      }
    }
  };
  await walk(path, 0);
  return { bytes, files, modified };
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  const root = papersDir();
  if (!(await IOUtils.exists(root))) return [];
  const out: WorkspaceInfo[] = [];
  for (const dir of await IOUtils.getChildren(root)) {
    const name = PathUtils.filename(dir);
    const m = name.match(/^(\d+)_([A-Za-z0-9]+)$/);
    if (!m) continue;
    const ref = { libraryID: Number(m[1]), itemKey: m[2] };
    const item = getItem(ref);
    out.push({
      dir,
      name,
      ...ref,
      title: item ? paperTitle(item) : "",
      orphan: !item || item.deleted,
      ...(await dirUsage(dir)),
    });
  }
  return out.sort((a, b) => b.modified - a.modified);
}

/** Workspaces are direct children of <root>/papers. */
function insideRoot(dir: string): boolean {
  return PathUtils.parent(dir) === papersDir() && /^\d+_[A-Za-z0-9]+$/.test(PathUtils.filename(dir));
}

export async function removeWorkspace(dir: string): Promise<void> {
  if (!insideRoot(dir)) throw new Error("只能删除工作区目录内的文件夹");
  await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
}

/** Remove workspaces whose Zotero item is gone. Returns how many were removed. */
export async function cleanOrphanWorkspaces(): Promise<number> {
  let n = 0;
  for (const w of await listWorkspaces()) {
    if (!w.orphan) continue;
    await removeWorkspace(w.dir);
    n++;
  }
  return n;
}

/** Clear attachments older than `days` in every workspace. */
export async function pruneAttachments(days = 30): Promise<number> {
  const cutoff = Date.now() - days * 86400_000;
  let n = 0;
  for (const w of await listWorkspaces()) {
    const att = PathUtils.join(w.dir, "attachments");
    let children: string[] = [];
    try {
      children = await IOUtils.getChildren(att);
    } catch {
      continue;
    }
    for (const c of children) {
      const st = await IOUtils.stat(c).catch(() => null);
      if (st && st.type !== "directory" && (st.lastModified || 0) < cutoff) {
        await IOUtils.remove(c, { ignoreAbsent: true });
        n++;
      }
    }
  }
  return n;
}

/** Open a workspace folder (created if missing) in the system file manager. */
export async function revealWorkspace(dir: string): Promise<void> {
  await mkdirp(dir);
  try {
    Zotero.launchFile(dir);
  } catch {
    Zotero.File.reveal(dir);
  }
}

// ---- CLI session mapping (stored in the plugin DB) ----

const cliKey = (sessionId: string) => `cli:${sessionId}`;

export async function getCliState(sessionId: string): Promise<CliSessionState | null> {
  const raw = await store.kvGet(cliKey(sessionId));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v.nativeId === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function setCliState(sessionId: string, state: CliSessionState | null): Promise<void> {
  if (state) await store.kvSet(cliKey(sessionId), JSON.stringify(state));
  else await store.kvDelete(cliKey(sessionId));
}

// ---- Antigravity plugin ----

export const AGY_PLUGIN_NAME = "zotero-pi";

/** Write the agy plugin (MCP server pointing at the bridge's stable token); returns its directory. */
export async function writeAgyPlugin(mcpUrl: string, version: string): Promise<string> {
  const dir = PathUtils.join(workspaceRoot(), "agy-plugin", AGY_PLUGIN_NAME);
  await mkdirp(dir);
  await IOUtils.writeUTF8(
    PathUtils.join(dir, "plugin.json"),
    JSON.stringify(
      {
        $schema: "https://antigravity.google/schemas/v1/plugin.json",
        name: AGY_PLUGIN_NAME,
        version,
        description: "Zotero Pi Agent: paper, annotation and library tools served by Zotero (only active while Zotero runs an agy turn).",
      },
      null,
      2,
    ) + "\n",
  );
  await IOUtils.writeUTF8(
    PathUtils.join(dir, "mcp_config.json"),
    JSON.stringify({ mcpServers: { zotero: { serverUrl: mcpUrl, disabled: false, disabledTools: [] } } }, null, 2) + "\n",
  );
  return dir;
}
