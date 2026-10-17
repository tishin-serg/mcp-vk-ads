# Инструменты

Для выбора по пользовательской задаче откройте [каталог MCP-возможностей](./capabilities/index.md). Эта страница остаётся техническим справочником схем и ответов API.

Сервер предоставляет типизированные инструменты для частых объектов VK Ads,
JSON-вызовы `raw_request` и multipart `upload_image`. Доступность методов зависит
от API, прав токена и серверной write-политики; это не гарантия доступа ко всему API.

Иерархия объектов: **ad_plan** (кампания) → **ad_group** (группа объявлений) → **banner** (объявление).

## Подключение

| Инструмент | Что делает |
| --- | --- |
| `auth_status` | Есть ли токен, откуда он взят (`env` / сохранённый вход), когда истекает, какой `client_id` и аккаунт за ним. Без сети; ни токен, ни `client_secret` не показывает. |
| `start_login` | Инструкция для пользователя: где в кабинете создать приложение и откуда скопировать `client_id` / `client_secret`. Без сети. |
| `finish_login` | Отключён, credentials не принимает. Для OAuth используйте локальный `npm run auth:setup`, для готового токена — `npm run auth:token`; Windows хранит их через DPAPI. |
| `logout` | Удаляет сохранённое подключение с диска. `VK_ADS_TOKEN` не трогает. |

OAuth refresh выполняется локальным TokenStore с повторной проверкой agency target.
У готового токена срок неизвестен и автоматического refresh нет. Секреты в MCP/чат
не передаются; подробности — в README.

## Аккаунт и справочники

| Инструмент | Что делает |
| --- | --- |
| `get_user_info` | Данные кабинета (`user.json`), в т.ч. `additional_info.client_name`. |
| `get_balance` | Баланс кабинета (`user.json`, поле `account`): доступные средства (`account.balance`) и валюта — в рублях, без микроединиц. |
| `get_throttling` | Текущие лимиты API и остаток (`throttling.json`). |
| `get_regions` | Поиск id регионов по подстроке названия (нужны для таргетинга групп). |

## Кампании, группы, объявления

| Инструмент | Что делает |
| --- | --- |
| `list_ad_plans` / `create_ad_plan` / `update_ad_plan` / `ad_plan_action` | Список, создание, обновление (имя, бюджеты, ставка, даты), смена статуса. |
| `list_ad_groups` / `create_ad_group` / `update_ad_group` / `ad_group_action` | Список, создание, обновление групп (бюджеты, ставка, `targetings`), смена статуса. |
| `list_banners` / `create_banner` / `update_banner` / `banner_action` | Список, создание, обновление объявлений (`textblocks`, `urls`, `content`), смена статуса. |
| `upload_image` | JPEG/PNG base64 + width/height + confirmWrite=true; full; POST `v2/content/static.json`, multipart file/data. Возвращает фактические id/variants. Не читает файлы/URL. |

`create_banner` использует POST `v2/ad_groups/{id}/banners.json`, а не верхний список.
`create_ad_plan` требует непустой adGroups (совместимо с extra.ad_groups) и создаёт
первые группы вместе с кампанией, JSON-поле — ad_groups. Пустой create, existing
group IDs и конфликт двух способов ввода отклоняются до сети. Возвращаются
GET-проверенные кампания и её группы. Общий и дневной бюджет одновременно не задавать.
Typed create/update/action после записи читают объект через GET. Если проверка
не удалась, ошибка явно сообщает, что write принят и его нельзя повторять вслепую.

`*_action` принимает `action`: `activate` (status=`active`), `stop` (status=`blocked`), `delete` (status=`deleted`) и список `ids`.

## Статистика и универсальный вызов

| Инструмент | Что делает |
| --- | --- |
| `get_statistics` | Обязательны dateFrom/dateTo. `summary`: сводка через v3 `/day.json`, метрики `total.base`, пагинация/сортировка. `day`: дневные `rows[].base` через v2 `/day.json` без пагинации. week/month не поддерживаются. |
| `raw_request` | Прямой вызов любого эндпоинта (`path`, `method`, `query`, `body`). GET свободен; POST/DELETE требуют `confirmWrite=true`. |

Тело raw_request — только JSON-объект, query — скаляры (списки фильтров CSV).
Пагинация ручная. POST известных рекламных объектов/сегментов/relations читает
состояние обратно через GET; прочие endpoints возвращают исходный ответ VK,
и при квитанции/ID нужен отдельный GET. DELETE возвращает ответ VK без объекта.
Все write проходят серверный mode/caps. Network error/5xx POST не повторяется;
сначала проверить результат GET. Практические endpoints и ограничения:
[исследование ретаргетинга](./RETARGETING.md).

## Деньги, статусы и постраничная выдача

- **Деньги** (`budget_limit`, `budget_limit_day`, `max_price`, `price`, расход в статистике) — в валюте кабинета (рублях), без пересчёта в микроединицы.
- **Статусы**: `status` (`active` / `blocked` / `deleted`) — единственный изменяемый; `delivery` (`delivering` / `not_delivering` / `pending`) и `moderation_status` (`allowed` / `banned` / `pending`) — только чтение, объясняют, почему объявление показывается или нет.
- **Постраничная выдача**: списочные инструменты принимают `limit` (≤250) / `offset` и флаг `autoPaginate`, который проходит все страницы по `offset`/`count`. Фильтры по id/статусу передаются как `_id__in`, `_status__in` и т.п.

## Переменные окружения

| Переменная | Обяз. | По умолчанию | Описание |
| --- | --- | --- | --- |
| `VK_ADS_TOKEN` | нет | — | Готовый access-токен VK Ads (Bearer) — для CI и автоматических установок. Имеет приоритет над входом из чата; сервер такой токен не обновляет и не удаляет. |
| `VK_ADS_LANG` | нет | `ru` | Заголовок `Accept-Language`. |
| `VK_ADS_TIMEOUT_MS` | нет | `60000` | Таймаут запроса, мс. |
| `VK_ADS_MAX_RETRIES` | нет | `3` | Повторы при временных ошибках (429, 5xx). |
| `VK_ADS_API_BASE` | нет | `https://ads.vk.com/api` | Корень API (без версии). |
