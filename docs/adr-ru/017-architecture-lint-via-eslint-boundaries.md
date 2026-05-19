# ADR-017: Архитектурный lint через `eslint-plugin-boundaries`

- **Date**: 2026-05-14
- **Status**: Принято

---

## Контекст

К task-11 кодовая база достигла своей целевой формы: каждый сервис следует per-module-гексагональной компоновке (`domain` / `application/ports` / `application/use-cases` / `infrastructure` / `presentation`), общие библиотеки (`@retail-inventory-system/{contracts,ddd,common,database,messaging,cache,observability,auth,config}`) имеют стабильные поверхности, а межсервисный трафик — RabbitMQ-only. Границы между этими слоями и библиотеками кодифицированы в `CLAUDE.md` как абзац «Forbidden imports».

До сих пор эти правила обеспечивались **код-ревью**. `eslint-plugin-boundaries` был установлен ещё в task-02 ([ADR-004](004-adopt-hexagonal-architecture-per-service.md)), но намеренно оставлен выключенным, чтобы миграция могла продвигаться без шторма в feedback-loop линта на каждом checkpoint.

При стабильной компоновке доминируют два риска:

1. **Регрессионный дрейф.** Будущие PR, добавляющие фичу, могут тихо ввести инжекцию `Repository<XEntity>` в use case или импортировать `@nestjs/cache-manager` из-за пределов `libs/cache`, а рецензент может это пропустить. Архитектура распадается по одному PR за раз.
2. **Трение онбординга.** Новому участнику нужны правила; указание ему на markdown-файл слабее, чем красная подсветка в редакторе.

Оба адресуются кодированием правил в lint и шлюзованием их в CI.

## Решение

### 1. Выбор плагина

Принять `eslint-plugin-boundaries` (v6.0.2, уже в `devDependencies`). Обоснование:

- Таксономия типов элементов чисто отображается на гексагональную компоновку: один тип элемента на слой (`domain`, `application-use-case`, `application-port`, `application-dto`, `infrastructure`, `presentation`, `app-bootstrap`, `app-shared`) плюс один на общую библиотеку (`lib-auth`, `lib-cache`, `lib-common`, `lib-config`, `lib-contracts`, `lib-database`, `lib-ddd`, `lib-messaging`, `lib-observability`, `lib-shim`).
- `capture: ['app', 'module']` на элементах app-слоя позволяет выражать кросс-сервисную и кросс-модульную изоляцию матчером `${from.app}` / `${from.module}`, а не перечислением каждой пары (X, Y).
- Селекторы `dependency.module` покрывают per-layer-denylists внешних пакетов из таблицы рекомендаций (domain запрещает `@nestjs/*`, ports запрещают `typeorm`, presentation запрещает `@keyv/redis` и т. д.) — объединены с внутренними правилами элемент-к-элементу под единым правилом `boundaries/dependencies`.
- Плагин переиспользует стандартную настройку `import/resolver` ESLint, так что TypeScript-path-алиасы (`@retail-inventory-system/*`) работают без дополнительного подключения.

Task-12 использует API v6 сквозно: унифицированное правило `boundaries/dependencies` (с `default: 'disallow'` и `checkAllOrigins: true`), объектные селекторы `BaseElementSelectorData` (`{ type: 'X', captured: {...} }`), синтаксис шаблонов `{{from.captured.x}}` и per-source-записи политики `dependency: { module: [...] }`. Индекс 0 в `dependencyRules` — это единственное catch-all-правило `allow: { to: { origin: ['external', 'core'] } }`, освобождающее npm-пакеты и node-core-модули от полярности `default: 'disallow'`; per-source-disallow-правила позднее в массиве накладывают конкретные denylists сверху (побеждает последнее совпадение).

### 2. Таксономия типов элементов

Определена в `eslint.config.mjs` как `boundariesElements`:

