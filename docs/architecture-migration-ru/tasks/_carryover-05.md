# _carryover-05.md — Write messaging articles (Phase: messaging/)

> Generated 2026-05-16 by the task-05 session of the **architecture
> migration guide** writing flow. Builds on `_carryover-04.md` (which
> built on `_carryover-03.md` → `_carryover-02.md` → `_carryover-01.md`,
> the source of the SHA pin `84b1507c68fd9ee02b185eef3c4594b6fe02f664`).

## Entry-gate result

`_carryover-04.md` was read in full. The five persistence articles
it produced are all on `status: review` and are now reachable
wiki-link targets from this task's messaging articles
(`mappers-and-repositories` shows up in one back-link from
`nest-microservices-transport.md` as the canonical anchor for the
`{ provide: SYMBOL, useExisting: Class }` DI pattern). The HEAD
SHA recorded in `_carryover-01.md`
(`84b1507c68fd9ee02b185eef3c4594b6fe02f664`) is used for every
GitHub permalink in every messaging article.

No build smoke-check was run inside the session — only
docs-only files were touched under
`docs/architecture-migration-ru/messaging/`. The working tree
was clean at session start; branch is `migration-guide`. No
code under `apps/` or `libs/` was modified during this
docs-only session. No `git` mutating commands were executed.

## Articles written

Four messaging articles. Each was reshaped from the task-01 stub
(frontmatter + `Заглушка` callout) into a stand-alone
Russian-language mid-level-NestJS article that grounds every
claim in production code.

| Path                                                                                       | One-line Russian summary                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/architecture-migration-ru/messaging/rabbitmq-as-bus.md`                              | RabbitMQ как inter-service transport (ADR-020): один брокер, `RABBITMQ_URL`, очередь-на-сервис (`retail_queue`, `inventory_queue`, `notification_events`), default-exchange wiring, зарезервированные `EXCHANGES` под будущий topic-routing, durable + `noAck: false`, failure-семантика RPC vs event. ~2254 слов. |
| `docs/architecture-migration-ru/messaging/nest-microservices-transport.md`                 | `@nestjs/microservices`: `Transport.RMQ` + `connectMicroservice` в `main.ts`, `ClientsModule.registerAsync` + `MicroserviceClientConfiguration`, ергономика `ClientProxy` (cold Observable → `firstValueFrom` → Promise), правило-граница «`ClientProxy` только в `infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`», ADR-009/012/013. ~2098 слов. |
| `docs/architecture-migration-ru/messaging/message-vs-event-patterns.md`                    | `@MessagePattern` (RPC, `.send`, типизированный ответ) vs `@EventPattern` (event, `.emit`, fire-and-forget, fan-out). Реальные flows: `retail.order.confirm` (RPC chain через `INVENTORY_CONFIRM_GATEWAY`-port) и `retail.order.created` / `inventory.stock.low` (post-commit best-effort events). Anti-patterns + ack-семантика. ~2361 слов. |
| `docs/architecture-migration-ru/messaging/routing-keys-and-contracts.md`                   | Dotted `<service>.<aggregate>.<action>`-конвенция (ADR-008): `ROUTING_KEYS` (`as const`) + `MicroserviceMessagePatternEnum` (зеркало), spec, который их сверяет, snake_case → dotted cutover. `ICorrelationPayload` как сквозной шов; разъяснён канал `correlationId` (payload) vs `traceparent` (AMQP properties). Wire-event ≠ domain-event. ~2260 слов. |

All four articles flipped `status: draft` → `status: review` in
their frontmatter; `updated:` set to `2026-05-16`. Each carries
the mandatory `> [!abstract] Кратко` block, `## Глоссарий`
section, and `> [!faq]- Проверь себя` collapsible (5 questions
per article).

Across the four articles: **39 GitHub permalinks** pinned to
`84b1507c68fd9ee02b185eef3c4594b6fe02f664` (12 + 11 + 9 + 7 = 39).
Code anchors include all the files suggested by task-05 step 3
plus a few that helped tell the story:

