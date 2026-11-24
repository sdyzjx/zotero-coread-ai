/**
 * Run one CLI agent turn: resolve the executable, spawn it with the command line
 * from providers.ts, parse its JSONL stream and report normalized events.
 * Also provides one-shot text completion (translation, conclusions, outline,
 * image description) through a CLI.
 */
import { getSettings } from "../config";
import { LineSplitter, type CliEvent } from "./parsers";
import { buildAgyStreamArgs, buildInvocation, CLI_PROVIDERS, formatAgyStreamTurn, mapEffort, parseCliModelId, type CliProviderId, type CliTurnSpec } from "./providers";
import { resolveExecutable, runCapture, spawn, spawnInteractive, type InteractiveProcess } from "./proc";
import { saveAttachment, workspaceRoot } from "./workspace";

export interface CliRunResult {
  ok: boolean;
  aborted: boolean;
  sessionId?: string;
  error?: string;
  text: string;
}

const PATH_PREF: Record<CliProviderId, "cliClaudePath" | "cliCodexPath" | "cliAgyPath"> = {
  "claude-code": "cliClaudePath",
  codex: "cliCodexPath",
  agy: "cliAgyPath",
};

export function executableFor(provider: CliProviderId): Promise<string> {
  return resolveExecutable(CLI_PROVIDERS[provider].bin, getSettings()[PATH_PREF[provider]]);
}

/** agy routes its MCP traffic through one stable endpoint: one agy turn at a time. */
let agyChain: Promise<unknown> = Promise.resolve();

const AGY_IDLE_TTL_MS = 10 * 60 * 1000;

interface PersistentAgy {
  configKey: string;
  conversationId?: string;
  child: InteractiveProcess;
  splitter: LineSplitter;
  active: {
    onLine: (line: string) => void;
    onExit: (code: number) => void;
  } | null;
  dead: boolean;
  idleTimer: any;
}

let persistentAgy: PersistentAgy | null = null;

function disposePersistentAgy(target?: PersistentAgy | null): void {
  const w = target === undefined ? persistentAgy : target;
  if (!w) return;
  if (persistentAgy === w) persistentAgy = null;
  clearTimeout(w.idleTimer);
  w.idleTimer = null;
  if (!w.dead) {
    w.dead = true;
    void w.child.closeStdin();
    w.child.kill();
  }
}

/** Close any warm persistent CLI processes (called on plugin shutdown or plugin reinstall). */
export function disposeCliProcesses(): void {
  disposePersistentAgy();
}

export async function runCliTurn(
  provider: CliProviderId,
  spec: CliTurnSpec,
  opts: { cwd: string; signal?: AbortSignal; onEvent?: (e: CliEvent) => void; beforeStart?: () => void; afterEnd?: () => void },
): Promise<CliRunResult> {
  // Only MCP-backed agy turns share the single stable bridge endpoint; one-shot
  // completions (background conclusion, translation, outline) should not block chat.
  if (provider !== "agy" || !spec.mcpUrl) return runUnlocked(provider, spec, opts);
  const prev = agyChain;
  const run = async (): Promise<CliRunResult> => {
    await prev;
    if (opts.signal?.aborted) return { ok: false, aborted: true, error: "已停止", text: "" };
    return runPersistentAgyTurn(spec, opts);
  };
  const next = run();
  agyChain = next.catch(() => undefined);
  if (!opts.signal) return next;
  return Promise.race([
    next,
    new Promise<CliRunResult>((resolve) => {
      if (opts.signal!.aborted) resolve({ ok: false, aborted: true, error: "已停止", text: "" });
      else opts.signal!.addEventListener("abort", () => resolve({ ok: false, aborted: true, error: "已停止", text: "" }), { once: true });
    }),
  ]);
}

