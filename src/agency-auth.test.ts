import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "./auth.js";
import { credentialsPath, readCredentials, writeCredentials } from "./credentials.js";
import { mintToken, refreshAccessToken } from "./oauth.js";
import { runLocalSetup } from "./setupWorkflow.js";
import { listManagerClients, verifyTokenAccount } from "./accountVerification.js";
import { validateAuthTarget, type AuthTarget } from "./authTarget.js";

const target: AuthTarget = { type: "agency-client", agencyClientName: "example@agency_client", userId: 123 };
const secret = "FAKE-CLIENT-SECRET-NOT-REAL";
const at = "FAKE-ACCESS-TOKEN-NOT-REAL";
const rt = "FAKE-REFRESH-TOKEN-NOT-REAL";
const user = { id: 123, username: "example@agency_client" };
const token = { access_token: at, refresh_token: rt, expires_in: 86400 };

async function isolated(run: () => Promise<void>): Promise<void> {
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agency-auth-test-"));
  try { await run(); }
  finally { if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved; }
}

function network(handler: (url: string, init: RequestInit) => unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    assert.equal(init.redirect, "error");
    const body = handler(String(url), init);
    return body instanceof Response ? body : new Response(JSON.stringify(body));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("own and agency mint use distinct grants; agency_client_name carries login not numeric ID", async () => {
  const mock = network(() => token);
  await mintToken({ clientId: "cid", clientSecret: secret, target: { type: "own" }, fetchImpl: mock.fetchImpl });
  await mintToken({ clientId: "cid", clientSecret: secret, target, fetchImpl: mock.fetchImpl });
  const own = new URLSearchParams(String(mock.calls[0].init.body));
  const agency = new URLSearchParams(String(mock.calls[1].init.body));
  assert.equal(own.get("grant_type"), "client_credentials");
  assert.equal(own.has("agency_client_name"), false);
  assert.equal(agency.get("grant_type"), "agency_client_credentials");
  assert.equal(agency.get("agency_client_name"), user.username);
  assert.equal(agency.has("agency_client_id"), false);
});

test("agency credentials and target round-trip through Windows DPAPI with no plaintext secrets", async () => {
  await isolated(async () => {
    const mock = network(url => url.includes("oauth2") ? token : user);
    const store = new TokenStore(undefined, { fetchImpl: mock.fetchImpl });
    await store.connect({ clientId: "cid", clientSecret: secret, target });
    assert.deepEqual(readCredentials()?.target, target);
    assert.equal(readCredentials()?.username, user.username);
    const status = JSON.stringify(store.status());
    for (const value of [secret, at, rt]) assert.equal(status.includes(value), false);
    if (process.platform === "win32") {
      const raw = readFileSync(credentialsPath(), "utf8");
      for (const value of [secret, at, rt, user.username]) assert.equal(raw.includes(value), false);
      assert.equal(JSON.parse(raw).scope, "CurrentUser");
      assert.equal(JSON.parse(raw).format, "dpapi-v1");
    }
  });
});

test("wrong manager, other client, missing username or wrong ID never persists candidate credentials", async () => {
  for (const wrong of [{ id: 999, username: "manager" }, { id: 123, username: "other@agency_client" }, { id: 123 }, { ...user, id: 999 }, { ...user, id: 0 }]) {
    await isolated(async () => {
      const mock = network(url => url.includes("oauth2") ? token : wrong);
      await assert.rejects(new TokenStore(undefined, { fetchImpl: mock.fetchImpl }).connectVerified({ clientId: "cid", clientSecret: secret, target }), /кабинет|username/);
      assert.equal(existsSync(credentialsPath()), false);
    });
  }
});

test("failed setup does not delete or overwrite a previous verified login", async () => {
  await isolated(async () => {
    const previous = { client_id: "old", client_secret: secret, access_token: "OLD-TOKEN", obtained_at: 1 };
    writeCredentials(previous);
    const mock = network(url => url.includes("oauth2") ? token : { id: 999, username: "manager" });
    await assert.rejects(new TokenStore(undefined, { fetchImpl: mock.fetchImpl }).connectVerified({ clientId: "cid", clientSecret: secret, target }));
    assert.deepEqual(readCredentials(), previous);
  });
});

test("agency refresh uses ordinary refresh grant and verifies same login and user ID before storage", async () => {
  await isolated(async () => {
    writeCredentials({ client_id: "cid", client_secret: secret, access_token: "old", refresh_token: rt, obtained_at: 1, expires_at: 2, target, username: user.username });
    const mock = network(url => url.includes("oauth2") ? { ...token, refresh_token: "rotated" } : user);
    const store = new TokenStore(undefined, { fetchImpl: mock.fetchImpl });
    assert.equal(await store.getToken(), at);
    const form = new URLSearchParams(String(mock.calls[0].init.body));
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), rt);
    assert.equal(form.has("agency_client_name"), false);
    assert.equal(form.has("agency_client_id"), false);
    assert.equal(mock.calls[1].init.method, "GET");
    assert.match(mock.calls[1].url, /v3\/user\.json/);
    assert.deepEqual(readCredentials()?.target, target);
    assert.equal(readCredentials()?.refresh_token, "rotated");
  });
});

