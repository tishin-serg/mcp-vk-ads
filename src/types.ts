export interface VkAdsConfig {
  /**
   * VK_ADS_TOKEN, when set. Optional: without it the token comes from the
   * credentials file written by the in-chat login (see TokenStore).
   */
  token?: string;
  /** Accept-Language header sent with every request. */
  lang: string;
  /** API root, without a version segment. Defaults to https://ads.vk.com/api. */
  apiBase: string;
  /** Per-request timeout in milliseconds. Defaults to 60_000. */
  timeoutMs?: number;
  /** Max retries for transient errors (429 rate limit, 5xx). Defaults to 3. */
  maxRetries?: number;
  /** Base backoff in milliseconds, doubled each retry. Defaults to 500. */
  retryBaseMs?: number;
}

/**
 * VK Ads reports failures as a non-2xx HTTP status with a JSON body. The body
 * shape varies by error kind; retain bounded, redacted diagnostics alongside
 * the status and derive a human-readable message including validation fields.
 */
export class VkAdsError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(status: number, body: unknown, secrets: readonly string[] = []) {
    const safeBody = safeDiagnostics(body, secrets);
    super(`HTTP ${status}: ${formatErrorBody(safeBody)}`);
    this.name = "VkAdsError";
    this.status = status;
    this.body = safeBody;
  }
}

/** Turns a parsed VK Ads error body into a short, readable message. */
function formatErrorBody(body: unknown): string {
  if (body == null) return "(пустое тело ответа)";
  if (typeof body === "string") return body.slice(0, 500);
  if (typeof body !== "object") return String(body);

  const obj = body as Record<string, unknown>;

  // OAuth-style: { error: "invalid_grant", error_description: "..." }
  if (typeof obj.error === "string") {
    const desc = typeof obj.error_description === "string" ? `: ${obj.error_description}` : "";
    return `${obj.error}${desc}`;
  }

  // Preserve field diagnostics even when VK supplies a generic message.
  if (obj.error && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>;
    const code = err.code !== undefined ? `[${err.code}] ` : "";
    const message = typeof err.message === "string" ? err.message : "";
    const fields = err.fields === undefined ? "" : ` fields=${JSON.stringify(err.fields)}`;
    return `${code}${message}${fields}`.slice(0, 12000);
  }

  // Validation-style: { field: ["msg", ...], ... } — keep the compact JSON.
  return JSON.stringify(obj).slice(0, 12000);
}

/** Bounded diagnostics only: never publish request/header/value/credential echoes. */
function safeDiagnostics(body: unknown, secrets: readonly string[]): unknown {
  const sensitive = /token|secret|password|authorization|cookie|api.?key|email|phone/i;
  const echoes = /^(request|response|headers?|body|payload|value|actual|input|trace|stack|details)$/i;
  let remaining = 300;
  const redact = (text: string): string => {
    for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
    return text
      .replace(/Bearer\s+[^\s,"'}]+/gi, "Bearer [REDACTED]")
      .replace(/\b(access_token|refresh_token|client_secret|password|api_key)\b\s*[:=]\s*["']?[^\s,"'}]+/gi, "$1=[REDACTED]")
      .slice(0, 1000);
  };
  const clean = (value: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 12) return "[TRUNCATED]";
    if (typeof value === "string") return redact(value);
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 30).map(item => clean(item, depth + 1));
    if (!value || typeof value !== "object") return undefined;
    return Object.fromEntries(Object.entries(value).slice(0, 60).flatMap(([key, item]) => {
      if (sensitive.test(key)) return [[redact(key), "[REDACTED]"]];
      if (echoes.test(key)) return [];
      return [[redact(key), clean(item, depth + 1)]];
    }));
  };
  // Provider extras may contain full request echoes. Only documented error data
  // is useful at the root; legacy field-map errors are handled by clean().
  if (body && typeof body === "object" && !Array.isArray(body) && "error" in body) {
    const obj = body as Record<string, unknown>;
    const error = obj.error && typeof obj.error === "object"
      ? Object.fromEntries(["code", "message", "fields"].filter(key => key in (obj.error as object)).map(key => [key, (obj.error as Record<string, unknown>)[key]]))
      : obj.error;
    return clean({ error, ...(typeof obj.error_description === "string" ? { error_description: obj.error_description } : {}) }, 0);
  }
  return clean(body, 0);
}