async function runPersistentAgyTurn(
  spec: CliTurnSpec,
  opts: { cwd: string; signal?: AbortSignal; onEvent?: (e: CliEvent) => void; beforeStart?: () => void; afterEnd?: () => void },
): Promise<CliRunResult> {
  if (opts.signal?.aborted) return { ok: false, aborted: true, error: "已停止", text: "" };
  const command = await executableFor("agy");
  const configKey = JSON.stringify([command, opts.cwd, spec.model || "", spec.effort || "", spec.agyMode || ""]);

  const attempt = async (allowReuse: boolean): Promise<CliRunResult> => {
    let worker: PersistentAgy;
    const reusing = allowReuse && !!persistentAgy && !persistentAgy.dead && persistentAgy.configKey === configKey && !!spec.resumeId && persistentAgy.conversationId === spec.resumeId;
    if (reusing) {
      worker = persistentAgy!;
      clearTimeout(worker.idleTimer);
      worker.idleTimer = null;
    } else {
      disposePersistentAgy();
      const splitter = new LineSplitter();
      worker = {
        configKey,
        conversationId: spec.resumeId,
        child: null as any,
        splitter,
        active: null,
        dead: false,
        idleTimer: null,
      };
      const child = await spawnInteractive(command, buildAgyStreamArgs(spec), {
        cwd: opts.cwd,
        env: { NO_COLOR: "1" },
        onStdout: (chunk) => {
          for (const line of worker.splitter.push(chunk)) worker.active?.onLine(line);
        },
      });
      worker.child = child;
      persistentAgy = worker;
      void child.wait().then((code) => {
        worker.dead = true;
        if (persistentAgy === worker) persistentAgy = null;
        clearTimeout(worker.idleTimer);
        worker.idleTimer = null;
        const active = worker.active;
        worker.active = null;
        active?.onExit(code);
      });
    }

    const result: CliRunResult = { ok: false, aborted: false, sessionId: worker.conversationId, text: "" };
    const parser = CLI_PROVIDERS.agy.parser();
    let settled = false;
    let resolveTurn!: (r: CliRunResult) => void;
    const turnDone = new Promise<CliRunResult>((r) => (resolveTurn = r));

    const finish = () => {
      if (settled) return;
      settled = true;
      worker.active = null;
      opts.signal?.removeEventListener("abort", onAbort);
      resolveTurn(result);
    };

    const onAbort = () => {
      result.aborted = true;
      result.error = "已停止";
      disposePersistentAgy(worker);
      finish();
    };

    const handleLine = (line: string) => {
      for (const e of parser.line(line)) {
        if (e.type === "session") {
          result.sessionId = e.id;
          worker.conversationId = e.id;
        } else if (e.type === "text") {
          result.text += e.delta;
        } else if (e.type === "done") {
          result.ok = e.ok;
          if (!e.ok) result.error = e.error;
          opts.onEvent?.(e);
          if (!e.ok) disposePersistentAgy(worker);
          else worker.idleTimer = setTimeout(() => disposePersistentAgy(worker), AGY_IDLE_TTL_MS);
          finish();
          return;
        }
        opts.onEvent?.(e);
      }
    };

    worker.active = {
      onLine: handleLine,
      onExit(code) {
        worker.splitter.flush().forEach(handleLine);
        if (settled) return;
        result.ok = false;
        const tail = worker.child.stderr().trim().split("\n").slice(-6).join("\n");
        result.error = `${CLI_PROVIDERS.agy.label} 退出（代码 ${code}）${tail ? `：${tail}` : ""}`;
        finish();
      },
    };

    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) {
      onAbort();
      return turnDone;
    }

    try {
      await worker.child.write(formatAgyStreamTurn(spec));
    } catch (err) {
      worker.active = null;
      opts.signal?.removeEventListener("abort", onAbort);
      disposePersistentAgy(worker);
      if (reusing) return attempt(false);
      throw err;
    }

    return turnDone;
  };

  opts.beforeStart?.();
  try {
    return await attempt(true);
  } finally {
    opts.afterEnd?.();
  }
}

