import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { clone, getApi } from "./api";
import { Dropdown, type DropdownOption } from "./dropdown";

const api = getApi();

type SourceId = "deepseek" | "claude-code" | "codex" | "agy";

interface SourceDef {
  id: SourceId;
  label: string;
  sub: string;
  enabledKey?: string;
  pathKey?: string;
  modelsKey?: string;
  bin?: string;
  modelsHint?: string;
}

const SOURCES: SourceDef[] = [
  { id: "deepseek", label: "DeepSeek API", sub: "API Key · 按量计费" },
  {
    id: "claude-code",
    label: "Claude Code",
    sub: "claude CLI · 使用其登录账号",
    enabledKey: "cliClaudeEnabled",
    pathKey: "cliClaudePath",
    modelsKey: "cliClaudeModels",
    bin: "claude",
    modelsHint: "传给 claude --model，例如 sonnet, opus, haiku 或完整模型 ID",
  },
  {
    id: "codex",
    label: "Codex",
    sub: "codex CLI · 使用其登录账号",
    enabledKey: "cliCodexEnabled",
    pathKey: "cliCodexPath",
    modelsKey: "cliCodexModels",
    bin: "codex",
    modelsHint: "传给 codex -m，例如 gpt-5.5；留空则只用 Codex 配置中的默认模型",
  },
  {
    id: "agy",
    label: "Antigravity",
    sub: "agy CLI · 使用其登录账号",
    enabledKey: "cliAgyEnabled",
    pathKey: "cliAgyPath",
    modelsKey: "cliAgyModels",
    bin: "agy",
    modelsHint: "传给 agy --model，可用 agy models 查看，例如 gemini-3.8-flash-medium",
  },
];