- `libs/messaging/{microservice-client.configuration,microservice-client-retail.module,exchanges.constants,rabbitmq.client.factory,routing-keys.constants}.ts` — the core wiring lib.
- `libs/messaging/spec/routing-keys.constants.spec.ts` — the synchronisation invariant.
- `libs/contracts/microservices/{microservice-queue.enum,microservice-message-pattern.enum,correlation.types}.ts` — wire-format identifier source of truth.
- `libs/contracts/retail/events/order-created.event.ts` — illustrative wire-payload extending `ICorrelationPayload`.
- `libs/config/config-module.config.ts` (line 18 — Joi `RABBITMQ_URL` schema).
- `docker-compose.yml` — rabbitmq service block, app environment variable wiring.
- `apps/{retail,inventory,notification}-microservice/src/main.ts` — `createMicroservice` blocks (only inventory + notification cited; retail's is identical to inventory).
- `apps/api-gateway/src/modules/retail/infrastructure/messaging/retail-rabbitmq.adapter.ts` — full RPC adapter.
- `apps/retail-microservice/src/modules/orders/presentation/orders.controller.ts` — full `@MessagePattern` triplet.
- `apps/inventory-microservice/src/modules/stock/presentation/stock.controller.ts` — full `@MessagePattern` pair.
- `apps/retail-microservice/src/modules/orders/infrastructure/messaging/{order-rabbitmq.publisher,inventory-confirm.rabbitmq.adapter}.ts` — event publisher + cross-service RPC adapter.
- `apps/inventory-microservice/src/modules/stock/infrastructure/messaging/stock-rabbitmq.publisher.ts` — `inventory.stock.low` publisher.
- `apps/notification-microservice/src/modules/notifications/infrastructure/consumers/{order-events,inventory-events}.consumer.ts` — both `@EventPattern` consumers.
- `apps/notification-microservice/src/modules/notifications/presentation/health.controller.ts` — RMQ-only health-check `@MessagePattern`.
- `apps/retail-microservice/src/modules/orders/application/use-cases/{create-order,confirm-order}.use-case.ts` — the publish-with-try/catch + RPC-then-publish patterns.
- `apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts` — full DI wiring (port↔adapter binding with `useExisting`).

All cited line ranges were validated against `wc -l` of the
corresponding file at the recorded SHA; off-by-one ends-of-file
were corrected before the carryover was written.

## Glossary terms collected

EN→RU pairs introduced across the four articles. These get
rolled into the consolidated `glossary.md` in task-12.

| Source article                       | EN term                                | RU explanation (short)                                                                                                |
| ------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| rabbitmq-as-bus                      | Message broker                         | Брокер сообщений — посредник между producer и consumer.                                                                |
| rabbitmq-as-bus                      | RabbitMQ                               | Брокер сообщений, реализация AMQP 0-9-1. Выбран в ADR-020.                                                              |
| rabbitmq-as-bus                      | AMQP                                   | Advanced Message Queuing Protocol — открытый протокол брокеров.                                                       |
| rabbitmq-as-bus                      | Exchange                               | Точка маршрутизации в AMQP. Producer публикует в exchange.                                                            |
| rabbitmq-as-bus                      | Default exchange                       | Безымянный direct-exchange, к которому каждая очередь привязана по имени.                                              |
| rabbitmq-as-bus                      | Topic exchange                         | Exchange, который матчит routing-key по шаблонам (`*`, `#`).                                                            |
| rabbitmq-as-bus                      | Queue                                  | Очередь сообщений; FIFO с возможными приоритетами.                                                                    |
| rabbitmq-as-bus                      | Durable queue                          | Очередь, переживающая рестарт брокера. У трёх очередей проекта `durable: true`.                                          |
| rabbitmq-as-bus                      | `RABBITMQ_URL`                         | Connection string `amqp://user:pass@host:port`. Joi-валидируется при boot'е.                                            |
| rabbitmq-as-bus                      | `Transport.RMQ`                        | Идентификатор RMQ-транспорта в `@nestjs/microservices`.                                                                |
| rabbitmq-as-bus                      | `RmqOptions`                           | Тип-конфиг RMQ-transport'а.                                                                                            |
| rabbitmq-as-bus                      | `MicroserviceQueueEnum`                | Enum имён очередей в `libs/contracts/microservices`.                                                                  |
| rabbitmq-as-bus                      | `EXCHANGES`                            | Frozen `as const` объект имён exchange'ей. Зарезервирован под topic-routing.                                            |
| rabbitmq-as-bus                      | `noAck`                                | Опция RMQ-транспорта. `false` — handler ack'ает явно.                                                                  |
| rabbitmq-as-bus                      | At-least-once                          | Гарантия доставки: сообщение придёт хотя бы один раз (возможны дубликаты).                                              |
| rabbitmq-as-bus                      | Transactional outbox                   | Паттерн «событие в той же транзакции с состоянием». В проекте сегодня нет.                                              |
| rabbitmq-as-bus                      | `ICorrelationPayload`                  | Интерфейс `{ correlationId: string }`; каждый wire-payload его extends.                                                |
| rabbitmq-as-bus                      | `traceparent`                          | Заголовок W3C trace context. Пробрасывается через AMQP message properties.                                              |
| nest-microservices-transport         | `@nestjs/microservices`                | Официальная NestJS-обёртка вокруг чужих транспортов (TCP, RMQ, NATS, gRPC, Kafka).                                       |
| nest-microservices-transport         | `MicroserviceOptions`                  | Union опций конкретного транспорта.                                                                                    |
| nest-microservices-transport         | `NestFactory.createMicroservice`       | Фабрика consumer-приложения NestJS; не открывает HTTP.                                                                  |
| nest-microservices-transport         | `ClientProxy`                          | Producer-абстракция `@nestjs/microservices`. Методы: `send`, `emit`.                                                    |
| nest-microservices-transport         | `ClientsModule.registerAsync`          | NestJS-модуль, регистрирующий `ClientProxy` по асинхронной конфигурации.                                                 |
| nest-microservices-transport         | `ClientProxyFactory.create`            | Низкоуровневая фабрика `ClientProxy` без DI. Используется в `RabbitmqClientFactory`.                                    |
| nest-microservices-transport         | `ClientsProviderAsyncOptions`          | Тип одного элемента в `registerAsync([…])`.                                                                            |
| nest-microservices-transport         | Cold Observable                        | rxjs-Observable, у которого работа начинается только после `.subscribe()`.                                              |
| nest-microservices-transport         | `firstValueFrom`                       | rxjs-функция; подписывается на Observable и резолвит Promise первым значением.                                          |
| nest-microservices-transport         | `@MessagePattern`                      | NestJS-декоратор. Помечает метод как RPC-handler.                                                                       |
| nest-microservices-transport         | `@EventPattern`                        | NestJS-декоратор. Помечает метод как event-handler.                                                                     |
| nest-microservices-transport         | `@Payload`                             | NestJS-декоратор. Инжектит body сообщения в параметр handler'а.                                                          |
| nest-microservices-transport         | `amqplib`                              | Низкоуровневый AMQP-клиент для Node.js.                                                                                |
| nest-microservices-transport         | `amqp-connection-manager`              | Reconnect-обёртка вокруг `amqplib`.                                                                                    |
| nest-microservices-transport         | `MicroserviceClientTokenEnum`          | Enum DI-токенов под `ClientProxy`.                                                                                      |
| message-vs-event-patterns            | RPC                                    | Remote Procedure Call; producer ждёт типизированный ответ.                                                              |
| message-vs-event-patterns            | Request/response                       | Стиль «запрос → ответ»; синоним RPC в этой шине.                                                                       |
| message-vs-event-patterns            | Event                                  | Уведомление о факте; ответа не ждут.                                                                                  |
| message-vs-event-patterns            | Fire-and-forget                        | Стиль публикации без ожидания ответа.                                                                                  |
| message-vs-event-patterns            | Fan-out                                | Доставка одного события нескольким consumer'ам.                                                                       |
| message-vs-event-patterns            | `ClientProxy.send`                     | Producer-метод для RPC; cold Observable от reply-очереди.                                                              |
| message-vs-event-patterns            | `ClientProxy.emit`                     | Producer-метод для события; cold Observable broker-ack'а.                                                              |
| message-vs-event-patterns            | Reply-очередь                          | Auto-named очередь под `send`-ответы.                                                                                  |
| message-vs-event-patterns            | `replyTo`                              | AMQP-property с именем reply-очереди.                                                                                  |
| message-vs-event-patterns            | `RpcException`                         | NestJS-класс ошибок из RPC-handler'а.                                                                                  |
| message-vs-event-patterns            | Post-commit publish                    | Публикация события **после** успешной фиксации состояния.                                                              |
| message-vs-event-patterns            | Best-effort delivery                   | Доставка «как сможем»; событие может быть потеряно при падении consumer'а.                                              |
| routing-keys-and-contracts           | Routing key                            | Строковый идентификатор сообщения в AMQP; в проекте — `<service>.<aggregate>.<action>`.                                  |
| routing-keys-and-contracts           | `ROUTING_KEYS`                         | Frozen `as const`-объект в `libs/messaging` с routing-key константами.                                                  |
| routing-keys-and-contracts           | `MicroserviceMessagePatternEnum`       | TypeScript-enum в `libs/contracts/microservices` с теми же значениями.                                                  |
| routing-keys-and-contracts           | Wire format                            | Внешнее представление сообщения: routing key + JSON-payload.                                                            |
| routing-keys-and-contracts           | Wire payload                           | TS-интерфейс из `libs/contracts/{retail,inventory}/`.                                                                  |
| routing-keys-and-contracts           | `correlationId`                        | UUID-подобный идентификатор бизнес-flow'а, ставит gateway-middleware.                                                  |
| routing-keys-and-contracts           | Source of truth                        | Каноничный источник значения. Для routing-key'ев — `ROUTING_KEYS` + enum, синхронизированный spec'ом.                  |
| routing-keys-and-contracts           | `as const`                             | TypeScript-конструкция, фиксирующая литералы как самые узкие типы.                                                     |
| routing-keys-and-contracts           | Domain event                           | In-process событие агрегата (`OrderCreatedEvent`); наследник `DomainEvent<TId>` из `libs/ddd`.                          |
| routing-keys-and-contracts           | Wire event                             | Plain JSON-форма события для AMQP (`IRetailOrderCreatedEvent`).                                                        |
| routing-keys-and-contracts           | Compile-time contract                  | Кросс-сервисный контракт через TypeScript: оба конца импортируют один тип.                                              |

Approximately **48 new pairs** introduced. Many duplicate
concept-group, project-shape and persistence glossary terms
(`ICorrelationPayload` appears twice, `traceparent` repeats);
task-12 will dedupe.

## Cross-references added

### Within `messaging/` (peer links)

- `rabbitmq-as-bus` → `[[nest-microservices-transport]]`, `[[message-vs-event-patterns]]`, `[[routing-keys-and-contracts]]`
- `nest-microservices-transport` → `[[rabbitmq-as-bus]]`, `[[message-vs-event-patterns]]`, `[[routing-keys-and-contracts]]`
- `message-vs-event-patterns` → `[[rabbitmq-as-bus]]`, `[[nest-microservices-transport]]`, `[[routing-keys-and-contracts]]`
- `routing-keys-and-contracts` → `[[rabbitmq-as-bus]]`, `[[nest-microservices-transport]]`, `[[message-vs-event-patterns]]`

Every article links to every peer; reciprocal cross-linking is
maintained.

### Back to `concepts/`, `project-shape/`, `persistence/` (per task-05 step 5)

- `rabbitmq-as-bus` → `[[microservices-split]]`, `[[api-gateway-pattern]]`, `[[shared-libs-philosophy]]`
- `nest-microservices-transport` → `[[hexagonal-architecture]]`, `[[module-boundaries]]`, `[[api-gateway-pattern]]`, `[[mappers-and-repositories]]`
- `message-vs-event-patterns` → `[[hexagonal-architecture]]`, `[[api-gateway-pattern]]`, `[[microservices-split]]`
- `routing-keys-and-contracts` → `[[hexagonal-architecture]]`, `[[module-boundaries]]`, `[[shared-libs-philosophy]]`

All four required `concepts/` / `project-shape/` back-links from
task-05 step 5 are present:
`[[api-gateway-pattern]]` × 3, `[[hexagonal-architecture]]` × 3,
`[[module-boundaries]]` × 2.

### Forward links into other groups

- `rabbitmq-as-bus` → `[[trace-log-correlation]]` (observability),
  on the `traceparent` paragraph.
- `routing-keys-and-contracts` → `[[trace-log-correlation]]`
  (observability), as required by task-05 step 5.

Both forward-links go to the **observability** group; the
`trace-log-correlation` article is a stub today and will be
filled by a later task. The links are intentionally cited so
the back-pointer from `trace-log-correlation` (when written)
can land without re-discovering messaging context.

No forward links into `caching/` or `auth/` were added — those
groups don't need to be referenced from messaging at this
phase; they'll back-link in their own tasks.

## Verification results

- [x] All four slot files filled; no `заглушка` callouts remain
      (verified by `grep -l 'заглушка\|Заглушка' docs/architecture-migration-ru/messaging/*.md` → 0 hits).
- [x] Every code excerpt has a GitHub permalink pinned to
      `84b1507c68fd9ee02b185eef3c4594b6fe02f664`
      (**39 permalinks total**: 12 + 11 + 9 + 7).
- [x] All cited line ranges validated against `wc -l` of the
      file at the recorded SHA; nine off-by-one ranges (typically
      `L1-LN+1` where the last newline-less line was N) were
      corrected to `L1-LN` before this carryover was written. No
      invented line numbers remain.
- [x] Every `[[wiki-link]]` resolves to a file that exists under
      `docs/architecture-migration-ru/` (verified by enumerating
      all unique link occurrences:
      `api-gateway-pattern`, `hexagonal-architecture`,
      `mappers-and-repositories`, `message-vs-event-patterns`,
      `microservices-split`, `module-boundaries`,
      `nest-microservices-transport`, `rabbitmq-as-bus`,
      `routing-keys-and-contracts`, `shared-libs-philosophy`,
      `trace-log-correlation` — and matching against
      `find docs/architecture-migration-ru -name '*.md'`).
- [x] No orphans under `docs/architecture-migration-ru/` — the
      root file's `### messaging/` section already links every
      stub from task-01 to all four articles (verified
      `grep -n "messaging" architecture-migration-guide.md` →
      lines 117–120). Plus reciprocal peer-links inside the
      messaging group + back-links to `concepts/`,
      `project-shape/`, `persistence/`.
- [x] Each article well above 600 words (smallest:
      `nest-microservices-transport.md` at **2098 слов**;
      largest: `message-vs-event-patterns.md` at **2361 слов**).
      All articles match the per-article guidance in task-05
      (the brief suggested ~2000 for `rabbitmq-as-bus`, ~1500
      for the others; all four overshot slightly because the
      code surface area justified more grounding).
- [x] Frontmatter valid on each touched file (`status: review`,
      `updated: 2026-05-16`, `related: [...]` populated with
      4–6 wiki-link entries).
- [x] Each article carries the mandatory `> [!abstract] Кратко`
      callout, `## Глоссарий` section, and `> [!faq]- Проверь
      себя` self-check block (5 questions per article).
- [x] `ICorrelationPayload` is mentioned (per task-05 step 4)
      in `routing-keys-and-contracts.md` (full coverage section)
      and additionally surfaced in `rabbitmq-as-bus.md` so the
      reader meets the concept first there. Forward-link to
      `[[trace-log-correlation]]` lands in both files, as
      required.
- [x] No `git` mutating commands were run during this session.

## Suggested adjustments to upcoming tasks

1. **The `trace-log-correlation` forward-link is doubled.** Both
   `rabbitmq-as-bus.md` and `routing-keys-and-contracts.md`
   forward-link to `[[trace-log-correlation]]` on the
   `traceparent` paragraph. When that article is written
   (task-09 observability per task-01's draft list), it should
   back-link to both — and re-cite the `correlationId` vs
   `traceparent` separation, which is the core mental model
   the messaging group set up. The "wire-format = payload +
   amqp-properties" framing is owned by
   `[[routing-keys-and-contracts]]`; the trace-correlation
   article should focus on **how** OTel auto-instrumentation
   does the injection and **where** Pino picks up the active
   span.

2. **`mappers-and-repositories` is now load-bearing for two
   patterns.** The `{ provide: SYMBOL, useExisting: Class }`
   DI-binding trick lived in
   `[[mappers-and-repositories]]` §"DI-binding в module". This
   group cites it from `[[nest-microservices-transport]]`
   (orders.module.ts walk-through). When task-08 writes
   `caching/cache-aside-pattern.md` and needs to show the
   `STOCK_CACHE` port wired to `StockCache`, it should also
   forward-link there rather than re-deriving the pattern.

3. **The `confirmedOrderProductIds = await
   this.inventoryGateway.reserveOrderStock(...)` excerpt in
   `[[message-vs-event-patterns]]` is the canonical place for
   the "RPC-chain through a port" pattern.** When task-10
   writes `application-layer/use-cases-vs-fat-services.md`,
   the cross-service RPC port story should refer back here
   rather than re-deriving why the inventory side is behind
   `IInventoryConfirmGatewayPort`. The application-layer
   article can then focus on the use-case's own structure (try/
   catch around the RPC, control-flow with `applyInventoryConfirmation`),
   which is a different concern.

4. **No new ADRs were necessary** during this writing session.
   The four articles document conventions already shipped
   (ADR-008, ADR-009, ADR-011, ADR-012, ADR-013, ADR-020). No
   architectural decisions were taken here.

5. **The `noAck` discussion in `[[rabbitmq-as-bus]]` is a thin
   summary**; the article cites it but doesn't dive into DLX
   strategy because there isn't one in the project yet. When
   `quality/test-strategy.md` is written, it can pick up the
   thread for retry / poison-message handling — the messaging
   group sets up the vocabulary without committing to a
   policy.

6. **`docker-compose.yml` is cited twice** (the rabbitmq
   service block and one env-var line). This is the only place
   in the guide so far that anchors a non-`apps/` non-`libs/`
   file. If the docs audit (task-12) prefers to keep the
   permalink set to `apps/` + `libs/` only, the rabbitmq block
   can be substituted with a description, and the env-var line
   can be dropped in favour of citing only the Joi schema. The
   compose excerpt is genuinely informative as it stands,
   though — leaving it for now.

7. **The `_carryover-07 §5 #3` reference in the
   `OrderRabbitmqPublisher` excerpt is preserved verbatim in
   the in-file comment** (it's source code, not the
   article). If a reader follows the comment trail looking for
   `_carryover-07.md`, they end up in
   `docs/architecture-migration-plan/tasks/_carryover-07.md`
   (the migration carryover, not this guide's carryover). That
   is the correct target and predates this guide. No action
   needed; this is documentation-of-documentation.

8. **The wire-event vs domain-event distinction is now anchored
   in three articles**: `[[entity-vs-domain-model]]` mentions
   `DomainEvent<TId>` for in-process events;
   `[[mappers-and-repositories]]` describes the mapper as a
   boundary; this group's `[[routing-keys-and-contracts]]`
   anchors the wire-event side and the publisher-as-mapper
   pattern. When task-10 writes
   `application-layer/notifier-port-and-adapters.md`, the
   notification-side mapping (consumer accepts wire payload →
   builds domain `Notification` VO → invokes notifier port)
   should not re-derive the distinction; link back to
   `[[routing-keys-and-contracts]]` and focus on the
   notifier port surface itself.
