import { VkAdsClient, type HttpMethod, type RequestOptions } from "./client.js";

export type WriteMode = "read-only" | "draft" | "full";

/**
 * Central safety layer for all typed tools and raw_request.
 *
 * read-only (default): no POST/DELETE reaches VK Ads.
 * draft: collection creates are forced to status=blocked; stopping an existing
 *        ad_plan/ad_group/banner is allowed; every other mutation is blocked.
 * full: writes are allowed, subject to optional budget caps.
 */
export class HardenedVkAdsClient extends VkAdsClient {
  override async request<T = unknown>(
    method: HttpMethod,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    if (method === "GET") return super.request<T>(method, path, opts);

    const mode = writeMode();
    if (mode === "read-only") {
      throw new Error(
        "Запись в VK Рекламу отключена политикой безопасности (VK_ADS_WRITE_MODE=read-only).",
      );
    }

    if (method === "DELETE") {
      if (mode !== "full") {
        throw new Error("Удаление разрешено только при VK_ADS_WRITE_MODE=full.");
      }
      return super.request<T>(method, path, opts);
    }

    if (opts.body instanceof FormData) {
      if (mode !== "full" || normalizePath(path) !== "v2/content/static.json") {
        throw new Error("Multipart разрешён только для v2/content/static.json при VK_ADS_WRITE_MODE=full.");
      }
      return super.request<T>(method, path, opts);
    }

    const body = asRecord(opts.body);
    enforceBudgetCaps(body);

    if (mode === "draft") {
      if (isCollectionCreate(path)) {
        const draftBody = stoppedTree(body);
        return super.request<T>(method, path, { ...opts, body: draftBody });
      }

      if (isEntityItemPath(path) && isStopOnly(body)) {
        return super.request<T>(method, path, opts);
      }

      throw new Error(
        "В draft-режиме разрешено только создание остановленных объектов и stop (status=blocked) " +
          "для ad_plan/ad_group/banner. Для остальных изменений требуется VK_ADS_WRITE_MODE=full.",
      );
    }

    return super.request<T>(method, path, opts);
  }
}

export function writeMode(env: NodeJS.ProcessEnv = process.env): WriteMode {
  const raw = (env.VK_ADS_WRITE_MODE || "read-only").trim().toLowerCase();
  if (raw === "read-only" || raw === "draft" || raw === "full") return raw;
  throw new Error(
    `Некорректный VK_ADS_WRITE_MODE="${raw}". Разрешены read-only, draft, full.`,
  );
}

function normalizePath(path: string): string {
  return path.replace(/^\//, "");
}

function isCollectionCreate(path: string): boolean {
  const normalized = normalizePath(path);
  return ["v2/ad_plans.json", "v2/ad_groups.json"].includes(normalized)
    || /^v2\/ad_groups\/\d+\/banners\.json$/.test(normalized);
}

function isEntityItemPath(path: string): boolean {
  return /^v2\/(ad_plans|ad_groups|banners)\/\d+\.json$/.test(normalizePath(path));
}

function isStopOnly(body: Record<string, unknown>): boolean {
  const entries = Object.entries(body).filter(([, value]) => value !== undefined);
  return entries.length === 1 && entries[0]?.[0] === "status" && entries[0]?.[1] === "blocked";
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body === undefined) return {};
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new Error("Операция записи должна содержать JSON-объект.");
}

// Existing JSON creates accept nested ad_groups/banners via extra/raw_request.
// Every created child must be stopped too, before a future activation of its parent.
function stoppedTree(body: Record<string, unknown>): Record<string, unknown> {
  const result = { ...body, status: "blocked" };
  for (const key of ["ad_groups", "campaigns", "banners"] as const) {
    const children = body[key];
    if (Array.isArray(children)) {
      (result as Record<string, unknown>)[key] = children.map((child) => stoppedTree(asRecord(child)));
    }
  }
  return result;
}

function enforceBudgetCaps(body: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  if (body.budget_limit !== undefined && body.budget_limit !== null &&
      body.budget_limit_day !== undefined && body.budget_limit_day !== null) {
    throw new Error("VK не разрешает одновременно budget_limit и budget_limit_day. Укажите только общий либо дневной бюджет.");
  }
  enforceCap(body.budget_limit_day, env.VK_ADS_MAX_DAILY_BUDGET, "дневной бюджет");
  enforceCap(body.budget_limit, env.VK_ADS_MAX_TOTAL_BUDGET, "общий бюджет");
  for (const value of Object.values(body)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child === "object" && !Array.isArray(child)) enforceBudgetCaps(child, env);
    } else if (value && typeof value === "object") {
      enforceBudgetCaps(value as Record<string, unknown>, env);
    }
  }
}

function enforceCap(value: unknown, rawCap: string | undefined, label: string): void {
  if (value === undefined || rawCap === undefined || rawCap.trim() === "") return;
  const amount = Number(value);
  const cap = Number(rawCap);
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error(`Некорректный лимит безопасности для поля «${label}»: ${rawCap}.`);
  }
  if ((typeof value !== "number" && typeof value !== "string") || !Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Операция отклонена: ${label} должен быть положительным конечным числом при заданном safety cap.`);
  }
  if (Number.isFinite(amount) && amount > cap) {
    throw new Error(`Операция отклонена: ${label} ${amount} превышает safety cap ${cap}.`);
  }
}