test("wrong account after agency refresh removes invalid old credentials and never returns manager token", async () => {
  await isolated(async () => {
    writeCredentials({ client_id: "cid", client_secret: secret, access_token: "old", refresh_token: rt, obtained_at: 1, expires_at: 2, target, username: user.username });
    const mock = network(url => url.includes("oauth2") ? token : { id: 999, username: "manager" });
    await assert.rejects(new TokenStore(undefined, { fetchImpl: mock.fetchImpl }).getToken(), /другой кабинет/);
    assert.equal(readCredentials(), undefined);
  });
});

test("malformed stored target is refused instead of downgraded to own account", () => {
  assert.throws(() => validateAuthTarget({ type: "agency-client" }));
  assert.throws(() => validateAuthTarget({ type: "unknown" }));
});

test("unparseable persisted agency metadata cannot be used as own credentials", async () => {
  await isolated(async () => {
    writeCredentials({ client_id: "cid", client_secret: secret, access_token: at, obtained_at: 1,
      target: { type: "agency-client" } as AuthTarget, username: user.username });
    assert.equal(readCredentials(), undefined);
    await assert.rejects(new TokenStore(undefined).getToken(), /npm run auth:setup/);
  });
});

test("agency refresh without rotated refresh_token keeps original refresh token and target", async () => {
  await isolated(async () => {
    writeCredentials({ client_id: "cid", client_secret: secret, access_token: "old", refresh_token: rt, obtained_at: 1, expires_at: 2, target, username: user.username });
    const mock = network(url => url.includes("oauth2") ? { access_token: at, expires_in: 86400 } : user);
    await new TokenStore(undefined, { fetchImpl: mock.fetchImpl }).getToken();
    assert.equal(readCredentials()?.refresh_token, rt);
    assert.deepEqual(readCredentials()?.target, target);
  });
});

test("refresh account mismatch cannot delete a newer successful local setup", async () => {
  await isolated(async () => {
    writeCredentials({ client_id: "cid", client_secret: secret, access_token: "old", refresh_token: rt, obtained_at: 1, expires_at: 2, target, username: user.username });
    const mock = network(url => {
      if (url.includes("oauth2")) return token;
      writeCredentials({ client_id: "cid", client_secret: secret, access_token: "NEWER-LOGIN", obtained_at: 3, target, username: user.username });
      return { id: 999, username: "manager" };
    });
    await assert.rejects(new TokenStore(undefined, { fetchImpl: mock.fetchImpl }).getToken(), /другой кабинет/);
    assert.equal(readCredentials()?.access_token, "NEWER-LOGIN");
  });
});