| Тип элемента            | Шаблон                                              | Capture           |
| ----------------------- | ---------------------------------------------------- | ----------------- |
| `domain`                | `apps/*/src/modules/*/domain/**`                     | `app`, `module`   |
| `application-use-case`  | `apps/*/src/modules/*/application/use-cases/**`      | `app`, `module`   |
| `application-port`      | `apps/*/src/modules/*/application/ports/**`          | `app`, `module`   |
| `application-dto`       | `apps/*/src/modules/*/application/dto/**`            | `app`, `module`   |
| `infrastructure`        | `apps/*/src/modules/*/infrastructure/**`             | `app`, `module`   |
| `presentation`          | `apps/*/src/modules/*/presentation/**`               | `app`, `module`   |
| `app-bootstrap`         | `apps/*/src/main.ts`, `apps/*/src/app/**`            | `app`             |
| `app-shared`            | `apps/*/src/common/**`                               | `app`             |
| `lib-shim`              | `libs/{inventory,retail}/**`, the `libs/common/{cache,config,correlation,modules}/**` subfolders, `libs/config/{cache-module,logger-module}.config.ts` | —                 |
| `lib-{auth,cache,common,config,contracts,database,ddd,messaging,observability}` | `libs/<name>/**`       | —                 |

Запись shim должна идти до широкой записи `libs/common/**` — плагин сопоставляется с первым попавшим шаблоном, иначе более узкие шаблоны внутри `libs/common/<subfolder>/**` были бы перекрыты.

### 3. Правила зависимостей (`boundaries/dependencies`, внутренние рёбра)

`default: 'disallow'` + `checkAllOrigins: true` — каждое ребро зависимости (внутреннее или внешнее) должно соответствовать явному allow-правилу. Catch-all «allow any external/core target» по индексу 0 убирает npm и node-core-модули с пути; per-source-disallow-правила позднее в массиве накладывают конкретные denylists сверху. Основные пункты внутренних allow-правил (полный блок в `eslint.config.mjs`):

- **`domain`** → собственный модуль `domain`, `lib-ddd`, `lib-common`, `lib-contracts`.
- **`application-use-case`** → собственный модуль `domain`, `application-port`, `application-dto`, `app-shared`, плюс `lib-ddd`, `lib-common`, `lib-contracts`, `lib-auth`.
- **`application-port`** → собственный модуль `domain` и `application-port`, плюс `lib-ddd`, `lib-contracts`.
- **`application-dto`** → собственный модуль `domain`, плюс `lib-contracts`.
- **`infrastructure`** → что угодно внутри своего модуля + любая общая библиотека (здесь живут адаптеры).
- **`presentation`** → собственный модуль `application-*`, `presentation` и `app-shared`; плюс `lib-auth`, `lib-contracts`, `lib-messaging` (для `ROUTING_KEYS`), `lib-observability` (для `@CorrelationId`).
- **`app-bootstrap`** → что угодно в собственном приложении + каждая общая библиотека.
- **`app-shared`** → `app-shared` собственного приложения, плюс `lib-contracts` и `lib-common`.
- **`lib-ddd`** → только `lib-ddd`.
- **`lib-contracts`** → только `lib-contracts`.
- Другие библиотеки разрешают узкую окрестность (`lib-common` может достигать `lib-contracts`/`lib-cache`/`lib-config`/`lib-observability`; и т. д.). Shim-элемент пробрасывает к чему угодно, что нужно его ре-экспортам, поскольку shim'ы исчезнут в task-14.

Кросс-сервисная и кросс-модульная изоляция кодируется селекторами `captured`, сопоставляемыми шаблонами `{{from.captured.app}}` / `{{from.captured.module}}` на каждом выводе помощников `sameModule(...)` / `sameApp(...)`: файл `presentation` в `apps/inventory-microservice/src/modules/stock/` не может достичь файла `domain` в `apps/retail-microservice/src/modules/orders/`, потому что их capture `app` различаются.

### 4. Правила для внешних пакетов (`boundaries/dependencies`, селекторы `dependency.module`)

Только слои с задокументированными denylists несут внешние правила. Каждая запись закрепляется на источнике `from: { type: 'X' }` и перечисляет модули под `disallow: { dependency: { module: [...] } }`. Основные пункты:

