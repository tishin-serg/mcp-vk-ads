# Ретаргетинг без дополнительных typed tools

Исследовано 2026-10-17: живой кабинет проверен только GET через существующий
raw_request. POST/DELETE не выполнялись. Write contract проверен по документации,
не боевым созданием рекламы. Конкретные ID/правила кабинета — в отдельном локальном
отчёте, без токенов и без публикации данных рекламодателя в Git.

## 1. Уже работает без изменений

Списки и статистика кампаний, групп и объявлений; создание/изменение кампаний и
групп; бюджеты, даты, запуск/остановка — существующие tools. Сложные поля передаются
через extra/targetings: `targetings.fulltime` (расписание), `targetings.pads`,
`targetings.segments`, `extra.pricelist_id`, `extra.enable_utm=true`, `extra.utm`.
Перед POST сверять options пакета. Нельзя копировать GET-объект целиком в POST:
часть полей read-only/create-only.

## 2. Работает через raw_request

Пути относительны к pinned `https://ads.vk.com/api/`.

| Возможность | Endpoint | Доказательства/параметры |
|---|---|---|
| Сегменты | GET `v2/remarketing/segments.json` | Живой 200; fields=id,name,pass_condition,relations; limit/offset |
| Сегмент | GET `v2/remarketing/segments/{id}.json` | Живой 200; fields=id,name,pass_condition,relations_count,campaign_ids |
| Полные правила | GET `v2/remarketing/segments/{id}/relations.json` | Живой 200; обязательно fields=id,object_type,object_id,params |
| Создать сегмент | POST `v2/remarketing/segments.json` | Документирован; JSON {name,pass_condition,relations:[...]} |
| Изменить сегмент | POST `v2/remarketing/segments/{id}.json` | Документирован; name/pass_condition; relations у сегмента create-only |
| Добавить источники | POST `v2/remarketing/segments/{id}/relations.json` | Документирован; JSON {items:[...]} |
| Изменить источник | POST `v2/remarketing/segments/{id}/relations/{rid}.json` | Документирован; params; object_type/object_id create-only |
| Удалить сегмент | DELETE `v2/remarketing/segments/{id}.json` | Документирован; нельзя, если используется. Для задачи не нужен |
| Счётчики/пиксель сайта | GET `v2/remarketing/counters.json` | Живой 200; id связи отличается от counter_id Top@Mail |
| События | GET `v2/remarketing/counters/{counter_id}/goals.json` | Живой 200 именно с Top@Mail counter_id |
| Детали счётчика | GET `v2/remarketing/counters/{counter_id}.json` | Живой 200; fields=id,counter_id,name,domain,goals |
| Каталоги | GET `v2/remarketing/pricelists.json`, `.../{id}.json` | Оба живых GET 200 |
| Пакеты | GET `v2/packages.json` | Живой 200; _id__in; fields=id,options,banner_format_id |
| Имена размещений | GET `v2/packages_pads.json` | Живой 200; _id__in=<pad IDs>; description/eye_url |
| Дерево площадок | GET `v2/pads_trees.json` | Живой 200; выбрать дерево по package.pads_tree_id локально |
| Форматы | GET `v2/banner_formats.json`, `v2/banner_patterns.json` | Format живой 200; новые pattern slots сверять с package |
| Ссылки | POST `v2/urls.json` | Документирован; JSON; в исследовании не выполнялся |

Все raw POST/DELETE требуют confirmWrite=true и разрешённого серверного режима.
Сегменты не требуют нового typed tool. Их изменение/создание требует full;
draft разрешает только остановленные рекламные объекты и stop.

`params.left/right` задают окно; `type=positive/negative` — включение/исключение;
source_id/goal_id — источник и событие. При object_type=segment рекурсивно читать
вложенный сегмент и его pass_condition: params=null не означает отсутствие правил.
В живом кабинете встречается pass_condition=0 для инверсии вложенного сегмента;
нельзя заменять логику по его названию. pass_condition — число, не "and"/"or".

Каталожный источник может содержать action=cart, negative_action=purchase. Это
не доказывает глобальное исключение всех покупателей: сопоставление товаров и
период отрицательного действия не раскрыты в доступной спецификации. Для явного
исключения покупателей использовать отдельное событие сайта.

Пример чтения правил (подставить ID из targetings текущей группы):

```json
{"path":"v2/remarketing/segments/123/relations.json","query":{"fields":"id,object_type,object_id,params"}}
```

count списка — число сегментов, не людей. raw_request не имеет autoPaginate:
обходить limit/offset до count. relations.params в fields дал живой 400 — читать
relations отдельным запросом. pads_trees проигнорировал _id__in и вернул весь
справочник; для компактного ответа использовать packages_pads с точными pad IDs.

## 3. Минимальная доработка

- Один новый tool upload_image: JPEG/PNG base64 + width/height + confirmWrite=true
  → native multipart file + JSON data={width,height} → фактические id/variants VK.
  Без новых зависимостей, URL fetching и чтения локальных файлов.
- Исправлен create_banner: POST v2/ad_groups/{adGroupId}/banners.json. Верхний
  v2/banners.json — список. Draft принудительно задаёт blocked на вложенном пути.
- Typed create/update/action возвращают объект после GET; raw POST к кампаниям,
  группам, объявлениям, сегментам и relations тоже получает read-back. Если GET
  после записи не удался, явная ошибка запрещает повтор create. Для других raw
  endpoint-ов возвращается исходный ответ VK: если это квитанция/ID, caller должен
  отдельно прочитать объект. DELETE возвращает ответ VK: удалённого объекта нет.
