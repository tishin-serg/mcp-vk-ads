import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { TokenStore } from "./auth.js";
import { VkAdsClient } from "./client.js";
import { DEFAULT_API_BASE } from "./config.js";

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

  const rl = createInterface({ input: stdin, output: stdout });
  let clientId: string;
  try {
    clientId = (await rl.question("client_id: ")).trim();
  } finally {
    rl.close();
  }
  if (!clientId) throw new Error("client_id не может быть пустым");

  const clientSecret = (await readHidden("client_secret: ")).trim();
  if (!clientSecret) throw new Error("client_secret не может быть пустым");

  const tokens = new TokenStore(undefined, { apiBase: DEFAULT_API_BASE });
  await tokens.connect({ clientId, clientSecret });

  try {
    const client = new VkAdsClient({ lang: "ru", apiBase: DEFAULT_API_BASE }, tokens);
    const user = await client.get<{
      username?: string;
      additional_info?: { client_name?: string };
    }>("v3/user.json", { fields: "id,username,additional_info" });

    if (user.username) tokens.rememberUsername(user.username);
    const status = tokens.status();
    stdout.write("\nПодключение проверено.\n");
    if (user.username) stdout.write(`VK Ads user: ${user.username}\n`);
    if (user.additional_info?.client_name) {
      stdout.write(`Кабинет: ${user.additional_info.client_name}\n`);
    }
    stdout.write(`Credentials: ${status.path} (DPAPI CurrentUser)\n`);
  } catch (error) {
    // Do not leave a token/secret behind when the freshly minted credentials do
    // not prove access to the intended VK Ads API account.
    tokens.logout();
    throw new Error(
      `Токен был получен, но проверка кабинета не прошла; сохранённые credentials удалены. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
