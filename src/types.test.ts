import { test } from "node:test";
import assert from "node:assert/strict";
import { VkAdsError } from "./types.js";

test("generic VK validation messages retain nested field paths, codes and constraints", () => {
  const fields = { campaigns: { items: [{ priced_goal: { source_id: { code: "required", message: "Source required" } }, budget_limit_day: { code: "min_value", message: "Too small", min_value: 300 } }] } };
  const err = new VkAdsError(400, { error: { code: "validation_failed", message: "Validation failed", fields } });
  assert.match(err.message, /HTTP 400.*validation_failed.*Validation failed.*campaigns.*items.*priced_goal.*source_id.*required.*Source required.*min_value.*300/);
  assert.deepEqual(err.body, { error: { code: "validation_failed", message: "Validation failed", fields } });
});

test("VK diagnostics exclude credential/header/request/value echoes and known bearer values", () => {
  const err = new VkAdsError(400, { error: { code: "validation_failed", message: "Rejected live-access", fields: {
    client_secret: { message: "secret-a" }, refresh_token: "secret-b", authorization: "secret-c",
    priced_goal: { code: "invalid", message: "Bearer reflected-access", value: "secret-d" },
    password: "secret-e", email: "secret-f", phone: "secret-g",
  }, request: { headers: { Authorization: "secret-h" } } }, request: "secret-i", details: "secret-j" }, ["live-access"]);
  const output = JSON.stringify({ message: err.message, body: err.body });
  for (const secret of ["live-access", "reflected-access", ..."abcdefghij".split("").map(c => `secret-${c}`)]) assert.equal(output.includes(secret), false);
  assert.match(output, /priced_goal.*invalid/);
});

test("legacy and OAuth diagnostics remain readable and redact credential assignments", () => {
  assert.match(new VkAdsError(400, { name: ["This field is required"] }).message, /This field is required/);
  const err = new VkAdsError(401, { error: "invalid_grant", error_description: "client_secret=hidden-value" });
  assert.match(err.message, /invalid_grant/);
  assert.equal(err.message.includes("hidden-value"), false);
});

test("malformed or oversized diagnostic trees are bounded", () => {
  const cycle: Record<string, unknown> = {}; cycle.field = cycle;
  assert.ok(new VkAdsError(400, cycle).message.length < 13000);
  const err = new VkAdsError(400, { error: { fields: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [String(i), "x".repeat(5000)])) } });
  assert.ok(err.message.length <= 12020);
});
