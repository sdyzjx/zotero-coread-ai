/**
 * Tool bridge for CLI agents: serves the plugin's pi tools as an MCP server on
 * Zotero's local HTTP server (127.0.0.1:<httpServer.port>), so Claude Code,
 * Codex and Antigravity call exactly the same tools the built-in agent uses.
 *
 * Every CLI turn opens a "run" with a random token: POST /zoteropi/mcp/<token>.
 * Antigravity only reads MCP servers from its global config, so its plugin
 * points at one stable token that resolves to whichever agy run is active
 * (agy runs are serialized by the CLI engine).
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { getPref, setPref } from "../config";
import type { Tool } from "../tools/common";
import { handleMcpPost, normalizeInputSchema, type McpCallResult, type McpServerImpl, type McpToolDef } from "./protocol";

const PATH = "/zoteropi/mcp/:token";
export const MCP_SERVER_NAME = "zotero";

export interface ToolCallInfo {
  id: string;
  name: string;
  args: any;
}

export interface BridgeRun {
  tools: Tool[];
  signal?: AbortSignal;
  onToolStart?(call: ToolCallInfo): void;
  onToolEnd?(call: ToolCallInfo, result: AgentToolResult<any>, isError: boolean): void;
}

interface RunState extends BridgeRun {
  chain: Promise<unknown>;
  seq: number;
}

const runs = new Map<string, RunState>();
let agyRun: RunState | null = null;

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function serverPort(): number {
  return Number(Zotero.Prefs.get("httpServer.port")) || 23119;
}

export function mcpUrl(token: string): string {
  return `http://127.0.0.1:${serverPort()}/zoteropi/mcp/${token}`;
}

/** Stable token baked into the Antigravity plugin's MCP config. */
export function agyToken(): string {
  let t = getPref<string>("agyBridgeToken");
  if (!t || !/^agy-[0-9a-f]{32}$/.test(t)) {
    t = `agy-${randomToken()}`;
    setPref("agyBridgeToken", t);
  }
  return t;
}

export function openRun(run: BridgeRun): { token: string; url: string; close(): void } {
  const token = randomToken();
  runs.set(token, { ...run, chain: Promise.resolve(), seq: 0 });
  return { token, url: mcpUrl(token), close: () => void runs.delete(token) };
}

/** Route the agy plugin's stable endpoint to this run (null when the run ends). */
export function setAgyRun(run: BridgeRun | null): void {
  agyRun = run ? { ...run, chain: Promise.resolve(), seq: 0 } : null;
}

function resolveRun(token: string): RunState | null {
  if (token && token === getPref<string>("agyBridgeToken")) return agyRun;
  return runs.get(token) || null;
}

function toMcpTool(t: Tool): McpToolDef {
  return { name: t.name, title: t.label, description: t.description, inputSchema: normalizeInputSchema(t.parameters) };
}

function toMcpResult(r: AgentToolResult<any>, isError: boolean): McpCallResult {
  const content = (r?.content || []).map((c: any) =>
    c.type === "image" ? { type: "image" as const, data: c.data, mimeType: c.mimeType } : { type: "text" as const, text: String(c.text ?? "") },
  );
  return { content: content.length ? content : [{ type: "text", text: "(no output)" }], ...(isError ? { isError: true } : {}) };
}

/** MCP server for one run; exported for tests. */
export function serverFor(run: RunState | null): McpServerImpl {
  return {
    name: MCP_SERVER_NAME,
    version: String(__PLUGIN_VERSION__),
    instructions: "Tools of the Zotero Pi reading assistant: the current paper, its annotations, the Zotero library, vision, web and academic search.",
    listTools: () => (run ? run.tools.map(toMcpTool) : []),
    async callTool(name, args, meta) {
      if (!run) throw new Error("No active Zotero Pi session for this agent.");
      const tool = run.tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const id = String((meta as any).toolUseId || `mcp_${Date.now().toString(36)}_${++run.seq}`);
      const call: ToolCallInfo = { id, name, args };
      const exec = async (): Promise<McpCallResult> => {
        run.onToolStart?.(call);
        let result: AgentToolResult<any>;
        let isError = false;
        try {
          if (run.signal?.aborted) throw new Error("aborted");
          const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
          const params = validateToolArguments(tool as any, { type: "toolCall", id, name, arguments: prepared } as any);
          result = await tool.execute(id, params, run.signal);
          isError = !!(result as any)?.isError;
        } catch (e: any) {
          isError = true;
          result = { content: [{ type: "text", text: `Error: ${e?.message || e}` }], details: { error: true } };
        }
        run.onToolEnd?.(call, result, isError);
        return toMcpResult(result, isError);
      };
      if (tool.executionMode === "sequential") {
        const next = run.chain.then(exec, exec);
        run.chain = next.catch(() => undefined);
        return next;
      }
      return exec();
    },
  };
}

export function registerMcpEndpoint(): void {
  const Endpoint: any = function () {};
  Endpoint.prototype = {
    supportedMethods: ["GET", "POST", "DELETE"],
    supportedDataTypes: "*",
    permitBookmarklet: false,
    init: async function (req: any) {
      const run = resolveRun(String(req.pathParams?.token || ""));
      const isAgy = req.pathParams?.token === getPref<string>("agyBridgeToken");
      if (!run && !isAgy) return [404, "text/plain", "Unknown or expired MCP session\n"];
      // Stateless server: no server-initiated SSE stream, nothing to terminate.
      if (req.method === "GET") return [405, { "Content-Type": "text/plain", Allow: "POST" }, "SSE stream not supported\n"];
      if (req.method === "DELETE") return [200, "text/plain", ""];
      const body = req.data;
      const toolUseId = body?.params?._meta?.["claudecode/toolUseId"] || body?.params?._meta?.callId;
      const impl = serverFor(run);
      const wrapped: McpServerImpl = toolUseId
        ? { ...impl, callTool: (n, a, m) => impl.callTool(n, a, { ...m, toolUseId } as any) }
        : impl;
      const res = await handleMcpPost(body, wrapped);
      if (res.body === null) return [202, "text/plain", ""];
      return [res.status, "application/json", JSON.stringify(res.body)];
    },
  };
  Zotero.Server.Endpoints[PATH] = Endpoint;
}

export function unregisterMcpEndpoint(): void {
  delete Zotero.Server.Endpoints[PATH];
  runs.clear();
  agyRun = null;
}
