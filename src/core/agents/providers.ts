/**
 * CLI agent providers: model ids, thinking levels and the exact command lines.
 * Pure module (unit tested); spawning lives in proc.ts / runner.ts.
 *
 * Model ids: "<provider>" uses the CLI's own default model, "<provider>:<model>"
 * passes --model. Providers: claude-code (Claude Code), codex (OpenAI Codex
 * CLI), agy (Google Antigravity CLI).
 */
import { agyParser, claudeParser, codexParser, type CliParser } from "./parsers.ts";

export type CliProviderId = "claude-code" | "codex" | "agy";

export interface CliProviderDef {
  id: CliProviderId;
  label: string;
  /** Executable name looked up on PATH. */
  bin: string;
  /** Thinking levels offered in the UI (mapped to the CLI's effort flag). */
  thinkingLevels: string[];
  /** Tool results with images reach the model (else images are described by a vision model). */
  supportsImages: boolean;
  parser(): CliParser;
  install: string;
}

export const CLI_PROVIDERS: Record<CliProviderId, CliProviderDef> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    bin: "claude",
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsImages: true,
    parser: claudeParser,
    install: "npm i -g @anthropic-ai/claude-code（或 brew install claude-code），然后运行一次 claude 登录",
  },
  codex: {
    id: "codex",
    label: "Codex",
    bin: "codex",
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    supportsImages: true,
    parser: codexParser,
    install: "npm i -g @openai/codex（或 brew install codex），然后运行 codex login",
  },
  agy: {
    id: "agy",
    label: "Antigravity",
    bin: "agy",
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsImages: false,
    parser: agyParser,
    install: "安装 Antigravity CLI（agy）并登录，然后在本页安装 Zotero 工具插件",
  },
};

export const CLI_PROVIDER_IDS = Object.keys(CLI_PROVIDERS) as CliProviderId[];

export function parseCliModelId(id: string | undefined | null): { provider: CliProviderId; model: string } | null {
  if (!id) return null;
  const i = id.indexOf(":");
  const provider = (i < 0 ? id : id.slice(0, i)) as CliProviderId;
  if (!CLI_PROVIDERS[provider]) return null;
  return { provider, model: i < 0 ? "" : id.slice(i + 1).trim() };
}

export function isCliModelId(id: string | undefined | null): boolean {
  return !!parseCliModelId(id);
}

/** Map a pi thinking level to the provider's effort value (undefined = CLI default). */
export function mapEffort(provider: CliProviderId, level?: string): string | undefined {
  if (!level) return undefined;
  const levels = CLI_PROVIDERS[provider].thinkingLevels;
  if (level === "off" || level === "minimal") return levels[0];
  if (levels.includes(level)) return level;
  return levels[levels.length - 1]; // e.g. "max" on Codex → xhigh
}

export interface CliModelEntry {
  id: string;
  name: string;
  provider: CliProviderId;
  model: string;
}

/** Models offered for the enabled providers. */
export function cliModelEntries(enabled: Partial<Record<CliProviderId, boolean>>, extra: Partial<Record<CliProviderId, string>>): CliModelEntry[] {
  const out: CliModelEntry[] = [];
  for (const p of CLI_PROVIDER_IDS) {
    if (!enabled[p]) continue;
    const def = CLI_PROVIDERS[p];
    out.push({ id: p, name: `${def.label}（默认模型）`, provider: p, model: "" });
    for (const m of String(extra[p] || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)) {
      if (!out.some((e) => e.id === `${p}:${m}`)) out.push({ id: `${p}:${m}`, name: `${def.label} · ${m}`, provider: p, model: m });
    }
  }
  return out;
}

export interface CliTurnSpec {
  prompt: string;
  /** Replaces the CLI's system prompt where supported (Claude Code); otherwise inlined into fresh sessions. */
  systemPrompt?: string;
  /** Instructions are already in the workspace's AGENTS.md (Codex reads it). */
  instructionsInWorkspace?: boolean;
  model?: string;
  effort?: string;
  /** MCP bridge URL; omitted = no tools (one-shot text tasks). */
  mcpUrl?: string;
  /** Continue this CLI session / thread / conversation. */
  resumeId?: string;
  /** Claude Code: id for a new session. */
  newSessionId?: string;
  /** Inline images (Claude Code stream-json input). */
  images?: { data: string; mimeType: string }[];
  /** Image files in the workspace (Codex -i; mentioned in the prompt for agy). */
  imagePaths?: string[];
  /** Skip the CLIs' own user settings / MCP servers. */
  isolate?: boolean;
  /** agy --mode. */
  agyMode?: string;
  /** Don't persist the CLI session (one-shot tasks). */
  ephemeral?: boolean;
}