- Вложенные ad_groups/banners принудительно stopped в draft; caps проверяются во
  вложенных JSON, включая items. При заданном cap null/0/нечисловой бюджет запрещён.
- Network error/5xx write явно требует GET перед повтором; автоматического
  replay нет. Ограниченный retry GET сохранён.

Медиа разрешено только в full: текущая draft-политика не расширена. Загрузка сама
не активирует рекламу. 5 MiB — локальный лимит tool, не обещание лимита VK.
Base64 изображения может упереться в лимиты MCP-клиента; вложения ChatGPT не
передаются автоматически. Нужны сами байты изображения. Видео/HTML5 не добавлены.

## 4. Ограничения API и границы доказательств

- Точный размер сегмента и количественное пересечение людей не подтверждены
  документированным GET; users_count/audience_size дали 400. users — пользователи
  кабинета с доступом, не аудитория. Это не доказательство отсутствия любых других
  методов во всём API.
- POST v3/projection.json — документированный прогноз по поддерживаемым
  таргетингам/ставке, не точный размер сегмента. В описанных ProjectionTargetings
  нет segments. Прогноз не запускался: POST запрещён для исследования.
- У сегмента нет документированного writable status=blocked: остановить можно
  использующую его группу. Удаление для пересборки не нужно.
- Динамические product images задаются фидом: соответствующие slots read-only.
  upload_image даёт медиа для writable slot (например icon_256x256), не меняет
  изображения товаров каталога.
- Модерация, права токена и package restrictions остаются условиями запуска.
  Рабочий GET не доказывает write-права или успешную публикацию.

## 5. Риски и порядок пересборки

1. get_user_info: точный ожидаемый клиент. list_ad_plans → list_ad_groups с полями
   targetings/pricelist_id/package_id/utm → list_banners. Прочитать правила raw GET.
2. Разные окна событий не делают аудитории людей непересекающимися: один человек
   может добавлять товары в разные дни. Предлагаемая логика последней корзины:
   C3 ∩ ¬P; C15 ∩ ¬C3 ∩ ¬P; C30 ∩ ¬C15 ∩ ¬P. Cn — накопительная корзина за n дней,
   P — покупки за согласованный период. Не выдумывать срок P и денежные лимиты.
   Это логическое непересечение при одинаковом источнике/времени/identity resolution,
   не измерение overlap. Границы и часовой пояс VK сверить перед записью.
3. После согласования временный full: raw POST создаёт новые сегменты с positive
   Cn и negative свежими корзинами/покупками; pass_condition = число условий.
   Не редактировать используемые сегменты. upload_image для новых изображений;
   raw POST urls.json для новых ссылок. Каждый вызов явный; raw/upload с confirmWrite.
4. Draft: create_ad_plan → create_ad_group → create_banner, с явными бюджетами,
   датами, package_id, pricelist_id, targetings, enable_utm/utm. Можно передать
   banners[] через extra при создании группы — вложенные статусы тоже blocked.
5. Проверить GET каждого объекта, реальные статусы/бюджеты/таргетинги/UTM,
   сегменты и модерацию. При неопределённом write найти результат GET по ID/имени/
   времени; не повторять create наугад.
6. Только после разрешения на запуск: временный full, явные banner_action,
   ad_group_action, ad_plan_action activate. Проверить delivery/issues/statistics.
   Stop через те же actions доступен и в draft. Затем вернуть read-only.

Full даёт широкие полномочия raw_request; confirmWrite не заменяет разрешение
человека на расход. Caps ограничивают поля каждого объекта, не сумму расходов
кабинета. Отсутствующее поле не создаёт бюджет автоматически. Неизвестные
mass_action/другие write endpoints требуют проверки payload и результата.
Полный цикл создания/запуска в исследовании не выполнялся.

## Источники

Официальные страницы прочитаны 2026-10-17 по HTTPS без авторизации через
Invoke-WebRequest (HTTP 200 и текст документа). ads.vk.com переадресует документацию
на ads.vk.ru. Credential-bearing API остался pinned на ads.vk.com без redirects.

- [Segments](https://ads.vk.ru/en/doc/api/resource/Segments),
  [Segment](https://ads.vk.ru/en/doc/api/resource/Segment),
  [SegmentRelation](https://ads.vk.ru/en/doc/api/resource/SegmentRelation),
  [SegmentRelations](https://ads.vk.ru/en/doc/api/resource/SegmentRelations),
  [SegmentParams](https://ads.vk.ru/en/doc/api/info/SegmentParams).
- [CounterGoals](https://ads.vk.ru/en/doc/api/resource/CounterGoals),
  [PackagesPads](https://ads.vk.ru/en/doc/api/resource/PackagesPads),
  [Package](https://ads.vk.ru/en/doc/api/object/Package).
- [Content](https://ads.vk.ru/en/doc/api/resource/Content),
  [Add banners](https://ads.vk.ru/en/doc/api/info/Add%20banners),
  [ProjectionPrediction](https://ads.vk.ru/en/doc/api/resource/ProjectionPrediction).
- Независимое подтверждение multipart file+JSON data:
  [Digsolab CreativeOperator](https://github.com/Digsolab/mytarget-php-ads-sdk/blob/4949ff7e0ff0197bae6464bfecd90bf5d8d519a4/src/Operator/V2/CreativeOperator.php).
  Старый SDK подтверждает формат, не новые маршруты/права текущего кабинета.
