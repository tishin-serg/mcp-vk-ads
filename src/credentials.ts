import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { validateAuthTarget, type AuthTarget } from "./authTarget.js";

const APP = "mcp-vk-ads";

export interface StoredCredentials {
  client_id: string;
  client_secret: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  obtained_at: number;
  username?: string;
  target?: AuthTarget;
}

interface DpapiEnvelope {
  format: "dpapi-v1";
  scope: "CurrentUser";
  ciphertext: string;
}

export function credentialsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, APP, "credentials.json");
}

export function readCredentials(): StoredCredentials | undefined {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch {
    return undefined;
  }

  if (process.platform === "win32") {
    try {
      const envelope = JSON.parse(raw) as Partial<DpapiEnvelope>;
      if (
        envelope.format !== "dpapi-v1" ||
        envelope.scope !== "CurrentUser" ||
        typeof envelope.ciphertext !== "string" ||
        envelope.ciphertext === ""
      ) {
        return undefined;
      }
      return parseCredentials(unprotectWindows(envelope.ciphertext));
    } catch {
      return undefined;
    }
  }

  return parseCredentials(raw);
}

export function writeCredentials(credentials: StoredCredentials): string {
  const file = credentialsPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

  if (process.platform === "win32") {
    const plaintext = `${JSON.stringify(credentials)}\n`;
    const envelope: DpapiEnvelope = {
      format: "dpapi-v1",
      scope: "CurrentUser",
      ciphertext: protectWindows(plaintext),
    };
    writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    return file;
  }

  writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Some filesystems do not implement POSIX modes.
  }
  return file;
}

export function clearCredentials(): boolean {
  const file = credentialsPath();
  if (!fileExists(file)) return false;
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

function parseCredentials(raw: string): StoredCredentials | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    if (
      typeof parsed.client_id !== "string" ||
      parsed.client_id === "" ||
      typeof parsed.client_secret !== "string" ||
      parsed.client_secret === "" ||
      typeof parsed.access_token !== "string" ||
      parsed.access_token === "" ||
      typeof parsed.obtained_at !== "number"
    ) {
      return undefined;
    }
    if (parsed.target !== undefined) parsed.target = validateAuthTarget(parsed.target);
    if (parsed.target?.type === "agency-client" && parsed.username !== parsed.target.agencyClientName) return undefined;
    return parsed as StoredCredentials;
  } catch {
    return undefined;
  }
}

function protectWindows(plaintext: string): string {
  return runDpapi("protect", plaintext);
}

function unprotectWindows(ciphertext: string): string {
  return runDpapi("unprotect", ciphertext);
}

function runDpapi(mode: "protect" | "unprotect", input: string): string {
  if (process.platform !== "win32") {
    throw new Error("DPAPI is available only on Windows");
  }

  const prefix = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
  ];
  const script = [
    ...prefix,
    ...(mode === "protect"
      ? [
          "$plain = [Console]::In.ReadToEnd()",
          "$bytes = [Text.Encoding]::UTF8.GetBytes($plain)",
          "$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser",
          "$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)",
          "[Console]::Out.Write([Convert]::ToBase64String($protected))",
        ]
      : [
          "$encoded = [Console]::In.ReadToEnd().Trim()",
          "$protected = [Convert]::FromBase64String($encoded)",
          "$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser",
          "$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, $scope)",
          "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))",
        ]),
  ].join("; ");

  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      input,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );

  if (result.error || result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(
      `Не удалось использовать Windows DPAPI для защищённого хранения credentials${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
  return result.stdout.trim();
}

function fileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
