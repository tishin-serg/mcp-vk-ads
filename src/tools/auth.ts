import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TokenStore } from "../auth.js";
import type { VkAdsClient } from "../client.js";
import { fail, ok, READ_ONLY, WRITE_DELETE } from "./util.js";

/**
 * Authentication tools for the hardened fork.
 *
 * The upstream in-chat OAuth flow accepted client_secret as a model tool argument.
 * This fork deliberately disables that path. On Windows, credentials are entered
 * locally through `npm run auth:setup` and stored with DPAPI CurrentUser.
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
        "Показывает, подключена ли VK Реклама, источник токена и путь локального credential-файла. Не возвращает токен или client_secret и не делает сетевой запрос.",
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
        "Показывает безопасный local-only способ подключения hardened-форка. Не просит и не принимает client_secret: секреты нельзя передавать через AI-чат.",
      inputSchema: {},
    },
    async () =>
      ok({
        mode: "windows-local-dpapi",
        steps: [
          "На Windows откройте PowerShell/Windows Terminal в локальной папке hardened MCP.",
          "Для OAuth выполните `npm run auth:setup`; для готового токена клиента — `npm run auth:token`. Секреты вводите только в локальном терминале.",
          "Команда проверит кабинет VK Ads и сохранит credentials через Windows DPAPI CurrentUser.",
          "Перезапустите MCP и вызовите auth_status для проверки подключения.",
        ],
        warning:
          "Не отправляйте client_secret, refresh_token или access token в AI-чат. " +
          "На Windows credential-файл содержит только DPAPI ciphertext, привязанный к текущему пользователю ОС.",
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
          "На Windows выполните `npm run auth:setup` локально в папке MCP.",
      ),
  );

  server.registerTool(
    "logout",
    {
      title: "Отключить VK Рекламу",
      annotations: WRITE_DELETE,
      description:
        "Удаляет сохранённые credentials с диска. На Windows файл зашифрован DPAPI CurrentUser. Токен из VK_ADS_TOKEN не меняет — его нужно удалить из локального окружения MCP.",
      inputSchema: {},
    },
    async () => {
      try {
        const removed = tokens.logout();
        return ok({
          removed,
          note: removed
            ? "Сохранённые данные подключения удалены."
            : "Сохранённого подключения не было — удалять нечего.",
          envTokenStillSet: tokens.status().source === "env",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
