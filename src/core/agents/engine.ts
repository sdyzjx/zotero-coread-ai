/**
 * CliAgentEngine: drives a chat session with a CLI agent (Claude Code, Codex,
 * Antigravity) behind the same surface SessionRuntime uses on pi's Agent —
 * `state`, `subscribe()` with pi-style events, `prompt()`, `followUp()`,
 * `continue()`, `abort()` — and produces pi-format messages, so the chat UI,
 * persistence and conclusions work unchanged.
 *
 * Tool calls are reported by the MCP bridge (which executes them), so the
 * transcript shows the same tool cards whichever CLI is used. The CLI keeps
 * its own conversation (resumed by id); when a session switches source, the
 * part of the transcript the CLI hasn't seen is passed along as context.
 */
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { getSettings } from "../config";
import { agyToken, mcpUrl, openRun, setAgyRun, type BridgeRun, type ToolCallInfo } from "../mcp/bridge";
import type { PaperRef } from "../paper";
import type { Tool } from "../tools/common";
import { agyPluginStatus } from "./agy";
import { CLI_PROVIDERS, mapEffort, parseCliModelId, type CliTurnSpec } from "./providers";
import { runCliTurn } from "./runner";
import { ensurePaperWorkspace, getCliState, saveAttachment, setCliState } from "./workspace";

type Listener = (e: AgentEvent) => void;

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export const CLI_TOOL_NOTE = `

# Tools in this environment
You run inside a command-line agent connected to Zotero. The tools named in this prompt are served by the MCP server "zotero" (depending on the agent they appear as mcp__zotero__<name> or zotero.<name>); use them for everything about the paper, its annotations and the library. Your working directory is only a scratch workspace for this paper: do not look for the PDF on disk or use shell / file tools to read it.`;

function userText(m: any): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return (m.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

function userImages(m: any): ImageContent[] {
  return typeof m?.content === "string" ? [] : (m?.content || []).filter((c: any) => c.type === "image");
}

/** Compact text transcript for handing earlier turns to a CLI session that hasn't seen them. */
export function transcriptForContext(messages: any[], maxChars = 16000): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const t = userText(m).trim();
      if (t) lines.push(`User: ${t}`);
    } else if (m.role === "assistant") {
      const parts: string[] = [];
      for (const c of m.content || []) {
        if (c.type === "text" && c.text.trim()) parts.push(c.text.trim());
        else if (c.type === "toolCall") parts.push(`[called ${c.name}(${JSON.stringify(c.arguments || {}).slice(0, 160)})]`);
      }
      if (parts.length) lines.push(`Assistant: ${parts.join("\n")}`);
    }
  }
  let text = lines.join("\n\n");
  if (text.length > maxChars) text = "…" + text.slice(-maxChars);
  return text;
}

export class CliAgentEngine {
  readonly state: {
    systemPrompt: string;
    model: any;
    thinkingLevel: string;
    tools: Tool[];
    messages: any[];
    isStreaming: boolean;
    streamingMessage: any | null;
    pendingToolCalls: Set<string>;
  };
  private listeners = new Set<Listener>();
  private queue: any[] = [];
  private ctrl: AbortController | null = null;
  private running: Promise<void> | null = null;
  private static agyChecked = false;