- **`domain`** запрещает `@nestjs/*`, `typeorm`, `@keyv/redis`, `cacheable`, `cache-manager`, `redis`, `amqplib`, `amqp-connection-manager`, `axios`, `nestjs-pino`, `pino`, `pino-http`.
- **`application-use-case`** запрещает `@keyv/redis`, `cacheable`, `cache-manager`, `redis`, `amqplib`, `amqp-connection-manager`, `@nestjs/cache-manager`, `@nestjs/typeorm`, `axios`. Сам `typeorm` намеренно разрешён на этом слое из-за шва транзакции `EntityManager`; см. §6.
- **`application-port`** запрещает всё из `@nestjs/{common,core,microservices,typeorm,cache-manager}`, `typeorm`, `@keyv/redis`, `cacheable`, `cache-manager`, `redis`, `amqplib`, `amqp-connection-manager`, `axios`, `nestjs-pino`.
- **`application-dto`** запрещает `@nestjs/*`, `typeorm`, `@keyv/redis`, `cacheable`, `redis`, `amqplib`, `axios`.
- **`presentation`** запрещает `typeorm`, `@keyv/redis`, `cacheable`, `cache-manager`, `redis`, `@nestjs/typeorm`, `amqplib`, `amqp-connection-manager`. Импорты Nest controller/swagger/microservices остаются разрешёнными — это и есть работа этого слоя.
- **`lib-contracts`** запрещает `@nestjs/{common,core,microservices,typeorm,jwt,passport,cache-manager}`, `typeorm`, `@keyv/redis`, `cacheable`, `redis`, `amqplib`. `class-validator`, `class-transformer` и `@nestjs/swagger` — задокументированные исключения: contracts параллельно служат DTO wire-формата, пересекающими границы HTTP/RPC, а метаданные `@ApiProperty` управляют просмотрщиком OpenAPI Scalar, подключённым в gateway. Таблица рекомендаций гласила «только plain TypeScript» — task-12 расширяет это, чтобы разрешить три пакета декораторов, потому что альтернатива (два параллельных дерева DTO, одно для транспорта, одно для Swagger) ничего не приносит и удваивает поверхность для синхронизации.
- **`lib-ddd`** запрещает `@nestjs/*`, `typeorm`, `@nestjs/typeorm`, `@nestjs/microservices`, `@keyv/redis`, `cacheable`, `cache-manager`, `redis`, `amqplib`.

### 5. Стратегия CI

Существующий job `lint` в `.github/workflows/ci-cd.yml` уже запускает `yarn lint` как шлюзовой шаг (`yarn lint --max-warnings 0`). С правилами boundaries, подключёнными в `eslint.config.mjs`, они выполняются внутри того же шага — путь (a), упомянутый в брифе задачи. Никакого отдельного скрипта `yarn lint:architecture` и никакого второго workflow-файла. Обоснование: CI-поверхность остаётся одним job, сбои PR по-прежнему цитируют ID нарушенного правила (сообщения об ошибках плагина boundaries точны), а дублированной install/checkout-стоимости нет.

Если более чёткие per-rule-сообщения о сбоях станут ценными позже, sibling-скрипт `yarn lint:architecture`, который запускает ESLint только с `--rule '{ "boundaries/*": "error" }'`, — это пятистрочное дополнение.

### 6. Задокументированные исключения

Строгое прочтение таблицы рекомендаций оставляет несколько реальных нарушений, которые не стоит чинить в области task-12. Они задокументированы in-file с `TODO(task-14)` и кодом отслеживания и перечислены в `_carryover-12.md`:

