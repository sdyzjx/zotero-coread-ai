/**
 * Child processes via Firefox's Subprocess module. Zotero started from the Dock
 * gets a minimal PATH, so executables are looked up on the login shell's PATH
 * plus the usual install locations (Homebrew, npm/bun/volta globals, ~/.local).
 */
const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

export interface ChildProcess {
  /** Resolves with the exit code. */
  wait(): Promise<number>;
  kill(): void;
  stderr(): string;
}

let pathPromise: Promise<string> | null = null;

function isWindows(): boolean {
  return !!Zotero.isWin;
}

function sep(): string {
  return isWindows() ? ";" : ":";
}

function home(): string {
  try {
    return Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
  } catch {
    return "";
  }
}

function extraDirs(): string[] {
  if (isWindows()) {
    const appData = Subprocess.getEnvironment().APPDATA || "";
    return [appData && `${appData}\\npm`, `${home()}\\.local\\bin`].filter(Boolean);
  }
  const h = home();
  return ["/opt/homebrew/bin", "/usr/local/bin", `${h}/.local/bin`, `${h}/.npm-global/bin`, `${h}/.bun/bin`, `${h}/.volta/bin`, `${h}/bin`, "/usr/bin", "/bin"];
}

async function readAll(pipe: any, limit = 1 << 20): Promise<string> {
  let out = "";
  for (;;) {
    const chunk = await pipe.readString();
    if (!chunk) break;
    if (out.length < limit) out += chunk;
  }
  return out;
}

/** PATH of the user's login shell (once per app run, ≤ 8 s). */
async function loginShellPath(): Promise<string> {
  if (isWindows()) return "";
  const env = Subprocess.getEnvironment();
  const shell = env.SHELL && /^\/[\w/.-]+$/.test(env.SHELL) ? env.SHELL : "/bin/zsh";
  try {
    const proc = await Subprocess.call({ command: shell, arguments: ["-ilc", 'printf "__ZPATH__%s__ZPATH__" "$PATH"'], stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 8000);
    const out = await readAll(proc.stdout);
    clearTimeout(timer);
    await proc.wait();
    return out.match(/__ZPATH__(.*?)__ZPATH__/s)?.[1] || "";
  } catch (e) {
    Zotero.debug(`[ZoteroPi] login shell PATH lookup failed: ${e}`);
    return "";
  }
}

export async function searchPath(): Promise<string> {
  if (!pathPromise) {
    pathPromise = loginShellPath().then((login) => {
      const parts = [...login.split(sep()), ...String(Subprocess.getEnvironment().PATH || "").split(sep()), ...extraDirs()];
      return [...new Set(parts.filter(Boolean))].join(sep());
    });
  }
  return pathPromise;
}

/** Absolute path of an executable: a configured path, or a PATH lookup. */
export async function resolveExecutable(name: string, configured?: string): Promise<string> {
  const custom = (configured || "").trim();
  if (custom) {
    if (!(await IOUtils.exists(custom))) throw new Error(`找不到可执行文件：${custom}`);
    return custom;
  }
  try {
    return await Subprocess.pathSearch(name, { PATH: await searchPath() });
  } catch {
    throw new Error(`在 PATH 中找不到 ${name}`);
  }
}

export interface SpawnOptions {
  cwd?: string;
  /** Extra environment variables (merged into Zotero's environment). */
  env?: Record<string, string>;
  /** Written to stdin, which is then closed. */
  stdin?: string;
  onStdout(chunk: string): void;
}

export async function spawn(command: string, args: string[], opts: SpawnOptions): Promise<ChildProcess> {
  const environment = { PATH: await searchPath(), ...(opts.env || {}) };
  const proc = await Subprocess.call({
    command,
    arguments: args,
    workdir: opts.cwd || null,
    environment,
    environmentAppend: true,
    stderr: "pipe",
  });
  let stderr = "";
  const pumpErr = (async () => {
    for (;;) {
      const c = await proc.stderr.readString().catch(() => "");
      if (!c) break;
      stderr = (stderr + c).slice(-16000);
    }
  })();
  const pumpOut = (async () => {
    for (;;) {
      const c = await proc.stdout.readString().catch(() => "");
      if (!c) break;
      try {
        opts.onStdout(c);
      } catch (e) {
        Zotero.logError(e);
      }
    }
  })();
  if (opts.stdin) await proc.stdin.write(opts.stdin).catch(() => undefined);
  await proc.stdin.close().catch(() => undefined);
  return {
    async wait() {
      const { exitCode } = await proc.wait();
      await Promise.all([pumpOut, pumpErr]);
      return exitCode;
    },
    kill() {
      try {
        proc.kill(1500);
      } catch {
        // already gone
      }
    },
    stderr: () => stderr,
  };
}

/** Run a command to completion and return its output (for version checks). */
export async function runCapture(command: string, args: string[], timeoutMs = 15000): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  const child = await spawn(command, args, { onStdout: (c) => (stdout += c) });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const code = await child.wait();
  clearTimeout(timer);
  return { code, stdout, stderr: child.stderr() };
}
