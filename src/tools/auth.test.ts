import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { TokenStore } from "../auth.js";
import type { VkAdsClient } from "../client.js";
import { readCredentials } from "../credentials.js";
import { registerAuthTools } from "./auth.js";

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

async function withTempConfig<T>(run: () => T | Promise<T>): Promise<T> {
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mcp-vk-ads-tools-"));
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
}

function captureAuthTools(tokens: TokenStore): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _def: unknown, h: Handler) => {
      handlers.set(name, h);
    },
  } as unknown as McpServer;
  registerAuthTools(server, {} as VkAdsClient, tokens);
  return handlers;
}

function payload(result: CallToolResult): Record<string, unknown> {
  return JSON.parse((result.content[0] as { text: string }).text);
}

test("start_login exposes Windows local setup and never requests secrets", async () => {
  await withTempConfig(async () => {
    const tools = captureAuthTools(new TokenStore());
    const result = await tools.get("start_login")!({});
    const body = payload(result);

    assert.equal(result.isError, undefined);
    assert.equal(body.mode, "windows-local-dpapi");
    assert.deepEqual(body.expectedInputs, []);
    assert.match(JSON.stringify(body), /npm run auth:setup/);
    assert.match(JSON.stringify(body), /DPAPI/);
    assert.match(String(body.warning), /Не отправляйте client_secret/);
    assert.doesNotMatch(JSON.stringify(body), /пришлите.*client_secret/i);
  });
});

test("finish_login is disabled and accepts no credentials", async () => {
  await withTempConfig(async () => {
    const fetchImpl = (async () => {
      throw new Error("disabled finish_login must not touch the network");
    }) as typeof fetch;
    const tools = captureAuthTools(new TokenStore(undefined, { fetchImpl }));
    const result = await tools.get("finish_login")!({});

    assert.equal(result.isError, true);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /отключён|отключено/i);
    assert.match(text, /client_secret/);
    assert.match(text, /npm run auth:setup/);
    assert.equal(readCredentials(), undefined, "disabled login must never persist credentials");
  });
});

test("auth_status never returns an environment access token", async () => {
  await withTempConfig(async () => {
    const token = "secret-access-token-value";
    const tools = captureAuthTools(new TokenStore(token));
    const status = await tools.get("auth_status")!({});
    const text = (status.content[0] as { text: string }).text;

    assert.ok(!text.includes(token));
    assert.equal(payload(status).configured, true);
    assert.equal(payload(status).source, "env");
  });
});

test("logout cannot remove an env token and reports that fact", async () => {
  await withTempConfig(async () => {
    const tools = captureAuthTools(new TokenStore("env-token"));
    const result = payload(await tools.get("logout")!({}));

    assert.equal(result.removed, false);
    assert.equal(result.envTokenStillSet, true);
    assert.equal(readCredentials(), undefined);
  });
});