  constructor(
    private readonly sessionId: string,
    private readonly paper: PaperRef,
    init: { systemPrompt: string; model: any; thinkingLevel: string; tools: Tool[]; messages: any[] },
  ) {
    this.state = { ...init, isStreaming: false, streamingMessage: null, pendingToolCalls: new Set() };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: any): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e as AgentEvent);
      } catch (err) {
        Zotero.logError(err);
      }
    }
  }

  async prompt(text: string, images: ImageContent[] = []): Promise<void> {
    const msg = { role: "user", content: images.length ? [{ type: "text", text }, ...images] : text, timestamp: Date.now() };
    if (this.state.isStreaming) {
      this.queue.push(msg);
      return;
    }
    await this.start(msg, true);
  }

  followUp(msg: any): void {
    if (this.state.isStreaming) this.queue.push(msg);
    else void this.start(msg, true);
  }

  /** Re-run the last user message (after a failed / aborted reply was dropped). */
  async continue(): Promise<void> {
    if (this.state.isStreaming) return;
    const last = [...this.state.messages].reverse().find((m) => m.role === "user");
    if (!last) return;
    await this.start(last, false);
  }

  abort(): void {
    this.queue = [];
    this.ctrl?.abort();
  }

  private async start(userMsg: any, append: boolean): Promise<void> {
    this.running = this.turn(userMsg, append);
    await this.running;
    this.running = null;
    const next = this.queue.shift();
    if (next) await this.start(next, true);
  }

  private newAssistant(): any {
    return {
      role: "assistant",
      content: [],
      api: "cli",
      provider: parseCliModelId(this.state.model.id)?.provider || "cli",
      model: this.state.model.id,
      usage: { ...ZERO_USAGE },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  private async turn(userMsg: any, append: boolean): Promise<void> {
    const st = this.state;
    const parsed = parseCliModelId(st.model.id);
    if (!parsed) throw new Error(`不是 CLI 模型：${st.model.id}`);
    const { provider, model } = parsed;
    const settings = getSettings();
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    st.isStreaming = true;
    this.emit({ type: "agent_start" });
    if (append) {
      st.messages = [...st.messages, userMsg];
      this.emit({ type: "message_start", message: userMsg });
      this.emit({ type: "message_end", message: userMsg });
    }
    const userIndex = st.messages.lastIndexOf(userMsg);

    let cur = this.newAssistant();
    st.streamingMessage = cur;
    this.emit({ type: "message_start", message: cur });
    const results = new Map<string, any>();
    const update = () => this.emit({ type: "message_update", message: cur });
    const pushMessage = (m: any) => {
      st.messages = [...st.messages, m];
      this.emit({ type: "message_end", message: m });
    };
    /** Close the current assistant message (and its finished tool results) and open a new one. */
    const flush = (final: boolean) => {
      const calls = cur.content.filter((c: any) => c.type === "toolCall");
      if (cur.content.length) {
        if (calls.length) cur.stopReason = "toolUse";
        pushMessage(cur);
        for (const c of calls) {
          const r = results.get(c.id);
          if (r) {
            pushMessage(r);
            results.delete(c.id);
          }
        }
        this.emit({ type: "turn_end", message: cur, toolResults: [] });
      }
      cur = this.newAssistant();
      st.streamingMessage = final ? null : cur;
      if (!final) this.emit({ type: "message_start", message: cur });
    };
    const appendBlock = (type: "text" | "thinking", delta: string) => {
      if (!delta) return;
      if (cur.content.some((c: any) => c.type === "toolCall")) flush(false);
      // a new message never starts with the paragraph break a parser put between messages
      if (!cur.content.length) delta = delta.replace(/^\s+/, "");
      if (!delta) return;
      const last = cur.content[cur.content.length - 1];
      if (last && last.type === type) {
        if (type === "text") last.text += delta;
        else last.thinking += delta;
      } else {
        cur.content.push(type === "text" ? { type: "text", text: delta } : { type: "thinking", thinking: delta });
      }
      update();
    };
    const toolStart = (call: ToolCallInfo) => {
      cur.content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.args || {} });
      st.pendingToolCalls.add(call.id);
      this.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args });
      update();
    };
    const toolEnd = (call: ToolCallInfo, content: any[], details: any, isError: boolean) => {
      st.pendingToolCalls.delete(call.id);
      results.set(call.id, { role: "toolResult", toolCallId: call.id, toolName: call.name, content, details, isError, timestamp: Date.now() });
      this.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: { content, details }, isError });
      // Once every call of this assistant message has its result, commit them so the cards show results.
      const calls = cur.content.filter((c: any) => c.type === "toolCall");
      if (calls.length && calls.every((c: any) => results.has(c.id))) flush(false);
      else update();
    };

    const bridge: BridgeRun = {
      tools: st.tools,
      signal: ctrl.signal,
      onToolStart: toolStart,
      onToolEnd: (call, r, isError) => toolEnd(call, r.content || [], r.details ?? {}, isError),
    };

    let error: string | undefined;
    let aborted = false;
    let resumedFrom: string | undefined;
    let nativeId: string | undefined;
    try {
      const dir = await ensurePaperWorkspace(this.paper, st.systemPrompt + CLI_TOOL_NOTE);
      const saved = await getCliState(this.sessionId);
      const resume = saved && saved.provider === provider ? saved : null;
      resumedFrom = resume?.nativeId;
      // Earlier turns the CLI session hasn't seen (new session, or turns answered by another source)
      const unseen = st.messages.slice(resume ? Math.min(resume.synced, userIndex) : 0, userIndex);
      const context = transcriptForContext(unseen);
      let prompt = userText(userMsg).trim() || "请看这张图。";
      if (context) prompt = `<conversation_so_far>\n${context}\n</conversation_so_far>\n\n${prompt}`;
      const images = userImages(userMsg);
      const spec: CliTurnSpec = {
        prompt,
        systemPrompt: st.systemPrompt + CLI_TOOL_NOTE,
        instructionsInWorkspace: provider === "codex",
        model,
        effort: mapEffort(provider, st.thinkingLevel),
        resumeId: resume?.nativeId,
        newSessionId: provider === "claude-code" && !resume ? crypto.randomUUID() : undefined,
        isolate: settings.cliIsolateConfig,
        agyMode: settings.cliAgyMode || undefined,
      };
      if (images.length) {
        if (provider === "claude-code") spec.images = images;
        else spec.imagePaths = await Promise.all(images.map((img) => saveAttachment(dir, img)));
      }

      let close: (() => void) | null = null;
      if (provider === "agy") {
        if (!CliAgentEngine.agyChecked) {
          const status = await agyPluginStatus().catch(() => null);
          if (status && !status.installed) throw new Error("Antigravity 还没有安装 Zotero 工具插件：请在 CoRead AI 设置 →「模型来源」中点「安装插件」。");
          CliAgentEngine.agyChecked = !!status?.installed;
        }
        spec.mcpUrl = mcpUrl(agyToken());
      } else {
        const run = openRun(bridge);
        spec.mcpUrl = run.url;
        close = run.close;
      }

      const r = await runCliTurn(provider, spec, {
        cwd: dir,
        signal: ctrl.signal,
        beforeStart: () => provider === "agy" && setAgyRun(bridge),
        afterEnd: () => {
          if (provider === "agy") setAgyRun(null);
          close?.();
        },
        onEvent: (e) => {
          if (e.type === "text") appendBlock("text", e.delta);
          else if (e.type === "thinking") appendBlock("thinking", e.delta);
          else if (e.type === "tool_start") toolStart({ id: e.id, name: e.name, args: e.args });
          else if (e.type === "tool_end") toolEnd({ id: e.id, name: e.name, args: {} }, [{ type: "text", text: e.output || "(no output)" }], { native: true }, e.isError);
        },
      });
      aborted = r.aborted;
      if (!r.ok && !r.aborted) error = r.error || `${CLI_PROVIDERS[provider].label} 运行失败`;
      if (r.ok && r.sessionId) nativeId = r.sessionId;
      else if (error && resumedFrom && !r.text) {
        // The CLI may have lost that session: start fresh (with the transcript as context) next time.
        await setCliState(this.sessionId, null);
      }
    } catch (e: any) {
      error = String(e?.message || e);
    } finally {
      this.ctrl = null;
    }

    // Tool calls that never reported back
    for (const id of [...st.pendingToolCalls]) {
      const call = cur.content.find((c: any) => c.type === "toolCall" && c.id === id);
      if (call) results.set(id, { role: "toolResult", toolCallId: id, toolName: call.name, content: [{ type: "text", text: aborted ? "aborted" : "no result" }], details: {}, isError: true, timestamp: Date.now() });
      st.pendingToolCalls.delete(id);
    }
    if (aborted || error) {
      // keep partial text in the failed message; tool calls go into their own message first
      if (cur.content.some((c: any) => c.type === "toolCall")) flush(false);
      cur.stopReason = aborted ? "aborted" : "error";
      if (error) cur.errorMessage = error;
    }
    if (cur.content.length || cur.stopReason !== "stop") {
      const final = cur;
      pushMessage(final);
      for (const c of final.content.filter((x: any) => x.type === "toolCall")) {
        const r = results.get(c.id);
        if (r) pushMessage(r);
      }
      this.emit({ type: "turn_end", message: final, toolResults: [] });
    }
    if (nativeId) {
      await setCliState(this.sessionId, { provider, nativeId, synced: st.messages.length }).catch((e) => Zotero.logError(e));
    }
    st.streamingMessage = null;
    st.isStreaming = false;
    this.emit({ type: "agent_end", messages: st.messages });
  }

  /** Wait for the running turn (used before swapping engines). */
  async idle(): Promise<void> {
    await this.running;
  }
}
