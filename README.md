# VK Ads MCP — hardened fork

Защищённый форк [`askads/mcp-vk-ads`](https://github.com/askads/mcp-vk-ads) для работы AI-ассистента с боевым кабинетом VK Рекламы.

Главная цель — сохранить готовую интеграцию с VK Ads API, но поставить серверные ограничения между моделью и реальными рекламными деньгами.

> **Важно:** не устанавливайте `mcp-vk-ads@latest`, если хотите использовать hardening из этого репозитория. Это upstream npm-пакет.

## Что уже защищено

- API origin закреплён только на `https://ads.vk.com/api`;
- внешняя телеметрия отключена;
- `read-only` включён по умолчанию;
- `draft` создаёт только остановленные рекламные объекты;
- `full` нужен для остальных write-операций;
- есть серверные hard caps для дневного и общего бюджета;
- `client_secret` не принимается ни одним MCP tool;
- на Windows credentials хранятся через DPAPI `CurrentUser`, а не plaintext JSON;
- runtime dependencies проходят audit в CI;
- native Windows runner проверяет build, tests и DPAPI round-trip.

## Windows: безопасное подключение кабинета

Нужны Git и Node.js 20+.

```powershell
git clone https://github.com/tishin-serg/mcp-vk-ads.git
cd mcp-vk-ads
git checkout <reviewed-commit>
npm ci
```

После сборки выполните **локально на Windows**:

```powershell
npm run auth:setup
```

Команда спросит:

- `client_id`;
- `client_secret`.

`client_secret` вводится скрыто в локальном терминале. Его не нужно и нельзя присылать в ChatGPT.

Setup:

1. получает токен только с официального `https://ads.vk.com/api`;
2. проверяет живым запросом, в какой VK Ads кабинет попал;
3. сохраняет `client_secret`, access token и refresh token через Windows DPAPI `CurrentUser`;
4. при неуспешной проверке удаляет сохранённые credentials.

Файл `~/.config/mcp-vk-ads/credentials.json` на Windows содержит только DPAPI ciphertext. Расшифровать его может Windows-контекст того пользователя, под которым был выполнен setup.

`VK_ADS_TOKEN` остаётся только как дополнительный локальный вариант для CI/временных сценариев и имеет приоритет над сохранённым входом.

## Запуск MCP на Windows

После `npm ci` и `npm run auth:setup` сервер можно запустить:

```powershell
npm start
```

Для MCP-клиента запускайте локальный файл:

```text
<absolute-path-to-repo>\dist\index.js
```

через `node`.

Пример переменных безопасности для первого подключения:

```text
VK_ADS_WRITE_MODE=read-only
VK_ADS_MAX_DAILY_BUDGET=5000
VK_ADS_MAX_TOTAL_BUDGET=30000
```

Сначала работайте в `read-only`. После проверки статистики и структуры кабинета переходите к `draft`. `full` нужен только для контролируемого запуска/изменения рекламы.

## Модель write-доступа

| Режим | Что разрешено |
|---|---|
| `read-only` | Только чтение. Любые POST/DELETE блокируются до сети. |
| `draft` | Создание кампаний, групп и объявлений только со `status=blocked`, плюс остановка существующих рекламных объектов. |
| `full` | Остальные write-операции в пределах budget caps. |

Ограничения применяет сам MCP-сервер, а не промпт модели.

## Что нельзя передавать в AI-чат

Никогда не отправляйте:

- `client_secret`;
- access token;
- refresh token.

Upstream `start_login` / `finish_login` передавал `client_secret` через аргументы MCP. В hardened fork `finish_login` отключён и не принимает credentials. `start_login` только сообщает, что setup нужно выполнить локально на Windows.

## Рабочий сценарий

1. AI читает кампании, группы, объявления и статистику.
2. Анализирует расходы, CPM/CTR/конверсии и действующие настройки.
3. Предлагает медиаплан и гипотезы.
4. В `draft` создаёт остановленные кампании/группы/объявления.
5. Пользователь проверяет план.
6. Активация и изменение боевого бюджета доступны только в явно разрешённом режиме и в пределах серверных caps.

## Проверки

CI проверяет Ubuntu Node 20/22/24 и Windows Node 22:

- `npm audit --omit=dev --audit-level=high`;
- TypeScript typecheck;
- build;
- полный набор тестов;
- Windows DPAPI encrypt/decrypt round-trip;
- отсутствие `client_secret`, access token и refresh token в credential-файле;
- запрет foreign API origin;
- `read-only` / `draft` / `full`;
- budget caps;
- отсутствие сетевой телеметрии.

Подробнее: [`docs/HARDENING.md`](./docs/HARDENING.md).

## Upstream

Исходный проект: [`askads/mcp-vk-ads`](https://github.com/askads/mcp-vk-ads), MIT License.

Форк не аффилирован с VK и не является официальным клиентом VK Рекламы.
