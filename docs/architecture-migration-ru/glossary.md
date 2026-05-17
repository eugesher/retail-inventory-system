---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, glossary]
status: final
related:
  - "[[hexagonal-architecture]]"
  - "[[domain-driven-design]]"
  - "[[clean-architecture-layers]]"
  - "[[module-boundaries]]"
  - "[[architecture-decision-records]]"
  - "[[nestjs-monorepo]]"
  - "[[microservices-split]]"
  - "[[api-gateway-pattern]]"
  - "[[shared-libs-philosophy]]"
  - "[[typeorm-overview]]"
  - "[[entity-vs-domain-model]]"
  - "[[mappers-and-repositories]]"
  - "[[base-entity-and-base-repository]]"
  - "[[snake-naming-strategy]]"
  - "[[rabbitmq-as-bus]]"
  - "[[nest-microservices-transport]]"
  - "[[message-vs-event-patterns]]"
  - "[[routing-keys-and-contracts]]"
  - "[[cache-aside-pattern]]"
  - "[[cache-stack-overview]]"
  - "[[lib-nestjs-cache-manager]]"
  - "[[lib-cache-manager]]"
  - "[[lib-keyv]]"
  - "[[lib-keyv-redis]]"
  - "[[lib-cacheable]]"
  - "[[jwt-and-rbac]]"
  - "[[auth-stack-overview]]"
  - "[[lib-nestjs-passport]]"
  - "[[lib-passport]]"
  - "[[lib-passport-jwt]]"
  - "[[lib-nestjs-jwt]]"
  - "[[lib-argon2]]"
  - "[[opentelemetry-overview]]"
  - "[[pino-logging]]"
  - "[[trace-log-correlation]]"
  - "[[jaeger-backend]]"
  - "[[lib-opentelemetry-api]]"
  - "[[lib-opentelemetry-sdk-node]]"
  - "[[lib-opentelemetry-auto-instrumentations-node]]"
  - "[[lib-opentelemetry-instrumentation-amqplib]]"
  - "[[lib-opentelemetry-exporter-trace-otlp-http]]"
  - "[[lib-opentelemetry-core]]"
  - "[[lib-opentelemetry-resources]]"
  - "[[lib-opentelemetry-semantic-conventions]]"
  - "[[use-cases-vs-fat-services]]"
  - "[[dto-by-direction]]"
  - "[[notifier-port-and-adapters]]"
  - "[[lib-eslint-plugin-boundaries]]"
  - "[[test-strategy]]"
---

# Глоссарий

> [!abstract] Кратко
> Алфавитный EN→RU справочник терминов, которые встречаются в гиде.
> Один термин — одна строка. В столбце «Введён в» перечислены статьи,
> в которых термин впервые появляется или раскрывается с
> существенной глубиной (обычно — одна-две статьи; редко больше).
> Если термин встречается ещё где-то по тексту, это не отмечается —
> здесь не индекс упоминаний, а словарь определений.
>
> Глоссарий собран из per-article-секций «Глоссарий», которые есть в
> каждой статье гида. Внутри каждой статьи свой локальный глоссарий
> ровно для того, чтобы её можно было читать **stand-alone**, без
> прыжка в этот файл. Этот файл нужен, когда термин встречается в
> нескольких статьях и хочется одно каноничное определение.

## Как читать таблицу

- **Сортировка** — алфавитная по EN-термину, регистро-нечувствительная.
  Символьные префиксы (`@`, `--`, `:`) и заглавные/строчные считаются
  частью слова и не учитываются в сравнении. То есть `@Cacheable`
  попадает в раздел «C», а `--runInBand` — в раздел «R».
- **EN-форма** — каноничная форма термина: имя класса, имя пакета,
  имя enum-значения, как оно встречается в коде проекта; либо
  устоявшийся английский термин (Aggregate Root, Cache-aside).
  Если термин — TypeScript-идентификатор, он окружён backtick'ами.
- **RU-пояснение** — одно-два предложения, объясняющие смысл и
  место термина в проекте; не словарный перевод, а ориентир для
  читателя, у которого этот термин встретился по тексту.
- **Введён в** — список статей в Obsidian-формате двойных квадратных скобок (`[[<статья>]]`). Если
  термин канонично определён в одной статье, цитируется одна; если
  он раскрывается с разных сторон в нескольких — все, по порядку
  глубины раскрытия.

## Таблица терминов