| Код              | Файл                                                                                                          | Что                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ARCH-LINT-EX-01` | `apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts`                    | `import { EntityManager } from 'typeorm'` для аргумента области транзакции на методах порта.  |
| `ARCH-LINT-EX-01` | `apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts`     | `import { InjectEntityManager } from '@nestjs/typeorm'`, чтобы получить тот же EntityManager. |

Оба — одна и та же корневая причина: единица работы, которую открывает use case, — это `EntityManager` из TypeORM, утекающий через поверхность порта, чтобы вызывающие могли компоновать транзакционные чтения/записи внутри одного callback `transaction(...)`. Чистый фикс — это абстракция `ITransactionPort`, которую use case приобретает и которую репозиторий принимает как непрозрачный токен. Рефакторинг крупнее области task-12 и естественно принадлежит очистке shim в task-14, когда ре-экспорты `libs/common` наконец уйдут и прикладной слой сможет осесть на финальной поверхности порта.

Каждое исключение несёт `eslint-disable-line boundaries/dependencies` плюс комментарий TODO, именующий код отслеживания. Перезапуск `yarn lint` с удалённым disable за секунды снова всплывает нарушение — подавление намеренно и обратимо.

### 7. Регрессионный тест

`tests/lint/architecture-lint.spec.ts` запускает ESLint `Linter` программно против hand-crafted-исходных строк-фикстур, утверждая, что каждое правило срабатывает с ожидаемым ruleId `boundaries/dependencies`. Он покрывает:

- per-layer-внешние denylists (domain, use-case, port, presentation, lib-contracts, lib-ddd);
- per-layer-запреты типов элементов (domain ↛ infrastructure, port ↛ infrastructure, presentation ↛ infrastructure, presentation ↛ lib-database);
- кросс-сервисное правило (use-case ↛ domain другого приложения);
- позитивные случаи (domain → lib-ddd, infrastructure → lib-cache) — для защиты от чрезмерно широкого правила, поглощающего легитимные рёбра.

Пути файлов фикстур — виртуальные — `Linter.verify(code, config, { filename })` принимает синтетический путь, и плагин boundaries сопоставляет его с шаблонами элементов так же, как реальные файлы. Кросс-элементные тесты нацеливают свои импорты на реальные продакшен-файлы (чтобы резолвер модулей плагина мог отобразить импорт обратно на элемент-типизированную цель).

Спек добавлен в lint-область `apps/**/*.ts` + `libs/**/*.ts` через блок послабления `tests/**/*.ts` в `eslint.config.mjs` (та же форма, что и у существующего послабления `test/**/*.ts`), чтобы правила строгой типизации не срабатывали на исходных строках фикстур.

## Последствия

### Положительные

- Архитектурный дрейф ловится во время PR, а не на следующем аудите. Рецензенты перестают быть узким местом для «нормально ли этот импорт».
- Правила становятся обнаруживаемыми: редактор с ESLint-расширением подсвечивает нарушение inline, со ссылкой на доки плагина из ID правила.
- Фикстурный спек даёт правилам референсную рамку юнит-теста — если будущее изменение ослабит правило, спек упадёт, всплывая регрессию до того, как плохой импорт высадится.
- Таксономия типов элементов параллельно служит словарём для код-ревью: «это принадлежит `application-port`, а не `application-use-case`» — то же, что говорит lint.

### Отрицательные

- Поверхность линта шире; участник, добавляющий фичу, может чаще переоформлять свои импорты. Смягчается тем, что правила соответствуют тому, что `CLAUDE.md` уже документирует — никаких неожиданных ограничений.
- У объединённого правила `boundaries/dependencies` больше режимов сбоя для рассуждения, чем у исходного split (`boundaries/element-types` + `boundaries/external`): catch-all «allow any external/core target» по индексу 0 — несущая, а случайные чрезмерно широкие disallow-правила могут молча блокировать npm-импорты. Фикстурный спек — это бампер, ловящий этот класс регрессии рано.

### Открытые

- Правило `import-order`, обеспечивающее, что `@retail-inventory-system/observability/tracer` — первый импорт в каждом `apps/*/src/main.ts`, не входит в поверхность плагина boundaries. Сегодня правило обеспечивается код-ревью; будущая задача может добавить его через `import/order` из `eslint-plugin-import` или маленькое кастомное правило.
- Тип элемента shim уйдёт вместе с shim-библиотеками в task-14.

## Рассмотренные альтернативы

- **Только `eslint-plugin-import`.** Ограничения по path-pattern через `no-restricted-imports` покрывают denylists *внешних* пакетов, но не могут выразить per-layer / per-module-изоляцию без явного перечисления каждой пары (source, target) — это взрывается с каждым новым модулем. `eslint-plugin-boundaries` — наименьший инструмент, обрабатывающий обе оси нативно.
- **Pre-commit-скрипт, грепающий запрещённые импорты.** Быстрее в написании, медленнее в поддержке — каждый новый запрещённый шаблон — это новый grep, и скрипт не может рассуждать о резолюции модулей (он не может отличить `import 'redis'` от `import './redis'`). Плагин boundaries получает резолюцию модулей бесплатно через `eslint-import-resolver-typescript`.
- **Разделённые конфиги eslint** (`eslint.config.mjs` для стиля кода, `eslint.architecture.mjs` для boundaries, два скрипта `yarn lint:*`). Отклонено: единый конфиг, выполняющийся в одном шаге CI, удерживает feedback-loop разработчика короче и избегает foot-gun «я запустил один lint, но не другой».

---

## Ссылки

- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) — границы
  слоёв, которые кодирует этот lint.
- [ADR-005](005-split-shared-common-into-bounded-libs.md) — таксономия
  библиотек, на которую отображаются типы элементов.
- [ADR-018](018-nestjs-monorepo-apps-and-libs.md) — единое исходное
  дерево монорепозитория, по которому работает плагин boundaries.
