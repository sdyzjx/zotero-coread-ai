import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agyParser, claudeParser, codexParser, LineSplitter, type CliEvent, type CliParser } from "../src/core/agents/parsers.ts";

function run(parser: CliParser, file: string): CliEvent[] {
  const text = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
  return text.split("\n").flatMap((l) => parser.line(l));
}

const textOf = (ev: CliEvent[]) => ev.map((e) => (e.type === "text" ? e.delta : "")).join("");

test("claude: session, streamed text, MCP calls left to the bridge, success", () => {
  const ev = run(claudeParser(), "claude-stream.jsonl");
  assert.deepEqual(ev[0], { type: "session", id: "5694c7b7-734b-4049-b944-8b266d83c6db" });
  assert.match(textOf(ev), /PINEAPPLE-42/);
  // text arrived as deltas: the full assistant message must not be emitted again
  assert.equal(textOf(ev).match(/PINEAPPLE-42/g)!.length, 1);
  assert.ok(!ev.some((e) => e.type === "tool_start"), "mcp__zotero__ calls are reported by the bridge");
  assert.deepEqual(ev[ev.length - 1], { type: "done", ok: true });
});

test("claude: native tools and errors without partial messages", () => {
  const p = claudeParser();
  const ev = [
    { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "t1", name: "WebSearch", input: { query: "x" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "found" }] }] } },
    { type: "result", subtype: "error_during_execution", is_error: true, errors: ["rate limited"] },
  ].flatMap((d) => p.line(JSON.stringify(d)));
  assert.deepEqual(ev, [
    { type: "text", delta: "Let me look." },
    { type: "tool_start", id: "t1", name: "WebSearch", args: { query: "x" } },
    { type: "tool_end", id: "t1", name: "WebSearch", output: "found", isError: false },
    { type: "done", ok: false, error: "rate limited" },
  ]);
});

test("codex: thread id, messages joined as paragraphs, own MCP calls skipped", () => {
  const ev = run(codexParser(), "codex-stream.jsonl");
  assert.deepEqual(ev[0], { type: "session", id: "01a20e07-6227-7493-abb2-16d6a942091e" });
  const text = textOf(ev);
  assert.match(text, /^I’ll check whether the Zotero/);
  assert.match(text, /\n\nThe secret code word is \*\*PINEAPPLE-42\*\*\.$/);
  assert.ok(!ev.some((e) => e.type === "tool_start"));
  assert.deepEqual(ev[ev.length - 1], { type: "done", ok: true });
});

test("codex: shell commands and failures", () => {
  const p = codexParser();
  const ev = [
    { type: "item.started", item: { id: "i1", type: "command_execution", command: "ls", status: "in_progress" } },
    { type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "a\n", exit_code: 0 } },
    { type: "error", message: "stream disconnected" },
    { type: "turn.failed", error: {} },
  ].flatMap((d) => p.line(JSON.stringify(d)));
  assert.deepEqual(ev, [
    { type: "tool_start", id: "i1", name: "shell", args: { command: "ls" } },
    { type: "tool_end", id: "i1", name: "shell", output: "a\n", isError: false },
    { type: "done", ok: false, error: "stream disconnected" },
  ]);
});

test("agy: conversation id, text deltas, success", () => {
  const ev = run(agyParser(), "agy-stream.jsonl");
  assert.deepEqual(ev[0], { type: "session", id: "77167282-1b09-4794-a127-4d451ab913ac" });
  assert.match(textOf(ev), /^Attention in transformers allows the model/);
  assert.match(textOf(ev), /context-rich representations\.\n$/);
  assert.deepEqual(ev[ev.length - 1], { type: "done", ok: true });
});

test("agy: separate response steps become paragraphs; failure status", () => {
  const p = agyParser();
  const step = (i: number, t: string) => JSON.stringify({ event: "step_update", step_update: { step_index: i, step_type: "agent_response", text_delta: t } });
  const ev = [step(1, "A"), step(1, "B"), step(3, "C"), JSON.stringify({ event: "result", result: { status: "ERROR", error: "quota" } })].flatMap((l) => p.line(l));
  assert.equal(textOf(ev), "AB\n\nC");
  assert.deepEqual(ev[ev.length - 1], { type: "done", ok: false, error: "quota" });
});

test("LineSplitter keeps partial lines until complete", () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(s.push(":2}\r\n"), ['{"b":2}']);
  assert.deepEqual(s.push("tail"), []);
  assert.deepEqual(s.flush(), ["tail"]);
});
