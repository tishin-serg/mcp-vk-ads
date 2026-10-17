import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { runLocalSetup } from "./setupWorkflow.js";

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Локальная защищённая настройка этого fork сейчас поддерживается только на Windows.");
  }
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Запустите npm run auth:setup в интерактивном Windows Terminal/PowerShell.");
  }

  stdout.write(
    "VK Ads local setup\n" +
      "Секреты останутся на этой Windows-машине и будут сохранены через DPAPI CurrentUser.\n" +
      "Ничего из введённого здесь не нужно отправлять в ChatGPT.\n\n",
  );

  const expectedManagerId = process.env.VK_ADS_EXPECTED_MANAGER_ID;
  const method = process.argv.slice(2);
  if (method.some(arg => arg !== "--access-token") || method.length > 1) {
    throw new Error("Допустим только несекретный флаг --access-token. Секреты вводятся исключительно в локальный prompt.");
  }
  if (expectedManagerId && (!/^\d+$/.test(expectedManagerId) || !Number.isSafeInteger(Number(expectedManagerId)))) {
    throw new Error("Некорректный expected manager ID.");
  }
  await runLocalSetup({
    ask: async (prompt) => {
      const rl = createInterface({ input: stdin, output: stdout });
      try { return await rl.question(prompt); }
      finally { rl.close(); }
    },
    readSecret: readHidden,
    write: (message) => { stdout.write(message); },
  }, {
    expectedManagerId: expectedManagerId ? Number(expectedManagerId) : undefined,
    expectedAgencyClientName: process.env.VK_ADS_EXPECTED_AGENCY_CLIENT_NAME,
    authMethod: method.includes("--access-token") ? "access-token" : "oauth",
  });
}

async function readHidden(prompt: string): Promise<string> {
  stdout.write(prompt);
  stdin.setRawMode!(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return await new Promise<string>((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode!(false);
      stdin.pause();
    };

    const onData = (chunk: string | Buffer) => {
      const text = String(chunk);
      for (const ch of text) {
        if (ch === "\u0003") {
          cleanup();
          stdout.write("\n");
          reject(new Error("Настройка отменена"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\b" || ch === "\u007f") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (ch >= " ") {
          value += ch;
          stdout.write("*");
        }
      }
    };

    stdin.on("data", onData);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