async function runUnlocked(
  provider: CliProviderId,
  spec: CliTurnSpec,
  opts: { cwd: string; signal?: AbortSignal; onEvent?: (e: CliEvent) => void; beforeStart?: () => void; afterEnd?: () => void },
): Promise<CliRunResult> {
  const result: CliRunResult = { ok: false, aborted: false, text: "" };
  if (opts.signal?.aborted) return { ...result, aborted: true, error: "已停止" };
  const command = await executableFor(provider);
  const inv = buildInvocation(provider, spec);
  const parser = CLI_PROVIDERS[provider].parser();
  const splitter = new LineSplitter();
  let done: CliEvent | null = null;
  const handle = (line: string) => {
    for (const e of parser.line(line)) {
      if (e.type === "session") result.sessionId = e.id;
      else if (e.type === "text") result.text += e.delta;
      else if (e.type === "done") done = e;
      opts.onEvent?.(e);
    }
  };
  opts.beforeStart?.();
  try {
    const child = await spawn(command, inv.args, {
      cwd: opts.cwd,
      stdin: inv.stdin,
      env: { NO_COLOR: "1" },
      onStdout: (chunk) => splitter.push(chunk).forEach(handle),
    });
    const onAbort = () => {
      result.aborted = true;
      child.kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const code = await child.wait();
    opts.signal?.removeEventListener("abort", onAbort);
    splitter.flush().forEach(handle);
    const d = done as (CliEvent & { type: "done" }) | null;
    if (result.aborted) {
      result.error = "已停止";
    } else if (d) {
      result.ok = d.ok;
      if (!d.ok) result.error = d.error;
    } else {
      result.ok = code === 0;
      if (!result.ok) {
        const tail = child.stderr().trim().split("\n").slice(-6).join("\n");
        result.error = `${CLI_PROVIDERS[provider].label} 退出（代码 ${code}）${tail ? `：${tail}` : ""}`;
      }
    }
  } finally {
    opts.afterEnd?.();
  }
  return result;
}

async function scratchDir(): Promise<string> {
  const dir = PathUtils.join(workspaceRoot(), "scratch");
  await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
  return dir;
}

/** One-shot text completion through a CLI (no tools, nothing persisted where the CLI allows). */
export async function cliComplete(
  modelId: string,
  input: { systemPrompt?: string; prompt: string; images?: { data: string; mimeType: string }[]; reasoning?: string; signal?: AbortSignal },
  onEvent?: (e: { type: "thinking" | "text"; text: string; thinking: string }) => void,
): Promise<string> {
  const parsed = parseCliModelId(modelId);
  if (!parsed) throw new Error(`不是 CLI 模型：${modelId}`);
  const { provider, model } = parsed;
  const s = getSettings();
  const cwd = await scratchDir();
  const spec: CliTurnSpec = {
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    model,
    effort: input.reasoning ? mapEffort(provider, input.reasoning) : undefined,
    isolate: s.cliIsolateConfig,
    ephemeral: true,
  };
  if (input.images?.length) {
    if (provider === "claude-code") spec.images = input.images;
    else if (provider === "codex") spec.imagePaths = await Promise.all(input.images.map((img) => saveAttachment(cwd, img)));
    else throw new Error(`${CLI_PROVIDERS[provider].label} 不支持图片输入`);
  }
  let text = "";
  let thinking = "";
  const r = await runCliTurn(provider, spec, {
    cwd,
    signal: input.signal,
    onEvent: (e) => {
      if (e.type === "text") text += e.delta;
      else if (e.type === "thinking") thinking += e.delta;
      else return;
      onEvent?.({ type: e.type, text, thinking });
    },
  });
  if (r.aborted) throw new Error("aborted");
  if (!r.ok) throw new Error(r.error || "CLI 调用失败");
  return r.text;
}

export interface CliStatus {
  provider: CliProviderId;
  ok: boolean;
  path?: string;
  version?: string;
  message: string;
}

/** Locate the CLI and read its version. */
export async function detectCli(provider: CliProviderId): Promise<CliStatus> {
  try {
    const path = await executableFor(provider);
    const r = await runCapture(path, ["--version"]);
    const version = (r.stdout || r.stderr).trim().split("\n")[0].slice(0, 80);
    if (r.code !== 0) return { provider, ok: false, path, message: `运行 --version 失败（代码 ${r.code}）：${r.stderr.trim().slice(0, 200)}` };
    return { provider, ok: true, path, version, message: `${version} · ${path}` };
  } catch (e: any) {
    return { provider, ok: false, message: `${e?.message || e}。${CLI_PROVIDERS[provider].install}` };
  }
}
