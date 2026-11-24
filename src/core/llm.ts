import { createModels, type Model, type Api, type Context, type AssistantMessage } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getSettings } from "./config";
import { cliComplete } from "./agents/runner";
import { CLI_PROVIDERS, cliModelEntries, parseCliModelId } from "./agents/providers";

const models = createModels();
models.setProvider(deepseekProvider());

export interface ModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: string[];
  builtin: boolean;
  /** "deepseek" (pi, API key) or a CLI provider id. */
  source: string;
  /** Display group, e.g. "DeepSeek API", "Claude Code". */
  group: string;
  images: boolean;
}

export const API_SOURCE = "deepseek";

/** DeepSeek models known to pi, user-configured extra model ids, then the enabled CLI agents. */
export function listModels(): ModelInfo[] {
  const builtin = models.getModels("deepseek");
  const api = { source: API_SOURCE, group: "DeepSeek API" };
  const out: ModelInfo[] = builtin.map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: !!m.reasoning,
    thinkingLevels: thinkingLevelsOf(m),
    builtin: true,
    images: (m.input || []).includes("image"),
    ...api,
  }));
  for (const id of extraModelIds()) {
    if (!out.some((m) => m.id === id)) {
      out.push({ id, name: id, reasoning: true, thinkingLevels: ["off", "low", "high", "max"], builtin: false, images: false, ...api });
    }
  }
  const s = getSettings();
  const cli = cliModelEntries(
    { "claude-code": s.cliClaudeEnabled, codex: s.cliCodexEnabled, agy: s.cliAgyEnabled },
    { "claude-code": s.cliClaudeModels, codex: s.cliCodexModels, agy: s.cliAgyModels },
  );
  for (const e of cli) {
    const m = cliModel(e.id);
    out.push({ id: e.id, name: e.name, reasoning: true, thinkingLevels: thinkingLevelsOf(m), builtin: true, images: CLI_PROVIDERS[e.provider].supportsImages, source: e.provider, group: CLI_PROVIDERS[e.provider].label });
  }
  return out;
}

export function isCliModel(id?: string | null): boolean {
  return !!parseCliModelId(id);
}

/** A pi Model stand-in for a CLI agent (the CLI picks the real model). */
function cliModel(id: string): Model<Api> {
  const { provider, model } = parseCliModelId(id)!;
  const def = CLI_PROVIDERS[provider];
  const thinkingLevelMap: Record<string, string | null> = {};
  for (const l of ["minimal", "low", "medium", "high", "xhigh", "max"]) thinkingLevelMap[l] = def.thinkingLevels.includes(l) ? l : null;
  return {
    id,
    name: model ? `${def.label} · ${model}` : `${def.label}（默认模型）`,
    api: "cli" as any,
    provider: provider as any,
    baseUrl: "",
    reasoning: true,
    thinkingLevelMap,
    input: def.supportsImages ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 32000,
  } as any;
}

function extraModelIds(): string[] {
  return getSettings()
    .extraModels.split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function thinkingLevelsOf(m: Model<Api>): string[] {
  if (!m.reasoning) return ["off"];
  const map: Record<string, string | null> = (m as any).thinkingLevelMap || {};
  const levels = ["off"];
  for (const l of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
    if (map[l] !== null && (map[l] !== undefined || l in map)) levels.push(l);
  }
  return levels.length > 1 ? levels : ["off", "high"];
}

/** Resolve a model id to a pi Model, applying the configured base URL. */
export function getModel(id?: string): Model<Api> {
  const settings = getSettings();
  const wanted = id || settings.model;
  if (isCliModel(wanted)) return cliModel(wanted);
  let model = models.getModel("deepseek", wanted);
  if (!model) {
    // Unknown DeepSeek id (e.g. a newer model): reuse the flash definition.
    const base = models.getModel("deepseek", "deepseek-flash") || models.getModels("deepseek")[0];
    model = { ...base, id: wanted, name: wanted } as Model<Api>;
  }
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, "");
  if (baseUrl && baseUrl !== model.baseUrl) model = { ...model, baseUrl };
  return model;
}

export function clampThinking(model: Model<Api>, level: string): string {
  const levels = thinkingLevelsOf(model);
  if (levels.includes(level)) return level;
  if (level === "off") return "off";
  // pick the closest supported level
  const order = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const idx = order.indexOf(level);
  for (let d = 1; d < order.length; d++) {
    for (const j of [idx + d, idx - d]) {
      if (j >= 0 && j < order.length && levels.includes(order[j])) return order[j];
    }
  }
  return levels[levels.length - 1];
}

function requireApiKey(): string {
  const key = getSettings().apiKey.trim();
  if (!key) throw new Error("尚未配置 DeepSeek API Key，请在 Pi Agent 设置中填写。");
  return key;
}

/** streamFn for pi Agent instances: injects the API key on every request. */
export const streamFn: StreamFn = (model, context, options) =>
  models.streamSimple(model, context as any, { ...options, apiKey: requireApiKey() });

