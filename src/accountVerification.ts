import { assertTrustedApiBase, DEFAULT_API_BASE } from "./config.js";
import { validateAuthTarget, type AuthTarget } from "./authTarget.js";

export interface VerifiedUser {
  id: number;
  username: string;
  additional_info?: { client_name?: string };
}

export class AccountMismatchError extends Error {}

/** Local auth GETs never persist tokens or include provider response bodies in errors. */
export async function authRead<T>(accessToken: string, path: string,
  options: { apiBase?: string; fetchImpl?: typeof fetch } = {}): Promise<T> {
  const base = `${assertTrustedApiBase(options.apiBase ?? DEFAULT_API_BASE)}/`;
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin || !url.pathname.startsWith("/api/")) throw new Error("Небезопасный auth API path.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(url.toString(), {
      method: "GET", redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`VK auth verification GET: HTTP ${response.status}.`);
    return JSON.parse(await response.text()) as T;
  } catch (error) {
    // Never print a fetch implementation's error containing headers or secrets.
    if (error instanceof Error && error.message.startsWith("VK auth verification GET:")) throw error;
    throw new Error("VK auth verification GET не выполнен (сеть, redirect, timeout или JSON).");
  } finally { clearTimeout(timer); }
}

export async function verifyTokenAccount(accessToken: string, target: AuthTarget,
  options: { apiBase?: string; fetchImpl?: typeof fetch } = {}): Promise<VerifiedUser> {
  const expected = validateAuthTarget(target);
  const user = await authRead<VerifiedUser>(accessToken, "v3/user.json?fields=id,username,additional_info", options);
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.username !== "string" || !user.username) {
    throw new AccountMismatchError("VK user.json не подтвердил id/username кабинета.");
  }
  if (expected.type === "agency-client" && (user.username !== expected.agencyClientName ||
      (expected.userId !== undefined && user.id !== expected.userId))) {
    throw new AccountMismatchError("VK user.json вернул другой кабинет; agency credentials не приняты.");
  }
  return user;
}

export interface ManagerClient { username: string; id?: number; name?: string }

/** GET v3/manager/clients.json; user.id is the user ID, not the relationship ID. */
export async function listManagerClients(accessToken: string,
  options: { apiBase?: string; fetchImpl?: typeof fetch } = {}): Promise<ManagerClient[]> {
  const clients = new Map<string, ManagerClient>();
  for (let offset = 0; offset < 1000; offset += 250) {
    const page = await authRead<{ items: Array<Record<string, unknown>>; count?: number }>(accessToken,
      `v3/manager/clients.json?limit=250&offset=${offset}`, options);
    if (!page || !Array.isArray(page.items)) throw new Error("Неизвестный формат списка клиентов VK.");
    for (const row of page.items) {
      const user = (row.user && typeof row.user === "object" ? row.user : row) as Record<string, unknown>;
      if (typeof user.username !== "string" || !user.username.trim()) continue;
      const info = user.additional_info as { client_name?: unknown } | undefined;
      clients.set(user.username, { username: user.username,
        ...(Number.isSafeInteger(user.id) && Number(user.id) > 0 ? { id: Number(user.id) } : {}),
        ...(typeof info?.client_name === "string" ? { name: info.client_name } : {}),
      });
    }
    if (page.items.length < 250 || (typeof page.count === "number" && offset + page.items.length >= page.count)) break;
    if (offset === 750) throw new Error("Список клиентов усечён; нужен точный login клиента.");
  }
  return [...clients.values()];
}