test("manager list uses nested user.id rather than manager relationship ID and follows pagination", async () => {
  const mock = network(url => url.includes("offset=0") ? { count: 251, items: Array.from({ length: 250 }, (_, i) => ({ id: 1000 + i, user: { id: i + 1, username: `c${i}`, additional_info: { client_name: `Name ${i}` } } })) } : { count: 251, items: [{ user: { id: 251, username: "last" } }] });
  const clients = await listManagerClients(at, mock);
  assert.equal(clients.length, 251);
  assert.equal(clients[0].id, 1);
  assert.equal(clients[0].name, "Name 0");
  assert.equal(mock.calls.length, 2);
  assert.ok(mock.calls.every(call => call.init.method === "GET"));
});

test("local agency UX keeps manager token in memory and exposes only the selected target", async () => {
  await isolated(async () => {
    const answers = ["cid"];
    let output = "";
    let minted = 0;
    const mock = network((url, init) => {
      if (url.includes("oauth2")) {
        assert.equal(existsSync(credentialsPath()), false);
        minted++;
        return { ...token, access_token: minted === 1 ? "MANAGER-FAKE-TOKEN" : at };
      }
      if (url.includes("manager/clients")) return { count: 2, items: [{ user }, { user: { id: 456, username: "other@agency_client", additional_info: { client_name: "Other" } } }] };
      return (init.headers as Record<string, string>).Authorization.includes("MANAGER") ? { id: 999, username: "manager" } : user;
    });
    await runLocalSetup({ ask: async () => answers.shift() ?? "", readSecret: async () => secret, write: value => { output += value; } }, { fetchImpl: mock.fetchImpl, expectedManagerId: 999, expectedAgencyClientName: user.username });
    assert.equal(minted, 2);
    assert.deepEqual(readCredentials()?.target, target);
    for (const value of [secret, at, rt, "MANAGER-FAKE-TOKEN", "other@agency_client"]) assert.equal(output.includes(value), false);
    assert.ok(output.includes(user.username));
  });
});

test("own local UX verifies own account and preserves client_credentials", async () => {
  await isolated(async () => {
    const answers = ["1", "cid"];
    const mock = network(url => url.includes("oauth2") ? token : user);
    await runLocalSetup({ ask: async () => answers.shift() ?? "", readSecret: async () => secret, write: () => {} }, mock);
    assert.equal(new URLSearchParams(String(mock.calls[0].init.body)).get("grant_type"), "client_credentials");
    assert.deepEqual(readCredentials()?.target, { type: "own" });
  });
});

test("when manager list is forbidden setup asks for login, and still verifies agency token", async () => {
  await isolated(async () => {
    const answers = ["2", "cid", user.username];
    let tokens = 0;
    const mock = network(url => {
      if (url.includes("oauth2")) return { ...token, access_token: ++tokens === 1 ? "manager-token" : at };
      if (url.includes("manager/clients")) return new Response("forbidden", { status: 403 });
      return tokens === 1 ? { id: 999, username: "manager" } : user;
    });
    await runLocalSetup({ ask: async () => answers.shift() ?? "", readSecret: async () => secret, write: () => {} }, { ...mock, expectedManagerId: 999 });
    assert.equal(readCredentials()?.target?.type, "agency-client");
    assert.equal(readCredentials()?.username, user.username);
  });
});

test("API or fetch error cannot reflect client_secret or refresh_token in OAuth output", async () => {
  const mock = network(() => new Response(JSON.stringify({ error: "invalid_client", error_description: `${secret} ${rt}` }), { status: 401 }));
  await assert.rejects(mintToken({ clientId: "cid", clientSecret: secret, target, fetchImpl: mock.fetchImpl }), error => error instanceof Error && !error.message.includes(secret));
  await assert.rejects(refreshAccessToken({ clientId: "cid", clientSecret: secret, refreshToken: rt, fetchImpl: mock.fetchImpl }), error => error instanceof Error && !error.message.includes(secret) && !error.message.includes(rt));
  const leakingFetch = (async () => { throw new Error(secret); }) as typeof fetch;
  await assert.rejects(mintToken({ clientId: "cid", clientSecret: secret, fetchImpl: leakingFetch }), error => error instanceof Error && !error.message.includes(secret));
  await assert.rejects(verifyTokenAccount(at, target, { fetchImpl: leakingFetch }), error => error instanceof Error && !error.message.includes(secret));
});
