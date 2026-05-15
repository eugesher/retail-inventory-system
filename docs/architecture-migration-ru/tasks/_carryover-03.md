# _carryover-03.md — Write project-shape articles (Phase: project-shape/)

> Generated 2026-05-15 by the task-03 session of the **architecture
> migration guide** writing flow. Builds on `_carryover-02.md` (which
> built on `_carryover-01.md`, the source of the SHA pin
> `84b1507c68fd9ee02b185eef3c4594b6fe02f664`).

## Entry-gate result

`_carryover-02.md` was read in full. The five concept articles it
produced are all on `status: review`, so this task could safely
wiki-link into them. The HEAD SHA recorded in `_carryover-01.md`
(`84b1507c68fd9ee02b185eef3c4594b6fe02f664`) is used for every
GitHub permalink in every project-shape article.

Build was not re-run for this docs-only session; task-01 captured the
green build at the same SHA, and this task adds no code under
`apps/` or `libs/`. Branch is `migration-guide`; working tree was
clean at session start.

## Articles written

Four project-shape articles. Each was reshaped from the task-01 stub
(frontmatter + `Заглушка` callout) into a stand-alone Russian-language
mid-level-NestJS article that grounds every claim in production code.

| Path                                                                          | One-line Russian summary                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/architecture-migration-ru/project-shape/nestjs-monorepo.md`             | NestJS-монорепо как структурный выбор: `apps/` + `libs/`, единый `package.json`, `nest-cli.json` `monorepo: true`, TS-path-алиасы (не Yarn-воркспейсы), `nest build --all` → `dist/apps/<service>/main.js`. Anchor — ADR-018. ~1976 слов.                                       |
| `docs/architecture-migration-ru/project-shape/microservices-split.md`         | Четыре сервиса как четыре bounded-контекста (DDD): gateway / retail (Order) / inventory (StockItem) / notification (canonical template). RabbitMQ как единственный seam (ADR-020); шаблон один на всех (ADR-004). Карта `main.ts`-ов, карта домена. ~2041 слова.                |
| `docs/architecture-migration-ru/project-shape/api-gateway-pattern.md`         | Gateway как HTTP-edge + auth, **не** business-сервис. `ClientProxy` живёт только в `infrastructure/messaging/*-rabbitmq.adapter.ts`. Per-module hexagonal даже без домена (auth — единственный модуль с `domain/`). End-to-end flow `POST /api/order`. Anchor — ADR-009. ~2316 слов. |
| `docs/architecture-migration-ru/project-shape/shared-libs-philosophy.md`      | Девять libs (`contracts`, `ddd`, `common`, `database`, `cache`, `messaging`, `observability`, `auth`, `config`), каждая со своим списком запретов. `default: 'disallow'` в `eslint-plugin-boundaries`; per-layer таблица «что куда». Anchor — ADR-005 + ADR-017. ~2210 слов.       |

All four articles flipped `status: draft` → `status: review` in their
frontmatter; `updated:` set to `2026-05-15`. Each carries the
mandatory `> [!abstract] Кратко` block, `## Глоссарий` section, and
`> [!faq]- Проверь себя` collapsible with five self-check questions.

Across the four articles: **38 GitHub permalinks** pinned to
`84b1507c68fd9ee02b185eef3c4594b6fe02f664` (verified by
`grep -c 'blob/84b1507c…' docs/architecture-migration-ru/project-shape/*.md`
→ 7 + 9 + 10 + 12 = 38). Code anchors include all suggested files
from task-03 step 3, plus a few that helped tell the story:

- `nest-cli.json`, `tsconfig.json`, `package.json`,
  `apps/api-gateway/tsconfig.app.json` — monorepo evidence.
- `apps/*/src/main.ts` for all four services — split evidence.
- `apps/api-gateway/src/app/app.module.ts` — global guards + middleware
  wiring.
- `apps/api-gateway/src/modules/retail/{presentation/order.controller,application/use-cases/create-order.use-case,application/ports/retail-gateway.port,infrastructure/messaging/retail-rabbitmq.adapter,infrastructure/retail.module,presentation/pipes/order-confirm.pipe}.ts`
  — full vertical slice of one gateway flow.
- `libs/{contracts,ddd,common,database,messaging,cache,observability,auth,config}/index.ts`
  — lib responsibility evidence.
- `eslint.config.mjs:62-70` (element-types), `:113-216` (per-source
  allow-lists), `:217-264` (per-source lib edges).

## Glossary terms collected

EN→RU pairs introduced across the four articles. These get rolled into
the consolidated `glossary.md` in task-12.

| Source article             | EN term                                  | RU explanation (short)                                                                                                       |
| -------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| nestjs-monorepo            | Monorepo                                 | Один Git-репозиторий, в котором живёт несколько деплоимых сервисов и общий код.                                                |
| nestjs-monorepo            | NestJS monorepo mode                     | Режим `nest-cli.json` с `monorepo: true`; общая сборка `nest build --all`.                                                    |
| nestjs-monorepo            | TS path alias                            | Алиас вида `@retail-inventory-system/<name>` в `compilerOptions.paths`.                                                       |
| nestjs-monorepo            | Yarn workspace                           | Сабпроект Yarn с собственным `package.json`. У нас объявлен, но per-lib `package.json` нет.                                    |
| nestjs-monorepo            | `nest-cli.json` projects                 | Запись `projects.<service>` под `monorepo: true`; root, sourceRoot, tsConfigPath.                                              |
| nestjs-monorepo            | `tsconfig.app.json`                      | Per-app TS-конфиг, наследующий корневой; переопределяет только `outDir` и `include`.                                          |
| nestjs-monorepo            | Webpack node externals                   | Плагин, исключающий `node_modules` из бандла; в Docker копируется только `dist/apps/<service>/`.                              |
| nestjs-monorepo            | Polyrepo                                 | «Один репозиторий — один сервис». В ADR-018 отвергнут.                                                                          |
| nestjs-monorepo            | Nx workspace                             | Альтернативный orchestrator (Nrwl Nx). Документирован как future option.                                                       |
| microservices-split        | Microservice                             | Деплоимый процесс со своим bounded-контекстом, очередью RMQ, набором сущностей.                                                |
| microservices-split        | Bounded context                          | Граница языка предметной области в DDD; один сервис = один контекст.                                                           |
| microservices-split        | API Gateway                              | Edge-сервис с HTTP-портом; аутентификация + проксирование RPC.                                                                  |
| microservices-split        | RMQ-only service                         | Сервис без HTTP-порта; общение только через RabbitMQ.                                                                          |
| microservices-split        | Bus / Message bus                        | RabbitMQ — единственный транспорт между процессами (ADR-020).                                                                  |
| microservices-split        | Canonical template                       | Notification-микросервис как шаблон для retail/inventory (ADR-011).                                                            |
| microservices-split        | Per-module hexagonal                     | Layout `domain/application/infrastructure/presentation` внутри `modules/<name>/`.                                              |
| microservices-split        | Queue per service                        | У каждого сервиса своя очередь RMQ (retail_queue, inventory_queue, notification_events).                                       |
| microservices-split        | Cross-service RPC                        | `ClientProxy.send` между двумя микросервисами.                                                                                  |
| microservices-split        | Cross-service event                      | `ClientProxy.emit` — fire-and-forget. Notification слушает retail/inventory events.                                            |
| api-gateway-pattern        | HTTP edge                                | «Внешняя кромка» системы — единственное место, куда могут подключаться внешние клиенты.                                          |
| api-gateway-pattern        | `ClientProxy`                            | Класс из `@nestjs/microservices` для RPC/event'ов. Живёт только в `infrastructure/messaging/`.                                  |
| api-gateway-pattern        | `MicroserviceClient<Svc>Module`          | Модуль из `libs/messaging` для регистрации `ClientProxy` под DI-токеном.                                                        |
| api-gateway-pattern        | `firstValueFrom`                         | Утилита rxjs: Observable → Promise. Используется в каждом адаптере.                                                             |
| api-gateway-pattern        | Global guard                              | `JwtAuthGuard` / `RolesGuard` через `APP_GUARD`. Применяются ко всем route'ам.                                                  |
| api-gateway-pattern        | `@Public()`                              | Декоратор из `libs/auth`. Помечает endpoint как доступный без аутентификации.                                                   |
| api-gateway-pattern        | `@Roles(...)`                            | Декоратор из `libs/auth`. Ограничивает endpoint списком ролей.                                                                  |
| api-gateway-pattern        | Validation pipe                          | Глобальный `ValidationPipe` с whitelist/transform/forbidNonWhitelisted.                                                          |
| api-gateway-pattern        | Correlation ID                           | `x-correlation-id` HTTP-header; протаскивается через RMQ и логи.                                                                |
| api-gateway-pattern        | Scalar OpenAPI viewer                    | Альтернатива Swagger UI на `/api/reference`.                                                                                    |
| shared-libs-philosophy     | Shared library                           | Папка `libs/<name>/` с переиспользуемым кодом, импортируемая по path-алиасу.                                                    |
| shared-libs-philosophy     | Forbidden imports                        | Раздел `CLAUDE.md`, дублирующий часть правил линта для людей.                                                                   |
| shared-libs-philosophy     | Element type                             | Категория файла в `eslint-plugin-boundaries`. У нас тип на каждую lib.                                                          |
| shared-libs-philosophy     | Foundation libs                          | `contracts`, `database`, тонкий `common`. Делаются в task-03 миграции; фундамент для остальных.                                  |
| shared-libs-philosophy     | Integration libs                         | `messaging`, `cache`, `observability`, `ddd`. Делаются в task-04 миграции.                                                       |
| shared-libs-philosophy     | `boundaries/dependencies`                | Правило v6 из `eslint-plugin-boundaries`. `default: 'disallow'`.                                                                |
| shared-libs-philosophy     | `lib-ddd`                                | Тип `eslint-plugin-boundaries` для `libs/ddd/**`. Самый строгий disallow-лист.                                                  |
| shared-libs-philosophy     | `lib-contracts`                          | Тип для `libs/contracts/**`. Разрешён `class-validator`/`@nestjs/swagger`.                                                      |
| shared-libs-philosophy     | Deep import                              | Импорт по длинному path-алиасу (`@retail-inventory-system/observability/tracer`).                                                |

Approximately **37 new pairs** introduced. Some duplicate the
concept-group glossary terms (`Per-module hexagonal`,
`Bounded context`) — task-12 will dedupe.

## Cross-references added

### Within `project-shape/` (peer links)

- `nestjs-monorepo` → `[[microservices-split]]`, `[[api-gateway-pattern]]`, `[[shared-libs-philosophy]]`
- `microservices-split` → `[[nestjs-monorepo]]`, `[[api-gateway-pattern]]`, `[[shared-libs-philosophy]]`
- `api-gateway-pattern` → `[[nestjs-monorepo]]`, `[[microservices-split]]`, `[[shared-libs-philosophy]]`
- `shared-libs-philosophy` → `[[nestjs-monorepo]]`, `[[microservices-split]]`, `[[api-gateway-pattern]]`

Each article links to all three peers — the within-group "Связанные
решения" requirement from task-03 step 5 is met by construction.

### Back to `concepts/` (per task-03 step 4)

- `nestjs-monorepo` → `[[module-boundaries]]`, `[[hexagonal-architecture]]`
- `microservices-split` → `[[hexagonal-architecture]]`
- `api-gateway-pattern` → `[[hexagonal-architecture]]`, `[[module-boundaries]]`
- `shared-libs-philosophy` → `[[module-boundaries]]`, `[[architecture-decision-records]]`, `[[hexagonal-architecture]]`

All four required `concepts/` back-links from task-03 step 4 are
present.

### Forward links into other groups

| From article            | To article (group)                        | Purpose                                                                              |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `microservices-split`   | `[[mappers-and-repositories]]` (persistence/) | Мэппер на границе процессов — domain-модель не пересекает RMQ.                       |
| `microservices-split`   | `[[opentelemetry-overview]]` (observability/) | Cross-trace через четыре сервиса собирается из `traceparent` в AMQP-properties.       |
| `api-gateway-pattern`   | `[[jwt-and-rbac]]` (auth/)                | Что делает модуль `modules/auth/` — единственный gateway-модуль с настоящим `domain/`. |
| `api-gateway-pattern`   | `[[trace-log-correlation]]` (observability/) | `CorrelationMiddleware` + `@CorrelationId()` — как correlation ID течёт через систему. |
| `shared-libs-philosophy`| `[[jwt-and-rbac]]` (auth/)                | `lib-auth` содержит только framework-glue; persistence-state живёт в `apps/api-gateway/.../auth/`. |

Five forward-links into other groups. All targets exist as stubs;
none orphan.

## Verification results

- [x] All four slot files filled; no `заглушка` callouts remain
      (verified by `grep -l 'заглушка\|Заглушка' docs/architecture-migration-ru/project-shape/*.md`
      → 0 hits).
- [x] Every code excerpt has a GitHub permalink pinned to
      `84b1507c68fd9ee02b185eef3c4594b6fe02f664` (38 permalinks total).
- [x] Every `[[wiki-link]]` resolves to a file that exists under
      `docs/architecture-migration-ru/` (verified by enumerating all
      27 unique link occurrences and matching against `find`).
- [x] No orphans under `docs/architecture-migration-ru/` — the root
      file's `### project-shape/` section already linked every stub
      from task-01 to all four articles; the new content adds further
      internal links without breaking that.
- [x] Each article ≥ 600 words (smallest: `nestjs-monorepo.md` at
      **1976 слов**; largest: `api-gateway-pattern.md` at **2316 слов**).
- [x] Frontmatter valid on each touched file (`status: review`,
      `updated: 2026-05-15`, `related: [...]` populated).
- [x] Each article carries the mandatory `> [!abstract] Кратко`
      callout, `## Глоссарий`, and `> [!faq]-` self-check block.
- [x] No `git` mutating commands were run during this session.

## Suggested adjustments to upcoming tasks

1. **`api-gateway-pattern.md` traces `POST /api/order` end-to-end on
   the gateway side** (controller → use-case → port → adapter → pipe),
   matching the note in `_carryover-02.md` §4. The big-picture
   walkthrough that passes through all four services lives in
   `concepts/clean-architecture-layers.md`. Future tasks
   (`messaging/message-vs-event-patterns.md`,
   `application-layer/use-cases-vs-fat-services.md`) should link to
   one of these instead of re-tracing the flow.

2. **`shared-libs-philosophy.md` already enumerates the nine libs and
   the per-layer allow-table from `eslint.config.mjs`.** The
   `quality/lib-eslint-plugin-boundaries.md` article (task-11) can
   focus on **how** the plugin works (element-types, captures,
   `default: 'disallow'`) and the fixture-spec regression suite; the
   per-layer allow-matrix is now «owned» by this project-shape
   article, with a back-link from quality.

3. **`microservices-split.md` calls notification the «canonical
   per-module template» without re-deriving its full layout**
   (carryover-02 note #6). The full layout walkthrough is reserved
   for `application-layer/notifier-port-and-adapters.md` (task-10).
   If notification's layout has subtly drifted, surface that in
   the article rather than back-editing this project-shape entry.

4. **All four project-shape articles cite `ADR-009`, `ADR-005`,
   `ADR-018`, or `ADR-020` in «Что почитать дальше».** Subsequent
   groups (persistence, messaging, caching, …) should similarly
   point at the ADR that pinned their decision — ADRs are the
   durable record; the guide is the explainer. If a future article
   contradicts an ADR, the ADR wins; the article is updated, not
   the ADR.

5. **The carryover-02 note about `lib-contracts` carrying
   `class-validator`/`@nestjs/swagger` decorators is reproduced in
   `shared-libs-philosophy.md` § «`lib-contracts`».** Future
   persistence and messaging articles that touch
   `libs/contracts` can refer to this section rather than
   re-deriving the exception. If a discussion lands that flips this
   choice (e.g. extracting DTOs from contracts to drop those
   decorators), it should be a new ADR — not a silent rewrite of
   ADR-005.

6. **The «forbidden imports» word-for-word excerpt from `CLAUDE.md`
   is reproduced in `shared-libs-philosophy.md`.** When `CLAUDE.md`
   changes (e.g. a new lib joins), this article must update too —
   not after the fact, but as part of the same PR. Treat the two
   surfaces as one.

7. **No new ADRs were necessary** during this writing session. The
   four articles document conventions already shipped (ADR-005,
   ADR-009, ADR-017, ADR-018, ADR-020). No architectural decisions
   were taken here.
