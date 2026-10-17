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

Сначала выберите тип подключения:

- **Own / manager** — `client_credentials`, собственный кабинет.
- **Agency / manager client** — временный manager token в памяти, чтение списка
  клиентов через `GET v3/manager/clients.json`, выбор клиента и выпуск
  `agency_client_credentials` с `agency_client_name=<username/login>`.

В списке показываются login, имя (если API его вернул) и `user.id`; ID связи
manager↔client не используется как ID рекламного пользователя. Если список
недоступен, setup попросит точный login, а не произвольный numeric ID.

Пример целевого локального подключения:

```text
manager 18752958
        ↓
client 707b7e2f6b@agency_client
        ↓
per-client OAuth token
        ↓
MCP (read-only)
```

Эти значения не зашиты в runtime. Для локальной проверки можно задать только
несекретные ограничения `VK_ADS_EXPECTED_MANAGER_ID` и
`VK_ADS_EXPECTED_AGENCY_CLIENT_NAME` перед setup. Другие клиенты не выбираются
автоматически. Заданный expected login — явный выбор пользователя: setup
сразу использует agency-режим и только этот login, без выбора другого клиента.

Agency token проверяется через `GET v3/user.json` **до сохранения**: username
должен совпасть с выбранным login, а user ID — с выбранным ID, если он известен.
При несовпадении новый token не сохраняется и старое подключение не удаляется.
Refresh использует `grant_type=refresh_token` с app credentials, затем повторно
проверяет исходные username и ID до принятия token. Возврата к manager grant нет.
При подтверждённом несовпадении после refresh старые agency credentials удаляются;
при временной сетевой ошибке token не принимается, а файл сохраняется для retry.

Исследованный OAuth contract и ограничения доказательств:
[`docs/OAUTH-CONTRACT.md`](./docs/OAUTH-CONTRACT.md).

`client_secret` вводится скрыто в локальном терминале. Его не нужно и нельзя присылать в ChatGPT.

Setup:

1. получает токен только с официального `https://ads.vk.com/api`;
2. проверяет живым запросом, в какой VK Ads кабинет попал;
3. только после успешной проверки сохраняет app credentials, access/refresh token
   и выбранный auth target через Windows DPAPI `CurrentUser`;
4. при неуспешной проверке не сохраняет новый token и не заменяет старый файл.

Файл `~/.config/mcp-vk-ads/credentials.json` на Windows содержит только DPAPI ciphertext. Расшифровать его может Windows-контекст того пользователя, под которым был выполнен setup.

`VK_ADS_TOKEN` остаётся только как дополнительный локальный вариант для CI/временных сценариев и имеет приоритет над сохранённым входом.

## Запуск MCP на Windows

### Готовый клиентский токен (например, выданный eLama)

Если вам выдали именно готовый access token для клиентского login, OAuth-пара
`client_id/client_secret` для его использования не нужна:

```powershell
npm run auth:token
```

Эквивалент: `npm run auth:setup -- --access-token`. Setup запросит ожидаемый login
клиента (или возьмёт явно заданный `VK_ADS_EXPECTED_AGENCY_CLIENT_NAME`), затем
сам токен через **скрытый локальный ввод**. Не передавайте значение в argv, env,
чат или файл. Вставляйте только токен, без префикса `Bearer`.

Этот сценарий делает только `GET v3/user.json`, проверяет точный username и
сохраняет token с подтверждённым user ID через DPAPI CurrentUser. При другом
кабинете или ошибке новый token не сохраняется, старое подключение сохраняется.
App credentials и refresh token не выдумываются и не записываются.

`auth_status` показывает `authMethod=access-token`, `canRefresh=false` и
`expiresAtKnown=false`: срок действия из голого token не установлен. Setup не
декодирует JWT и не обещает бессрочное действие. При HTTP 401 нужно получить
новый token у выдавшей стороны и снова выполнить `npm run auth:token` локально.
Ни одного нового MCP-инструмента для передачи token через AI не добавлено.

Первый реальный запуск должен оставаться read-only. Верификация API обязательна:
надпись «токен» в письме сама по себе не доказывает формат или валидность строки.

После `npm ci` и `npm run auth:setup` сервер можно запустить:

```powershell
npm start
```

Простой Windows launcher (секретов внутри нет, режим по умолчанию read-only):

```powershell
powershell.exe -NoProfile -File .\scripts\start-windows.ps1
```

Явный `-Mode draft` / `-Mode full` действует только на текущий процесс; launcher
требует оба утверждённых budget cap. Не включайте full постоянно.

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

Проверка живого read-only кабинета 2026-10-17 выявила и исправила маршрут
статистики: диапазонная сводка берётся из v3 `/statistics/{entity}/day.json`
(метрики через `fields`), дневные строки — из v2 `/day.json` (через `metrics`).
Оба режима требуют даты. week/month явно не поддерживаются; параметры пагинации
и сортировки доступны только для summary. Подробности:
[`get_statistics`](./docs/capabilities/get-statistics.md).
API total относится к возвращённой странице, а не ко всему кабинету; при
autoPaginate он опускается, чтобы не выдать неполный итог за общий.

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
