import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "./auth.js";
import { VkAdsClient } from "./client.js";
import { credentialsPath, readCredentials, writeCredentials } from "./credentials.js";
import { runLocalSetup } from "./setupWorkflow.js";

const token = "FAKE-ELAMA-TOKEN-NOT-A-SECRET";
const user = { id: 12345, username: "example@agency_client" };
const target = { type: "agency-client" as const, agencyClientName: user.username };

async function isolated(run: () => Promise<void>) {
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mcp-vk-token-import-"));
  try { await run(); }
  finally { if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved; }
}

function verificationFetch(body: unknown, status = 200): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), "https://ads.vk.com/api/v3/user.json?fields=id,username,additional_info");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${token}`);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

test("ready-token import verifies one GET and stores a bound token without fake OAuth credentials", async () => {
  await isolated(async () => {
    const store = new TokenStore(undefined, { fetchImpl: verificationFetch(user) });
    const imported = await store.importAccessToken({ accessToken: token, target });
    assert.equal(imported.authMethod, "access-token");
    assert.deepEqual(readCredentials(), imported);
    assert.deepEqual(imported.target, { ...target, userId: user.id });
    for (const key of ["client_id", "client_secret", "refresh_token", "expires_at"]) assert.equal(Object.hasOwn(imported, key), false);
    assert.equal(await store.getToken(), token);
    assert.equal(store.canRefresh(), false);
    assert.equal(store.status().canRefresh, false);
    assert.equal(store.status().authMethod, "access-token");
    assert.equal(store.status().expiresAtKnown, false);
    assert.equal(JSON.stringify(store.status()).includes(token), false);
    await assert.rejects(store.refresh(), /не продлевается автоматически/);
    if (process.platform === "win32") {
      const raw = readFileSync(credentialsPath(), "utf8");
      assert.equal(raw.includes(token), false);
      assert.equal(raw.includes(user.username), false);
      assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["ciphertext", "format", "scope"]);
      assert.equal(JSON.parse(raw).scope, "CurrentUser");
    }
  });
});

test("wrong manager, other client and wrong user ID cannot be imported", async () => {
  for (const wrong of [{ id: 777, username: "manager" }, { id: 12345, username: "other@agency_client" }, { id: 12345 }, { ...user, id: 54321 }]) {
    await isolated(async () => {
      const store = new TokenStore(undefined, { fetchImpl: verificationFetch(wrong) });
      await assert.rejects(store.importAccessToken({ accessToken: token, target: { ...target, userId: user.id } }));
      assert.equal(existsSync(credentialsPath()), false);
    });
  }
});

test("failed token verification preserves an existing login", async () => {
  await isolated(async () => {
    const previous = { client_id: "cid", client_secret: "fake-secret", access_token: "old-fake-token", obtained_at: 1 };
    writeCredentials(previous);
    const store = new TokenStore(undefined, { fetchImpl: verificationFetch({ id: 777, username: "manager" }) });
    await assert.rejects(store.importAccessToken({ accessToken: token, target }));
    assert.deepEqual(readCredentials(), previous);
  });
});

test("local token workflow uses hidden input only, with no client_id or secret prompt", async () => {
  await isolated(async () => {
    let output = "";
    let secretPrompts = 0;
    await runLocalSetup({
      ask: async () => { assert.fail("the expected client is already selected"); },
      readSecret: async prompt => { assert.match(prompt, /access_token/); secretPrompts++; return token; },
      write: message => { output += message; },
    }, { authMethod: "access-token", expectedAgencyClientName: user.username, fetchImpl: verificationFetch(user) });
    assert.equal(secretPrompts, 1);
    assert.equal(output.includes(token), false);
    assert.equal(output.includes("client_id:"), false);
    assert.match(output, /Срок действия неизвестен/);
    assert.match(output, /Автоматического refresh нет/);
  });
});

test("a reflected token in provider errors never reaches local output or errors", async () => {
  await isolated(async () => {
    let output = "";
    await assert.rejects(runLocalSetup({ ask: async () => user.username, readSecret: async () => token, write: message => { output += message; } },
      { authMethod: "access-token", fetchImpl: verificationFetch({ error: token }, 401) }),
      error => error instanceof Error && /HTTP 401/.test(error.message) && !error.message.includes(token));
    assert.equal(output.includes(token), false);
    assert.equal(existsSync(credentialsPath()), false);
  });
});

test("token import rejects blank/Bearer input and own target before network", async () => {
  await isolated(async () => {
    const fetchImpl = (async () => { assert.fail("invalid import must not hit the network"); }) as typeof fetch;
    const store = new TokenStore(undefined, { fetchImpl });
    for (const value of ["", "Bearer fake", "fake\nvalue", "fake\0value"]) {
      await assert.rejects(store.importAccessToken({ accessToken: value, target }));
    }
    await assert.rejects(store.importAccessToken({ accessToken: token, target: { type: "own" } as unknown as typeof target }));
    assert.equal(existsSync(credentialsPath()), false);
  });
});

test("malformed imported metadata cannot bypass OAuth credential requirements", async () => {
  await isolated(async () => {
    const base = { authMethod: "access-token" as const, access_token: token, obtained_at: 1, username: user.username, target: { ...target, userId: user.id } };
    for (const overrides of [{ authMethod: undefined }, { authMethod: "unknown" }, { client_secret: "unexpected" }, { refresh_token: "unexpected" }, { target: { ...target } }, { username: "manager" }]) {
      writeCredentials({ ...base, ...overrides } as Parameters<typeof writeCredentials>[0]);
      assert.equal(readCredentials(), undefined);
    }
  });
});

test("imported token 401 is actionable and cannot trigger an OAuth request", async () => {
  await isolated(async () => {
    const store = new TokenStore(undefined, { fetchImpl: verificationFetch(user) });
    await store.importAccessToken({ accessToken: token, target });
    const original = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      assert.equal(init?.method, "GET");
      reads++;
      return new Response(JSON.stringify({ message: token }), { status: 401 });
    }) as typeof fetch;
    try {
      const client = new VkAdsClient({ apiBase: "https://ads.vk.com/api", lang: "ru", maxRetries: 0 }, store);
      await assert.rejects(client.get("v3/user.json"), error => error instanceof Error && /auth:token/.test(error.message) && !error.message.includes(token));
      assert.equal(reads, 1);
      assert.equal(store.canRefresh(), false);
    } finally { globalThis.fetch = original; }
  });
});
