/**
 * Minimal MCP (Model Context Protocol) server core: stateless JSON-RPC over the
 * "streamable HTTP" transport, answering with plain JSON (no SSE). Pure module —
 * no Zotero globals — so it can be unit tested under Node and reused by the
 * Zotero HTTP endpoint that lets CLI agents (Claude Code, Codex, agy) call the
 * plugin's tools.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export interface McpToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, any>;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpServerImpl {
  name: string;
  version: string;
  instructions?: string;
  listTools(): McpToolDef[];
  callTool(name: string, args: Record<string, any>, meta: { requestId: string | number }): Promise<McpCallResult>;
}

export interface McpHttpResponse {
  status: number;
  /** JSON body, or null for 202 Accepted (notifications only). */
  body: any | null;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function rpcError(id: any, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function rpcResult(id: any, result: any) {
  return { jsonrpc: "2.0", id, result };
}

/** Make a JSON Schema safe for MCP clients: plain JSON, object root. */
export function normalizeInputSchema(schema: any): Record<string, any> {
  const plain = schema ? JSON.parse(JSON.stringify(schema)) : {};
  if (plain.type !== "object") return { type: "object", properties: {} };
  if (!plain.properties) plain.properties = {};
  return plain;
}

async function handleOne(msg: any, impl: McpServerImpl): Promise<any | null> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id, INVALID_REQUEST, "Invalid JSON-RPC request");
  }
  const req = msg as JsonRpcRequest;
  const isNotification = req.id === undefined || req.id === null;
  if (isNotification) return null; // notifications/initialized, cancelled, …: nothing to answer
  const id = req.id as string | number;
  try {
    switch (req.method) {
      case "initialize": {
        const wanted = req.params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(wanted) ? wanted : LATEST_PROTOCOL_VERSION;
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: impl.name, version: impl.version },
          ...(impl.instructions ? { instructions: impl.instructions } : {}),
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: impl.listTools() });
      case "tools/call": {
        const name = req.params?.name;
        if (typeof name !== "string") return rpcError(id, INVALID_PARAMS, "tools/call needs a tool name");
        if (!impl.listTools().some((t) => t.name === name)) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
        const args = req.params?.arguments && typeof req.params.arguments === "object" ? req.params.arguments : {};
        try {
          return rpcResult(id, await impl.callTool(name, args, { requestId: id }));
        } catch (e: any) {
          // Tool failures are results the model should see, not protocol errors.
          return rpcResult(id, { content: [{ type: "text", text: `Error: ${e?.message || e}` }], isError: true });
        }
      }
      case "resources/list":
        return rpcResult(id, { resources: [] });
      case "resources/templates/list":
        return rpcResult(id, { resourceTemplates: [] });
      case "prompts/list":
        return rpcResult(id, { prompts: [] });
      case "logging/setLevel":
        return rpcResult(id, {});
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${req.method}`);
    }
  } catch (e: any) {
    return rpcError(id, INTERNAL_ERROR, String(e?.message || e));
  }
}

/** Handle one HTTP POST body (already parsed JSON, or a raw string). */
export async function handleMcpPost(body: any, impl: McpServerImpl): Promise<McpHttpResponse> {
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return { status: 400, body: rpcError(null, PARSE_ERROR, "Parse error") };
    }
  }
  if (Array.isArray(parsed)) {
    if (!parsed.length) return { status: 400, body: rpcError(null, INVALID_REQUEST, "Empty batch") };
    const out = (await Promise.all(parsed.map((m) => handleOne(m, impl)))).filter((r) => r !== null);
    return out.length ? { status: 200, body: out } : { status: 202, body: null };
  }
  const res = await handleOne(parsed, impl);
  return res === null ? { status: 202, body: null } : { status: 200, body: res };
}
