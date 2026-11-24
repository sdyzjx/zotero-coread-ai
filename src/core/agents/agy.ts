/**
 * Antigravity reads MCP servers only from its global config, so the Zotero
 * tools reach agy through a small agy plugin ("zotero-pi") whose MCP server
 * points at the bridge's stable agy endpoint. Installing it changes the user's
 * agy setup, so it only happens from the settings page on request.
 */
import { agyToken, mcpUrl } from "../mcp/bridge";
import { runCapture } from "./proc";
import { executableFor } from "./runner";
import { AGY_PLUGIN_NAME, writeAgyPlugin } from "./workspace";

export interface AgyPluginStatus {
  installed: boolean;
  enabled: boolean;
  message: string;
}

export async function agyPluginStatus(): Promise<AgyPluginStatus> {
  const agy = await executableFor("agy");
  const r = await runCapture(agy, ["plugin", "list", "--json"]);
  let entry: any = null;
  try {
    const data = JSON.parse(r.stdout);
    const list: any[] = Array.isArray(data) ? data : data.plugins || [];
    entry = list.find((p) => p?.name === AGY_PLUGIN_NAME) || null;
  } catch {
    // older agy without --json: fall back to the text listing
    if (r.stdout.includes(`- ${AGY_PLUGIN_NAME} `)) entry = { name: AGY_PLUGIN_NAME, enabled: r.stdout.includes(`${AGY_PLUGIN_NAME} (enabled)`) };
  }
  if (!entry) return { installed: false, enabled: false, message: "未安装 Zotero 工具插件" };
  const enabled = entry.enabled !== false && entry.status !== "disabled";
  return { installed: true, enabled, message: enabled ? "已安装并启用" : "已安装，但被禁用" };
}

export async function installAgyPlugin(version: string): Promise<string> {
  const agy = await executableFor("agy");
  const dir = await writeAgyPlugin(mcpUrl(agyToken()), version);
  let r = await runCapture(agy, ["plugin", "install", dir], 60000);
  if (r.code !== 0 && /already|exists/i.test(r.stdout + r.stderr)) {
    await runCapture(agy, ["plugin", "uninstall", AGY_PLUGIN_NAME], 30000);
    r = await runCapture(agy, ["plugin", "install", dir], 60000);
  }
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 400) || `agy plugin install 失败（代码 ${r.code}）`);
  await runCapture(agy, ["plugin", "enable", AGY_PLUGIN_NAME], 30000).catch(() => undefined);
  return (r.stdout || "已安装").trim().split("\n").slice(-2).join("\n");
}

export async function uninstallAgyPlugin(): Promise<void> {
  const agy = await executableFor("agy");
  const r = await runCapture(agy, ["plugin", "uninstall", AGY_PLUGIN_NAME], 30000);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 400) || `agy plugin uninstall 失败（代码 ${r.code}）`);
}
