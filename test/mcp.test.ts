import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMcpPost, normalizeInputSchema, type McpServerImpl } from "../src/core/mcp/protocol.ts";

function server(calls: any[] = []): McpServerImpl {
  return {
    name: "zotero",
    version: "test",
    listTools: () => [{ name: "paper_read", description: "Read pages", inputSchema: { type: "object", properties: { pages: { type: "string" } } } }],
    async callTool(name, args) {
      calls.push({ name, args });
      if (args.fail) throw new Error("boom");
      return { content: [{ type: "text", text: `read ${args.pages}` }] };
    },
  };
}

test("initialize echoes a supported protocol version and falls back to the latest", async () => {
  const a = await handleMcpPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, server());
  assert.equal(a.status, 200);
  assert.equal(a.body.result.protocolVersion, "2025-03-26");
  assert.deepEqual(a.body.result.serverInfo, { name: "zotero", version: "test" });
  assert.ok(a.body.result.capabilities.tools);
  const b = await handleMcpPost({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, server());
  assert.equal(b.body.result.protocolVersion, "2025-11-25");
});

test("notifications get 202 with no body", async () => {
  const r = await handleMcpPost({ jsonrpc: "2.0", method: "notifications/initialized" }, server());
  assert.deepEqual(r, { status: 202, body: null });
});

test("tools/list and tools/call", async () => {
  const calls: any[] = [];
  const list = await handleMcpPost({ jsonrpc: "2.0", id: 3, method: "tools/list" }, server(calls));
  assert.equal(list.body.result.tools[0].name, "paper_read");
  const call = await handleMcpPost(
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "paper_read", arguments: { pages: "3-4" } } }),
    server(calls),
  );
  assert.deepEqual(call.body.result, { content: [{ type: "text", text: "read 3-4" }] });
  assert.deepEqual(calls, [{ name: "paper_read", args: { pages: "3-4" } }]);
});

test("tool failures become isError results, unknown tools are protocol errors", async () => {
  const fail = await handleMcpPost({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "paper_read", arguments: { fail: true } } }, server());
  assert.equal(fail.body.result.isError, true);
  assert.match(fail.body.result.content[0].text, /boom/);
  const unknown = await handleMcpPost({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } }, server());
  assert.equal(unknown.body.error.code, -32602);
});

test("unknown methods, bad JSON and batches", async () => {
  const m = await handleMcpPost({ jsonrpc: "2.0", id: 7, method: "server/discover" }, server());
  assert.equal(m.body.error.code, -32601);
  const bad = await handleMcpPost("{not json", server());
  assert.equal(bad.status, 400);
  const batch = await handleMcpPost(
    [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 8, method: "ping" },
    ],
    server(),
  );
  assert.deepEqual(batch.body, [{ jsonrpc: "2.0", id: 8, result: {} }]);
});

test("normalizeInputSchema strips non-JSON keys and forces an object root", () => {
  const sym = Symbol("kind");
  const schema: any = { type: "object", properties: { a: { type: "string" } }, [sym]: "Object" };
  assert.deepEqual(normalizeInputSchema(schema), { type: "object", properties: { a: { type: "string" } } });
  assert.deepEqual(normalizeInputSchema({ type: "string" }), { type: "object", properties: {} });
  assert.deepEqual(normalizeInputSchema({ type: "object" }), { type: "object", properties: {} });
});
