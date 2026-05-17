---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, guide-root]
status: final
related: []
---

# Гид по архитектурной миграции Retail Inventory System

> [!abstract] Кратко
> Этот гид рассказывает, как монорепозиторий **Retail Inventory
> System** — четыре сервиса NestJS, общающиеся через RabbitMQ — был
> переведён с плоского scaffold'а Brocoders на per-module hexagonal
> архитектуру с портами и адаптерами, JWT + RBAC, кэшем Redis,
> распределённым трейсингом OpenTelemetry и архитектурным линтом
> `eslint-plugin-boundaries`. Гид рассчитан на mid-level разработчика
> NestJS, который хочет понять не только «как сделано», но и «почему
> именно так» — каждая статья ссылается на исходный код проекта и на
> соответствующий ADR.

## Что было до миграции и что получилось после

До миграции (см. ADR-018, ADR-019, ADR-020 — фиксацию исходного
baseline'а; и `docs/baseline/` — снимок конфигурации на старте) проект
выглядел так:

- **Плоские per-action сервисы** (`*-service.ts`) — каждый класс
  инжектил `Repository<X>`, `ClientProxy`, `Cache` и Pino-логгер
  одновременно; границы между domain, application и infrastructure
  существовали только в виде договорённостей в код-ревью.
- **«Толстый» `libs/common`** — DTO, enum'ы, helper'ы для кеша,
  middleware корреляции, конфигурации модулей лежали в одной
  библиотеке.
- **Нет auth** — все HTTP-роуты были публичными; пакеты `@nestjs/jwt`,
  `@nestjs/passport`, `argon2` в `package.json` отсутствовали.
- **Нет OpenTelemetry** — `@opentelemetry/*` не были установлены,
  трейсинг отсутствовал; логи Pino несли `correlationId`, но не
  `traceId`.
- **Notification-микросервис был заглушкой** — `app.module.ts` лишь
  поднимал `ConfigModule` + `LoggerModule`, ни одного handler.
- **Не было архитектурного линта** — никто не запрещал на уровне
  компиляции/CI импортировать TypeORM в domain или `ClientProxy` в
  use-case.

После 14 фаз миграции (см.
`docs/architecture-migration-plan/`) в проекте:

- **Per-module hexagonal layout** во всех четырёх сервисах. В каждом
  модуле — `domain/` (framework-free), `application/` (use-cases +
  ports), `infrastructure/` (TypeORM, RabbitMQ, Redis-адаптеры),
  `presentation/` (HTTP-контроллеры или RMQ-handlers). См. ADR-004.
- **Девять связанных библиотек** под `libs/*`: `contracts`,
  `database`, `ddd`, `messaging`, `cache`, `observability`, `config`,
  `common`, `auth`. ADR-005 разносит обязанности; ADR-017 фиксирует
  границы через линт.
- **JWT + RBAC на gateway**: HS256 access + rotated refresh с
  reuse-detection, argon2id-хеши, глобальные `JwtAuthGuard` и
  `RolesGuard` с opt-out через `@Public()`. ADR-010.
- **Redis cache-aside с обобщённой конвенцией ключей**
  `ris:<service>:<aggregate>:<id>[:<facet>]`, await-invalidate
  post-commit, SCAN+UNLINK через `delByPrefix`. ADR-002 + ADR-016.
- **OpenTelemetry + Jaeger**: OTLP/HTTP через collector → Jaeger,
  amqplib auto-instrumentation сохраняет `traceparent` сквозь все
  четыре сервиса; Pino-логи внутри активного span'а несут
  `traceId`/`spanId`. ADR-014 + ADR-015.
- **Архитектурный линт** через `eslint-plugin-boundaries` v6 с
  fixture-based регрессионным spec'ом. ADR-017.

## Как читать гид

Гид написан так, что разделы можно читать **последовательно** (вверху
понятия, ниже — стеки и инфраструктура) или **выборочно** (зайти в
нужную группу, например `caching/` или `auth/`). Внутри каждой группы
статьи перекрёстно ссылаются друг на друга через
Obsidian-style wiki-links.

Рекомендуемый порядок первого прочтения: **concepts → project-shape →
persistence → messaging → caching → auth → observability →
application-layer → quality → glossary**.

Каждая статья:

- начинается с callout `> [!abstract] Кратко`;
- имеет секцию «Применение в проекте» с цитатами реального кода и
  GitHub-permalink'ами, пришпиленными к фиксированному SHA;
- содержит секцию «Глоссарий» (EN-термин → русское пояснение);
- ссылается на смежные ADR.

## Оглавление

### concepts/

- [[hexagonal-architecture]] — порты и адаптеры как способ изолировать domain от инфраструктуры.
- [[domain-driven-design]] — тактические DDD-паттерны (Aggregate, Value Object, Domain Event), используемые в проекте.
- [[clean-architecture-layers]] — четырёхслойная структура `domain → application → infrastructure/presentation` и правило зависимости внутрь.
- [[module-boundaries]] — кросс-модульные и кросс-сервисные правила импортов; что может пересекать границу, что нет.
- [[architecture-decision-records]] — формат Nygard-hybrid, когда писать ADR и как они нумеруются.

### project-shape/

- [[nestjs-monorepo]] — `apps/` + `libs/`, единый `package.json`, `nest-cli.json` с `monorepo: true`, TS-алиасы `@retail-inventory-system/*`.
- [[microservices-split]] — почему четыре сервиса (gateway + 3 микросервиса), а не монолит; mapping bounded-context'ов на сервисы.
- [[api-gateway-pattern]] — HTTP-edge + global auth-guards; что gateway делает и чего сознательно не делает.
- [[shared-libs-philosophy]] — за что отвечает каждая `libs/<name>`; правила «forbidden imports».

### persistence/

- [[typeorm-overview]] — TypeORM + MySQL, `mysql2`-драйвер, `migration:*` workflow, `synchronize: false`.
- [[entity-vs-domain-model]] — почему TypeORM-`@Entity` живёт только в `infrastructure/persistence/`, а domain-модель остаётся framework-free.
- [[mappers-and-repositories]] — `*.mapper.ts` как боундари entity↔domain; port (`IOrderRepositoryPort`) vs adapter (`OrderTypeormRepository`).
- [[base-entity-and-base-repository]] — `BaseEntity`, `BaseTypeormRepository`, `DatabaseModule.forRoot/forFeature` из `libs/database`.
- [[snake-naming-strategy]] — почему camelCase в TS и snake_case в MySQL и кто между ними переводит.

### messaging/

- [[rabbitmq-as-bus]] — RabbitMQ как транспорт и для RPC, и для событий; одна очередь на сервис; reserved `EXCHANGES`.
- [[nest-microservices-transport]] — `Transport.RMQ`, `ClientProxy`, `firstValueFrom`, правило «ClientProxy только в infrastructure/messaging/».
- [[message-vs-event-patterns]] — `@MessagePattern` (RPC, типизированный ответ) vs `@EventPattern` (fire-and-forget, fan-out).
- [[routing-keys-and-contracts]] — конвенция `<service>.<aggregate>.<action>`; `ROUTING_KEYS` + `MicroserviceMessagePatternEnum` + spec, который их сверяет.

### caching/

- [[cache-aside-pattern]] — паттерн от первых принципов; read-flow, invalidation, post-commit-await; что закрыто и что осталось из audit-2026-05-08.
- [[cache-stack-overview]] — диаграмма `use case → ICachePort → RedisCacheAdapter → cache-manager → keyv → @keyv/redis → Redis`.
- [[lib-nestjs-cache-manager]] — Nest-обёртка над `cache-manager` для DI; что делает, что не делает.
- [[lib-cache-manager]] — фасад get/set/del/wrap; не знает про Redis напрямую.
- [[lib-keyv]] — абстракция over storage; интерфейс `KeyvStoreAdapter`.
- [[lib-keyv-redis]] — собственно клиент к Redis под `keyv`.
- [[lib-cacheable]] — multi-tier cache primitive, через который `RedisCacheAdapter` доходит до SCAN+UNLINK.

### auth/

- [[jwt-and-rbac]] — решения ADR-010: HS256, rotated refresh с reuse-detection, argon2id, глобальные guard'ы, `@Roles/@Public/@CurrentUser`.
- [[auth-stack-overview]] — request-flow: `Bearer <jwt>` → `passport-jwt` → `JwtStrategy.validate` → `AUTH_USER_VALIDATOR` → `req.user` → `@CurrentUser()`.
- [[lib-nestjs-passport]] — Nest-обёртка над `passport`; `PassportStrategy`, `AuthGuard('jwt')`.
- [[lib-passport]] — исходный middleware; не выбирает стратегию аутентификации.
- [[lib-passport-jwt]] — JWT-стратегия (извлечение из header'а + верификация подписи).
- [[lib-nestjs-jwt]] — `JwtService` для подписи access/refresh-токенов.
- [[lib-argon2]] — argon2id-хеширование паролей с OWASP-2024 cost-параметрами.

### observability/

- [[opentelemetry-overview]] — spans, traces, propagation, exporters; правило «`@retail-inventory-system/observability/tracer` — первый импорт в каждом `main.ts`».
- [[pino-logging]] — структурированное JSON-логирование, `nestjs-pino`, redaction, `correlationId` через `x-correlation-id`.
- [[trace-log-correlation]] — `logMethod`-hook, инжектящий `traceId`/`spanId` в каждый Pino-record (ADR-015).
- [[jaeger-backend]] — `docker-compose.observability.yml`, otel-collector между приложениями и Jaeger, OTLP/HTTP `:4318`, UI `:16686`.
- [[lib-opentelemetry-api]] — публичный API (`trace.getActiveSpan`, `trace.getTracer`).
- [[lib-opentelemetry-sdk-node]] — `NodeSDK` boot-driver.
- [[lib-opentelemetry-auto-instrumentations-node]] — bundle инструментаций (http/mysql2/redis/amqplib/nestjs-core).
- [[lib-opentelemetry-instrumentation-amqplib]] — патч, инжектящий `traceparent` в AMQP-message-properties.
- [[lib-opentelemetry-exporter-trace-otlp-http]] — OTLP-over-HTTP exporter к коллектору.
- [[lib-opentelemetry-core]] — context manager, propagator; почти всегда транзитивный.
- [[lib-opentelemetry-resources]] — `Resource`-builder для `service.name`/`deployment.environment.name`.
- [[lib-opentelemetry-semantic-conventions]] — строковые константы для атрибутов span'ов.

### application-layer/

- [[use-cases-vs-fat-services]] — «толстый» сервис как анти-паттерн vs use-case (один класс на действие, инжектит только порты).
- [[dto-by-direction]] — пять суффиксов (`*.request.dto.ts`, `*.response.dto.ts`, `*.command.ts`, `*.query.ts`, `*.view.ts`) и зачем направление.
- [[notifier-port-and-adapters]] — канонический per-module template из notification-микросервиса; `INotifierPort` + `NOTIFIER` + `LogNotifierAdapter`.

### quality/

- [[lib-eslint-plugin-boundaries]] — element-type-таксономия, `boundaries/dependencies` v6 rule, `capture: ['app','module']`-templates, regression spec.
- [[test-strategy]] — Jest unit + e2e + `tests/lint/architecture-lint.spec.ts`; in-memory port doubles; `yarn test:infra:reload` cycle.

### Справочник

- [[glossary]] — алфавитный EN→RU справочник терминов с указанием, в какой статье каждый из них вводится.

## Связанные документы

- `docs/adr/index.md` — каталог всех 20 ADR, на которые ссылается гид.
- `docs/architecture-migration-plan/` — исходный план миграции, отчёты по каждой из 14 фаз (`tasks/_carryover-NN.md`).
- `docs/audits/audit-2026-05-08.md` — pre-миграционный аудит, на который ссылаются ADR-002, ADR-006, ADR-016.
- `CLAUDE.md` и `README.md` — durable-документация репозитория, синхронизированная с ADR.
