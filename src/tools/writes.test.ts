import assert from "node:assert/strict";
import test from "node:test";
import type { VkAdsClient } from "../client.js";
import { HardenedVkAdsClient } from "../hardenedClient.js";
import { registerAdPlanTools } from "./adPlans.js";
import { registerAdGroupTools } from "./adGroups.js";
import { registerBannerTools } from "./banners.js";
import { registerRawTool } from "./raw.js";
import { VkAdsError } from "../types.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
function tools(client: VkAdsClient) {
  const handlers: Record<string, Handler> = {};
  const server = { registerTool: (name: string, _config: unknown, handler: Handler) => { handlers[name] = handler; } };
  for (const register of [registerAdPlanTools, registerAdGroupTools, registerBannerTools, registerRawTool]) register(server as never, client);
  return handlers;
}

test("plan/group/banner/raw errors expose safe validation fields without retry", async () => {
  let calls = 0;
  const error = new VkAdsError(400, { error: { code: "validation_failed", message: "Validation failed", fields: { priced_goal: { name: { code: "required", message: "Goal required" } } } } });
  const reject = async () => { calls++; throw error; };
  const handlers = tools({ post: reject, request: reject } as unknown as VkAdsClient);
  for (const [name, args] of [
    ["create_ad_plan", { name: "X", adGroups: [{ package_id: 1 }] }],
    ["create_ad_group", { adPlanId: 1, name: "X", packageId: 1 }],
    ["create_banner", { adGroupId: 1 }],
    ["raw_request", { path: "v2/ad_plans.json", method: "POST", body: {}, confirmWrite: true }],
  ] as const) {
    const result = await handlers[name](args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /HTTP 400.*validation_failed.*priced_goal.*Goal required/);
  }
  assert.equal(calls, 4);
});

test("typed create/update tools return fetched objects and banner creation uses its parent endpoint", async () => {
  const posts: Array<{ path: string; body: unknown }> = [];
  const reads: string[] = [];
  const client = {
    post: async (path: string, body: unknown) => { posts.push({ path, body }); return { id: 31 }; },
    get: async (path: string) => { reads.push(path); return { id: 31, name: "from VK", status: "blocked" }; },
    getAll: async () => ({ count: 1, items: [{ id: 32, ad_plan_id: 31, status: "blocked" }] }),
  } as unknown as VkAdsClient;
  const handlers = tools(client);
  for (const [name, args] of [
    ["create_ad_plan", { name: "X", adGroups: [{ name: "G", package_id: 2 }] }], ["update_ad_plan", { id: 31, name: "X" }],
    ["create_ad_group", { adPlanId: 1, name: "X", packageId: 2 }], ["update_ad_group", { id: 31, name: "X" }],
    ["create_banner", { adGroupId: 2, name: "X", content: { icon_256x256: { id: 77 } } }], ["update_banner", { id: 31, name: "X" }],
  ] as const) {
    const result = await handlers[name](args);
    assert.equal(result.isError, undefined, name);
    assert.equal(JSON.parse(result.content[0].text).name, "from VK", name);
  }
  assert.equal(posts[4].path, "v2/ad_groups/2/banners.json");
  assert.deepEqual((posts[4].body as { content: unknown }).content, { icon_256x256: { id: 77 } });
  assert.deepEqual(reads, ["v2/ad_plans/31.json", "v2/ad_plans/31.json", "v2/ad_groups/31.json", "v2/ad_groups/31.json", "v2/banners/31.json", "v2/banners/31.json"]);
});

test("draft forces the nested banner route blocked and rejects legacy/query-shaped routes", async (t) => {
  const previous = process.env.VK_ADS_WRITE_MODE;
  process.env.VK_ADS_WRITE_MODE = "draft";
  t.after(() => { if (previous === undefined) delete process.env.VK_ADS_WRITE_MODE; else process.env.VK_ADS_WRITE_MODE = previous; });
  const bodies: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    if (init.method === "POST") { bodies.push(JSON.parse(init.body as string)); return Response.json({ id: 31 }); }
    return Response.json({ id: 31, name: "X", status: "blocked" });
  });
  const client = new HardenedVkAdsClient({ token: "test-token", lang: "ru", apiBase: "https://ads.vk.com/api" });
  const result = await tools(client).create_banner({ adGroupId: 2, name: "X", extra: { status: "active" } });
  assert.equal(result.isError, undefined);
  assert.equal((bodies[0] as { status: string }).status, "blocked");
  await assert.rejects(client.post("v2/banners.json", {}), /full/);
  await assert.rejects(client.post("v2/ad_groups/2/banners.json?status=active", {}), /full/);
  assert.equal(bodies.length, 1);
});

