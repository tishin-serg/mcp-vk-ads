import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpMethod } from "../client.js";
import type { VkAdsClient } from "../client.js";
import { fail, ok, readBackWrite, WRITE_DELETE } from "./util.js";

/** Only GET reads data; POST and DELETE mutate the account. */
export function isReadMethod(method: string): boolean {
  return method.toUpperCase() === "GET";
}

export function registerRawTool(server: McpServer, client: VkAdsClient): void {
  server.registerTool(
    "raw_request",
    {
      title: "Произвольный запрос к API VK Рекламы",
      // Escape hatch: can POST/DELETE, so flag it destructive.
      annotations: WRITE_DELETE,
      description:
        'JSON-запрос к API VK Ads: сегменты v2/remarketing/segments.json и /{id}/relations.json (fields=id,object_type,object_id,params), counters, pricelists, packages/packages_pads. GET без confirmWrite; POST/DELETE требуют confirmWrite=true и разрешённого write mode. Body — JSON-объект, query — скаляры, пагинация limit/offset вручную. Известные рекламные объекты и сегменты после POST читаются через GET; другие endpoints возвращают исходный ответ VK (проверить объект отдельно). При неопределённом write не повторять create вслепую. Для multipart используйте upload_image.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe('Путь эндпоинта с версией, например "v2/ad_plans.json", "v3/statistics/banners/day.json".'),
        method: z.enum(["GET", "POST", "DELETE"]).optional().describe("HTTP-метод. По умолчанию GET."),
        query: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Параметры строки запроса (фильтры, поля, постраничная выдача)."),
        body: z.record(z.any()).optional().describe("JSON-тело для POST-запросов."),
        confirmWrite: z
          .boolean()
          .optional()
          .describe("Должен быть true для записи (POST или DELETE)."),
      },
    },
    async ({ path, method, query, body, confirmWrite }) => {
      try {
        const m = (method ?? "GET") as HttpMethod;
        if (!isReadMethod(m) && confirmWrite !== true) {
          return fail(
            `"${m} ${path}" — операция записи. Повторить вызов с confirmWrite=true, чтобы выполнить её.`,
          );
        }
        const result = await client.request(m, path, { query, body });
        return ok(m === "POST" ? await readBackWrite(client, path, result) : result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
