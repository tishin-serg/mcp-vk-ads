#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TokenStore } from "./auth.js";
import { ConfigError, DEFAULT_API_BASE, loadConfig } from "./config.js";
import { HardenedVkAdsClient } from "./hardenedClient.js";
import { instrumentToolCalls, Telemetry } from "./telemetry.js";
import type { VkAdsConfig } from "./types.js";

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
import { registerAuthTools } from "./tools/auth.js";
import { registerAccountTools } from "./tools/account.js";
import { registerAdPlanTools } from "./tools/adPlans.js";
import { registerAdGroupTools } from "./tools/adGroups.js";
import { registerBannerTools } from "./tools/banners.js";
import { registerStatisticsTools } from "./tools/statistics.js";
import { registerRawTool } from "./tools/raw.js";

export const INSTRUCTIONS =
  "VK Реклама (VK Ads) — API рекламного кабинета на ads.vk.com. Объекты вложены: " +
  "ad_plan (кампания) → ad_group (группа объявлений) → banner (объявление). " +
  "Этот hardened fork по умолчанию работает в режиме read-only. VK_ADS_WRITE_MODE=draft " +
  "разрешает только создание объектов со status=blocked и остановку существующих; " +
  "VK_ADS_WRITE_MODE=full разрешает остальные записи. Дополнительно можно задать " +
  "VK_ADS_MAX_DAILY_BUDGET и VK_ADS_MAX_TOTAL_BUDGET как серверные safety caps. " +
  "Песочницы у VK Ads нет: разрешённые write-вызовы идут в живой кабинет. " +
  "raw_request не принимает абсолютные URL; API origin закреплён на https://ads.vk.com/api. " +
  "Телеметрия в этом форке отключена на уровне кода.";

const UNCONFIGURED_PREFIX =
  "ВНИМАНИЕ: VK Реклама ещё не подключена — токена нет, поэтому инструменты данных не сработают. " +
  "На Windows выполните локально `npm run auth:setup` в папке hardened MCP: credentials будут сохранены через DPAPI CurrentUser. " +
  "Не передавайте client_secret через AI-чат. Для временных/CI-сценариев можно локально задать VK_ADS_TOKEN. ";

function loadConfigOrDegraded(): {
  config: VkAdsConfig;
  problem?: ConfigError;
} {
  try {
    return { config: loadConfig() };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`Ошибка конфигурации: ${err.message}`);
    return {
      config: {
        token: process.env.VK_ADS_TOKEN || undefined,
        lang: process.env.VK_ADS_LANG || "ru",
        apiBase: DEFAULT_API_BASE,
      },
      problem: err,
    };
  }
}

async function main(): Promise<void> {
  const telemetry = new Telemetry(readVersion());
  const { config, problem } = loadConfigOrDegraded();
  const tokens = new TokenStore(config.token, { apiBase: config.apiBase });
  const client = new HardenedVkAdsClient(config, tokens);

  const connected = tokens.hasToken();

  const server = new McpServer(
    {
      name: "mcp-vk-ads",
      version: readVersion(),
    },
    {
      instructions: connected
        ? INSTRUCTIONS
        : UNCONFIGURED_PREFIX +
          (problem ? `Проблема конфигурации: ${problem.message} ` : "") +
          INSTRUCTIONS,
    },
  );

  instrumentToolCalls(server, telemetry);

  registerAuthTools(server, client, tokens);
  registerAccountTools(server, client);
  registerAdPlanTools(server, client);
  registerAdGroupTools(server, client);
  registerBannerTools(server, client);
  registerStatisticsTools(server, client);
  registerRawTool(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`mcp-vk-ads running on stdio${connected ? "" : " (без токена)"}`);
}

main().catch((err) => {
  console.error("Критическая ошибка при запуске mcp-vk-ads:", err);
  process.exit(1);
});
