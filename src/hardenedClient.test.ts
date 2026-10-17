import { test } from "node:test";
import assert from "node:assert/strict";

import { HardenedVkAdsClient } from "./hardenedClient.js";
import type { VkAdsConfig } from "./types.js";

const config: VkAdsConfig = {
  token: "test-token",
  lang: "ru",
  apiBase: "https://ads.vk.com/api",
  maxRetries: 0,
};

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const saved = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withRecordingFetch<T>(run: (bodies: unknown[]) => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    return await run(bodies);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("read-only is the default and blocks writes before network", async () => {
  await withEnv({ VK_ADS_WRITE_MODE: undefined }, async () => {
    await withRecordingFetch(async (bodies) => {
      const client = new HardenedVkAdsClient(config);
      await assert.rejects(client.post("v2/ad_plans.json", { name: "test" }), /read-only/);
      assert.equal(bodies.length, 0);
    });
  });
});

test("draft creation is forced to blocked status", async () => {
  await withEnv({ VK_ADS_WRITE_MODE: "draft" }, async () => {
    await withRecordingFetch(async (bodies) => {
      const client = new HardenedVkAdsClient(config);
      await client.post("v2/ad_plans.json", { name: "test", status: "active" });
      assert.deepEqual(bodies[0], { name: "test", status: "blocked" });
    });
  });
});

test("draft mode allows stop only on known ad entity item paths", async () => {
  await withEnv({ VK_ADS_WRITE_MODE: "draft" }, async () => {
    await withRecordingFetch(async (bodies) => {
      const client = new HardenedVkAdsClient(config);
      await client.post("v2/ad_plans/123.json", { status: "blocked" });
      assert.equal(bodies.length, 1);

      await assert.rejects(
        client.post("v2/oauth2/token/delete.json", { status: "blocked" }),
        /VK_ADS_WRITE_MODE=full/,
      );
      await assert.rejects(
        client.post("v2/ad_plans/123.json", { budget_limit_day: 5000 }),
        /VK_ADS_WRITE_MODE=full/,
      );
      assert.equal(bodies.length, 1);
    });
  });
});

test("delete is blocked outside full mode", async () => {
  await withEnv({ VK_ADS_WRITE_MODE: "draft" }, async () => {
    await withRecordingFetch(async (bodies) => {
      const client = new HardenedVkAdsClient(config);
      await assert.rejects(client.delete("v2/ad_plans/123.json"), /только.*full/);
      assert.equal(bodies.length, 0);
    });
  });
});

test("budget caps apply even in full mode", async () => {
  await withEnv(
    {
      VK_ADS_WRITE_MODE: "full",
      VK_ADS_MAX_DAILY_BUDGET: "1000",
      VK_ADS_MAX_TOTAL_BUDGET: "10000",
    },
    async () => {
      await withRecordingFetch(async (bodies) => {
        const client = new HardenedVkAdsClient(config);
        await assert.rejects(
          client.post("v2/ad_plans/123.json", { budget_limit_day: 1001 }),
          /safety cap 1000/,
        );
        await assert.rejects(
          client.post("v2/ad_plans/123.json", { budget_limit: 10001 }),
          /safety cap 10000/,
        );
        assert.equal(bodies.length, 0);
      });
    },
  );
});

test("nested JSON creates cannot bypass caps or create active children in draft", async () => {
  await withEnv({ VK_ADS_WRITE_MODE: "draft", VK_ADS_MAX_DAILY_BUDGET: "100" }, async () => {
    await withRecordingFetch(async (bodies) => {
      const client = new HardenedVkAdsClient(config);
      for (const budget of [101, null, 0, -1, "unlimited", true]) {
        await assert.rejects(client.post("v2/ad_plans.json", { name: "X", ad_groups: [{ budget_limit_day: budget }] }), /отклонена/);
      }
      assert.equal(bodies.length, 0);
      await client.post("v2/ad_plans.json", { status: "active", ad_groups: [{ status: "active", budget_limit_day: 50, banners: [{ status: "active" }] }] });
      const body = bodies[0] as { status: string; ad_groups: { status: string; banners: { status: string }[] }[] };
      assert.equal(body.status, "blocked");
      assert.equal(body.ad_groups[0].status, "blocked");
      assert.equal(body.ad_groups[0].banners[0].status, "blocked");
    });
  });
});
