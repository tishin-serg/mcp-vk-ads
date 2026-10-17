import assert from "node:assert/strict";
import test from "node:test";
import type { VkAdsClient } from "../client.js";
import { HardenedVkAdsClient } from "../hardenedClient.js";
import { registerAdPlanTools } from "./adPlans.js";
import { registerAdGroupTools } from "./adGroups.js";
import { registerBannerTools } from "./banners.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
function tools(client: VkAdsClient) {
  const handlers: Record<string, Handler> = {};
  const server = { registerTool: (name: string, _config: unknown, handler: Handler) => { handlers[name] = handler; } };
  for (const register of [registerAdPlanTools, registerAdGroupTools, registerBannerTools]) register(server as never, client);
  return handlers;
}

test("typed create/update tools return fetched objects and banner creation uses its parent endpoint", async () => {
  const posts: Array<{ path: string; body: unknown }> = [];
  const reads: string[] = [];
  const client = {
    post: async (path: string, body: unknown) => { posts.push({ path, body }); return { id: 31 }; },
    get: async (path: string) => { reads.push(path); return { id: 31, name: "from VK", status: "blocked" }; },
  } as unknown as VkAdsClient;
  const handlers = tools(client);
  for (const [name, args] of [
    ["create_ad_plan", { name: "X" }], ["update_ad_plan", { id: 31, name: "X" }],
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
