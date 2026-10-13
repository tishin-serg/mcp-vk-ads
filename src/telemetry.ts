import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Hardened fork policy: no usage telemetry leaves the machine.
 *
 * Keep the public surface as a no-op so the rest of the upstream code can stay
 * close to source and future upstream merges remain small and reviewable.
 */
export function telemetryEnabled(): boolean {
  return false;
}

export interface ClientInfo {
  name?: string;
  version?: string;
}

export type TelemetryEvent =
  | "server_start"
  | "tool_call"
  | "startup_failed"
  | "unconfigured_start";

export interface EventFields {
  tool?: string;
  reason?: string;
}

export class Telemetry {
  constructor(..._args: unknown[]) {}

  setClientInfo(_info: ClientInfo | undefined): void {}

  send(_event: TelemetryEvent, _fields: EventFields = {}): void {}

  async sendBlocking(_event: TelemetryEvent, _fields: EventFields = {}): Promise<void> {}
}

/** No wrapping is needed when telemetry is disabled. */
export function instrumentToolCalls(_server: McpServer, _telemetry: Telemetry): void {}
