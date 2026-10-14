import { TokenStore } from "./auth.js";
import { mintToken } from "./oauth.js";
import { listManagerClients, verifyTokenAccount, type ManagerClient } from "./accountVerification.js";
import type { AuthTarget } from "./authTarget.js";

export interface SetupIO {
  ask(prompt: string): Promise<string>;
  readSecret(prompt: string): Promise<string>;
  write(message: string): void;
}

export interface SetupOptions {
  fetchImpl?: typeof fetch;
  expectedManagerId?: number;
  expectedAgencyClientName?: string;
}

export async function runLocalSetup(io: SetupIO, options: SetupOptions = {}): Promise<void> {
  io.write("Account type:\n1. Own / manager account\n2. Agency / manager client\n");
  // A local expected username is an explicit operator choice, never an AI default.
  const choice = options.expectedAgencyClientName ? "2" : (await io.ask("Выбор [1]: ")).trim() || "1";
  if (options.expectedAgencyClientName) io.write(`Agency target: ${options.expectedAgencyClientName}\n`);
  if (choice !== "1" && choice !== "2") throw new Error("Выберите 1 или 2.");
  if (options.expectedAgencyClientName && choice !== "2") throw new Error("Локальная проверка требует agency client, не manager.");
  const clientId = (await io.ask("client_id: ")).trim();
  if (!clientId) throw new Error("client_id не может быть пустым.");
  const clientSecret = (await io.readSecret("client_secret: ")).trim();
  if (!clientSecret) throw new Error("client_secret не может быть пустым.");
  let target: AuthTarget = { type: "own" };
  if (choice === "2") {
    // Temporary own/manager credentials stay in memory, never in TokenStore.
    const managerToken = await mintToken({ clientId, clientSecret, fetchImpl: options.fetchImpl });
    const manager = await verifyTokenAccount(managerToken.access_token, { type: "own" }, options);
    if (options.expectedManagerId !== undefined && manager.id !== options.expectedManagerId) {
      throw new Error("Manager user.json вернул другой ID; настройка остановлена.");
    }
    io.write(`Manager: ${manager.username}; ID ${manager.id}\n`);
    let clients: ManagerClient[] = [];
    try { clients = await listManagerClients(managerToken.access_token, options); }
    catch { io.write("Список клиентов недоступен. Нужен точный username/login для agency_client_name.\n"); }
    if (options.expectedAgencyClientName) clients = clients.filter(client => client.username === options.expectedAgencyClientName);
    if (clients.length) {
      clients.forEach((client, index) => io.write(`${index + 1}. ${client.username}; ${client.name ?? ""}; user ID ${client.id ?? "не указан"}\n`));
      const selected = options.expectedAgencyClientName && clients.length === 1 ? "1" : (await io.ask("Клиент (номер): ")).trim();
      if (!/^\d+$/.test(selected) || !clients[Number(selected) - 1]) throw new Error("Клиент не выбран.");
      const client = clients[Number(selected) - 1];
      target = { type: "agency-client", agencyClientName: client.username, ...(client.id === undefined ? {} : { userId: client.id }) };
    } else {
      const login = options.expectedAgencyClientName ?? (await io.ask("Agency client username/login: ")).trim();
      if (!login) throw new Error("Нужен username клиента, не numeric cabinet ID.");
      target = { type: "agency-client", agencyClientName: login };
    }
    if (options.expectedAgencyClientName && target.agencyClientName !== options.expectedAgencyClientName) {
      throw new Error("Выбран другой клиент; agency token не выпущен.");
    }
  }
  const tokens = new TokenStore(undefined, { fetchImpl: options.fetchImpl });
  try {
    const credentials = await tokens.connectVerified({ clientId, clientSecret, target });
    // Print only a safe projection, never serialize credentials or provider bodies.
    io.write(`\nПодключение проверено.\nVK Ads user: ${credentials.username}\n`);
    if (credentials.target?.type === "agency-client") io.write(`Client user ID: ${credentials.target.userId}\n`);
    io.write(`Credentials: ${tokens.status().path} (DPAPI CurrentUser)\n`);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(clientSecret).join("[REDACTED]") : "Ошибка локальной настройки.";
    throw new Error(`OAuth/проверка кабинета не прошла. Новые credentials не сохранены; старое подключение не изменено. ${reason}`);
  }
}