test("empty/malformed plans, conflicting group inputs and existing group IDs are rejected before POST", async () => {
  let posts = 0;
  const handlers = tools({ post: async () => { posts++; return {}; } } as unknown as VkAdsClient);
  for (const input of [
    { name: "X" }, { name: "X", adGroups: [] }, { name: "X", extra: { ad_groups: [null] } },
    { name: "X", adGroups: [{}], extra: { ad_groups: [{}] } },
    { name: "X", extra: { campaigns: [{}] } },
    { name: "X", adGroups: [{ id: 7 }] }, { name: "X", adGroups: [{ ad_plan_id: 7 }] },
  ]) assert.equal((await handlers.create_ad_plan(input)).isError, true);
  assert.equal(posts, 0);
});

test("create_ad_plan sends documented ad_groups and returns independently fetched children", async () => {
  const sent: Record<string, unknown>[] = [];
  const client = {
    post: async (_path: string, body: Record<string, unknown>) => { sent.push(body); return { id: 31, ad_groups: [{ id: 32 }] }; },
    get: async () => ({ id: 31, status: "blocked" }),
    getAll: async (path: string, query: Record<string, unknown>) => {
      assert.equal(path, "v2/ad_groups.json"); assert.equal(query._ad_plan_id__in, 31);
      return { count: 1, items: [{ id: 32, ad_plan_id: 31, name: "actual VK group", status: "blocked" }] };
    },
  } as unknown as VkAdsClient;
  for (const input of [{ adGroups: [{ package_id: 2 }] }, { extra: { ad_groups: [{ package_id: 2 }] } }]) {
    const result = await tools(client).create_ad_plan({ name: "X", ...input });
    assert.equal(result.isError, undefined);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.ad_groups[0].name, "actual VK group");
  }
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].ad_groups, [{ package_id: 2 }]);
  assert.equal(sent[0].campaigns, undefined);
});

test("plan create enforces draft on children and caps without mutating caller input", async (t) => {
  const saved = { mode: process.env.VK_ADS_WRITE_MODE, cap: process.env.VK_ADS_MAX_DAILY_BUDGET };
  process.env.VK_ADS_WRITE_MODE = "draft"; process.env.VK_ADS_MAX_DAILY_BUDGET = "100";
  t.after(() => {
    for (const [key, value] of [["VK_ADS_WRITE_MODE", saved.mode], ["VK_ADS_MAX_DAILY_BUDGET", saved.cap]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  });
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (init.method === "POST") { bodies.push(JSON.parse(init.body as string)); return Response.json({ id: 31 }); }
    return Response.json(String(url).includes("ad_groups.json") ? { count: 1, items: [{ id: 32, ad_plan_id: 31, status: "blocked" }] } : { id: 31, status: "blocked" });
  });
  const client = new HardenedVkAdsClient({ token: "test-token", lang: "ru", apiBase: "https://ads.vk.com/api" });
  const group = { name: "G", package_id: 2, status: "active", budget_limit_day: 50, banners: [{ status: "active" }] };
  const result = await tools(client).create_ad_plan({ name: "X", adGroups: [group], extra: { status: "active" } });
  assert.equal(result.isError, undefined);
  assert.equal(bodies[0].status, "blocked");
  assert.equal(bodies[0].ad_groups[0].status, "blocked");
  assert.equal(bodies[0].ad_groups[0].banners[0].status, "blocked");
  assert.equal(group.status, "active");
  const rejected = await tools(client).create_ad_plan({ name: "X", adGroups: [{ ...group, budget_limit_day: 101 }] });
  assert.equal(rejected.isError, true); assert.equal(bodies.length, 1);
  const conflicting = await tools(client).create_ad_plan({ name: "X", budgetLimit: 50, budgetLimitDay: 50, adGroups: [group] });
  assert.equal(conflicting.isError, true); assert.match(conflicting.content[0].text, /только общий либо дневной/);
  const nestedConflict = await tools(client).create_ad_plan({ name: "X", adGroups: [{ ...group, budget_limit: 50 }] });
  assert.equal(nestedConflict.isError, true); assert.equal(bodies.length, 1);
});

test("missing/truncated/wrong-parent nested read-back never reports a successful plan create", async () => {
  for (const groups of [
    { count: 0, items: [] }, { count: 2, items: [{ id: 32, ad_plan_id: 31 }] },
    { count: 1, items: [{ id: 32, ad_plan_id: 99 }] },
    { count: 1, items: [{ id: 32, ad_plan_id: 31 }], _truncated: true },
  ]) {
    let posts = 0;
    const client = { post: async () => { posts++; return { id: 31 }; }, get: async () => ({ id: 31 }), getAll: async () => groups } as unknown as VkAdsClient;
    const result = await tools(client).create_ad_plan({ name: "X", adGroups: [{ package_id: 2 }] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Запись принята.*Не повторяйте/);
    assert.equal(posts, 1);
  }
});
