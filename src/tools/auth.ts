import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TokenStore } from "../auth.js";
import type { VkAdsClient } from "../client.js";
import { fail, ok, READ_ONLY, WRITE_DELETE } from "./util.js";

/**
 * Authentication tools for the hardened fork.
 *
 * The upstream in-chat OAuth flow accepted client_secret as a model tool argument.
 * This fork deliberately disables that path: secrets must not pass through AI
 * context. Until secure local credential storage is implemented, use VK_ADS_TOKEN
 * in the local MCP process environment.
 */
export function registerAuthTools(
  server: McpServer,
  _client: VkAdsClient,
  tokens: TokenStore,
): void {
  server.registerTool(
    "auth_status",
    {
      title: "Статус подключения к VK Рекламе",
      annotations: READ_ONLY,
      description:
        "Показывает, подключена ли VK Реклама, источник токена и путь legacy-файла credentials. Не возвращает токен или client_secret и не делает сетевой запрос.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(tokens.status());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "start_login",
    {
      title: "Инструкция безопасного подключения VK Рекламы",
      annotations: READ_ONLY,
      description:
        "Показывает безопасный временный способ подключения hardened-форка. Не просит и не принимает client_secret: секреты нельзя передавать через AI-чат.",
      inputSchema: {},
    },
    async () =>
      ok({
        mode: "local-token-only",
        steps: [
          "Получите access token VK Ads вне AI-чата.",
          "Задайте его локально для процесса MCP как переменную окружения VK_ADS_TOKEN.",
          "Перезапустите MCP и вызовите auth_status для проверки подключения.",
        ],
        warning:
          "Не отправляйте client_secret, refresh_token или access token в AI-чат. " +
          "Защищённый постоянный вход будет добавлен отдельным hardening-изменением.",
        expectedInputs: [],
      }),
  );

  server.registerTool(
    "finish_login",
    {
      title: "In-chat подключение отключено",
      annotations: READ_ONLY,
      description:
        "Отключено в hardened-форке, потому что upstream-вариант передавал client_secret через модель. Не принимает credentials.",
      inputSchema: {},
    },
    async () =>
      fail(
        "In-chat OAuth отключён политикой безопасности. Не передавайте client_secret через AI-чат. " +
          "Временно используйте локальный VK_ADS_TOKEN; безопасный persistent login будет добавлен отдельно.",
      ),
  );

  server.registerTool(
    "logout",
    {
      title: "Отключить VK Рекламу",
      annotations: WRITE_DELETE,
      description:
        "Удаляет legacy-сохранённые credentials с диска. Токен из VK_ADS_TOKEN не меняет — его нужно удалить из локального окружения MCP.",
      inputSchema: {},
    },
    async () => {
      try {
        const removed = tokens.logout();
        return ok({
          removed,
          note: removed
            ? "Legacy-сохранённые данные подключения удалены."
            : "Legacy-сохранённого подключения не было — удалять нечего.",
          envTokenStillSet: tokens.status().source === "env",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
