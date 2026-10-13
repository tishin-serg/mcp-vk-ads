import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  clearCredentials,
  credentialsPath,
  readCredentials,
  writeCredentials,
  type StoredCredentials,
} from "./credentials.js";

const windowsOnly = { skip: process.platform !== "win32" };

test("Windows credentials are encrypted at rest with DPAPI CurrentUser", windowsOnly, () => {
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mcp-vk-ads-dpapi-"));

  try {
    const credentials: StoredCredentials = {
      client_id: "cid-123",
      client_secret: "client-secret-should-never-be-on-disk",
      access_token: "access-token-should-never-be-on-disk",
      refresh_token: "refresh-token-should-never-be-on-disk",
      obtained_at: Date.now(),
      expires_at: Date.now() + 60_000,
      username: "adv@example",
    };

    writeCredentials(credentials);

    const raw = readFileSync(credentialsPath(), "utf8");
    assert.doesNotMatch(raw, /client-secret-should-never-be-on-disk/);
    assert.doesNotMatch(raw, /access-token-should-never-be-on-disk/);
    assert.doesNotMatch(raw, /refresh-token-should-never-be-on-disk/);

    const envelope = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(envelope.format, "dpapi-v1");
    assert.equal(envelope.scope, "CurrentUser");
    assert.equal(typeof envelope.ciphertext, "string");

    const restored = readCredentials();
    assert.deepEqual(restored, credentials);
    assert.equal(clearCredentials(), true);
    assert.equal(readCredentials(), undefined);
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
});
