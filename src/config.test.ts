import { test } from "node:test";
import assert from "node:assert/strict";

import { ConfigError, DEFAULT_API_BASE, assertTrustedApiBase, loadConfig } from "./config.js";

function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    run();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function reasonOf(vars: Record<string, string | undefined>): string {
  let caught: unknown;
  withEnv(vars, () => {
    try {
      loadConfig();
    } catch (err) {
      caught = err;
    }
  });
  assert.ok(caught instanceof ConfigError, "config problems must throw ConfigError");
  return caught.reason;
}

test("a missing token is not a config error", () => {
  withEnv({ VK_ADS_TOKEN: undefined, VK_ADS_API_BASE: undefined }, () => {
    const config = loadConfig();
    assert.equal(config.token, undefined);
    assert.equal(config.apiBase, DEFAULT_API_BASE);
  });
});

test("a configured server loads without throwing", () => {
  withEnv({ VK_ADS_TOKEN: "t0ken", VK_ADS_API_BASE: undefined }, () => {
    assert.equal(loadConfig().token, "t0ken");
  });
});

test("the official VK Ads API base is accepted and normalized", () => {
  assert.equal(assertTrustedApiBase("https://ads.vk.com/api"), DEFAULT_API_BASE);
  assert.equal(assertTrustedApiBase("https://ads.vk.com/api/"), DEFAULT_API_BASE);
});

test("foreign, insecure and decorated API bases are rejected", () => {
  for (const value of [
    "ads.vk.com",
    "http://ads.vk.com/api",
    "https://evil.example/api",
    "https://ads.vk.com.evil.example/api",
    "https://ads.vk.com:444/api",
    "https://user:pass@ads.vk.com/api",
    "https://ads.vk.com/api?next=https://evil.example",
    "https://ads.vk.com/api#fragment",
    "https://ads.vk.com/other",
  ]) {
    assert.equal(reasonOf({ VK_ADS_API_BASE: value }), "untrusted_api_base", value);
  }
});
