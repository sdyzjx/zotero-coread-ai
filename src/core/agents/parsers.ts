/**
 * Line parsers for the JSONL streams of the supported CLI agents, normalized to
 * one small event vocabulary. Pure (no Zotero globals) and unit tested against
 * recorded CLI output in test/fixtures.
 *
 * Calls to the plugin's own MCP server ("zotero") are skipped here: the MCP
 * bridge executes those and reports them with full results, identically for
 * every CLI.
 */

export type CliEvent =
  | { type: "session"; id: string }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; id: string; name: string; args: any }
  | { type: "tool_end"; id: string; name: string; output: string; isError: boolean }
  | { type: "notice"; message: string }
  | { type: "done"; ok: boolean; error?: string };

export interface CliParser {
  /** Feed one stdout line; returns the events it produced. */
  line(line: string): CliEvent[];
}

const OWN_SERVER = "zotero";

function parseJson(line: string): any {
  const t = line.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => (c?.type === "text" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Claude Code: claude -p --output-format stream-json --verbose --include-partial-messages

export function claudeParser(): CliParser {
  const streamed = new Set<string>(); // message ids that arrived as partial deltas
  let currentMsg = "";
  const nativeTools = new Map<string, string>();
  return {
    line(line) {
      const d = parseJson(line);
      if (!d) return [];
      const out: CliEvent[] = [];
      switch (d.type) {
        case "system":
          if (d.subtype === "init" && d.session_id) out.push({ type: "session", id: String(d.session_id) });
          break;
        case "stream_event": {
          const e = d.event || {};
          if (e.type === "message_start") {
            currentMsg = e.message?.id || "";
            if (currentMsg) streamed.add(currentMsg);
          } else if (e.type === "content_block_delta") {
            if (e.delta?.type === "text_delta" && e.delta.text) out.push({ type: "text", delta: e.delta.text });
            else if (e.delta?.type === "thinking_delta" && e.delta.thinking) out.push({ type: "thinking", delta: e.delta.thinking });
          }
          break;
        }
        case "assistant": {
          const msg = d.message || {};
          const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
          const hadDeltas = msg.id && streamed.has(msg.id);
          for (const b of blocks) {
            if (!hadDeltas && b.type === "text" && b.text) out.push({ type: "text", delta: b.text });
            if (!hadDeltas && b.type === "thinking" && b.thinking) out.push({ type: "thinking", delta: b.thinking });
            if (b.type === "tool_use" && typeof b.name === "string" && !b.name.startsWith(`mcp__${OWN_SERVER}__`)) {
              nativeTools.set(b.id, b.name);
              out.push({ type: "tool_start", id: b.id, name: b.name, args: b.input || {} });
            }
          }
          break;
        }
        case "user": {
          const blocks: any[] = Array.isArray(d.message?.content) ? d.message.content : [];
          for (const b of blocks) {
            if (b.type === "tool_result" && nativeTools.has(b.tool_use_id)) {
              out.push({ type: "tool_end", id: b.tool_use_id, name: nativeTools.get(b.tool_use_id)!, output: textOf(b.content), isError: !!b.is_error });
              nativeTools.delete(b.tool_use_id);
            }
          }
          break;
        }
        case "result": {
          const ok = d.subtype === "success" && !d.is_error;
          const err = ok ? undefined : String(d.result || (Array.isArray(d.errors) ? d.errors.join("; ") : "") || d.subtype || "Claude Code 运行失败");
          out.push({ type: "done", ok, ...(err ? { error: err } : {}) });
          break;
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Codex: codex exec --json

export function codexParser(): CliParser {
  let wroteText = false;
  let lastError = "";
  return {
    line(line) {
      const d = parseJson(line);
      if (!d) return [];
      const out: CliEvent[] = [];
      const item = d.item || {};
      switch (d.type) {
        case "thread.started":
          if (d.thread_id) out.push({ type: "session", id: String(d.thread_id) });
          break;
        case "item.started":
        case "item.completed": {
          const done = d.type === "item.completed";
          if (item.type === "agent_message" && done && item.text) {
            out.push({ type: "text", delta: (wroteText ? "\n\n" : "") + item.text });
            wroteText = true;
          } else if (item.type === "reasoning" && done && item.text) {
            out.push({ type: "thinking", delta: item.text + "\n" });
          } else if (item.type === "command_execution") {
            if (!done) out.push({ type: "tool_start", id: item.id, name: "shell", args: { command: item.command } });
            else
              out.push({
                type: "tool_end",
                id: item.id,
                name: "shell",
                output: String(item.aggregated_output ?? ""),
                isError: typeof item.exit_code === "number" ? item.exit_code !== 0 : item.status === "failed",
              });
          } else if (item.type === "mcp_tool_call" && item.server !== OWN_SERVER) {
            const name = `${item.server}.${item.tool}`;
            if (!done) out.push({ type: "tool_start", id: item.id, name, args: item.arguments || {} });
            else out.push({ type: "tool_end", id: item.id, name, output: item.error ? String(item.error?.message || item.error) : textOf(item.result?.content), isError: !!item.error });
          } else if (item.type === "web_search") {
            if (!done) out.push({ type: "tool_start", id: item.id, name: "web_search", args: { query: item.query } });
            else out.push({ type: "tool_end", id: item.id, name: "web_search", output: "", isError: false });
          }
          // "error" items are config warnings; todo_list / file_change are not relevant here.
          break;
        }
        case "error":
          lastError = String(d.message || "");
          break;
        case "turn.completed":
          out.push({ type: "done", ok: true });
          break;
        case "turn.failed":
          out.push({ type: "done", ok: false, error: String(d.error?.message || lastError || "Codex 运行失败") });
          break;
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Antigravity: agy -p --output-format stream-json

export function agyParser(): CliParser {
  let lastTextStep = -1;
  let wroteText = false;
  return {
    line(line) {
      const d = parseJson(line);
      if (!d) return [];
      const out: CliEvent[] = [];
      switch (d.event) {
        case "init":
          if (d.conversation_id) out.push({ type: "session", id: String(d.conversation_id) });
          break;
        case "step_update": {
          const s = d.step_update || {};
          if (s.thinking_delta) out.push({ type: "thinking", delta: String(s.thinking_delta) });
          if (s.step_type === "agent_response" && s.text_delta) {
            const sep = wroteText && s.step_index !== lastTextStep ? "\n\n" : "";
            lastTextStep = s.step_index;
            wroteText = true;
            out.push({ type: "text", delta: sep + String(s.text_delta) });
          }
          break;
        }
        case "error":
          out.push({ type: "notice", message: String(d.error?.message || d.message || "agy error") });
          break;
        case "result": {
          const r = d.result || {};
          const ok = String(r.status || "").toUpperCase() === "SUCCESS";
          out.push({ type: "done", ok, ...(ok ? {} : { error: String(r.error || r.response || r.status || "agy 运行失败") }) });
          break;
        }
      }
      return out;
    },
  };
}

/** Split a growing stdout buffer into complete lines. */
export class LineSplitter {
  private buf = "";
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split(/\r?\n/);
    this.buf = parts.pop() || "";
    return parts;
  }
  flush(): string[] {
    const rest = this.buf;
    this.buf = "";
    return rest.trim() ? [rest] : [];
  }
}
