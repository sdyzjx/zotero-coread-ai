import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgyStreamArgs, buildInvocation, cliModelEntries, formatAgyStreamTurn, mapEffort, parseCliModelId } from "../src/core/agents/providers.ts";

test("model ids", () => {
  assert.deepEqual(parseCliModelId("claude-code"), { provider: "claude-code", model: "" });
  assert.deepEqual(parseCliModelId("codex:gpt-5.5"), { provider: "codex", model: "gpt-5.5" });
  assert.deepEqual(parseCliModelId("agy:gemini-3.8-flash-medium"), { provider: "agy", model: "gemini-3.8-flash-medium" });
  assert.equal(parseCliModelId("deepseek-flash"), null);
  assert.equal(parseCliModelId(""), null);
});

test("effort mapping", () => {
  assert.equal(mapEffort("claude-code", "off"), "low");
  assert.equal(mapEffort("claude-code", "max"), "max");
  assert.equal(mapEffort("codex", "max"), "xhigh");
  assert.equal(mapEffort("agy", "medium"), "medium");
  assert.equal(mapEffort("agy", undefined), undefined);
});

test("model entries for enabled providers only", () => {
  const e = cliModelEntries({ "claude-code": true, agy: true }, { "claude-code": "sonnet, opus sonnet", codex: "gpt-5.5" });
  assert.deepEqual(
    e.map((x) => x.id),
    ["claude-code", "claude-code:sonnet", "claude-code:opus", "agy"],
  );
});

test("claude: tools only through the MCP bridge, resume vs new session, inline images", () => {
  const inv = buildInvocation("claude-code", {
    prompt: "hi",
    systemPrompt: "You are Pi.",
    mcpUrl: "http://127.0.0.1:23119/zoteropi/mcp/t",
    model: "sonnet",
    effort: "high",
    isolate: true,
    newSessionId: "u-1",
    images: [{ data: "AAA", mimeType: "image/png" }],
  });
  const a = inv.args;
  assert.equal(a[a.indexOf("--tools") + 1], "");
  assert.deepEqual(JSON.parse(a[a.indexOf("--mcp-config") + 1]), { mcpServers: { zotero: { type: "http", url: "http://127.0.0.1:23119/zoteropi/mcp/t" } } });
  assert.equal(a[a.indexOf("--allowedTools") + 1], "mcp__zotero");
  assert.equal(a[a.indexOf("--system-prompt") + 1], "You are Pi.");
  assert.equal(a[a.indexOf("--setting-sources") + 1], "");
  assert.equal(a[a.indexOf("--session-id") + 1], "u-1");
  assert.ok(!a.includes("--resume"));
  const msg = JSON.parse(inv.stdin);
  assert.equal(msg.message.content[0].text, "hi");
  assert.deepEqual(msg.message.content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } });

  const resumed = buildInvocation("claude-code", { prompt: "again", resumeId: "u-1" }).args;
  assert.equal(resumed[resumed.indexOf("--resume") + 1], "u-1");
  assert.ok(!resumed.includes("--mcp-config"), "one-shot without MCP");
});

test("codex: new thread vs resume; images before flags; prompt on stdin", () => {
  const fresh = buildInvocation("codex", {
    prompt: "explain",
    systemPrompt: "You are Pi.",
    instructionsInWorkspace: true,
    mcpUrl: "http://x/t",
    imagePaths: ["/w/a.png"],
    effort: "high",
  });
  assert.deepEqual(fresh.args.slice(0, 3), ["exec", "-i", "/w/a.png"]);
  assert.ok(fresh.args.includes('mcp_servers.zotero.url="http://x/t"'));
  assert.ok(fresh.args.includes('model_reasoning_effort="high"'));
  assert.equal(fresh.args[fresh.args.length - 1], "-");
  assert.equal(fresh.stdin, "explain", "AGENTS.md carries the instructions");

  const resumed = buildInvocation("codex", { prompt: "more", resumeId: "th-1", isolate: true });
  assert.deepEqual(resumed.args.slice(0, 2), ["exec", "resume"]);
  assert.deepEqual(resumed.args.slice(-2), ["th-1", "-"]);
  assert.ok(resumed.args.includes("--ignore-user-config"));

  const oneShot = buildInvocation("codex", { prompt: "translate", systemPrompt: "Translate.", ephemeral: true });
  assert.ok(oneShot.args.includes("--ephemeral"));
  assert.match(oneShot.stdin, /^<instructions>\nTranslate\.\n<\/instructions>\n\ntranslate$/);
});

test("agy: prompt attached to -p, instructions only for new conversations", () => {
  const fresh = buildInvocation("agy", { prompt: "- list", systemPrompt: "You are Pi.", agyMode: "auto", model: "gemini-x", imagePaths: ["/w/a.png"] });
  const last = fresh.args[fresh.args.length - 1];
  assert.ok(last.startsWith("-p=<instructions>\nYou are Pi."));
  assert.match(last, /- list\n\n\(Attached image files: \/w\/a\.png\)$/);
  assert.ok(fresh.args.includes("--dangerously-skip-permissions"));
  assert.ok(!fresh.args.includes("--mode"));
  const planned = buildInvocation("agy", { prompt: "plan", agyMode: "plan" });
  assert.equal(planned.args[planned.args.indexOf("--mode") + 1], "plan");
  const resumed = buildInvocation("agy", { prompt: "next", systemPrompt: "You are Pi.", resumeId: "c-1" });
  assert.equal(resumed.args[resumed.args.indexOf("--conversation") + 1], "c-1");
  assert.equal(resumed.args[resumed.args.length - 1], "-p=next");
});

test("agy: persistent stream-json args and NDJSON turn payload", () => {
  const args = buildAgyStreamArgs({ resumeId: "c-1", agyMode: "auto", model: "gemini-x", effort: "medium" });
  assert.deepEqual(args, [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--conversation",
    "c-1",
    "--dangerously-skip-permissions",
    "--model",
    "gemini-x",
    "--effort",
    "medium",
  ]);
  const first = JSON.parse(formatAgyStreamTurn({ prompt: "hi", systemPrompt: "You are Pi.", imagePaths: ["/w/a.png"] }));
  assert.equal(first.event, "user");
  assert.match(first.message.content, /^<instructions>\nYou are Pi\.\n<\/instructions>\n\nhi\n\n\(Attached image files: \/w\/a\.png\)$/);
  const second = JSON.parse(formatAgyStreamTurn({ prompt: "follow up", systemPrompt: "You are Pi.", resumeId: "c-1" }));
  assert.deepEqual(second, { event: "user", message: { content: "follow up" } });
});
