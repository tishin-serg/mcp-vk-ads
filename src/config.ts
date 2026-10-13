import type { VkAdsConfig } from "./types.js";

/** A malformed or unsafe environment configuration. */
export class ConfigError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "ConfigError";
    this.reason = reason;
  }
}

/**
 * The only API root this hardened fork is allowed to send VK Ads credentials to.
 * Keeping this fixed prevents a poisoned environment variable from redirecting
 * Bearer tokens or OAuth client_secret values to a foreign host.
 */
export const DEFAULT_API_BASE = "https://ads.vk.com/api";

/** Validate and normalize an API base before any authenticated request is built. */
export function assertTrustedApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`Некорректный адрес VK Ads API: "${value}".`, "untrusted_api_base");
  }

  const trustedPath = url.pathname === "/api" || url.pathname === "/api/";
  const trusted =
    url.protocol === "https:" &&
    url.hostname === "ads.vk.com" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    trustedPath;

  if (!trusted) {
    throw new ConfigError(
      `Небезопасный VK Ads API base запрещён: "${value}". Разрешён только ${DEFAULT_API_BASE}.`,
      "untrusted_api_base",
    );
  }

  return DEFAULT_API_BASE;
}

/**
 * Builds the client config from environment variables.
 *
 * A missing token is not a config error: the server may still start and explain
 * how to connect. VK_ADS_API_BASE is accepted only when it resolves to the exact
 * official VK Ads API origin; arbitrary overrides are intentionally forbidden.
 */
export function loadConfig(): VkAdsConfig {
  const token = process.env.VK_ADS_TOKEN || undefined;
  const apiBase = process.env.VK_ADS_API_BASE
    ? assertTrustedApiBase(process.env.VK_ADS_API_BASE)
    : DEFAULT_API_BASE;

  const timeoutMs = Number(process.env.VK_ADS_TIMEOUT_MS);
  const maxRetries = Number(process.env.VK_ADS_MAX_RETRIES);
  return {
    token,
    lang: process.env.VK_ADS_LANG || "ru",
    apiBase,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
    maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 3,
  };
}
