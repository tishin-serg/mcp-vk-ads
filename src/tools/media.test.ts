import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { z } from "zod";
import { HardenedVkAdsClient } from "../hardenedClient.js";
import { registerMediaTool, MAX_IMAGE_BYTES } from "./media.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZkAAAAASUVORK5CYII=";
const args = { imageBase64: PNG, width: 1, height: 1, confirmWrite: true };
type Result = { content: { text: string }[]; isError?: boolean };

function mode(t: TestContext, value: string | undefined) {
  const previous = process.env.VK_ADS_WRITE_MODE;
  if (value === undefined) delete process.env.VK_ADS_WRITE_MODE;
  else process.env.VK_ADS_WRITE_MODE = value;
  t.after(() => {
    if (previous === undefined) delete process.env.VK_ADS_WRITE_MODE;
    else process.env.VK_ADS_WRITE_MODE = previous;
  });
}

function harness() {
  let handler!: (args: Record<string, unknown>) => Promise<Result>;
  let schema!: z.ZodObject<any>;
  const server = { registerTool: (_name: string, config: { inputSchema: z.ZodRawShape }, run: typeof handler) => {
    schema = z.object(config.inputSchema); handler = run;
  } };
  const client = new HardenedVkAdsClient({ token: "offline-token", lang: "ru", apiBase: "https://ads.vk.com/api", maxRetries: 2, retryBaseMs: 0 });
  registerMediaTool(server as never, client);
  return { client, call: (input: Record<string, unknown>) => handler(schema.parse(input)) };
}

test("upload sends actual multipart bytes, metadata, automatic boundary and provider content ID", async (t) => {
  mode(t, "full");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, "https://ads.vk.com/api/v2/content/static.json");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).has("Content-Type"), false);
    const wire = new Request(url, init);
    assert.match(wire.headers.get("Content-Type")!, /multipart\/form-data; boundary=/);
    const multipart = await wire.formData();
    assert.deepEqual(JSON.parse(multipart.get("data") as string), { width: 1, height: 1 });
    const file = multipart.get("file") as File;
    assert.equal(file.name, "creative.png");
    assert.equal(file.type, "image/png");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(PNG, "base64"));
    return Response.json({ id: 77, variants: { original: { width: 1, height: 1 } } });
  });
  const result = await harness().call(args);
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).id, 77);
  assert.doesNotMatch(JSON.stringify(result), /offline-token|iVBOR/);
  assert.equal(calls, 1);
});

test("upload fails closed in default read-only and draft, even with confirmWrite", async (t) => {
  mode(t, undefined);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ id: 1 }); });
  const h = harness();
  assert.match((await h.call(args)).content[0].text, /read-only/);
  process.env.VK_ADS_WRITE_MODE = "draft";
  assert.match((await h.call(args)).content[0].text, /full/);
  assert.equal(calls, 0);
});

test("upload rejects missing confirmation, text, malformed/oversized base64 and invalid dimensions before network", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ id: 1 }); });
  const h = harness();
  for (const input of [
    { ...args, confirmWrite: false },
    { ...args, imageBase64: Buffer.from("not-an-image").toString("base64") },
    { ...args, imageBase64: "not base64" },
    { ...args, imageBase64: "Zh==" }, // non-canonical padding bits
  ]) assert.equal((await h.call(input)).isError, true);
  assert.throws(() => h.call({ ...args, width: 0 }));
  assert.throws(() => h.call({ ...args, imageBase64: Buffer.alloc(MAX_IMAGE_BYTES + 3).toString("base64") }));
  assert.equal(calls, 0);
});

test("upload accepts JPEG; never retries POST on network/5xx or redirects; flags missing content ID", async (t) => {
  mode(t, "full");
  let calls = 0;
  let failure: "network" | "500" | "redirect" | "missing" | "none" = "none";
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls++;
    assert.equal(init.redirect, "error");
    if (failure === "network" || failure === "redirect") throw new TypeError("private transport detail");
    if (failure === "500") return new Response("private provider detail", { status: 503 });
    const file = (init.body as FormData).get("file") as File;
    assert.equal(file.type, "image/jpeg");
    return Response.json(failure === "missing" ? {} : { id: 9 });
  });
  const jpeg = { ...args, imageBase64: Buffer.from([255, 216, 255, 217]).toString("base64") };
  const h = harness();
  assert.equal((await h.call(jpeg)).isError, undefined);
  for (const mode of ["network", "500", "redirect", "missing"] as const) {
    failure = mode;
    const before = calls;
    const result = await h.call(jpeg);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Не повторяйте/);
    assert.doesNotMatch(result.content[0].text, /private|offline-token/);
    assert.equal(calls, before + 1);
  }
});

test("multipart cannot be sent to arbitrary endpoints, even in full mode", async (t) => {
  mode(t, "full");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({}); });
  await assert.rejects(harness().client.post("v2/ad_plans.json", new FormData()), /Multipart/);
  assert.equal(calls, 0);
});