| Термин (EN) | Перевод / пояснение (RU) | Введён в |
|---|---|---|
| `@ApiProperty` | Декоратор `@nestjs/swagger` для inbound-полей: попадает и в OpenAPI-схему, и в Swagger-UI. | [[dto-by-direction]] |
| `@ApiResponseProperty` | Декоратор `@nestjs/swagger` для outbound-полей: документирует тип возврата. | [[dto-by-direction]] |
| `@Cacheable` | Method-decorator-syntactic-sugar над `ICachePort.wrap`; в проекте есть, но потребителей нет (см. [[cache-stack-overview]] про «слот, оставленный на future list-style use cases»). | [[lib-cacheable]] |
| `@Column({ name })` | Явное указание имени колонки; используется, когда `SnakeNamingStrategy` не угадывает (FK-колонки, исторические имена). | [[snake-naming-strategy]] |
| `@CreateDateColumn` | TypeORM-декоратор автозаполнения `created_at`. | [[base-entity-and-base-repository]] |
| `@CurrentUser()` | Param-decorator из `libs/auth`; читает `request.user` и возвращает `ICurrentUser`. | [[jwt-and-rbac]] |
| `@CorrelationId()` | Param-decorator из `libs/observability`; достаёт `correlationId` из request-scope. | [[pino-logging]] |
| `@DeleteDateColumn` | TypeORM-декоратор soft-delete-маркера. | [[base-entity-and-base-repository]] |
| `@EventPattern` | NestJS-декоратор: помечает метод как event-handler (fan-out, без response). | [[nest-microservices-transport]], [[notifier-port-and-adapters]] |
| `@keyv/redis` | Concrete Redis-клиент под `keyv`; `KeyvStoreAdapter`-имплементация. | [[lib-keyv-redis]] |
| `@MessagePattern` | NestJS-декоратор: помечает метод как RPC-handler (типизированный response). | [[nest-microservices-transport]], [[notifier-port-and-adapters]] |
| `@nestjs/cache-manager` | Nest-обёртка над `cache-manager` для DI; в `libs/cache` это адаптер, не публичный API. | [[lib-nestjs-cache-manager]] |
| `@nestjs/jwt` | NPM-пакет: NestJS-обёртка над `jsonwebtoken`; даёт `JwtService` под DI. | [[lib-nestjs-jwt]] |
| `@nestjs/microservices` | Официальная NestJS-обёртка вокруг чужих транспортов: TCP, RMQ, NATS, gRPC, Kafka. | [[nest-microservices-transport]] |
| `@nestjs/passport` | NPM-пакет: NestJS-обёртка над `passport`; даёт `PassportStrategy` + `AuthGuard`. | [[lib-nestjs-passport]] |
| `@opentelemetry/instrumentation-pino` | Альтернативный путь auto-inject `traceId`/`spanId` в Pino; в проекте **не** установлен — выбран `logMethod`-hook вручную. | [[trace-log-correlation]] |
| `@Payload` | NestJS-декоратор: инжектит body сообщения в параметр handler'а. | [[nest-microservices-transport]] |
| `@PrimaryGeneratedColumn` | TypeORM-декоратор auto-increment-PK. | [[base-entity-and-base-repository]] |
| `@Public()` | Декоратор-метаданные `auth:isPublic` из `libs/auth`: помечает endpoint как доступный без аутентификации. | [[api-gateway-pattern]], [[jwt-and-rbac]] |
| `@redis/client` | NPM-пакет; официальный Redis-клиент Node.js. Public-property `KeyvRedis.client`. | [[lib-keyv-redis]] |
| `@Roles(...)` | Декоратор-метаданные `auth:roles` из `libs/auth`: ограничивает endpoint списком ролей. | [[api-gateway-pattern]], [[jwt-and-rbac]] |
| `@UpdateDateColumn` | TypeORM-декоратор auto-update `updated_at`. | [[base-entity-and-base-repository]] |
| `--forceExit` | Jest-flag: жёсткий exit процесса после прохождения тестов (нужно, когда не все handle'ы корректно закрываются). | [[test-strategy]] |
| `--runInBand` | Jest-flag: последовательное выполнение suite'ов; обязательное для e2e, чтобы инфраструктура не дрейфовала. | [[test-strategy]] |
| `:4317` | Default-порт OTLP/gRPC. В проекте **не** используется. | [[jaeger-backend]] |
| `:4318` | Default-порт OTLP/HTTP; на него идёт `OTEL_EXPORTER_OTLP_ENDPOINT`. | [[jaeger-backend]] |
| `:16686` | Default-порт Jaeger UI. | [[jaeger-backend]] |
| `__all__` | Sentinel в ключе `inventoryStock`, означающий «все storages» (не glob, а строковый префикс). | [[cache-aside-pattern]] |
| `_carryover-NN.md` | Receipt-файл одной фазы миграции; источник правды о том, что **шипилось** (в отличие от task-брифа). | [[architecture-decision-records]] |
| `{{from.captured.x}}` | Template-syntax `eslint-plugin-boundaries`: подставляет captured-значение из source-pattern'а в target-pattern. | [[lib-eslint-plugin-boundaries]] |
| Access token | Короткоживущий (15m) JWT с `sub` и `roles[]`; ходит в `Authorization: Bearer …`. | [[jwt-and-rbac]] |
| Active span | Span, который вернёт `trace.getActiveSpan()` в текущем `AsyncLocalStorage`-scope'е. | [[opentelemetry-overview]] |
| Adapter | Адаптер — реализация порта под конкретную технологию (TypeORM, RabbitMQ, Redis). | [[hexagonal-architecture]] |
| ADR | Architecture Decision Record — markdown-документ, фиксирующий ровно одно архитектурное решение. | [[architecture-decision-records]] |
| Aggregate | Аггрегат — группа объектов, меняющихся как одно целое; одна транзакция = один aggregate. | [[domain-driven-design]] |
| Aggregate Root (`AggregateRoot<TId>`) | Корень аггрегата — единственный объект, к которому разрешено обращаться извне; в коде — базовый класс из `libs/ddd` с методом `pullDomainEvents()`. | [[domain-driven-design]], [[entity-vs-domain-model]] |
| Alg-confusion attack | Атака на JWT: подменить `alg: HS256` на `alg: none` или RS256→HS256, чтобы пройти подпись пустым/публичным ключом. Защита — параметр `algorithms` в `passport-jwt`. | [[lib-passport-jwt]] |
| AlwaysOnSampler | Default-sampler OTel-SDK: 100% sampling. | [[lib-opentelemetry-sdk-node]] |
| `amqp-connection-manager` | Reconnect-обёртка вокруг `amqplib`; ею пользуется `@nestjs/microservices` RMQ-transport. | [[nest-microservices-transport]] |
| `amqplib` | Низкоуровневый AMQP-клиент для Node.js; на нём построен RMQ-transport NestJS. | [[nest-microservices-transport]], [[jaeger-backend]] |
| AMQP | Advanced Message Queuing Protocol — открытый протокол брокеров; RabbitMQ реализует AMQP 0-9-1. | [[rabbitmq-as-bus]] |
| Anti-corruption layer (ACL) | Слой защиты от чужой модели; в проекте роль ACL играет mapper между TypeORM-entity и domain-model. | [[hexagonal-architecture]] |
| API Gateway | Edge-сервис с HTTP-портом: аутентификация + проксирование RPC к микросервисам. | [[microservices-split]], [[api-gateway-pattern]] |
| Application layer | Слой `application/` — use-cases, ports, application-DTO; зависит **только** от `domain/`. | [[clean-architecture-layers]] |
| Application service (DDD) | DDD-термин для оркестратора; в нашем коде это и есть use-case. | [[use-cases-vs-fat-services]] |
| `APP_GUARD` | Nest-токен: guard, регистрируемый глобально через `{ provide: APP_GUARD, useClass: …Guard }`. | [[jwt-and-rbac]] |
| `AppNameEnum` | Enum имён сервисов (`api-gateway`, `retail`, `inventory`, `notification`); используется в Pino-`customProps`. | [[pino-logging]] |
| Architecture lint | Архитектурный линт — статическая проверка правил импорта через ESLint; в проекте — `eslint-plugin-boundaries` v6. | [[module-boundaries]], [[lib-eslint-plugin-boundaries]] |
| `ARCH-LINT-EX-01` | Документированное исключение архитектурного линта: `EntityManager` пробрасывается через `IStockRepositoryPort` и `ReserveStockForOrderUseCase`. Закрытие — введение `ITransactionPort`. | [[module-boundaries]], [[entity-vs-domain-model]], [[use-cases-vs-fat-services]], [[lib-eslint-plugin-boundaries]] |
| Argon2 | Победитель Password Hashing Competition (2015); семейство `argon2i/2d/2id`. | [[lib-argon2]] |
| Argon2id | Гибрид Argon2i + Argon2d: устойчив и к side-channel, и к timing-атакам; в проекте — выбор по OWASP-рекомендации. | [[lib-argon2]], [[jwt-and-rbac]] |
| `as const` | TypeScript-конструкция: фиксирует литералы как самые узкие типы; используется в `ROUTING_KEYS`, `EXCHANGES`, `CACHE_KEYS`. | [[routing-keys-and-contracts]] |
| `AsyncLocalStorage` | Node.js-API для async-scoped-state; основа `Context` в OTel и Pino-correlation. | [[pino-logging]] |
| `AsyncLocalStorageContextManager` | Класс из `@opentelemetry/context-async-hooks`; прод-имплементация `ContextManager`. | [[trace-log-correlation]] |
| At-least-once | Гарантия RMQ-доставки: сообщение придёт **хотя бы один раз** (возможны дубликаты). Дедупликация — на consumer'е. | [[rabbitmq-as-bus]], [[notifier-port-and-adapters]] |
| `ATTR_SERVICE_NAME` | Константа `'service.name'` из `@opentelemetry/semantic-conventions`; не пишем литералов. | [[opentelemetry-overview]], [[lib-opentelemetry-semantic-conventions]] |
| `AuthGuard(name)` | Guard-фабрика из `@nestjs/passport`; глобально подменяется на `JwtAuthGuard`. | [[auth-stack-overview]] |
| `AUTH_USER_VALIDATOR` | DI-port из `libs/auth`: апп даёт способ резолва user'а по JWT-payload'у. В gateway связывается с `ValidateUserUseCase`. | [[jwt-and-rbac]] |
| Authentication | Доказательство identification — у нас подпись JWT. | [[jwt-and-rbac]] |
| Authorization | Право на конкретное действие — у нас `roles[]` + `@Roles(...)`. | [[jwt-and-rbac]] |
| Auto-instrumentation | Runtime-monkey-patching библиотек при `require()`; для нас — `getNodeAutoInstrumentations()`, патчит http/mysql2/redis/amqplib/nestjs-core. | [[opentelemetry-overview]], [[lib-opentelemetry-auto-instrumentations-node]] |
| Back-fill (ADR) | Написание ADR постфактум для давно существующего решения (ADR-018/019/020). | [[architecture-decision-records]] |
| `BaseEntity` | Абстрактный родитель всех TypeORM-entity'ев из `libs/database`: id, timestamp'ы, soft-delete. | [[base-entity-and-base-repository]] |
| `BaseTypeormRepository` | Mapper-aware-обёртка над `Repository<TEntity>`: даёт `find`, `save`, `softDelete`. | [[base-entity-and-base-repository]] |
| `BasicTracerProvider` | Минимальный provider OTel для unit-тестов; не требует SDK. | [[trace-log-correlation]], [[lib-opentelemetry-core]] |
| `batch` (processor) | Processor OTel-Collector: группирует span'ы в пакеты перед отправкой. | [[jaeger-backend]] |
| `BatchSpanProcessor` | Default-processor OTel-SDK: буферизует span'ы и шлёт пакетами. | [[lib-opentelemetry-sdk-node]] |
| Bcrypt | Старый де-факто-стандарт хеширования паролей; не memory-hard, проигрывает Argon2id. | [[lib-argon2]] |
| Best-effort delivery | Доставка «как сможем»: event может быть потерян при падении consumer'а до ack'а. | [[message-vs-event-patterns]] |
| Bounded context | DDD: граница языка предметной области; в проекте 4 контекста, маппинг 1:1 на сервисы. | [[microservices-split]], [[notifier-port-and-adapters]] |
| `boundaries/dependencies` | Единственный rule v6 API `eslint-plugin-boundaries`; полярность `default: 'disallow'`. | [[shared-libs-philosophy]], [[lib-eslint-plugin-boundaries]] |
| `boundaries/no-unknown` | Off-by-default rule `eslint-plugin-boundaries`: ругается на файлы без element-type. | [[lib-eslint-plugin-boundaries]] |
| Bumper vs contract test | Bumper ловит ослабление правила (regression spec); contract test ловит drift между копиями. В проекте `architecture-lint.spec.ts` — bumper. | [[lib-eslint-plugin-boundaries]] |
| Bus / Message bus | RabbitMQ как единственный транспорт между процессами (ADR-020). | [[microservices-split]] |
| `Cache` (тип) | Класс из `cache-manager`, переэкспортированный `@nestjs/cache-manager`; в `libs/cache` инжектится в `RedisCacheAdapter`. | [[cache-stack-overview]] |
| Cache-aside | Паттерн «приложение само читает кэш и само инвалидирует»; синоним — lazy loading. Применяется по ADR-002 + ADR-016. | [[cache-aside-pattern]] |
| `cache-manager` | NPM-пакет: фасад get/set/del/wrap; не знает про Redis напрямую — это работа `keyv`. | [[lib-cache-manager]] |
| `CACHE_KEYS` | Frozen `as const`-объект builder'ов ключей из `libs/cache`; апп не пишет строковых литералов. | [[cache-aside-pattern]] |
| `CACHE_MANAGER` | DI-токен под `Cache` (из `@nestjs/cache-manager`). | [[cache-stack-overview]] |
| `CacheModule` (Nest) | Nest-модуль из `@nestjs/cache-manager`; даёт `register` + `registerAsync`. | [[lib-nestjs-cache-manager]] |
| `CacheModuleAsyncOptions` | Тип-конфиг для `CacheModule.registerAsync`. | [[lib-nestjs-cache-manager]] |
| `cacheable` (npm) | Multi-tier cache primitive под `cache-manager v7+`; `RedisCacheAdapter` дотягивается через него до SCAN+UNLINK. | [[lib-cacheable]] |
| `CacheInterceptor` | HTTP-interceptor из `@nestjs/cache-manager` для GET-кэширования. **Не используется** — кэш-инвалидация привязана к domain-event'ам, а не к URL'у. | [[lib-nestjs-cache-manager]] |
| `CACHE_PORT` | DI-токен (Symbol) для `ICachePort` из `libs/cache`. | [[cache-aside-pattern]] |
| `cache.stores` | Массив `Keyv`-инстансов внутри `Cache` (`cache-manager`). | [[lib-cache-manager]] |
| `camelCase` | TypeScript-конвенция именования. Переводится в `snake_case` при сборке SQL через `SnakeNamingStrategy`. | [[snake-naming-strategy]] |
| Canonical name vs custom attribute | Canonical — атрибут из OTel-spec'а (`http.request.method`); custom — domain-имя под `'app.'`-префиксом. | [[lib-opentelemetry-semantic-conventions]] |
| Canonical template | Notification-микросервис как шаблон для retail/inventory (ADR-011). | [[microservices-split]] |
| Capture | Захват — переменные, извлекаемые из пути файла (`app`, `module`) `eslint-plugin-boundaries`-плагином через glob. | [[module-boundaries]], [[lib-eslint-plugin-boundaries]] |
| Catch-all rule | Первое правило в массиве `boundaries/dependencies`: blanket-allow для всех `external` + `core`. Load-bearing, потому что `default: 'disallow'`. | [[lib-eslint-plugin-boundaries]] |
| `Channel.ack` / `Channel.nack` | Методы `amqplib`, закрывающие `process`-span auto-instrumentation'а. | [[lib-opentelemetry-instrumentation-amqplib]] |
| `checkAllOrigins: true` | Опция `boundaries/dependencies`: проверять и internal-, и external-зависимости. | [[lib-eslint-plugin-boundaries]] |
| Clean Architecture | Чистая архитектура (Robert Martin); направление зависимости — внутрь. | [[clean-architecture-layers]] |
| `ClientProxy` | Producer-абстракция `@nestjs/microservices`: методы `send` (RPC) и `emit` (event). Живёт только в `infrastructure/messaging/`. | [[api-gateway-pattern]], [[nest-microservices-transport]] |
| `ClientProxy.emit` | Producer-метод для события; cold Observable broker-ack'а. Используется для cross-service-events. | [[message-vs-event-patterns]] |
| `ClientProxy.send` | Producer-метод для RPC; cold Observable от reply-очереди. | [[message-vs-event-patterns]] |
| `ClientProxyFactory.create` | Низкоуровневая фабрика `ClientProxy` без DI; используется в `RabbitmqClientFactory`. | [[nest-microservices-transport]] |
| `ClientsModule.registerAsync` | NestJS-модуль, регистрирующий `ClientProxy` по асинхронной конфигурации. | [[nest-microservices-transport]] |
| `ClientsProviderAsyncOptions` | Тип одного элемента в `registerAsync([…])`. | [[nest-microservices-transport]] |
| Cold Observable | rxjs-Observable, у которого работа начинается только после `.subscribe()`. `ClientProxy.send` возвращает cold observable — мы всегда оборачиваем `firstValueFrom`. | [[nest-microservices-transport]] |
| Collector | Отдельный процесс OTel: receive → process → re-export. В проекте — `otelcol-contrib` через compose-overlay. | [[opentelemetry-overview]], [[jaeger-backend]] |
| Command (`*.command.ts`) | Plain interface — write-вход application-слоя; не несёт class-validator'а. | [[dto-by-direction]] |
| Compile-time contract | Кросс-сервисный контракт через TypeScript: оба конца импортируют один тип из `libs/contracts`. | [[routing-keys-and-contracts]] |
| Compose-overlay | `-f` дополнительный compose-file; в проекте — `docker-compose.observability.yml` поверх основного. | [[jaeger-backend]] |
| Composition root | Корень композиции — место сборки DI-графа; у нас `<module>.module.ts`. | [[clean-architecture-layers]] |
| `CompositePropagator` | Комбинатор propagator'ов из `@opentelemetry/core`. | [[lib-opentelemetry-core]] |
| Constant-time compare | Сравнение без раннего exit'а; защита от timing-атак; внутри `argon2.verify`. | [[lib-argon2]] |
| Context | Невидимый объект OTel через `AsyncLocalStorage`; содержит активный span. | [[opentelemetry-overview]] |
| `ContextManager` | Интерфейс OTel: «как async-контекст хранится»; прод-реализация — `AsyncLocalStorageContextManager`. | [[lib-opentelemetry-api]] |
| `context.with(...)` | OTel-идиома: «исполни callback в контексте, где этот span активен». | [[trace-log-correlation]] |
| `correlationId` | UUID v4 на бизнес-flow; ставит `CorrelationMiddleware` на edge'е, протаскивается через RMQ и логи. | [[routing-keys-and-contracts]], [[pino-logging]] |
| Correlation ID | См. `correlationId`. | [[api-gateway-pattern]] |
| `CORRELATION_ID_HEADER` | Константа `'x-correlation-id'` из `libs/observability`. | [[pino-logging]] |
| `CorrelationMiddleware` | Nest-middleware: read-or-generate `correlationId`, кладёт в `AsyncLocalStorage`. | [[pino-logging]] |
| `COUNT` (SCAN) | Hint Redis'у: «бери N ключей за iteration». | [[lib-keyv-redis]] |
| `createCache` | Фабрика `cache-manager`'а. | [[lib-cache-manager]] |
| Cross-service event | `ClientProxy.emit` между двумя микросервисами; fire-and-forget. | [[microservices-split]] |
| Cross-service RPC | `ClientProxy.send` между двумя микросервисами с типизированным response. | [[microservices-split]] |
| `customProps` (Pino) | Pino-опция: статические поля на каждой строке (например, `service`). Альтернатива `logMethod`. | [[pino-logging]], [[trace-log-correlation]] |
| `DatabaseModule` | DynamicModule из `libs/database`; `forRoot(entities)` + `forFeature(entities)`. | [[base-entity-and-base-repository]] |
| `DataSource` | Главный объект TypeORM: одна точка подключения к одной БД. | [[typeorm-overview]] |
| `DATABASE_URL` | Connection-string `mysql://user:pass@host:port/db`. Joi-валидируется при boot и при CLI-запуске миграций. | [[typeorm-overview]] |
| `debug` (exporter) | Exporter OTel-Collector'а: печатает sample каждого span'а в stdout — диагностика. | [[jaeger-backend]] |
| Decision atom | Атомарность ADR — один документ = одно решение. | [[architecture-decision-records]] |
| Deep import | Импорт по длинному path-алиасу (`@retail-inventory-system/observability/tracer`); противоположность импорту через index. | [[shared-libs-philosophy]] |
| `default: 'disallow'` | Полярность по умолчанию `boundaries/dependencies`: каждое ребро должно быть явно разрешено. Fail-closed. | [[module-boundaries]], [[lib-eslint-plugin-boundaries]] |
| Default exchange | Безымянный direct-exchange в RabbitMQ, к которому каждая очередь привязана по имени. | [[rabbitmq-as-bus]] |
| `defaultStrategy` | Имя стратегии для `AuthGuard()` без аргумента (в проекте — `'jwt'`). | [[lib-nestjs-passport]] |
| Defence in depth | Многоуровневая защита: hash + cost + salt + constant-time. | [[lib-argon2]] |
| `delByPrefix` | Метод `ICachePort` для bulk-invalidation. SCAN+UNLINK под капотом. | [[cache-aside-pattern]] |
| Dependency inversion | Инверсия зависимостей: оба слоя зависят от одной абстракции (порта), не друг от друга. | [[hexagonal-architecture]] |
| Dependency Rule | Правило зависимости (Clean Architecture): внешний слой импортирует внутренний, не наоборот. | [[clean-architecture-layers]] |
| DI symbol | `Symbol('X_REPOSITORY')` — токен, через который use case инжектит реализацию порта. Альтернатива — string-token; в проекте по конвенции Symbol. | [[mappers-and-repositories]] |
| Domain Event | Доменное событие — факт, который произошёл в домене; in-process публикация через `pullDomainEvents()`. | [[domain-driven-design]], [[routing-keys-and-contracts]] |
| Domain layer | Слой `domain/` — самое внутреннее кольцо; framework-free. | [[clean-architecture-layers]] |
| Domain model | Класс с инвариантами и поведением; framework-free; не знает про TypeORM. | [[entity-vs-domain-model]] |
| Domain service (DDD) | Бизнес-правило без owning-агрегата; живёт в `domain/`. | [[use-cases-vs-fat-services]] |
| `DomainEvent<TId>` | Базовый класс in-process-события из `libs/ddd`. | [[entity-vs-domain-model]] |
| Driver (DB) | Низкоуровневый клиент СУБД; в проекте — `mysql2`. | [[typeorm-overview]] |
| Driving port (primary) | Входящий порт — то, через что мир дёргает приложение (presentation → application). | [[hexagonal-architecture]] |
| Driven port (secondary) | Исходящий порт — то, через что приложение дёргает мир (application → infrastructure). | [[hexagonal-architecture]] |
| DTO | Data Transfer Object — шейп для переноса данных между слоями/сервисами. | [[dto-by-direction]] |
| Durable queue | Очередь RMQ, переживающая рестарт брокера; в проекте у всех трёх очередей `durable: true`. | [[rabbitmq-as-bus]] |
| Element type | Логический тип файла в `eslint-plugin-boundaries`; назначается через glob. У нас 18 типов. | [[module-boundaries]], [[shared-libs-philosophy]], [[lib-eslint-plugin-boundaries]] |
| Entity | DDD: объект с идентичностью; равенство по `id`. | [[domain-driven-design]] |
| Entity (TypeORM) | POJO с TypeORM-декораторами, описывающий ровно одну строку таблицы; живёт в `infrastructure/persistence/`. | [[entity-vs-domain-model]] |
| `Entity<TId>` | Базовый класс из `libs/ddd` для child-сущностей агрегата. | [[entity-vs-domain-model]] |
| `EntityManager` | Контекст TypeORM для CRUD-операций внутри `DataSource`; ключ к транзакциям. Из-за `ARCH-LINT-EX-01` сегодня leaks в `IStockRepositoryPort`. | [[typeorm-overview]] |
| Event (DTO, `*.event.ts`) | Plain interface; wire-формат cross-service-события. | [[dto-by-direction]] |
| Event (messaging) | Уведомление о факте; producer ответа не ждёт. Транспортный аналог Domain Event. | [[message-vs-event-patterns]] |
| `EXCHANGES` | Frozen `as const` объект имён exchange'ей из `libs/messaging`. Зарезервирован под topic-routing — сейчас все очереди слушают `default exchange`. | [[rabbitmq-as-bus]] |
| Exchange | Точка маршрутизации AMQP; producer публикует в exchange, тот раскладывает по queues. | [[rabbitmq-as-bus]] |
| `execute(...)` | Единственный public-метод use-case'а — конвенция. | [[use-cases-vs-fat-services]] |
| Exporter | Компонент OTel-SDK, шлющий span'ы наружу; в проекте — `OTLPTraceExporter` через HTTP. | [[opentelemetry-overview]] |
| `expiresIn` | JwtSignOptions-параметр lifetime: `'15m'`, `'7d'`, число секунд. | [[lib-nestjs-jwt]] |
| `ExtractJwt` | Объект с фабриками функций извлечения токена из request'а; в проекте — `fromAuthHeaderAsBearerToken`. | [[lib-passport-jwt]], [[auth-stack-overview]] |
| Fail-closed | Дефолт «всё запрещено, открой явно»; применяется и к auth (`JwtAuthGuard` глобально), и к lint (`boundaries/dependencies` default `disallow`). | [[jwt-and-rbac]] |
| Fan-out | Доставка одного события нескольким consumer'ам; pub-sub. | [[message-vs-event-patterns]], [[notifier-port-and-adapters]] |
| Fat service (анти-паттерн) | Класс, инжектящий repo + ClientProxy + cache + logger; противоположность use-case'у. | [[use-cases-vs-fat-services]] |
| Fire-and-forget | Стиль публикации без ожидания ответа; `ClientProxy.emit`. | [[message-vs-event-patterns]] |
| `firstValueFrom` | rxjs-функция: подписывается на Observable и резолвит Promise первым значением. Используется в каждом messaging-адаптере. | [[api-gateway-pattern]], [[nest-microservices-transport]] |
| Forbidden imports | Раздел `CLAUDE.md`, дублирующий часть правил линта **для людей**: что нельзя импортировать в `domain/`. | [[module-boundaries]], [[shared-libs-philosophy]] |
| `forFeature` | `DatabaseModule.forFeature(entities)` — per-module регистрация entity для `@InjectRepository`. | [[base-entity-and-base-repository]] |
| `forRoot` | `DatabaseModule.forRoot()` — глобальная регистрация TypeORM `DataSource`. Один вызов в AppModule. | [[base-entity-and-base-repository]] |
| Foundation libs | `contracts`, `database`, тонкий `common`. Делаются в task-03 миграции; фундамент для остальных. | [[shared-libs-philosophy]] |
| `getNodeAutoInstrumentations()` | Функция из `@opentelemetry/auto-instrumentations-node`: возвращает bundle инструментаций (http/mysql2/redis/amqplib/nestjs-core/fs). | [[opentelemetry-overview]] |
| Global guard | `JwtAuthGuard` / `RolesGuard`, регистрируемые через `APP_GUARD`; применяются ко всем route'ам. | [[api-gateway-pattern]] |
| Graceful degradation | Кэш-fail логируется и проглатывается; fallback — БД. | [[cache-aside-pattern]] |
| Graceful shutdown | SDK гарантирует, что финальные span'ы успеют покинуть процесс до exit'а. | [[lib-opentelemetry-sdk-node]] |
| Hard reset | Удаление Docker-volume'ов перед e2e-тестом; реализуется `yarn test:infra:reload`. | [[test-strategy]] |
| Healthcheck `--wait` | Docker-compose-flag: ждать, пока контейнер не перейдёт в `healthy`. | [[test-strategy]] |
| Hexagonal core | «Ядро» гексагональной архитектуры — `domain/` + `application/`. | [[hexagonal-architecture]] |
| `hooks.logMethod` | Pino-hook на каждый log-call: даёт доступ к аргументам перед сериализацией. У нас инжектит `traceId`/`spanId`. | [[pino-logging]], [[trace-log-correlation]] |
| `hrTime()` | High-resolution timestamp-helper из `@opentelemetry/core`. | [[lib-opentelemetry-core]] |
| HS256 | HMAC-SHA-256: симметричная подпись JWT, один секрет. Выбран для портфельного scope (vs RS256 с парой ключей). | [[jwt-and-rbac]] |
| HTTP edge | «Внешняя кромка» системы — единственное место, куда могут подключаться внешние клиенты. У нас это API Gateway. | [[api-gateway-pattern]] |
| `ICorrelationPayload` | Cross-service контракт `{ correlationId: string }`; каждый wire-payload его extends. | [[rabbitmq-as-bus]], [[pino-logging]] |
| Identification | «Кто это утверждает, что он»; у нас — `sub` в JWT. | [[jwt-and-rbac]] |
| `ignoreExpiration` | passport-jwt-параметр: если `true`, не проверяет `exp`. В проекте — `false`. | [[lib-passport-jwt]] |
| In-memory port double | Plain-TypeScript-класс, реализующий port; держит state в Map/Array. Конвенция файла — `test-doubles.ts`. | [[test-strategy]] |
| Infrastructure layer | Слой `infrastructure/` — адаптеры конкретных технологий (TypeORM, RMQ, Redis). | [[clean-architecture-layers]] |
| `INotifierPort` | Outbound port: `send(Notification): Promise<void>`; реализации — log/email/webhook. | [[notifier-port-and-adapters]] |
| `instrumentation-amqplib` | Патч `traceparent` в AMQP-properties — связывает producer- и consumer-span'ы в одно дерево. Pin'ится явно, чтобы версия не дрейфовала. | [[jaeger-backend]], [[lib-opentelemetry-instrumentation-amqplib]] |
| Integration libs | `messaging`, `cache`, `observability`, `ddd`. Делаются в task-04 миграции; зависят от foundation-libs. | [[shared-libs-philosophy]] |
| Internal edge / External edge | Зависимость inside-repo / на npm в `eslint-plugin-boundaries`. | [[lib-eslint-plugin-boundaries]] |
| Internal-only use-case | Use-case, доступный только из другого use-case'а; в проекте — `ValidateUserUseCase`. | [[use-cases-vs-fat-services]] |
| Invariant | Условие, всегда истинное для domain-объекта; нарушение делает его невалидным. | [[domain-driven-design]], [[entity-vs-domain-model]] |
| `IPasswordHasher` | Узкий интерфейс (только verify) для domain-model. | [[lib-argon2]] |
| `IPasswordPort` | DI-port: `hash` + `verify` для use-cases. Реализация — `Argon2PasswordAdapter`. | [[lib-argon2]] |
| `ITransactionPort` | Будущий unit-of-work-порт; закроет `ARCH-LINT-EX-01`. Сегодня не существует. | [[use-cases-vs-fat-services]] |
| Jaeger | OSS distributed tracing: collector + storage + UI. В проекте поднимается через compose-overlay. | [[jaeger-backend]] |
| Jaeger UI | Web-интерфейс по `:16686`. | [[jaeger-backend]] |
| `jest.spyOn` vs `jest.mock` | `spyOn` — Spy с реальной реализацией (можно вызвать `mockReturnValue`); `jest.mock` — полная подмена модуля. | [[test-strategy]] |
| `jsonwebtoken` | NPM-пакет; реальный исполнитель sign/verify под `@nestjs/jwt`. | [[lib-nestjs-jwt]] |
| JWT | JSON Web Token, RFC 7519. | [[jwt-and-rbac]] |
| JWT-claims | Поля payload'а: `sub`, `iat`, `exp`, `aud`, `iss`, и т.п. | [[lib-passport-jwt]] |
| `JwtAuthGuard` | Global `APP_GUARD` из `libs/auth`; уважает `@Public()`. | [[jwt-and-rbac]] |
| `JwtModule.registerAsync` | Регистратор `JwtService`; читает секрет и `expiresIn` из `ConfigService`. | [[auth-stack-overview]] |
| `JwtService` | Класс из `@nestjs/jwt`: `signAsync` + `verifyAsync`. | [[auth-stack-overview]], [[lib-nestjs-jwt]] |
| `JwtSignOptions` | Тип опций `signAsync`. | [[lib-nestjs-jwt]] |
| `KeyvRedis` | Класс `@keyv/redis`; `KeyvStoreAdapter`-имплементация over Redis. | [[cache-stack-overview]] |
| `KeyvStoreAdapter` | Интерфейс `keyv`: три обязательных метода — get/set/delete. Реализации: `@keyv/redis`, `@keyv/mongo`, in-memory… | [[cache-stack-overview]], [[lib-keyv]] |
| `keyPrefixSeparator` | Разделитель namespace ↔ key в `keyv`. | [[cache-stack-overview]] |
| L1 / L2 | Уровни кэша. У нас сегодня только L2 (Redis); L1 (in-process) зарезервирован под `cacheable`. | [[lib-cacheable]] |
| `last match wins` | Семантика массива правил `boundaries/dependencies`: побеждает **последнее** совпавшее правило, не первое. | [[lib-eslint-plugin-boundaries]] |
| Ledger | Append-only таблица со знаковыми дельтами; в проекте — `product_stock`. | [[entity-vs-domain-model]], [[cache-aside-pattern]] |
| `lib-contracts` | Тип `eslint-plugin-boundaries` для `libs/contracts/**`; единственный, где разрешены `class-validator`/`class-transformer`/`@nestjs/swagger`. | [[shared-libs-philosophy]] |
| `lib-ddd` | Тип `eslint-plugin-boundaries` для `libs/ddd/**`; самый строгий disallow-лист. | [[shared-libs-philosophy]] |
| `lib(type)` | Helper для lib-*-typed target'а в `boundaries/dependencies`. | [[lib-eslint-plugin-boundaries]] |
| `Linter.verify(...)` | Programmatic ESLint-API; на нём построен fixture-based `architecture-lint.spec.ts`. | [[lib-eslint-plugin-boundaries]] |
| `LOG_LEVEL` | Env-var Pino. Default `info` (prod) / `debug` (dev). | [[pino-logging]] |
| `Logger` (`nestjs-pino`) | Nest-DI provider, который инжектится в сервисы. | [[pino-logging]] |
| `LoggerModuleConfig` | Класс из `libs/observability`: даёт Pino options в `LoggerModule.forRootAsync`. | [[pino-logging]] |
| `logger.assign(...)` | Pino-метод: привязывает поле через `AsyncLocalStorage`-scope. | [[pino-logging]] |
| `logMethod` (Pino-hook) | См. `hooks.logMethod`. ADR-015. | [[trace-log-correlation]] |
| Mapper | Класс boundary entity ↔ domain. Static-методы, без state. | [[mappers-and-repositories]] |
| Memory-hard | Свойство Argon2: нужно много памяти на один hash, не только CPU. | [[lib-argon2]] |
| `memoryCost` (m) | Argon2-параметр: сколько KiB памяти per hash. В проекте — 19,456 (OWASP-2024). | [[lib-argon2]] |
| `MessagePattern` | См. `@MessagePattern`. | [[nest-microservices-transport]] |
| Message broker | Брокер сообщений — посредник между producer и consumer. | [[rabbitmq-as-bus]] |
| `MicroserviceClient<Svc>Module` | Модуль из `libs/messaging` для регистрации `ClientProxy` под DI-токеном. | [[api-gateway-pattern]] |
| `MicroserviceClientTokenEnum` | Enum DI-токенов под `ClientProxy` из `libs/contracts/microservices`. | [[nest-microservices-transport]] |
| `MicroserviceMessagePatternEnum` | TypeScript-enum в `libs/contracts/microservices` с identifier-именами routing-key'ев. Синхронизируется с `ROUTING_KEYS` через spec. | [[routing-keys-and-contracts]] |
| `MicroserviceOptions` | Union опций конкретного транспорта `@nestjs/microservices`. | [[nest-microservices-transport]] |
| `MicroserviceQueueEnum` | Enum имён очередей в `libs/contracts/microservices`. | [[rabbitmq-as-bus]] |
| Microservice | Деплоимый процесс со своим bounded-контекстом, очередью RMQ, набором сущностей. | [[microservices-split]] |
| Migration | Timestamp'ованный TS-файл с парой `up`/`down`-методов; **единственный** канал изменения схемы. | [[typeorm-overview]] |
| `MigrationInterface` | Тип-интерфейс TypeORM для миграции. Требует `up(qr)` и `down(qr)`. | [[typeorm-overview]] |
| Mixin | Функция, возвращающая класс; runtime-композиция. Используется `@nestjs/passport` для `PassportStrategy`. | [[lib-nestjs-passport]] |
| `mixin` (Pino) | Альтернатива `logMethod`: функция-add'ер полей. | [[trace-log-correlation]] |
| Monorepo | Один Git-репозиторий, в котором живёт несколько деплоимых сервисов и общий код. | [[nestjs-monorepo]] |
| Multi-tier cache | L1 (in-process) + L2 (shared, Redis) + …; `cacheable` это умеет, у нас сегодня только L2. | [[cache-stack-overview]] |
| `mysql2` | Promise-based MySQL-клиент для Node.js. Используется TypeORM'ом при `type: 'mysql'`. | [[typeorm-overview]] |
| Namespace (keyv) | Префикс к каждому ключу; default — пусто. | [[cache-stack-overview]] |
| `NestFactory.createMicroservice` | Фабрика consumer-приложения NestJS; не открывает HTTP-порт. | [[nest-microservices-transport]] |
| `nest-cli.json projects` | Запись `projects.<service>` под `monorepo: true`; root, sourceRoot, tsConfigPath. | [[nestjs-monorepo]] |
| NestJS monorepo mode | Режим `nest-cli.json` с `monorepo: true`; общая сборка через `nest build --all`. | [[nestjs-monorepo]] |
| `nestjs-pino` | NPM-пакет: NestJS-обёртка над `pino` + `pino-http`. | [[pino-logging]] |
| `noAck` | Опция RMQ-транспорта. `false` — handler ack'ает явно. У нас — `false`. | [[rabbitmq-as-bus]] |
| `NodeSDK` | Класс `@opentelemetry/sdk-node`: запускает SDK при `start()`. Вызывается в `libs/observability/tracer.ts`. | [[opentelemetry-overview]], [[lib-opentelemetry-sdk-node]] |
| `NOISY_CONTEXTS` | Set Nest-context'ов, отфильтровываемых в dev-Pino (например, `NestFactory`-spam). | [[pino-logging]] |
| No-op-span | Span без провайдера; попадает в `/dev/null`. | [[lib-opentelemetry-api]] |
| Notification-consumer ~62s | Артефакт `process`-span'а в Jaeger из-за того, как `instrumentation-amqplib` закрывает consumer-span. Не настоящая латентность. | [[jaeger-backend]] |
| `NOTIFIER` | DI-symbol для `INotifierPort`. | [[notifier-port-and-adapters]] |
| Nx workspace | Альтернативный monorepo-orchestrator (Nrwl Nx). Документирован как future option, не выбран. | [[nestjs-monorepo]] |
| Nygard hybrid format | Nygard + MADR гибрид структуры ADR: Date, Status, Context, Decision, Alternatives, Consequences. ADR-003. | [[architecture-decision-records]] |
| OpenTelemetry (OTel) | Vendor-neutral observability framework CNCF; в проекте — для distributed tracing. | [[opentelemetry-overview]] |
| OpenTelemetry Collector | Vendor-neutral агрегатор span'ов; receive → process → re-export. | [[jaeger-backend]] |
| Origin (`external`/`core`) | Тип target'а в `eslint-plugin-boundaries`: npm-пакет или Node-stdlib. | [[lib-eslint-plugin-boundaries]] |
| ORM | Object-Relational Mapper — слой, преобразующий строки таблиц в объекты языка. | [[typeorm-overview]] |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Env-var, обязательная. URL коллектора + `/v1/traces`. | [[opentelemetry-overview]] |
| `OTEL_EXPORTER_OTLP_HEADERS` / `TIMEOUT` / `COMPRESSION` | Доп-env-vars OTLP-exporter'а; не выставлены, дефолты приемлемы. | [[lib-opentelemetry-exporter-trace-otlp-http]] |
| `OTEL_SDK_DISABLED` | Env-var OTel: `'true'` → SDK не стартует. В проекте не используется — гипотетический test-context. | [[opentelemetry-overview]] |
| `OTEL_SERVICE_NAME` | Env-var, обязательная. Имя сервиса в Jaeger. | [[opentelemetry-overview]] |
| `otelcol-contrib` | Distribution OTel-Collector'а с extra-exporters; в проекте — образ для compose-overlay. | [[jaeger-backend]] |
| OTLP | OpenTelemetry Protocol. | [[opentelemetry-overview]] |
| OTLP/gRPC | OTLP over gRPC, `:4317`. В проекте не используется. | [[jaeger-backend]] |
| OTLP/HTTP | OTLP over HTTP, `:4318`. В проекте выбран этот вариант. | [[jaeger-backend]] |
| OTLP/JSON | JSON-сериализация OTLP-payload'а; то, что использует наш exporter-trace-otlp-http. | [[lib-opentelemetry-exporter-trace-otlp-http]] |
| OTLP/protobuf | Бинарная сериализация OTLP. Отдельный пакет, не выбран. | [[lib-opentelemetry-exporter-trace-otlp-http]] |
| `OTLPTraceExporter` | Класс exporter'а из `@opentelemetry/exporter-trace-otlp-http`. Конструктор без аргументов = читать env-vars. | [[opentelemetry-overview]], [[lib-opentelemetry-exporter-trace-otlp-http]] |
| OWASP A01:2021 | Broken Access Control — top-1 риск в web-приложениях. Контекст для глобальных guard'ов. | [[jwt-and-rbac]] |
| OWASP A02:2021 | Cryptographic Failures — top-2 риск. Контекст для argon2id и rotated-refresh. | [[lib-argon2]] |
| `parallelism` (p) | Argon2-параметр: сколько потоков использует один hash. У нас — 1. | [[lib-argon2]] |
| `parentSpanId` | Указатель «выше по call-graph'у» внутри trace'а. | [[opentelemetry-overview]] |
| `Params` (`nestjs-pino`) | Интерфейс, который реализует `LoggerModuleConfig`. | [[pino-logging]] |
| `passport` | NPM-пакет: middleware-runner для стратегий. Сам стратегию не выбирает — это работа `@nestjs/passport`. | [[lib-passport]] |
| `passport-jwt` | NPM-пакет: passport-Strategy для проверки JWT (извлечение из header + верификация подписи). | [[lib-passport-jwt]] |
| `passport.authenticate(name)` | Express-middleware-фабрика; запускает стратегию по имени. | [[lib-passport]] |
| `PassportModule` | Nest-модуль из `@nestjs/passport`: `register({ defaultStrategy })`. | [[lib-nestjs-passport]] |
| `PassportStrategy(Strategy, name)` | Mixin из `@nestjs/passport`; делает passport-стратегию DI-friendly. | [[auth-stack-overview]] |
| Passthrough (hook) | Поведение Pino-hook: «не модифицировать args»; нужно для `logMethod`, когда нет активного span'а. | [[trace-log-correlation]] |
| Pattern (boundaries) | Glob, который матчит файлы для element-type'а в `eslint-plugin-boundaries`. | [[lib-eslint-plugin-boundaries]] |
| peerDependency | NPM-зависимость, версия которой согласуется wrapper'ом (`@nestjs/passport` peers `passport`). | [[lib-passport]] |
| Per-module hexagonal | Layout `domain/application/infrastructure/presentation` внутри `modules/<name>/`; ADR-004. | [[microservices-split]] |
| Per-module template | Канонический per-module layout, скопированный из notification-микросервиса (ADR-011). | [[notifier-port-and-adapters]] |
| Per-service Resource | OTel-Resource привязан к процессу; не пропагируется между сервисами. | [[lib-opentelemetry-resources]] |
| Pino | Самый быстрый JSON-logger Node.js. Выбран для логов проекта; ADR-001. | [[pino-logging]] |
| `pino-http` | HTTP-middleware Pino: per-request logger. | [[pino-logging]] |
| `pino-pretty` | Dev-форматтер; в prod не активен. | [[pino-logging]] |
| `PinoLogger` | Класс из `nestjs-pino`. Использование на boot-time в `main.ts`. | [[pino-logging]] |
| Polyrepo | «Один репозиторий — один сервис». Альтернатива monorepo; отвергнута в ADR-018. | [[nestjs-monorepo]] |
| Port | Порт — TypeScript-интерфейс, описывающий, что приложение умеет (driving) или что ему нужно (driven). | [[hexagonal-architecture]] |
| Post-commit | Действие, выполняющееся **после** успешного COMMIT (например, await-инвалидация кэша или publish event'а). | [[cache-aside-pattern]], [[use-cases-vs-fat-services]] |
| Post-commit publish | Публикация события после успешной фиксации состояния; не до. | [[message-vs-event-patterns]] |
| Presentation layer | Слой `presentation/` — controllers, pipes, RPC-handlers. | [[clean-architecture-layers]] |
| `primary` (cacheable) | Историческое имя первого tier'а в `cacheable`. | [[lib-cacheable]] |
| Processor | Компонент OTel-Collector'а, трансформирующий span'ы между receiver и exporter. | [[jaeger-backend]] |
| Projection | DTO, форма которого не совпадает с агрегатом 1-к-1; типичный read-shape. | [[dto-by-direction]] |
| Propagation | Распространение trace-context между процессами через `traceparent`. | [[opentelemetry-overview]] |
| Pull semantics | Pull-модель публикации domain-event'ов: aggregate накапливает события, repository выгружает по запросу через `pullDomainEvents()`. | [[domain-driven-design]] |
| `publish`-span / `process`-span | Span'ы `instrumentation-amqplib` на стороне producer'а / consumer'а соответственно. | [[lib-opentelemetry-instrumentation-amqplib]] |
| Query (`*.query.ts`) | Plain interface; read-вход application-слоя; зарезервированный слот (в проекте сегодня нет complex-query'ев). | [[dto-by-direction]] |
| `QueryBuilder` | Программируемый builder произвольных SQL-запросов с join'ами и lock'ами. | [[typeorm-overview]] |
| `QueryRunner` | Низкоуровневый исполнитель сырого SQL; на нём работают миграции. | [[typeorm-overview]] |
| Queue | Очередь сообщений RMQ; FIFO с возможными приоритетами. | [[rabbitmq-as-bus]] |
| Queue per service | Конвенция: у каждого сервиса своя очередь (`retail_queue`, `inventory_queue`, `notification_events`). | [[microservices-split]] |
| RabbitMQ | Брокер сообщений, реализация AMQP 0-9-1. Выбран в ADR-020. | [[rabbitmq-as-bus]] |
| `RABBITMQ_URL` | Connection string `amqp://user:pass@host:port`. Joi-валидируется при boot'е. | [[rabbitmq-as-bus]] |
| Race window (`CACHE-001`) | Audit-item: окно между чтением БД и записью в кэш в cache-aside; не покрыт тестами. | [[test-strategy]] |
| Rainbow-table | Pre-computed reverse-lookup hash → plaintext. Защита — salt. | [[lib-argon2]] |
| Reach-through | Структурный доступ через несколько слоёв стека (например, `cache.stores[0].store.client`). | [[cache-stack-overview]] |
| Receiver | Компонент OTel-Collector'а, принимающий span'ы. | [[jaeger-backend]] |
| Reconstitute | Восстановление aggregate'а из персистентных данных — без событий и без re-проверки инвариант. | [[domain-driven-design]] |
| `reconstitute(...)` | Второй factory-метод агрегата — рядом с обычным create. | [[mappers-and-repositories]] |
| `redact` | Pino-опция: маскировка/удаление полей (Authorization, Cookie, refreshTokenHash). | [[pino-logging]] |
| `RedisClient` | Класс из `@redis/client`. Public-property `KeyvRedis.client`. | [[lib-keyv-redis]] |
| Reference table | БД-таблица, хранящая enum-значения + поля `name`/`color`; например, `order_status`. | [[dto-by-direction]] |
| `Reflect.construct` | Низкоуровневый JS-механизм создания инстанса; используется mixin'ом `PassportStrategy`. | [[lib-nestjs-passport]] |
| Reflector | Nest-util: читает метаданные с handler/class. Используется guard'ами. | [[auth-stack-overview]] |
| Refresh token | Долгоживущий (7d) JWT; обменивается на новую пару (rotation). | [[jwt-and-rbac]] |
| Regression spec | `tests/lint/architecture-lint.spec.ts` — fixture-based защита самого ESLint-конфига от silent loosening. | [[module-boundaries]], [[lib-eslint-plugin-boundaries]] |
| `remove: true` (redact) | Pino-redact-опция: удалить поле целиком, не заменять на `[Redacted]`. | [[pino-logging]] |
| Repository | DDD: «коллекция aggregate'ов» с интерфейсом `findById`/`save`. | [[domain-driven-design]] |
| Repository adapter | `@Injectable()`-класс, implementing port; технологически-specific. | [[mappers-and-repositories]] |
| Repository port | Интерфейс persistence-контракта в терминах домена; framework-free. | [[mappers-and-repositories]] |
| `Repository<TEntity>` | Низкоуровневый TypeORM-репозиторий; в `BaseTypeormRepository` он спрятан. | [[mappers-and-repositories]] |
| Reply-очередь | Auto-named очередь под `send`-ответы в `@nestjs/microservices`. | [[message-vs-event-patterns]] |
| `replyTo` | AMQP-property с именем reply-очереди. | [[message-vs-event-patterns]] |
| Request DTO (`*.request.dto.ts`) | Inbound-класс с `class-validator`-decorator'ами и `@ApiProperty`. | [[dto-by-direction]] |
| Request/response | Стиль «запрос → ответ»; синоним RPC в этой шине. | [[message-vs-event-patterns]] |
| `require-in-the-middle` | NPM-пакет для перехвата `require()`; основа auto-instrumentation. | [[opentelemetry-overview]] |
| Resource | Метаданные сервиса (`service.name`, `deployment.environment.name`); attach'ятся ко всем span'ам процесса. | [[opentelemetry-overview]] |
| Resource detectors | Пакеты, авто-детектирующие атрибуты из окружения. | [[lib-opentelemetry-resources]] |
| `resourceFromAttributes(...)` | Builder из `@opentelemetry/resources`. | [[lib-opentelemetry-resources]] |
| `resourceSpans` | Внешняя обёртка JSON-payload'а в OTLP/HTTP. | [[lib-opentelemetry-exporter-trace-otlp-http]] |
| RESP | REdis Serialization Protocol; wire-формат Redis. | [[lib-keyv-redis]] |
| Response DTO (`*.response.dto.ts`) | Outbound-класс с `@ApiResponseProperty`. | [[dto-by-direction]] |
| RFC 6750 | Стандарт «Bearer Token Usage for OAuth 2.0»; формат `Authorization: Bearer <token>`. | [[auth-stack-overview]] |
| Rich domain model | Богатая модель — с поведением; противоположность «анемичной» (только геттеры). | [[domain-driven-design]] |
| RMQ-only service | Сервис без HTTP-порта; общение только через RabbitMQ (notification-микросервис). | [[microservices-split]], [[notifier-port-and-adapters]] |
| `RmqOptions` | Тип-конфиг RMQ-transport'а в `@nestjs/microservices`. | [[rabbitmq-as-bus]] |
| `RoleEnum` | `'admin' \| 'customer'`; источник правды — `libs/contracts/auth`. | [[jwt-and-rbac]] |
| `RolesGuard` | Global `APP_GUARD`; сверяет `request.user.roles` со списком `@Roles(...)`. | [[jwt-and-rbac]] |
| `RoleVO` | Domain-side value object вокруг `RoleEnum`. | [[jwt-and-rbac]] |
| Rotation reuse-detection | Попытка переиспользовать обменянный refresh → invalidate всех сессий пользователя. | [[jwt-and-rbac]] |
| Routing key | Строковый идентификатор сообщения в AMQP; в проекте — `<service>.<aggregate>.<action>` по ADR-008. | [[routing-keys-and-contracts]] |
| `ROUTING_KEYS` | Frozen `as const`-объект в `libs/messaging` с routing-key константами. | [[routing-keys-and-contracts]] |
| RPC | Remote Procedure Call; producer ждёт типизированный ответ. | [[message-vs-event-patterns]] |
| `RpcException` | NestJS-класс ошибок из RPC-handler'а. | [[message-vs-event-patterns]] |
| RS256 | RSA-SHA-256: пара ключей вместо одного секрета; отвергнут для портфельного scope. | [[jwt-and-rbac]] |
| `req.user` | Свойство, куда passport-middleware кладёт результат стратегии; читается через `@CurrentUser()`. | [[auth-stack-overview]] |
| Runtime monkey-patching | Подмена экспортов модуля в момент `require()`. Основа OTel-auto-instrumentation. | [[lib-opentelemetry-auto-instrumentations-node]] |
| Salt | Случайные байты в hash'е; защита от rainbow-table. | [[lib-argon2]] |
| `sameApp(type)` | Helper для same-`{app}`-target'а в `boundaries/dependencies`. | [[lib-eslint-plugin-boundaries]] |
| `sameModule(type)` | Helper для same-`{app, module}`-target'а в `boundaries/dependencies`. | [[lib-eslint-plugin-boundaries]] |
| SCAN | Команда Redis для итерации ключей по pattern'у; не блокирует. Используется в `delByPrefix`. | [[cache-aside-pattern]] |
| `scanIterator` | API `@redis/client v5+`: async-iterator над SCAN. | [[lib-keyv-redis]] |
| Scalar OpenAPI viewer | Альтернатива Swagger UI на `/api/reference`; пакет `@scalar/nestjs-api-reference`. | [[api-gateway-pattern]] |
| Schema-version segment | Сегмент ключа `:v2:`, инвалидирующий старые entries при breaking-change; в проекте не введён (audit-item `CACHE-003`). | [[cache-aside-pattern]] |
| `secretOrKey` | Параметр `passport-jwt`-Strategy: чем проверять подпись. | [[auth-stack-overview]] |
| `secretOrKeyProvider` | Динамический resolver секрета для `passport-jwt`. | [[lib-passport-jwt]] |
| Seed | Тестовые данные, вставляемые в already-migrated схему. | [[typeorm-overview]] |
| Seed (test) | Скрипт `scripts/test-db-seed.ts`; вставляет stable UUID'ы для e2e-asserts. | [[test-strategy]] |
| Semantic conventions | OTel-spec, определяющий правильные имена атрибутов; пакет `@opentelemetry/semantic-conventions`. | [[lib-opentelemetry-semantic-conventions]] |
| `SemanticResourceAttributes` (deprecated) | Старый namespace-style в semantic-conventions; alias на новые `ATTR_*`-константы. | [[lib-opentelemetry-semantic-conventions]] |
| Shared library | Папка `libs/<name>/` с переиспользуемым кодом, импортируемая по path-алиасу. | [[shared-libs-philosophy]] |
| Shared network (`backend`) | Docker-сеть из основного compose'а, используемая overlay'ем для связи коллектора и приложений. | [[jaeger-backend]] |
| Side-effect import | Импорт ради побочного эффекта (без named bindings). У нас — `import '@retail-inventory-system/observability/tracer';` первой строкой `main.ts`. | [[opentelemetry-overview]] |
| `signAsync<T>` | `JwtService`-метод: подписать payload → `Promise<string>`. | [[lib-nestjs-jwt]] |
| `SimpleSpanProcessor` | Альтернатива `BatchSpanProcessor`: один span = один экспорт; для тестов. | [[lib-opentelemetry-sdk-node]] |
| Single-flight | Защита от stampede: один miss делает DB-запрос, остальные ждут результата. В проекте не реализован. | [[cache-aside-pattern]] |
| Slug | Kebab-case-описание решения в имени ADR-файла; описывает **что** решили (не «adr-001», а «structured-logging-with-pino»). | [[architecture-decision-records]] |
| `snake_case` | SQL-конвенция именования таблиц/колонок; в проект приходит через `SnakeNamingStrategy`. | [[snake-naming-strategy]] |
| `SnakeNamingStrategy` | Реализация TypeORM naming-strategy из `typeorm-naming-strategies`: camelCase ↔ snake_case. | [[snake-naming-strategy]] |
| Soft-delete | Логическое удаление: метка времени (`deleted_at`) вместо `DELETE FROM`. | [[base-entity-and-base-repository]] |
| Source of truth | Каноничный источник значения. Для routing-key'ев — `ROUTING_KEYS` + enum, синхронизированный spec'ом. | [[routing-keys-and-contracts]] |
| Span | Одна логическая операция в OTel: HTTP-handler, SQL-query, RMQ-publish. | [[opentelemetry-overview]] |
| `SpanContext` | Объект `{ traceId, spanId, traceFlags, isRemote? }`; то, что возвращает `span.spanContext()`. | [[trace-log-correlation]] |
| `spanId` | 64-битный идентификатор span'а. | [[opentelemetry-overview]] |
| Stable UUID | Фиксированный UUID, на который assert'ятся `expect.toBe(...)` в e2e-тестах. Источник — seed-скрипт. | [[test-strategy]] |
| Stack (auth) | Вертикальная цепочка пакетов; каждый адаптирует более низкий (passport → @nestjs/passport → JwtStrategy). | [[auth-stack-overview]] |
| Stampede / Thundering herd | Множество одновременных miss'ов на одном ключе → пиковая нагрузка БД. Защита — single-flight. | [[cache-aside-pattern]] |
| Status: Accepted | ADR в силе. Большинство наших ADR — Accepted. | [[architecture-decision-records]] |
| Status: Superseded by ADR-NNN | ADR отменён более новым; старый файл не редактируется. | [[architecture-decision-records]] |
| `Store` | Концепт `cache-manager v7+`/`cacheable` — один tier кэша. | [[cache-stack-overview]] |
| Strategy (passport) | Класс с `authenticate(req)`; зарегистрирован под именем. | [[auth-stack-overview]] |
| Strategy registry | Глобальный map `{ name → instance }` внутри `passport`. | [[lib-passport]] |
| Structural subtyping | TypeScript-механика: типы matched по полям, без `implements`; почему Command-interface работает без класса. | [[dto-by-direction]] |
| `synchronize` | Опция TypeORM «синхронизируй схему при старте». Запрещена. Только миграции. | [[typeorm-overview]] |
| `test-doubles.ts` | Файл-конвенция для in-memory port-doubles; plain TypeScript, no jest globals, реализует port-interface. | [[test-strategy]] |
| Test double | In-memory port-реализация для unit-тестов; не bootstrap'ит TypeORM/Redis/RMQ. | [[mappers-and-repositories]], [[use-cases-vs-fat-services]], [[test-strategy]] |
| `test:infra:reload` | npm-скрипт: hard-reset инфраструктуры (`docker compose down -v && up && migrate && seed`). | [[test-strategy]] |
| Test pyramid | Соотношение unit : integration : e2e; у нас — 29 unit-suites + 3 e2e + 1 architecture-lint. | [[test-strategy]] |
| `this.success` / `fail` / `error` | Callback'и passport-стратегии для возврата результата. | [[lib-passport]] |
| `timeCost` (t) | Argon2-параметр: количество итераций. В проекте — 2. | [[lib-argon2]] |
| `tls.insecure: true` | YAML-флаг коллектора для in-network-связи; допустимо за compose-сетью. | [[jaeger-backend]] |
| Token rotation | На каждом refresh — **новый** refresh-токен; старый одноразовый. | [[jwt-and-rbac]] |
| Topic exchange | Exchange, который матчит routing-key по шаблонам (`*`, `#`). У нас зарезервирован, не используется. | [[rabbitmq-as-bus]] |
| `Trace` | Дерево span'ов с общим `traceId`. | [[opentelemetry-overview]] |
| `trace.getActiveSpan()` | Функция из `@opentelemetry/api`; возвращает активный span текущего контекста (или no-op). | [[trace-log-correlation]] |
| `TraceContextInterceptor` | Nest-interceptor из `libs/observability`, placeholder; auto-instrumentation сегодня закрывает cross-service-flow без него. | [[trace-log-correlation]] |
| `traceId` | 128-битный идентификатор trace'а. | [[opentelemetry-overview]] |
| `traceparent` | Заголовок W3C trace context: `00-<traceId>-<spanId>-<flags>`. Пробрасывается через AMQP message properties и HTTP. | [[rabbitmq-as-bus]], [[opentelemetry-overview]] |
| `Tracer` (interface) | Объект, возвращаемый `trace.getTracer(...)`; даёт `startSpan` / `startActiveSpan`. | [[lib-opentelemetry-api]] |
| `TracerProvider` | Интерфейс OTel-API: фабрика Tracer'ов. Реализуется SDK или test-stub'ами. | [[lib-opentelemetry-api]] |
| Tracking code | Стандартизированный ID exception'а архитектурного линта (например, `ARCH-LINT-EX-01`). | [[lib-eslint-plugin-boundaries]] |
| Transaction script | Анти-паттерн: пошаговый сценарий внутри одного метода use-case'а; нет агрегатов. | [[hexagonal-architecture]] |
| Transactional outbox | Паттерн «событие в той же транзакции с состоянием». В проекте сегодня **нет**. | [[rabbitmq-as-bus]] |
| `transport.target` | Pino-опция: форматтер (у нас `'pino-pretty'` в dev). | [[pino-logging]] |
| `Transport.RMQ` | Идентификатор RMQ-транспорта в `@nestjs/microservices`. | [[rabbitmq-as-bus]] |
| Tree-shaking | Bundler-оптимизация: убирает неиспользуемые экспорты. Важна для semantic-conventions с тысячами констант. | [[lib-opentelemetry-semantic-conventions]] |
| TS path alias | Алиас вида `@retail-inventory-system/<name>` в `compilerOptions.paths`. | [[nestjs-monorepo]] |
| `tsconfig.app.json` | Per-app TS-конфиг, наследующий корневой; переопределяет только `outDir` и `include`. | [[nestjs-monorepo]] |
| `ts-jest` | TypeScript transformer для Jest. | [[test-strategy]] |
| TTL | Time-to-live (time-window invalidate); default `CACHE_TTL_MS_DEFAULT` = 60000ms. | [[cache-aside-pattern]] |
| TypeORM | ORM для TypeScript/Node.js; основной выбор проекта (ADR-019). | [[typeorm-overview]] |
| `typeorm-naming-strategies` | NPM-пакет, в котором живут naming-strategy'и для TypeORM. | [[snake-naming-strategy]] |
| Транзитивная зависимость | Зависимость через другую зависимость, без явного pin'а в `package.json`. | [[lib-opentelemetry-core]] |
| Unit of work | Транзакционный scope, в котором несколько операций атомарны. Будущий `ITransactionPort` закроет `ARCH-LINT-EX-01`. | [[mappers-and-repositories]] |
| UNLINK | Удаление ключей Redis с async-free памяти в background-thread; не блокирует main-loop. | [[cache-aside-pattern]] |
| Use-case | Класс одного write- или read-сценария; инжектит **только** порты, не технологии. | [[use-cases-vs-fat-services]] |
| `useClass` | Nest-DI: создаёт новый instance под токеном. | [[notifier-port-and-adapters]] |
| `useExisting` | Nest-DI: alias на уже-зарегистрированного провайдера под другим токеном. | [[mappers-and-repositories]], [[auth-stack-overview]], [[notifier-port-and-adapters]] |
| User enumeration | Возможность отличить ответ «нет логина» от «неверный пароль»; защита — единый generic error. | [[jwt-and-rbac]] |
| `validate(payload)` | Метод passport-стратегии; passport-middleware его зовёт после verify-подписи. У нас делегирует в `AUTH_USER_VALIDATOR`. | [[auth-stack-overview]] |
| `ValidationPipe` | Глобальный pipe `class-validator` с `whitelist`/`transform`/`forbidNonWhitelisted`. | [[api-gateway-pattern]] |
| Value Object | DDD: объект без идентичности, неизменяемый, равенство по структурному значению. | [[domain-driven-design]], [[notifier-port-and-adapters]] |
| `ValueObject<TProps>` | Базовый класс из `libs/ddd` для VO; структурное равенство через `equals`. | [[entity-vs-domain-model]] |
| Vendor swap | Замена бэкенда трейсинга через смену `exporters:` в YAML-конфиге Collector'а; не приложений. | [[jaeger-backend]] |
| `verify`-callback | `(payload, done) => …` в passport-jwt; для бизнес-проверок после успешной верификации подписи. | [[lib-passport-jwt]] |
| `verifyAsync<T>` | `JwtService`-метод: проверить подпись → `Promise<T>`. | [[lib-nestjs-jwt]] |
| Version pin | Явная top-level-зависимость для контроля версии (вместо peer-pull through bundle). | [[lib-opentelemetry-instrumentation-amqplib]] |
| View (`*.view.ts`) | Plain interface/класс, read-projection; зарезервированный слот. | [[dto-by-direction]] |
| `waitForCall` | Poll-loop с deadline для ожидания async-event'ов в e2e-тестах. | [[test-strategy]] |
| `W3CBaggagePropagator` | Реализация W3C-baggage из `@opentelemetry/core`. | [[lib-opentelemetry-core]] |
| `W3CTraceContextPropagator` | Реализация W3C `traceparent`/`tracestate` inject/extract. | [[lib-opentelemetry-core]] |
| W3C `traceparent` | Стандартный header формата `00-<traceId>-<spanId>-<flags>`. | [[opentelemetry-overview]] |
| Webpack node externals | Плагин, исключающий `node_modules` из бандла; в Docker копируется только `dist/apps/<service>/`. | [[nestjs-monorepo]] |
| Wire event | Plain JSON-форма события для AMQP (`IRetailOrderCreatedEvent`). Отличается от in-process `DomainEvent`. | [[routing-keys-and-contracts]] |
| Wire format | Внешнее представление сообщения: routing key + JSON-payload. | [[routing-keys-and-contracts]], [[dto-by-direction]] |
| Wire payload | TS-интерфейс из `libs/contracts/{retail,inventory}/`; компиляция-time контракт обоих концов. | [[routing-keys-and-contracts]] |
| `wrap` | Метод single-call read-through из `cache-manager`; обёрнут в `ICachePort.wrap`. | [[lib-cache-manager]] |
| Write-behind | Write в кэш, асинхронный flush в БД. Не наш случай. | [[cache-aside-pattern]] |
| Write-through | Каждый write идёт в БД и в кэш синхронно. Не наш случай. | [[cache-aside-pattern]] |
| `x-correlation-id` | HTTP-header `correlationId`; пробрасывается на edge'е `CorrelationMiddleware`. | [[pino-logging]] |
| Yarn dedup | Сворачивание нескольких versions одного пакета в одну. Важно для транзитивного `@opentelemetry/core`. | [[lib-opentelemetry-core]] |
| Yarn workspace | Сабпроект Yarn с собственным `package.json`. У нас объявлен на уровне корня, но per-lib `package.json` нет. | [[nestjs-monorepo]] |

## Что не вошло в глоссарий

Намеренно опущены **категории**, которые не являются «терминами»:

- **ADR-номера** (ADR-001 — ADR-020). Один ADR ≠ термин; справочник
  ADR живёт в `docs/adr/index.md`.
- **Имена файлов и path'ы** (`apps/inventory-microservice/src/...`,
  `libs/cache/cache.module.ts`). Это анкеры permalink'ов, а не словарь.
- **NPM-версии пакетов**. Они зафиксированы в `_carryover-01.md`
  (`yarn.lock` на entry-SHA) и в `package.json`. Глоссарий называет
  пакет, а не его версию.
- **Имена очередей RMQ** (`retail_queue`, `inventory_queue`,
  `notification_events`). Это **значения**, не термины; см.
  [[rabbitmq-as-bus]] §«Очереди» для канонического перечисления.
- **Имена routing-key'ев** (`retail.order.create`, `inventory.stock.low`,
  …). Тоже значения; см. [[routing-keys-and-contracts]].
- **Имена storage-id'шников** (`__default__`, `__all__`). Sentinel'ы
  объясняются в [[cache-aside-pattern]], как и почему они **не** glob.
- **Имена env-vars** (`DATABASE_URL`, `RABBITMQ_URL`, `OTEL_*`). Включаются
  в глоссарий, **только** если несут смысл, не выводимый из имени
  (`OTEL_SDK_DISABLED` — да; `LOG_LEVEL` — да; обычная connection-string —
  нет; см. [[typeorm-overview]] / [[rabbitmq-as-bus]] для них).
- **Audit-codes** (`CACHE-001` — `CACHE-012`). Это идентификаторы
  audit-items, их каталог — `docs/audits/audit-2026-05-08.md`. В
  глоссарий попадает только `Race window (CACHE-001)`, потому что
  на него ссылается [[test-strategy]] как на собирательный пример.

> [!note]- Если термин встретился, а в глоссарии его нет
> Это, скорее всего, **локальный** термин одной статьи. Загляните в
> её секцию «Глоссарий» — там он точно есть. Если и там нет — это
> значит, что термин «общеизвестен» в смысле NestJS/TypeScript
> (`Promise`, `Symbol`, `Module`, `Injectable`) и предполагается
> известным читателю.
