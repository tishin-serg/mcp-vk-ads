import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VkAdsClient } from "../client.js";
import { compact, csv, fail, isoDate, ok, READ_ONLY } from "./util.js";

const ENTITIES = ["ad_plans", "ad_groups", "banners"] as const;
const PERIODS = ["day", "week", "month", "summary"] as const;

export function registerStatisticsTools(server: McpServer, client: VkAdsClient): void {
  server.registerTool(
    "get_statistics",
    {
      title: "Статистика",
      annotations: READ_ONLY,
      description:
        "Возвращает статистику по ad_plans/ad_groups/banners за явно заданные dateFrom/dateTo. " +
        "summary (по умолчанию): сводные total.base на объект, через v3/statistics/{entity}/day.json с пагинацией и сортировкой. " +
        "day: дневные rows через v2/statistics/{entity}/day.json без пагинации/сортировки. " +
        "week/month не поддерживаются. Верхний total относится к возвращённой странице, не ко всему кабинету. " +
        "При autoPaginate общий total опускается: анализируйте total каждого объекта. spent — в валюте кабинета.",
      inputSchema: {
        entity: z.enum(ENTITIES).optional().describe("Тип объектов для отчёта. По умолчанию banners."),
        period: z
          .enum(PERIODS)
          .optional()
          .describe("summary — сводка за выбранные даты; day — дневные rows. week/month не поддерживаются."),
        ids: z
          .array(z.number().int())
          .optional()
          .describe("Ограничить отчёт этими id объектов (выбранного entity)."),
        dateFrom: isoDate().optional().describe("Обязательная дата начала, YYYY-MM-DD."),
        dateTo: isoDate().optional().describe("Обязательная дата окончания, YYYY-MM-DD."),
        metrics: z
          .array(z.string())
          .optional()
          .describe("Группы метрик в отчёте, например base, events, video. По умолчанию — набор API."),
        sortBy: z
          .string()
          .optional()
          .describe("Поле сортировки на стороне сервера, например base.spent / base.clicks / base.shows (топ-N по метрике)."),
        order: z.enum(["asc", "desc"]).optional().describe("Направление сортировки для sortBy. По умолчанию desc."),
        limit: z.number().int().min(1).max(250).optional().describe("Сколько объектов на страницу (не больше 250)."),
        offset: z.number().int().min(0).optional().describe("Смещение постраничной выдачи (сколько объектов пропустить)."),
        autoPaginate: z.boolean().optional().describe("Забрать все страницы, идя по offset/count."),
      },
    },
    async ({ entity, period, ids, dateFrom, dateTo, metrics, sortBy, order, limit, offset, autoPaginate }) => {
      try {
        const ent = entity ?? "banners";
        const grp = period ?? "summary";
        if (grp === "week" || grp === "month") {
          return fail("week/month не поддерживаются VK endpoint. Используйте day и агрегируйте дневные rows отдельно.");
        }
        if (!dateFrom || !dateTo) return fail("Нужны и dateFrom, и dateTo (YYYY-MM-DD), в том числе для summary.");
        if (dateFrom > dateTo) return fail("dateFrom не может быть позже dateTo.");
        const summary = grp === "summary";
        if (!summary && (autoPaginate || limit !== undefined || offset !== undefined || sortBy !== undefined || order !== undefined)) {
          return fail("day возвращает дневные rows из API v2 без пагинации и сортировки; уберите limit/offset/autoPaginate/sortBy/order или используйте summary.");
        }
        // VK v3 /day.json returns range totals, not daily rows. /summary.json is 404.
        // v2 /summary.json is lifetime data and must not silently ignore requested dates.
        const path = `${summary ? "v3" : "v2"}/statistics/${ent}/day.json`;
        const query = compact({
          id: csv(ids),
          date_from: dateFrom,
          date_to: dateTo,
          ...(summary ? { fields: csv(metrics) } : { metrics: csv(metrics) }),
          sort_by: sortBy,
          d: order, // VK direction param (asc|desc); passing sort_by selects v3 sorting
          limit,
          offset,
        });
        const result = autoPaginate ? await client.getAll(path, query) : await client.get(path, query);
        // fail-loud: явный фильтр по ids, но 0 объектов — почти всегда неверный id/период.
        // Пустой ответ провоцирует модель снять фильтр; явная ошибка заставляет его починить.
        const items = (result as { items?: unknown[] } | undefined)?.items;
        if (ids?.length && Array.isArray(items) && items.length === 0) {
          return fail(
            `Статистика вернула 0 объектов по ids [${ids.join(", ")}] (entity ${ent}, группировка ${grp}). ` +
              "Проверить id и диапазон дат — снимать фильтр вслепую не нужно.",
          );
        }
        if (result && typeof result === "object" && !Array.isArray(result)) {
          const { total, ...rest } = result as Record<string, unknown>;
          if (autoPaginate) {
            return ok({ ...rest, _totalScope: "not-provided", _totalNote: "API total является итогом страницы и опущен при autoPaginate. Используйте items[].total; производные метрики нельзя суммировать." });
          }
          return ok({ ...rest, ...(total === undefined ? {} : { total }), _totalScope: "returned-items" });
        }
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
