import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    getAll: async () => ({ count: 1, items: [{ id: 42, ad_plan_id: 41, status: "blocked" }] }),
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

test("segment unknown_source preserves the submitted JSON and stops without replay or read-back", async (t) => {
  const previous = process.env.VK_ADS_WRITE_MODE;
  process.env.VK_ADS_WRITE_MODE = "full";
  t.after(() => { if (previous === undefined) delete process.env.VK_ADS_WRITE_MODE; else process.env.VK_ADS_WRITE_MODE = previous; });
  // Reproduce only the supplied failure shape. No real credentials or VK request.
  const body = { name: "Synthetic exclusion", pass_condition: 0, relations: [{ object_type: "segment", object_id: 123 }] };
  const calls: Array<{ method?: string; body: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    calls.push({ method: init?.method, body: JSON.parse(String(init?.body)) });
    return Response.json({ error: { code: "unknown_source", message: "Segment not found" } }, { status: 400 });
  });
  const client = new HardenedVkAdsClient({ token: "synthetic-secret", lang: "ru", apiBase: "https://ads.vk.com/api", maxRetries: 3 });
  const result = await captureRawTool(client)({ path: "v2/remarketing/segments.json", method: "POST", body, confirmWrite: true });
  assert.equal(result.isError, true);
  assert.match(text(result), /400.*unknown_source.*Segment not found/s);
  assert.equal(text(result).includes("synthetic-secret"), false);
  assert.deepEqual(calls, [{ method: "POST", body }]);
  // A readable internal node is not proof that VK accepts it in a new write.
  // raw_request must not rewrite IDs, switch routes, or invent a different NOT.
});

type CounterRelation = {
  object_type: string;
  params: { source_id: number; goal_id: string; type: string; left: number; right: number };
};
type SegmentExample = {
  path: string;
  method: string;
  confirmWrite: boolean;
  body: { name: string; pass_condition: number; relations: CounterRelation[] };
};
const segmentExamples = JSON.parse(readFileSync(new URL("../../docs/examples/retargeting-counter-segments.json", import.meta.url), "utf8")) as SegmentExample[];

test("documented counter segment examples keep direct positive/negative sources intact through raw_request", async () => {
  assert.equal(segmentExamples.length, 3);
  for (const example of segmentExamples) {
    assert.equal(example.path, "v2/remarketing/segments.json");
    assert.equal(example.method, "POST");
    assert.equal(example.confirmWrite, true);
    assert.equal(example.body.pass_condition, example.body.relations.length);
    const writes: unknown[] = [];
    const client = {
      request: async (_method: unknown, _path: unknown, opts: { body: unknown }) => { writes.push(opts.body); return { id: 11 }; },
      get: async (path: string) => path.endsWith("/relations.json")
        ? { items: example.body.relations }
        : { id: 11, name: example.body.name, pass_condition: example.body.pass_condition },
    } as unknown as VkAdsClient;
    const result = await captureRawTool(client)(example as unknown as Record<string, unknown>);
    assert.equal(result.isError, undefined);
    assert.deepEqual(writes, [example.body]);
    assert.deepEqual(JSON.parse(text(result)).relations, example.body.relations);
    for (const relation of example.body.relations) {
      assert.equal(relation.object_type, "remarketing_counter");
      assert.equal(relation.params.source_id, 1234567); // documentation placeholder
      assert.equal(relation.params.right, 0);
      assert.ok(relation.params.left > 0 && relation.params.left <= 365);
      assert.ok(["positive", "negative"].includes(relation.params.type));
    }
  }
  assert.deepEqual(segmentExamples.map(x => x.body.relations.map(r => [r.params.goal_id, r.params.type, r.params.left])), [
    [["jse:addToCart", "positive", 3], ["jse:purchase", "negative", 30]],
    [["jse:addToCart", "positive", 15], ["jse:addToCart", "negative", 3], ["jse:purchase", "negative", 30]],
    [["jse:addToCart", "positive", 30], ["jse:addToCart", "negative", 15], ["jse:purchase", "negative", 30]],
  ]);
});

test("example audiences partition cumulative user sets, including repeat carts and buyers", () => {
  // Abstract membership, not an emulator of VK timing, rounding or propagation.
  const cartStates = [[], [30], [15, 30], [3, 15, 30]];
  for (const membership of cartStates) {
    for (const purchased of [false, true]) {
      const actual = segmentExamples.map(example => {
        const matches = example.body.relations.filter(({ params }) => {
          const included = params.goal_id === "jse:purchase" ? purchased : membership.includes(params.left);
          return params.type === "negative" ? !included : included;
        }).length;
        return matches >= example.body.pass_condition;
      });
      const expected = [3, 15, 30].map((window, index) => !purchased && membership.includes(window) && (index === 0 || !membership.includes([3, 15, 30][index - 1])));
      assert.deepEqual(actual, expected);
      assert.equal(actual.filter(Boolean).length, purchased || membership.length === 0 ? 0 : 1);
    }
  }
});
