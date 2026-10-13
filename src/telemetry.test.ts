import { test } from "node:test";
import assert from "node:assert/strict";

import { Telemetry, telemetryEnabled } from "./telemetry.js";

test("telemetry is permanently disabled in the hardened fork", () => {
  assert.equal(telemetryEnabled(), false);
});

test("telemetry methods never perform network requests", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("telemetry must not call fetch");
  }) as typeof fetch;

  try {
    const telemetry = new Telemetry("test");
    telemetry.send("server_start");
    telemetry.send("tool_call", { tool: "get_balance" });
    await telemetry.sendBlocking("startup_failed", { reason: "test" });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