const LEVEL_LABELS: Record<string, string> = { off: "关闭思考", minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最大" };
const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function sourceOf(id: string): SourceId {
  const p = String(id || "").split(":")[0];
  return (SOURCES.some((s) => s.id === p) ? p : "deepseek") as SourceId;
}

function Field({ label, hint, children }: { label: string; hint?: any; children: any }) {
  return (
    <div class="field">
      <span class="label">{label}</span>
      <div class="control">
        {children}
        {hint && <div class="hint">{hint}</div>}
      </div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <span class="toggle-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      {label && <span>{label}</span>}
    </span>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function modelOptions(models: any[], extra: DropdownOption[] = [], current?: string): DropdownOption[] {
  const opts: DropdownOption[] = [...extra, ...models.map((m) => ({ value: m.id, label: m.name, note: m.id === m.name ? undefined : m.id, group: m.group }))];
  if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: current, note: "未启用的来源", group: "其他" });
  return opts;
}

type Status = { ok: boolean; text: string } | null;

function App() {
  const [s, setS] = useState<any>(() => clone(api.getSettings()));
  const [tab, setTab] = useState<SourceId>(() => sourceOf(api.getSettings().model));
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [panelMsg, setPanelMsg] = useState<Record<string, Status>>({});
  const [remote, setRemote] = useState<string[]>([]);
  const [detected, setDetected] = useState<Record<string, any>>({});
  const [agy, setAgy] = useState<any>(null);
  const [workspaces, setWorkspaces] = useState<any[] | null>(null);
  const set = (k: string, v: any) => setS((prev: any) => ({ ...prev, [k]: v }));

  // Model lists follow unsaved edits (enabled sources, extra model ids)
  const models: any[] = useMemo(
    () => clone(api.listModels(s)),
    [s.extraModels, s.cliClaudeEnabled, s.cliCodexEnabled, s.cliAgyEnabled, s.cliClaudeModels, s.cliCodexModels, s.cliAgyModels],
  );
  const defaultSource = sourceOf(s.model);
  const def = SOURCES.find((x) => x.id === tab)!;

  const say = (key: string, st: Status) => setPanelMsg((p) => ({ ...p, [key]: st }));
  const persist = () => api.saveSettings(clone(s));

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e: any) {
      say(key.split(":")[0], { ok: false, text: String(e?.message || e) });
    } finally {
      setBusy(null);
    }
  };

  const detect = (src: SourceDef) =>
    run(`${src.id}:detect`, async () => {
      persist();
      const r = clone(await api.cli.detect(src.id));
      setDetected((d) => ({ ...d, [src.id]: r }));
      if (src.id === "agy" && r.ok) setAgy(clone(await api.cli.agyStatus().catch((e: any) => ({ installed: false, message: String(e?.message || e) }))));
    });

  // Detect the CLI of the opened tab once
  useEffect(() => {
    if (def.bin && !detected[def.id]) void detect(def);
  }, [tab]);

  const save = () => {
    persist();
    setStatus({ ok: true, text: "已保存" });
    setTimeout(() => setStatus(null), 2500);
  };

  /** Make a source the default for chat and quick tasks. */
  const makeDefault = (src: SourceDef) => {
    const patch: any = {};
    if (src.enabledKey) patch[src.enabledKey] = true;
    const list: any[] = clone(api.listModels({ ...s, ...patch })).filter((m: any) => m.source === src.id);
    if (!list.length) return;
    const quick = src.id === "claude-code" ? list.find((m) => /haiku/i.test(m.id)) || list[0] : list[0];
    setS((prev: any) => ({ ...prev, ...patch, model: list[0].id, quickModel: quick.id }));
    say(src.id, { ok: true, text: `已设为默认：对话用「${list[0].name}」，翻译 / 结论用「${quick.name}」。点底部「保存」生效。` });
  };

  const testSource = (src: SourceDef) =>
    run(`${src.id}:test`, async () => {
      persist();
      if (src.id === "deepseek") {
        const r = clone(await api.testConnection());
        say(src.id, { ok: r.ok, text: r.message });
        setRemote(r.remoteModels || []);
        return;
      }
      const id = models.find((m) => m.source === src.id)?.id || src.id;
      say(src.id, { ok: true, text: "测试中…（CLI 首次启动可能需要十几秒）" });
      const r = clone(await api.testModel(id));
      say(src.id, { ok: r.ok, text: r.message });
    });

  const addExtra = (id: string) => {
    const list = s.extraModels.split(/[,\s]+/).filter(Boolean);
    if (!list.includes(id) && !models.some((m) => m.id === id)) set("extraModels", [...list, id].join(", "));
  };

  const loadWorkspaces = () =>
    run("ws:list", async () => {
      persist();
      setWorkspaces(clone(await api.cli.listWorkspaces()));
    });

  const chatModel = models.find((m) => m.id === s.model);
  const levels: string[] = chatModel?.thinkingLevels?.length ? chatModel.thinkingLevels : ["off", "low", "high", "max"];
  const actions: any[] = s.quickActions;
  const setAction = (i: number, patch: any) => set("quickActions", actions.map((a, j) => (i === j ? { ...a, ...patch } : a)));

  const sourceState = (src: SourceDef): { cls: string; text: string } => {
    if (src.id === "deepseek") return s.apiKey ? { cls: "on", text: "已配置 Key" } : { cls: "off", text: "未配置 Key" };
    const d = detected[src.id];
    if (!s[src.enabledKey!]) return { cls: "off", text: d?.ok ? "已安装 · 未启用" : "未启用" };
    if (d && !d.ok) return { cls: "warn", text: "找不到 CLI" };
    return { cls: "on", text: "已启用" };
  };

  return (
    <div class="page">
      <header>
        <img class="logo" src="icons/icon.svg" alt="" />
        <div>
          <h1>CoRead AI 设置</h1>
          <div class="sub">AI 伴读 · 与 AI 协同精读论文 · v{api.version}</div>
        </div>
      </header>

      <section>
        <h2>模型来源</h2>
        <div class="hint top">
          可以用 DeepSeek API，也可以直接调用本机已登录的 Claude Code、Codex 或 Antigravity CLI。CLI 通过 Zotero 本地服务（MCP）使用与内置 Agent 完全相同的论文 / 批注 / 文献库工具。聊天框下方的模型菜单可以随时在已启用的来源之间切换。
        </div>
        <div class="sources" role="tablist">
          {SOURCES.map((src) => {
            const st = sourceState(src);
            return (
              <button type="button" role="tab" aria-selected={tab === src.id} class={`source${tab === src.id ? " active" : ""}`} onClick={() => setTab(src.id)}>
                <span class="source-head">
                  <span class={`dot ${st.cls}`} />
                  <span class="source-name">{src.label}</span>
                  {defaultSource === src.id && <span class="badge">默认</span>}
                </span>
                <span class="source-sub">{st.text}</span>
              </button>
            );
          })}
        </div>

        <div class="panel">
          {tab === "deepseek" ? (
            <>
              <Field label="API Key" hint="保存在 Zotero 本地偏好设置中。获取：platform.deepseek.com">
                <div class="row">
                  <input type={showKey ? "text" : "password"} value={s.apiKey} placeholder="sk-..." onInput={(e) => set("apiKey", (e.target as HTMLInputElement).value.trim())} />
                  <button onClick={() => setShowKey(!showKey)}>{showKey ? "隐藏" : "显示"}</button>
                </div>
              </Field>
              <Field label="API 地址" hint="默认 https://api.deepseek.com">
                <input value={s.baseUrl} onInput={(e) => set("baseUrl", (e.target as HTMLInputElement).value)} />
              </Field>
              <Field label="额外模型 ID" hint="逗号分隔，用于 DeepSeek 新发布、pi 尚未内置的模型">
                <input value={s.extraModels} placeholder="例如 deepseek-v4-flash" onInput={(e) => set("extraModels", (e.target as HTMLInputElement).value)} />
              </Field>
              {remote.length > 0 && (
                <div class="remote">
                  账户可用模型：
                  {remote.map((id) => (
                    <button class="tag" title="加入额外模型" onClick={() => addExtra(id)}>
                      {id}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <Field label="启用" hint="启用后它的模型出现在所有模型菜单中">
                <Toggle checked={!!s[def.enabledKey!]} onChange={(v) => set(def.enabledKey!, v)} label={`在模型菜单中显示 ${def.label}`} />
              </Field>
              <Field
                label="可执行文件"
                hint={
                  detected[def.id] ? (
                    <span class={detected[def.id].ok ? "ok" : "err"}>{detected[def.id].message}</span>
                  ) : (
                    `留空则在 PATH 与登录 shell 的 PATH 中查找 ${def.bin}`
                  )
                }
              >
                <div class="row">
                  <input value={s[def.pathKey!]} placeholder={`自动查找 ${def.bin}`} onInput={(e) => set(def.pathKey!, (e.target as HTMLInputElement).value.trim())} />
                  <button onClick={() => detect(def)} disabled={busy === `${def.id}:detect`}>
                    {busy === `${def.id}:detect` ? "检测中…" : "检测"}
                  </button>
                </div>
              </Field>
              <Field label="可选模型" hint={`逗号分隔；${def.modelsHint}。「默认模型」使用 CLI 自己的配置`}>
                <input value={s[def.modelsKey!]} onInput={(e) => set(def.modelsKey!, (e.target as HTMLInputElement).value)} />
              </Field>
              {def.id === "agy" && (
                <>
                  <Field
                    label="Zotero 工具插件"
                    hint="Antigravity 只从全局配置读取 MCP 服务器，需要安装一个小插件（zotero-pi）指向 Zotero 本地服务；只在 Zotero 发起 agy 对话时提供工具。"
                  >
                    <div class="row">
                      <span class={agy?.installed ? "ok" : "muted"}>{agy ? agy.message : "未检测"}</span>
                      <button
                        disabled={!!busy}
                        onClick={() =>
                          run("agy:install", async () => {
                            persist();
                            const msg = await api.cli.installAgy();
                            setAgy(clone(await api.cli.agyStatus()));
                            say("agy", { ok: true, text: `插件已安装：${msg}` });
                          })
                        }
                      >
                        {busy === "agy:install" ? "安装中…" : agy?.installed ? "重新安装" : "安装插件"}
                      </button>
                      {agy?.installed && (
                        <button
                          disabled={!!busy}
                          onClick={() =>
                            run("agy:uninstall", async () => {
                              await api.cli.uninstallAgy();
                              setAgy(clone(await api.cli.agyStatus()));
                              say("agy", { ok: true, text: "插件已卸载" });
                            })
                          }
                        >
                          卸载
                        </button>
                      )}
                    </div>
                  </Field>
                  <Field label="执行模式" hint="「auto」让 agy 不经确认即可调用工具（在独立工作区中运行）；选「CLI 默认」则需要 agy 自己允许工具调用">
                    <Dropdown
                      value={s.cliAgyMode}
                      onChange={(v) => set("cliAgyMode", v)}
                      options={[
                        { value: "auto", label: "auto（推荐）" },
                        { value: "", label: "CLI 默认" },
                      ]}
                    />
                  </Field>
                </>
              )}
              <Field label="隔离 CLI 配置" hint="不加载 Claude Code / Codex 自己的用户设置、hooks 与 MCP 服务器（推荐）；若你依赖其中的代理或自定义模型提供方，可关闭">
                <Toggle checked={!!s.cliIsolateConfig} onChange={(v) => set("cliIsolateConfig", v)} label="使用干净的 CLI 环境" />
              </Field>
            </>
          )}
          <div class="row actions">
            {defaultSource !== tab && (
              <button class="primary" onClick={() => makeDefault(def)}>
                设为默认来源
              </button>
            )}
            <button onClick={() => testSource(def)} disabled={busy === `${tab}:test`}>
              {busy === `${tab}:test` ? "测试中…" : tab === "deepseek" ? "测试连接" : "测试对话"}
            </button>
            {panelMsg[tab] && <span class={panelMsg[tab]!.ok ? "ok" : "err"}>{panelMsg[tab]!.text}</span>}
          </div>
        </div>
      </section>

      <section>
        <h2>模型分配</h2>
        <Field label="默认对话模型" hint="新会话使用；每个会话可在输入框下方单独切换（包括切换来源）">
          <Dropdown value={s.model} onChange={(v) => set("model", v)} options={modelOptions(models, [], s.model)} />
        </Field>
        <Field label="默认思考强度" hint="CLI 模型对应其 effort 参数；不支持的强度会改用最接近的一档">
          <Dropdown
            value={s.thinkingLevel}
            onChange={(v) => set("thinkingLevel", v)}
            options={LEVEL_ORDER.filter((l) => levels.includes(l) || l === s.thinkingLevel).map((l) => ({ value: l, label: LEVEL_LABELS[l] || l }))}
          />
        </Field>
        <Field label="翻译 / 结论模型" hint="划词翻译、自动生成会话结论与图片描述（速度优先，DeepSeek 不开启思考）">
          <Dropdown value={s.quickModel} onChange={(v) => set("quickModel", v)} options={modelOptions(models, [], s.quickModel)} />
        </Field>
        <Field label="脉络分析模型" hint="默认使用「翻译 / 结论模型」">
          <Dropdown
            value={s.outlineModel}
            onChange={(v) => set("outlineModel", v)}
            options={modelOptions(models, [{ value: "", label: "与翻译 / 结论模型相同" }], s.outlineModel || undefined)}
          />
        </Field>
        <Field label="脉络思考强度" hint="默认「中」；模型不支持的强度会改用较低一档（DeepSeek Flash 只有 低 / 高 / 最大，「中」按「低」运行）">
          <Dropdown
            value={s.outlineThinking}
            onChange={(v) => set("outlineThinking", v)}
            options={[
              { value: "off", label: "关闭" },
              { value: "low", label: "低" },
              { value: "medium", label: "中（默认）" },
              { value: "high", label: "高" },
            ]}
          />
        </Field>
      </section>

      <section>
        <h2>CLI 工作区</h2>
        <div class="hint top">每篇论文一个工作目录，作为 CLI 的工作区：保存 Agent 说明（AGENTS.md）、论文信息与随消息发送的图片；CLI 自己的会话按目录续接。</div>
        <Field label="工作区根目录" hint={`留空使用 ${api.cli.defaultWorkspaceRoot()}`}>
          <div class="row">
            <input value={s.cliWorkspaceRoot} placeholder={api.cli.defaultWorkspaceRoot()} onInput={(e) => set("cliWorkspaceRoot", (e.target as HTMLInputElement).value.trim())} />
            <button
              onClick={() => {
                persist();
                void api.cli.reveal();
              }}
            >
              打开
            </button>
          </div>
        </Field>
        <div class="row actions">
          <button onClick={loadWorkspaces} disabled={busy === "ws:list"}>
            {workspaces ? "刷新列表" : "查看工作区"}
          </button>
          <button
            disabled={!!busy}
            onClick={() =>
              run("ws:clean", async () => {
                const n = await api.cli.cleanOrphans();
                say("ws", { ok: true, text: `已清理 ${n} 个已删除条目的工作区` });
                setWorkspaces(clone(await api.cli.listWorkspaces()));
              })
            }
          >
            清理孤立工作区
          </button>
          <button
            disabled={!!busy}
            onClick={() =>
              run("ws:prune", async () => {
                const n = await api.cli.pruneAttachments(30);
                say("ws", { ok: true, text: `已删除 ${n} 个 30 天前的图片附件` });
                setWorkspaces(clone(await api.cli.listWorkspaces()));
              })
            }
          >
            清理 30 天前的附件
          </button>
          {panelMsg.ws && <span class={panelMsg.ws.ok ? "ok" : "err"}>{panelMsg.ws.text}</span>}
        </div>
        {workspaces && (
          <div class="ws-list">
            {!workspaces.length && <div class="muted">还没有工作区（使用 CLI 模型对话后自动创建）。</div>}
            {workspaces.map((w) => (
              <div class={`ws${w.orphan ? " orphan" : ""}`}>
                <div class="ws-main">
                  <div class="ws-title">{w.title || w.name}</div>
                  <div class="ws-meta">
                    {w.orphan ? "条目已删除 · " : ""}
                    {w.files} 个文件 · {fmtBytes(w.bytes)} · {fmtTime(w.modified)}
                  </div>
                </div>
                <button onClick={() => void api.cli.reveal(w.dir)}>打开</button>
                <button
                  onClick={() =>
                    run("ws:remove", async () => {
                      if (!window.confirm(`删除「${w.title || w.name}」的工作区？\n（不影响 Zotero 中的会话记录；CLI 下次会新开会话并带上聊天记录）`)) return;
                      await api.cli.removeWorkspace(w.dir);
                      setWorkspaces(clone(await api.cli.listWorkspaces()));
                    })
                  }
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>阅读与回答</h2>
        <Field label="回答语言">
          <input value={s.replyLanguage} onInput={(e) => set("replyLanguage", (e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="翻译目标语言">
          <input value={s.targetLanguage} onInput={(e) => set("targetLanguage", (e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="单次读取字符上限" hint="渐进式披露：Agent 每次读取论文 / 网页的最大字符数（1000–50000）">
          <input type="number" min={1000} max={50000} step={1000} value={s.maxReadChars} onInput={(e) => set("maxReadChars", Number((e.target as HTMLInputElement).value))} />
        </Field>
        <Field label="自动生成会话结论" hint="每轮对话结束后用「翻译 / 结论模型」总结结论，供其他文章的会话查阅">
          <Toggle checked={!!s.autoConclusion} onChange={(v) => set("autoConclusion", v)} />
        </Field>
        <Field label="自定义系统提示词" hint="追加到 Agent 的系统提示词末尾（CLI 模型同样生效）">
          <textarea rows={4} value={s.customSystemPrompt} onInput={(e) => set("customSystemPrompt", (e.target as HTMLTextAreaElement).value)} />
        </Field>
      </section>

      <section>
        <h2>文章脉络</h2>
        <div class="hint top">阅读器左侧常驻一个悬浮的脉络导航，点击「生成文章脉络」后才会分析该论文（背景 → 问题 → 相关工作 → Gap → 方法 → 实验 → 结果 → 结论；综述梳理发展脉络与研究分支），结果会缓存。分析所用模型在「模型分配」中设置。</div>
        <Field label="展开脉络导航" hint="关闭则收起为左边缘的小标签；也可以用导航上的 ‹ 按钮或阅读器工具栏的脉络按钮切换">
          <Toggle checked={!!s.outlineVisible} onChange={(v) => set("outlineVisible", v)} />
        </Field>
      </section>

      <section>
        <h2>网络搜索</h2>
        <Field label="搜索引擎" hint="DeepSeek 搜索使用同一个 API Key，按次计费（约 $0.75 / 千次成功请求）；失败或未配置 Key 时自动回退到 DuckDuckGo">
          <Dropdown
            value={s.searchEngine}
            onChange={(v) => set("searchEngine", v)}
            options={[
              { value: "deepseek", label: "DeepSeek 搜索（推荐）" },
              { value: "duckduckgo", label: "DuckDuckGo（免费）" },
              { value: "tavily", label: "Tavily" },
              { value: "brave", label: "Brave Search" },
              { value: "searxng", label: "SearXNG（自建）" },
            ]}
          />
        </Field>
        {s.searchEngine === "tavily" && (
          <Field label="Tavily API Key">
            <input type="password" value={s.tavilyKey} onInput={(e) => set("tavilyKey", (e.target as HTMLInputElement).value.trim())} />
          </Field>
        )}
        {s.searchEngine === "brave" && (
          <Field label="Brave API Key">
            <input type="password" value={s.braveKey} onInput={(e) => set("braveKey", (e.target as HTMLInputElement).value.trim())} />
          </Field>
        )}
        {s.searchEngine === "searxng" && (
          <Field label="SearXNG 地址">
            <input value={s.searxngUrl} placeholder="https://searx.example.com" onInput={(e) => set("searxngUrl", (e.target as HTMLInputElement).value.trim())} />
          </Field>
        )}
        <Field label="网页读取" hint="DeepSeek Fetch 返回整理后的 Markdown（按次计费）；本地抓取免费但对动态网页效果较差">
          <Dropdown
            value={s.fetchEngine}
            onChange={(v) => set("fetchEngine", v)}
            options={[
              { value: "deepseek", label: "DeepSeek Fetch（失败时回退本地）" },
              { value: "local", label: "本地抓取" },
            ]}
          />
        </Field>
      </section>

      <section>
        <h2>批注</h2>
        <Field label="AI 批注颜色">
          <input type="color" value={s.annotationColor} onInput={(e) => set("annotationColor", (e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="AI 批注标签" hint="AI 创建的批注会加上此标签，便于筛选（留空则不加）">
          <input value={s.annotationTag} onInput={(e) => set("annotationTag", (e.target as HTMLInputElement).value)} />
        </Field>
      </section>

      <section>
        <h2>划词操作</h2>
        <div class="hint top">选中 PDF 文本后弹出的 AI 按钮。提示词中的 {"{text}"} 会被替换为选中文本；“翻译”类型使用「翻译 / 结论模型」直接翻译。</div>
        {actions.map((a, i) => (
          <div class="action">
            <input class="a-label" value={a.label} onInput={(e) => setAction(i, { label: (e.target as HTMLInputElement).value })} />
            <Dropdown
              value={a.mode}
              onChange={(v) => setAction(i, { mode: v })}
              options={[
                { value: "agent", label: "Agent" },
                { value: "translate", label: "翻译" },
              ]}
            />
            <textarea rows={2} disabled={a.mode === "translate"} value={a.prompt} placeholder={a.mode === "translate" ? "（翻译无需提示词）" : "提示词，包含 {text}"} onInput={(e) => setAction(i, { prompt: (e.target as HTMLTextAreaElement).value })} />
            <button onClick={() => set("quickActions", actions.filter((_, j) => j !== i))}>删除</button>
          </div>
        ))}
        <div class="row">
          <button onClick={() => set("quickActions", [...actions, { id: `custom${Date.now()}`, label: "新操作", mode: "agent", prompt: "{text}" }])}>添加操作</button>
        </div>
      </section>

      <footer>
        {status && <span class={status.ok ? "ok" : "err"}>{status.text}</span>}
        <button class="primary" onClick={save}>
          保存
        </button>
      </footer>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
