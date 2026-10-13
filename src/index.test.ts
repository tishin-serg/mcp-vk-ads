import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Boots the real entrypoint as a child process and completes a real MCP handshake
 * over stdio. Run from source (`node --import tsx src/index.ts`) rather than dist/,
 * because `npm test` runs before the build in the publish lifecycle. No network:
 * the handshake never calls the VK Ads API, so a dummy token is enough.
 */
async function connectToServer(overrides: Record<string, string | undefined> = {}): Promise<Client> {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;

  const merged: Record<string, string> = {
    ...env,
    VK_ADS_TOKEN: "test-token",
    ASKADS_TELEMETRY: "0",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("./index.ts", import.meta.url))],
    cwd: repoRoot,
    stderr: "ignore",
    env: merged,
  });
  const client = new Client({ name: "instructions-smoke", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/**
 * A server with no token at all: no env var, and a config dir that cannot hold a
 * stored login. Both halves matter — pointing XDG_CONFIG_HOME at a fresh temp dir
 * is what keeps the developer's own credentials.json from making this pass.
 */
async function connectUnconfigured(): Promise<Client> {
  return connectToServer({
    VK_ADS_TOKEN: undefined,
    XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "mcp-vk-ads-unconfigured-")),
  });
}

test("initialize carries non-empty server instructions", async () => {
  const client = await connectToServer();
  try {
    const instructions = client.getInstructions();
    assert.ok(instructions, "initialize result must carry instructions");
    assert.ok(instructions.trim().length > 0, "instructions must not be blank");
    assert.ok(
      instructions.length <= 1500,
      `instructions must stay within budget, got ${instructions.length} chars`,
    );
    assert.match(instructions, /ads\.vk\.com/);
  } finally {
    await client.close();
  }
});

test("without a token the server still starts and completes the handshake", async () => {
  const client = await connectUnconfigured();
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("start_login"), "the safe setup helper must remain available");
    assert.ok(tools.includes("finish_login"), "the disabled legacy entrypoint must be explicit");
    assert.ok(tools.includes("list_ad_plans"), "and must not hide the real tools");

    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /не подключена/, "instructions must state the server is unusable");
    assert.match(instructions, /VK_ADS_TOKEN/, "instructions must name the local temporary setup");
    assert.match(
      instructions,
      /Не передавайте client_secret через AI-чат/,
      "instructions must explicitly keep the app secret out of model context",
    );
    assert.doesNotMatch(
      instructions,
      /пришлите.*client_secret/i,
      "instructions must never ask for the app secret",
    );
  } finally {
    await client.close();
  }
});

test("an unconfigured data call returns safe actionable text", async () => {
  const client = await connectUnconfigured();
  try {
    const result = (await client.callTool({ name: "get_user_info", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    assert.equal(result.isError, true);
    const text = result.content.map((c) => c.text ?? "").join(" ");
    assert.match(text, /VK_ADS_TOKEN/);
    assert.match(text, /не поможет|не сбой сети/);
    assert.match(text, /Не передавайте client_secret/);
    assert.doesNotMatch(text, /пришлите.*client_secret/i);
  } finally {
    await client.close();
  }
});

test("start_login gives only local-token instructions", async () => {
  const client = await connectUnconfigured();
  try {
    const result = (await client.callTool({ name: "start_login", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    assert.notEqual(result.isError, true);
    const body = JSON.parse(result.content[0]?.text ?? "{}") as {
      mode?: string;
      steps?: string[];
      expectedInputs?: string[];
      warning?: string;
    };
    assert.equal(body.mode, "local-token-only");
    assert.deepEqual(body.expectedInputs, []);
    assert.ok((body.steps ?? []).some((step) => step.includes("VK_ADS_TOKEN")));
    assert.match(body.warning ?? "", /Не отправляйте client_secret/);
  } finally {
    await client.close();
  }
});

test("finish_login is disabled without accepting credentials", async () => {
  const client = await connectUnconfigured();
  try {
    const result = (await client.callTool({ name: "finish_login", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    assert.equal(result.isError, true);
    const text = result.content.map((c) => c.text ?? "").join(" ");
    assert.match(text, /отключён|отключено/i);
    assert.match(text, /VK_ADS_TOKEN/);
  } finally {
    await client.close();
  }
});

test("auth_status reports the disconnected state without touching the network", async () => {
  const client = await connectUnconfigured();
  try {
    const result = (await client.callTool({ name: "auth_status", arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
    };
    const status = JSON.parse(result.content[0]?.text ?? "{}") as {
      configured?: boolean;
      path?: string;
    };
    assert.equal(status.configured, false);
    assert.match(status.path ?? "", /credentials\.json$/);
  } finally {
    await client.close();
  }
});
