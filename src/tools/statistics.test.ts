import { test } from "node:test";
import assert from "node:assert/strict";
import { registerStatisticsTools } from "./statistics.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const dates = { dateFrom: "2026-10-01", dateTo: "2026-10-17" };

/** Fake server + mock client (get/getAll) so the handler runs without network. */
function harness(opts: { getResult?: unknown; getAllResult?: unknown } = {}) {
  const calls: { path: string; query: Record<string, unknown>; kind: "get" | "getAll" }[] = [];
  const client = {
    get: async (path: string, query: Record<string, unknown>) => {
      calls.push({ path, query, kind: "get" });
      return opts.getResult ?? { count: 1, items: [{ id: 1 }] };
    },
    getAll: async (path: string, query: Record<string, unknown>) => {
      calls.push({ path, query, kind: "getAll" });
      return opts.getAllResult ?? { count: 1, items: [{ id: 1 }] };
    },
  };
  const tools: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerStatisticsTools(server as never, client as never);
  return { calls, tools };
}

test("get_statistics defaults to the summary grouping (period-aggregate, not daily)", async () => {
  const { calls, tools } = harness();
  await tools.get_statistics({ entity: "banners", ...dates, metrics: ["base"] });
  assert.equal(calls[0].path, "v3/statistics/banners/day.json");
  assert.equal(calls[0].query.fields, "base");
  assert.equal(calls[0].query.metrics, undefined);
  assert.equal(calls[0].kind, "get");
});

test("get_statistics maps sortBy/order to VK sort_by/d (server-side top-N)", async () => {
  const { calls, tools } = harness();
  await tools.get_statistics({ entity: "banners", ...dates, sortBy: "base.spent", order: "desc" });
  assert.equal(calls[0].query.sort_by, "base.spent");
  assert.equal(calls[0].query.d, "desc");
});

test("get_statistics requires explicit dates for summary and day (no lifetime fallback)", async () => {
  const { calls, tools } = harness();
  const res = await tools.get_statistics({ period: "day" });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
  assert.equal((await tools.get_statistics({ period: "summary" })).isError, true);
  assert.equal(calls.length, 0);
});

test("get_statistics fails loud when an ids filter returns 0 objects", async () => {
  const { tools } = harness({ getResult: { count: 0, items: [] } });
  const res = await tools.get_statistics({ entity: "banners", ...dates, ids: [123] });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /0 объектов/);
});

test("get_statistics routes autoPaginate through getAll", async () => {
  const { calls, tools } = harness({ getAllResult: { count: 1, items: [{ id: 1 }] } });
  await tools.get_statistics({ entity: "banners", ...dates, autoPaginate: true });
  assert.equal(calls[0].kind, "getAll");
});

test("daily rows use v2 day and metrics, while summary retains v3 pagination", async () => {
  const { calls, tools } = harness();
  const result = await tools.get_statistics({ entity: "ad_plans", period: "day", ...dates, ids: [123], metrics: ["base"] });
  assert.equal(result.isError, undefined);
  assert.equal(calls[0].path, "v2/statistics/ad_plans/day.json");
  assert.equal(calls[0].query.metrics, "base");
  assert.equal(calls[0].query.fields, undefined);
  assert.equal(calls[0].query.id, "123");
});

test("unsupported grouping, inverted dates and day pagination fail before network", async () => {
  const { calls, tools } = harness();
  for (const args of [
    { ...dates, period: "week" }, { ...dates, period: "month" },
    { dateFrom: "2026-10-17", dateTo: "2026-10-01" },
    { ...dates, period: "day", limit: 5 }, { ...dates, period: "day", autoPaginate: true },
  ]) assert.equal((await tools.get_statistics(args)).isError, true);
  assert.equal(calls.length, 0);
});

test("page total is labelled and never exposed as a combined total after pagination", async () => {
  const page = { count: 2, items: [{ id: 1, total: { base: { spent: "10.00" } } }], total: { base: { spent: "10.00" } } };
  const { tools } = harness({ getResult: page, getAllResult: { ...page, items: [...page.items, { id: 2, total: { base: { spent: "5.00" } } }] } });
  const result = JSON.parse((await tools.get_statistics({ ...dates, limit: 1 })).content[0].text);
  assert.equal(result._totalScope, "returned-items");
  assert.equal(result.total.base.spent, "10.00");
  const all = JSON.parse((await tools.get_statistics({ ...dates, autoPaginate: true })).content[0].text);
  assert.equal(all.total, undefined);
  assert.equal(all.items.length, 2);
  assert.equal(all._totalScope, "not-provided");
});