export interface CliInvocation {
  args: string[];
  /** Written to stdin, then stdin is closed. */
  stdin: string;
}

function inlineInstructions(spec: CliTurnSpec): string {
  if (!spec.systemPrompt || spec.resumeId || spec.instructionsInWorkspace) return spec.prompt;
  return `<instructions>\n${spec.systemPrompt.trim()}\n</instructions>\n\n${spec.prompt}`;
}

export function buildAgyStreamArgs(spec: Pick<CliTurnSpec, "resumeId" | "agyMode" | "model" | "effort">): string[] {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  if (spec.resumeId) args.push("--conversation", spec.resumeId);
  if (spec.agyMode === "auto") args.push("--dangerously-skip-permissions");
  else if (spec.agyMode) args.push("--mode", spec.agyMode);
  if (spec.model) args.push("--model", spec.model);
  if (spec.effort) args.push("--effort", spec.effort);
  return args;
}

export function formatAgyStreamTurn(spec: Pick<CliTurnSpec, "prompt" | "systemPrompt" | "resumeId" | "instructionsInWorkspace" | "imagePaths">): string {
  let prompt = inlineInstructions(spec as CliTurnSpec);
  if (spec.imagePaths?.length) prompt += `\n\n(Attached image files: ${spec.imagePaths.join(", ")})`;
  return JSON.stringify({ event: "user", message: { content: prompt } }) + "\n";
}

export function buildInvocation(provider: CliProviderId, spec: CliTurnSpec): CliInvocation {
  switch (provider) {
    case "claude-code": {
      const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--strict-mcp-config", "--tools", ""];
      if (spec.mcpUrl) {
        args.push(
          "--mcp-config",
          JSON.stringify({ mcpServers: { zotero: { type: "http", url: spec.mcpUrl } } }),
          "--allowedTools",
          "mcp__zotero",
          "--permission-mode",
          "dontAsk",
        );
      }
      if (spec.systemPrompt) args.push("--system-prompt", spec.systemPrompt);
      if (spec.isolate) args.push("--setting-sources", "");
      if (spec.model) args.push("--model", spec.model);
      if (spec.effort) args.push("--effort", spec.effort);
      if (spec.ephemeral) args.push("--no-session-persistence");
      else if (spec.resumeId) args.push("--resume", spec.resumeId);
      else if (spec.newSessionId) args.push("--session-id", spec.newSessionId);
      const content: any[] = [{ type: "text", text: spec.prompt }];
      for (const img of spec.images || []) content.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } });
      const msg = { type: "user", message: { role: "user", content } };
      return { args, stdin: JSON.stringify(msg) + "\n" };
    }
    case "codex": {
      const args = ["exec"];
      if (spec.resumeId) args.push("resume");
      // -i takes several values: keep it before the other flags and the "-" prompt marker
      for (const p of spec.imagePaths || []) args.push("-i", p);
      args.push("--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"');
      if (spec.mcpUrl) {
        args.push("-c", `mcp_servers.zotero.url=${JSON.stringify(spec.mcpUrl)}`, "-c", 'mcp_servers.zotero.default_tools_approval_mode="approve"');
      }
      if (spec.isolate) args.push("--ignore-user-config");
      if (spec.model) args.push("-m", spec.model);
      if (spec.effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(spec.effort)}`);
      if (spec.ephemeral) args.push("--ephemeral");
      if (spec.resumeId) args.push(spec.resumeId);
      args.push("-");
      return { args, stdin: inlineInstructions(spec) };
    }
    case "agy": {
      const args = ["--output-format", "stream-json"];
      if (spec.resumeId) args.push("--conversation", spec.resumeId);
      if (spec.agyMode === "auto") args.push("--dangerously-skip-permissions");
      else if (spec.agyMode) args.push("--mode", spec.agyMode);
      if (spec.model) args.push("--model", spec.model);
      if (spec.effort) args.push("--effort", spec.effort);
      let prompt = inlineInstructions(spec);
      if (spec.imagePaths?.length) prompt += `\n\n(Attached image files: ${spec.imagePaths.join(", ")})`;
      // "-p=<prompt>": a prompt starting with "-" must not be taken for a flag
      args.push(`-p=${prompt}`);
      return { args, stdin: "" };
    }
  }
}
