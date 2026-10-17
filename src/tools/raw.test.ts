import { test } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { VkAdsClient } from "../client.js";
import { isReadMethod, registerRawTool } from "./raw.js";
import { HardenedVkAdsClient } from "../hardenedClient.js";

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function captureRawTool(client: VkAdsClient): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool: (_name: string, _def: unknown, h: Handler) => {
      handler = h;
    },
  } as unknown as McpServer;
  registerRawTool(server, client);
  if (!handler) throw new Error("raw_request was not registered");
  return handler;
}

function text(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

test("isReadMethod is true only for GET", () => {
  assert.equal(isReadMethod("GET"), true);
  assert.equal(isReadMethod("get"), true);
  assert.equal(isReadMethod("POST"), false);
  assert.equal(isReadMethod("DELETE"), false);
});

test("raw_request blocks a POST without confirmWrite", async () => {
  const calls: unknown[][] = [];
  const client = {
    request: async (...args: unknown[]) => {
      calls.push(args);
      return {};
    },
  } as unknown as VkAdsClient;

  const raw = captureRawTool(client);
  const result = await raw({ path: "v2/ad_plans/1.json", method: "POST", body: { status: "blocked" } });

  assert.equal(result.isError, true);
  assert.match(text(result), /confirmWrite=true/);
  assert.equal(calls.length, 0);
});

test("raw_request runs a POST when confirmWrite is true", async () => {
  const calls: unknown[][] = [];
  const client = {
    request: async (...args: unknown[]) => {
      calls.push(args);
      return { id: 41 };
    },
    get: async () => ({ id: 41, name: "X", status: "blocked" }),
  } as unknown as VkAdsClient;

  const raw = captureRawTool(client);
  const result = await raw({ path: "v2/ad_plans.json", method: "POST", body: { name: "X" }, confirmWrite: true });

  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "POST");
  assert.equal(JSON.parse(text(result)).id, 41);
});

test("raw_request runs a GET without confirmWrite", async () => {
  const calls: unknown[][] = [];
  const client = {
    request: async (...args: unknown[]) => {
      calls.push(args);
      return { count: 0, items: [] };
    },
  } as unknown as VkAdsClient;

  const raw = captureRawTool(client);
  const result = await raw({ path: "v2/ad_plans.json" });

  assert.equal(result.isError, undefined);
  assert.equal(calls[0][0], "GET");
});

test("raw_request forwards complete segment rule/exclusion JSON and reads back the actual rules", async () => {
  const writes: unknown[][] = [];
  const relation = { object_type: "remarketing_counter", params: { source_id: 7, goal_id: "jse:purchase", left: 30, right: 0, type: "negative" } };
  const client = {
    request: async (...args: unknown[]) => { writes.push(args); return { id: 5 }; },
    get: async (path: string, query: { fields: string }) => {
      if (path.endsWith("/relations.json")) {
        assert.match(query.fields, /params/);
        return { items: [relation] };
      }
      return { id: 5, name: "New audience", pass_condition: 1 };
    },
  } as unknown as VkAdsClient;
  const body = { name: "New audience", pass_condition: 1, relations: [relation] };
  const result = await captureRawTool(client)({ path: "v2/remarketing/segments.json", method: "POST", body, confirmWrite: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual((writes[0][2] as { body: unknown }).body, body);
  assert.deepEqual(JSON.parse(text(result)).relations, [relation]);
  assert.equal(writes.length, 1);
});

test("raw_request cannot bypass read-only with confirmWrite, including segment writes and DELETE", async (t) => {
  const previous = process.env.VK_ADS_WRITE_MODE;
  delete process.env.VK_ADS_WRITE_MODE;
  t.after(() => { if (previous === undefined) delete process.env.VK_ADS_WRITE_MODE; else process.env.VK_ADS_WRITE_MODE = previous; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({}); });
  const client = new HardenedVkAdsClient({ token: "test-token", lang: "ru", apiBase: "https://ads.vk.com/api" });
  for (const method of ["POST", "DELETE"]) {
    const result = await captureRawTool(client)({ path: "v2/remarketing/segments/1.json", method, body: {}, confirmWrite: true });
    assert.equal(result.isError, true);
    assert.match(text(result), /read-only/);
  }
  assert.equal(calls, 0);
});

test("raw_request does not replay an accepted POST after failed read-back", async () => {
  let posts = 0;
  const client = {
    request: async () => { posts++; return { id: 8 }; },
    get: async () => { throw new Error("temporary outage"); },
  } as unknown as VkAdsClient;
  const result = await captureRawTool(client)({ path: "v2/ad_plans.json", method: "POST", body: { name: "X" }, confirmWrite: true });
  assert.equal(result.isError, true);
  assert.match(text(result), /Запись принята.*Не повторяйте/);
  assert.equal(posts, 1);
});

test("raw DELETE needs explicit confirmation before reaching a client", async () => {
  let calls = 0;
  const raw = captureRawTool({ request: async () => { calls++; return {}; } } as unknown as VkAdsClient);
  assert.equal((await raw({ path: "v2/remarketing/segments/1.json", method: "DELETE" })).isError, true);
  assert.equal(calls, 0);
});
