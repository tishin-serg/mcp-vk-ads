/** OAuth agency_client_name is a username/login, not a cabinet number. */
export type AuthTarget =
  | { type: "own" }
  | { type: "agency-client"; agencyClientName: string; userId?: number };

export function validateAuthTarget(value: unknown): AuthTarget {
  if (value === undefined) return { type: "own" }; // Legacy own credentials.
  if (!value || typeof value !== "object") throw new Error("Некорректный auth target.");
  const target = value as Record<string, unknown>;
  if (target.type === "own") return { type: "own" };
  if (target.type !== "agency-client" || typeof target.agencyClientName !== "string" ||
      !target.agencyClientName.trim() || target.agencyClientName !== target.agencyClientName.trim() ||
      (target.userId !== undefined && (!Number.isSafeInteger(target.userId) || Number(target.userId) <= 0))) {
    throw new Error("Некорректный agency-client target: требуется login клиента.");
  }
  return { type: "agency-client", agencyClientName: target.agencyClientName, ...(target.userId === undefined ? {} : { userId: Number(target.userId) }) };
}