export function streamSimple(model: Model<Api>, context: Context, options: Record<string, any> = {}) {
  return models.streamSimple(model, context, { ...options, apiKey: requireApiKey() });
}

export async function completeText(
  context: Context,
  opts: { model?: string; reasoning?: string; signal?: AbortSignal; maxTokens?: number } = {},
): Promise<string> {
  const model = getModel(opts.model || getSettings().quickModel);
  const reasoning = opts.reasoning && opts.reasoning !== "off" ? clampThinking(model, opts.reasoning) : undefined;
  if (isCliModel(model.id)) return cliComplete(model.id, { ...contextToPrompt(context), reasoning, signal: opts.signal });
  const msg: AssistantMessage = await models.completeSimple(model, context, {
    apiKey: requireApiKey(),
    reasoning: reasoning as any,
    signal: opts.signal,
    maxTokens: opts.maxTokens,
  });
  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    throw new Error(msg.errorMessage || `请求失败 (${msg.stopReason})`);
  }
  return msg.content
    .filter((c) => c.type === "text")
    .map((c: any) => c.text)
    .join("");
}

/**
 * Thinking level for a model, falling back to the nearest LOWER supported level (then higher),
 * so e.g. "medium" on DeepSeek Flash (low / high / max only) runs as "low", not "high".
 */
export function pickThinking(model: Model<Api>, level: string): string | undefined {
  if (!level || level === "off") return undefined;
  const levels = thinkingLevelsOf(model);
  if (levels.includes(level)) return level;
  const order = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const idx = order.indexOf(level);
  for (let j = idx - 1; j >= 0; j--) if (levels.includes(order[j])) return order[j];
  for (let j = idx + 1; j < order.length; j++) if (levels.includes(order[j])) return order[j];
  return undefined;
}

/** Stream a completion; `onEvent` sees thinking / text progress. Returns the full text. */
export async function streamText(
  context: Context,
  opts: { model?: string; reasoning?: string; signal?: AbortSignal; maxTokens?: number },
  onEvent: (e: { type: "thinking" | "text"; text: string; thinking: string }) => void,
): Promise<string> {
  const model = getModel(opts.model || getSettings().quickModel);
  if (isCliModel(model.id)) return cliComplete(model.id, { ...contextToPrompt(context), reasoning: opts.reasoning, signal: opts.signal }, onEvent);
  const stream = models.streamSimple(model, context, {
    apiKey: requireApiKey(),
    reasoning: opts.reasoning as any,
    signal: opts.signal,
    maxTokens: opts.maxTokens,
  });
  let text = "";
  let thinking = "";
  for await (const ev of stream as any) {
    if (ev.type === "text_delta") {
      text += ev.delta;
      onEvent({ type: "text", text, thinking });
    } else if (ev.type === "thinking_delta") {
      thinking += ev.delta;
      onEvent({ type: "thinking", text, thinking });
    } else if (ev.type === "error") {
      throw new Error(ev.error?.errorMessage || "请求失败");
    }
  }
  if (opts.signal?.aborted) throw new Error("aborted");
  return text;
}

/** Flatten a pi context into one prompt (+ images) for a one-shot CLI call. */
function contextToPrompt(context: Context): { systemPrompt?: string; prompt: string; images: { data: string; mimeType: string }[] } {
  const images: { data: string; mimeType: string }[] = [];
  const parts: string[] = [];
  const multi = context.messages.length > 1;
  for (const m of context.messages as any[]) {
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else
      for (const c of m.content || []) {
        if (c.type === "text") text += (text ? "\n" : "") + c.text;
        else if (c.type === "image") images.push({ data: c.data, mimeType: c.mimeType });
      }
    if (!text) continue;
    parts.push(multi ? `${m.role === "assistant" ? "Assistant" : "User"}: ${text}` : text);
  }
  return { systemPrompt: context.systemPrompt, prompt: parts.join("\n\n"), images };
}

/** Check credentials and list models available on the account. */
export async function testConnection(): Promise<{ ok: boolean; message: string; remoteModels: string[] }> {
  const settings = getSettings();
  let remoteModels: string[] = [];
  try {
    const res = await fetch(settings.baseUrl.replace(/\/+$/, "") + "/models", {
      headers: { Authorization: `Bearer ${requireApiKey()}` },
    });
    if (!res.ok) {
      return { ok: false, message: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, remoteModels };
    }
    const data = await res.json();
    remoteModels = (data.data || []).map((m: any) => m.id);
    const text = await completeText(
      { messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: Date.now() }] },
      { model: settings.model, maxTokens: 20 },
    );
    return { ok: true, message: `连接成功，模型回复：${text.trim().slice(0, 50)}`, remoteModels };
  } catch (e: any) {
    return { ok: false, message: String(e?.message || e), remoteModels };
  }
}
