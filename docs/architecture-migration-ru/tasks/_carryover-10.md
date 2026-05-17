# _carryover-10.md — Write application-layer articles (Phase: application-layer/)

> Generated 2026-05-17 by the task-10 session of the **architecture
> migration guide** writing flow. Builds on `_carryover-09.md` (which
> built on `_carryover-08.md` → … → `_carryover-01.md`, source of the
> SHA pin `84b1507c68fd9ee02b185eef3c4594b6fe02f664`).

## Entry-gate result

`_carryover-09.md` was read in full first. The eight observability
lib-articles it produced are on `status: review`; this task does not
add or change any forward-link from them. Branch is
`migration-guide`; working tree was clean at session start and no
`git` mutating command was executed during the session. No code
under `apps/` or `libs/` was modified.

The `_carryover-09.md` deferred follow-up (the
`OTEL_SDK_DISABLED=true` test-context explanation belongs in
`[[test-strategy]]`) is preserved for task-11 to honour — task-10
did not touch `quality/`.

`_carryover-09.md` §«Suggested adjustments» #8 (forward-links from
observability/ into application-layer/ are now possible) is **not**
exercised in this task. The three application-layer articles do not
cite any `[[lib-opentelemetry-*]]`; the path from
`@Inject(NOTIFIER)` to `trace.getActiveSpan()` is implicit and
covered by `[[trace-log-correlation]]` from the observability
group. Adding such a link would have been ceremonial, not load-
bearing.

## Articles written

Three application-layer articles, each reshaped from the task-01
stub into a stand-alone Russian-language article grounded in
production code at the recorded SHA.

| Path | One-line Russian summary |
| ---- | ------------------------ |
| `docs/architecture-migration-ru/application-layer/use-cases-vs-fat-services.md` | Use-case как один класс на write/read-сценарий; инжектит только порты, не `Repository<X>` / `ClientProxy` / `Cache`. Before/after: легаси `OrderConfirmService` (5 зависимостей, 5 обязанностей) → `ConfirmOrderUseCase` (3 порта + Pino, state-transition в агрегате). Inventory `ReserveStockForOrderUseCase` — тот же шаблон. Документирован известный exception `ARCH-LINT-EX-01` (`EntityManager` инжектится напрямую). — ~2557 слов. |
| `docs/architecture-migration-ru/application-layer/dto-by-direction.md` | Пять (плюс один) суффиксов: `*.request.dto.ts` / `*.response.dto.ts` (presentation), `*.command.ts` / `*.query.ts` / `*.view.ts` (application), `*.event.ts` (wire-format cross-service events). Анти-паттерн «один DTO на всё»: HTTP + RPC + persistence + event одним классом. Конкретные examples: `OrderCreateDto` + `OrderCreateResponseDto`, `IOrderCreatePayload extends ICorrelationPayload, OrderCreateDto`, `ILoginCommand` + `LoginRequestDto`, `IRetailOrderCreatedEvent`. Зафиксирован gap: `*.view.ts` сегодня не материализованы; `*.types.ts` — легаси-имя для query. — ~2615 слов. |
| `docs/architecture-migration-ru/application-layer/notifier-port-and-adapters.md` | Notification-микросервис как канонический per-module template. `INotifierPort` + `NOTIFIER` symbol; `LogNotifierAdapter` как default через `useExisting`; Email/Webhook — TODO-scaffold'ы с `throw 'not implemented'`. RMQ-consumer'ы в `infrastructure/consumers/`, а не `presentation/` (ADR-011 §4). Inventory `stock` и retail `orders` копируют ту же трёхпортовую форму. Объясняется, что `INotifierPort` НЕ делает (нет batch, retry, idempotency на уровне порта). — ~2798 слов. |

All three articles flipped `status: draft` → `status: review` in
their frontmatter; `updated:` set to `2026-05-17`. Each carries the
mandatory `> [!abstract] Кратко` block, `## Глоссарий` section,
`> [!faq]- Проверь себя` collapsible (5 questions each), and
`## Что почитать дальше` with 3–5 external references. No
per-article `## Что этот пакет НЕ делает` (that pattern is for
lib-articles); the equivalent here is the `## Что …` block named
appropriately per-article — `notifier-port-and-adapters.md`
carries a `### Что INotifierPort НЕ делает` subsection (4
bullets: batching, retry/backoff, idempotency, delivery-result).

## GitHub permalinks pinned

Across the three articles: **45 permalink citations / 41 unique URLs**
pinned to `84b1507c68fd9ee02b185eef3c4594b6fe02f664`. The
in-article count (45) is higher than the unique URL count (41)
because four URLs are cited by two different articles each —
notably ADR-011 (cited in `dto-by-direction.md` and
`notifier-port-and-adapters.md`), ADR-012 and ADR-013 (each cited
in `use-cases-vs-fat-services.md` and
`notifier-port-and-adapters.md`), and
`recommendation.md` §5 (cited in `dto-by-direction.md` and
`use-cases-vs-fat-services.md`). Counts:

| Article | Citations |
|---------|-----------|
| `use-cases-vs-fat-services.md` | 12 |
| `dto-by-direction.md` | 16 |
| `notifier-port-and-adapters.md` | 17 |

Code anchors cited (deduped):

- **ADR documents (5)** — ADR-004, ADR-011, ADR-012, ADR-013,
  ADR-017, ADR-018. ADR-011 cited twice (once per
  `notifier-port-*` and once per `dto-by-direction`).
- **`recommendation.md` sections** — §3 (L221-L240), §3+§4+§5
  (L221-L289), §4 (L241-L273, L250-L255), §5 (L274-L289).
- **`_carryover-11.md`** of the migration plan — cited once in
  `use-cases-vs-fat-services.md` to explain why `@Cacheable`
  decorator has no consumer today.
- **`apps/notification-microservice/.../`** (8 files) — every
  file in the notifications module from `domain/notification.model.ts`
  through `infrastructure/notifications.module.ts`.
- **`apps/retail-microservice/.../orders/`** (3 files) —
  `confirm-order.use-case.ts`,
  `application/ports/order.repository.port.ts`,
  `application/ports/inventory-confirm.gateway.port.ts`.
- **`apps/inventory-microservice/.../stock/`** (4 files) —
  `reserve-stock-for-order.use-case.ts` (cited twice with
  different line ranges: L1-L7 for the audit-comment header,
  L28-L187 for the use-case body), `get-stock.use-case.ts`,
  `stock.repository.port.ts`,
  `stock-events.publisher.port.ts`.
- **`apps/api-gateway/.../auth/`** (3 files) —
  `application/dto/login.command.ts`,
  `application/dto/refresh.command.ts`,
  `presentation/dto/login.request.dto.ts`.
- **`libs/contracts/retail/`** (5 files) — `order-create.dto.ts`,
  `order-create-response.dto.ts`,
  `order-confirm-response.dto.ts`,
  `interfaces/order-create.interface.ts`,
  `events/order-created.event.ts`.
- **`libs/contracts/inventory/`** (3 files) —
  `product-stock-get.types.ts`,
  `product-stock-get.response.dto.ts`,
  `events/stock-low.event.ts`.

Each cited line range was validated against the file's `wc -l` at
the recorded SHA. The one initial mismatch — `recommendation.md`
L255-L256 (range straddled the convention list and a sibling
sub-bullet about domain events) — was corrected to L250-L255 in a
post-write patch, which now covers the whole DTO-suffix list
without spilling into adjacent content. No other off-by-one
corrections were required.

## Word counts

| Article | Suggested | Actual |
|---------|-----------|--------|
| `use-cases-vs-fat-services.md` | ~2000 | **2557** |
| `dto-by-direction.md` | ~1500 | **2615** |
| `notifier-port-and-adapters.md` | ~1800 | **2798** |
| **Total** | **~5300** | **7970** |

Same overshoot pattern as in the preceding clarification groups:
`_carryover-09.md` §«Word counts» recorded 930–1316 words against
a 700–1000 target, and the auth group similarly ran ~30% over.
Here three things compound the overshoot:

1. **Code-anchor density.** Each article carries 12–17 unique
   permalinks; most reference a code excerpt and add 100–200 words
   of commentary around it. `dto-by-direction.md` quotes seven
   complete DTO/interface files (each ≤30 lines, but with framing
   text).
2. **The glossary + self-check + «что почитать дальше» tail is a
   constant ~400-word overhead** regardless of body length, so
   smaller articles overshoot by a larger relative margin.
3. **Russian-language verbosity.** Russian-language technical text
   runs ~10-15% longer than English equivalents for the same idea
   count; this is consistent with the corpus-wide pattern (every
   prior task carryover §«Word counts» records this trend).

`dto-by-direction.md` is the largest relative overshoot (74% over
target). The five-suffix convention has enough corner cases —
legacy `*.dto.ts` files retaining their old names, `*.types.ts`
legacy for query, the un-materialized `*.view.ts` slot, and the
sixth `*.event.ts` suffix that `recommendation.md` §4 does not
list — that the article walks each in turn rather than glossing
over the deltas. Cutting any of those walks would have left a
reader who hits one of the un-canonical files unable to tell what
went wrong.

## Audit status

No new audit items opened by this session.

**`ARCH-LINT-EX-01`** is now triple-documented:

1. ADR-017 §6 — the original record.
2. `_carryover-12.md` of the migration plan — operational record.
3. `use-cases-vs-fat-services.md` (this task) — reader-facing
   explanation with the closure path (`ITransactionPort`).

Cross-link is reciprocal: the new article cites
ADR-017 directly. Any future task that closes the exception
should retire the explanation block from
`use-cases-vs-fat-services.md` §«Что с `EntityManager` в
`ReserveStockForOrderUseCase`» and update the FAQ §4 question
(which currently exists *because* of the exception).

## Glossary terms collected

EN→RU pairs introduced across the three articles. These get
rolled into the consolidated `glossary.md` in task-12.
**Approximately 60 new pairs** introduced across the group;
substantial overlap with the auth and observability groups (e.g.
«DI symbol», «port», «adapter» appear in all three corner of the
guide).

Key new terms (not yet defined elsewhere):

| Source article | EN term | RU explanation (short) |
| -------------- | ------- | ---------------------- |
| use-cases-vs-fat-services | Use-case | Класс одного write/read-сценария; инжектит порты. |
| use-cases-vs-fat-services | Application service (DDD) | Оркестратор; то же, что use-case у нас. |
| use-cases-vs-fat-services | Domain service (DDD) | Бизнес-правило без owning-агрегата; в `domain/`. |
| use-cases-vs-fat-services | Fat service (анти-паттерн) | Класс, инжектящий repo+ClientProxy+cache+logger. |
| use-cases-vs-fat-services | `execute(...)` | Единственный public-метод use-case'а. |
| use-cases-vs-fat-services | Post-commit | Шаг после успешного commit'а транзакции. |
| use-cases-vs-fat-services | Internal-only use-case | Use-case, доступный только из другого use-case'а. |
| use-cases-vs-fat-services | `ITransactionPort` | Будущий unit-of-work порт; закроет `ARCH-LINT-EX-01`. |
| use-cases-vs-fat-services | `ARCH-LINT-EX-01` | Документированный exception в reserve-use-case. |
| use-cases-vs-fat-services | Test-double | In-memory port-реализация для unit-тестов. |
| dto-by-direction | DTO | Шейп для переноса данных между слоями/сервисами. |
| dto-by-direction | Request DTO (`*.request.dto.ts`) | Inbound-класс с `class-validator`-decorator'ами. |
| dto-by-direction | Response DTO (`*.response.dto.ts`) | Outbound-класс с `@ApiResponseProperty`. |
| dto-by-direction | Command (`*.command.ts`) | Plain interface, write-вход application-слоя. |
| dto-by-direction | Query (`*.query.ts`) | Plain interface, read-вход; зарезервированный слот. |
| dto-by-direction | View (`*.view.ts`) | Plain interface/класс, read-projection; зарезервированный слот. |
| dto-by-direction | Event (`*.event.ts`) | Plain interface, wire-формат cross-service-события. |
| dto-by-direction | `@ApiProperty` | Декоратор `@nestjs/swagger` для inbound-полей. |
| dto-by-direction | `@ApiResponseProperty` | Декоратор `@nestjs/swagger` для outbound-полей. |
| dto-by-direction | Wire-формат | Сериализованная форма payload'а в канале (JSON в RMQ). |
| dto-by-direction | Projection | DTO, форма которого не совпадает с агрегатом 1-к-1. |
| dto-by-direction | Reference table | БД-таблица, хранящая enum-значения + поля `name`/`color`. |
| dto-by-direction | Structural subtyping | TypeScript-механика: типы matched по полям, без `implements`. |
| notifier-port-and-adapters | Per-module template | Канонический layout `domain/application/infrastructure/presentation`. |
| notifier-port-and-adapters | Bounded context | DDD-термин для модуля; в проекте 4 контекста. |
| notifier-port-and-adapters | `INotifierPort` | Outbound port; `send(Notification): Promise<void>`. |
| notifier-port-and-adapters | `NOTIFIER` | DI-symbol для `INotifierPort`. |
| notifier-port-and-adapters | ValueObject | DDD: равенство по содержанию, не identity. |
| notifier-port-and-adapters | AggregateRoot | DDD: transactional unit с identity и lifecycle. |
| notifier-port-and-adapters | `useExisting` | Nest-DI: alias на существующий provider. |
| notifier-port-and-adapters | `useClass` | Nest-DI: создаёт новый instance под токеном. |
| notifier-port-and-adapters | `@EventPattern` | Nest-microservices: fan-out, без response. |
| notifier-port-and-adapters | `@MessagePattern` | Nest-microservices: RPC, типизированный response. |
| notifier-port-and-adapters | Fan-out | Pub-sub: 1 publish, N subscribers, каждый свою копию. |
| notifier-port-and-adapters | At-least-once | RMQ-гарантия: доставка хотя бы раз; нужна дедупликация. |
| notifier-port-and-adapters | RMQ-only | Сервис без HTTP-listener'а. |

## Cross-references added

### Within `application-layer/` (sibling links)

Each of the three articles cross-links to the other two
reciprocally:

- `use-cases-vs-fat-services` ↔ `dto-by-direction` ↔
  `notifier-port-and-adapters` — all three reciprocally linked
  via the `related:` frontmatter block AND via inline wiki-links
  in the «Связанные решения» section. Reader landing on any one
  article can navigate to the other two without backtracking.

### Cross-group back-links

All three articles back-link into established groups:

- `[[hexagonal-architecture]]` (concepts/) — referenced by all 3
  articles. The port/adapter mechanic is the substrate.
- `[[clean-architecture-layers]]` (concepts/) — referenced by all
  3 articles. The four-layer split is where use-cases sit.
- `[[module-boundaries]]` (concepts/) — referenced by
  `use-cases-vs-fat-services` and `notifier-port-and-adapters`.
- `[[mappers-and-repositories]]` (persistence/) — referenced by
  all 3 articles. The repository-port pattern is the read/write
  edge.
- `[[entity-vs-domain-model]]` (persistence/) — referenced by
  `dto-by-direction` (DTO ≠ entity) and `notifier-port-and-adapters`
  (Notification VO vs AggregateRoot).
- `[[message-vs-event-patterns]]` (messaging/) — referenced by
  all 3 articles.
- `[[routing-keys-and-contracts]]` (messaging/) — referenced by
  all 3 articles.
- `[[rabbitmq-as-bus]]` (messaging/) — referenced by
  `notifier-port-and-adapters`.
- `[[shared-libs-philosophy]]` (project-shape/) — referenced by
  all 3 articles. `libs/contracts` lives there.

**No forward-links into yet-unwritten articles.** All wiki-link
targets resolve to files that exist under
`docs/architecture-migration-ru/`. The `quality/` (task-11) and
`glossary.md` (task-12) slots are intentionally not yet linked
from these three articles — adding such links would create
forward-orphans, which conflicts with the verification rule.

### Root file's TOC

`docs/architecture-migration-ru/architecture-migration-guide.md`
already lists all three `application-layer/` slugs at L159-L161
(populated by task-01's scaffolding). No edits to the root file
required this session.

## Verification results

- [x] All three slot files filled; no `заглушка` callouts remain
      (verified by
      `grep -l 'заглушка\|Заглушка' docs/architecture-migration-ru/application-layer/*.md`
      → 0 hits).
- [x] Every code excerpt has a GitHub permalink pinned to
      `84b1507c68fd9ee02b185eef3c4594b6fe02f664` (**45 citations
      / 41 unique URLs**: 12 + 16 + 17 per-article).
- [x] Every `[[wiki-link]]` resolves to a file that exists under
      `docs/architecture-migration-ru/` (verified by enumerating
      distinct targets and checking each via `find`):
      - Within `application-layer/`: 3 — all reciprocally
        linked.
      - Cross-group: `[[hexagonal-architecture]]`,
        `[[clean-architecture-layers]]`, `[[module-boundaries]]`,
        `[[mappers-and-repositories]]`,
        `[[entity-vs-domain-model]]`,
        `[[message-vs-event-patterns]]`,
        `[[routing-keys-and-contracts]]`, `[[rabbitmq-as-bus]]`,
        `[[shared-libs-philosophy]]` — all hit existing files.
- [x] No orphan slugs under
      `docs/architecture-migration-ru/application-layer/`.
- [x] Each article above the 600-word soft floor (smallest:
      `use-cases-vs-fat-services.md` at **2557 слов**; largest:
      `notifier-port-and-adapters.md` at **2798 слов**; median
      across the 3 articles is **2615 слов**).
- [x] Frontmatter valid on each touched file (`status: review`,
      `updated: 2026-05-17`, `related: [...]` populated with 8-10
      wiki-link entries each).
- [x] Each article carries the mandatory `> [!abstract] Кратко`
      callout, `## Глоссарий` section, and `> [!faq]- Проверь
      себя` self-check block (5 questions each).
- [x] No `git` mutating commands were run during this session.
- [x] Working tree was clean at session start; only docs-only
      files were touched under
      `docs/architecture-migration-ru/application-layer/`. No
      code under `apps/` or `libs/` was modified.

## Suggested adjustments to upcoming tasks

1. **The application-layer group is now COMPLETE** (3 articles:
   `use-cases-vs-fat-services`, `dto-by-direction`,
   `notifier-port-and-adapters`). All three articles ship at
   `status: review`. Audit time in task-12 will involve
   confirming the «view ≡ response» observation (recorded in
   `dto-by-direction.md`) is still accurate — if any
   `*.view.ts`-file lands between task-10 and task-12, the
   article needs a refresh.

2. **The legacy `*.dto.ts` files in `libs/contracts/retail/dto/`
   (without the `request` suffix) are documented as legacy
   in `dto-by-direction.md`** — the rename to
   `order-create.request.dto.ts` etc. is explicitly out of scope
   here because it would break every consumer of
   `@retail-inventory-system/contracts`. Task-12 audit may flag
   this for a future structural pass; do not propose it as a
   guide-side change.

3. **The `*.view.ts` and `*.query.ts` slots are honestly
   reserved** in the article. Task-12 audit should resist the
   temptation to rename `*.types.ts` files to `*.query.ts` as a
   correction — those files are wire-format types (extend
   `ICorrelationPayload`), and the rename would muddle the
   convention rather than improve it. The article calls this out
   explicitly.

4. **`ARCH-LINT-EX-01` is the only exception currently
   advertised reader-facing.** If it is closed before task-12,
   the article's §«Что с `EntityManager`» subsection and the FAQ
   §4 question both need a follow-up edit (the question's
   correctness depends on the exception still existing). The
   carryover §«Audit status» records the closure path so a
   future writer can find this dependency without re-reading
   ADR-017.

5. **No new audit items were opened, no new ADRs were written.**
   The three articles document conventions already shipped
   (ADR-004, ADR-011, recommendation.md §4-§5). The session is a
   pure docs-shaping pass.

6. **`notifications.module.ts` is cited by `useExisting` vs
   `useClass` distinction** — this is a Nest-DI subtlety that
   surfaced naturally in `notifier-port-and-adapters.md`.
   `[[shared-libs-philosophy]]` may benefit from a one-line
   pointer to this discussion if task-12 audit detects readers
   getting confused. No edit needed today; flag for re-audit.

7. **The «notification microservice as canonical template»
   framing is repeated in three places** now: ADR-011 itself,
   `microservices-split.md` (task-03), and
   `notifier-port-and-adapters.md` (this task). If a fourth
   place needs the framing (e.g. a future blog post on the
   migration), reciprocal links must be added in all three;
   today the framing is consistent across the corpus.

8. **`SendOrderNotificationUseCase` and
   `SendLowStockAlertUseCase` are the only two use cases in the
   notification module today.** Both inject only `NOTIFIER` plus
   `PinoLogger` — the minimal use-case shape. If task-06 had
   added a `UserLoggedIn` event publisher, a third use case
   `send-login-alert.use-case.ts` would exist; the task-07
   carryover records that this was skipped. If it lands later,
   `notifier-port-and-adapters.md` needs a one-paragraph update
   (and a third FAQ-style entry).

9. **Russian-language verbosity tax** is now well-documented
   across three carryovers (07, 08, 09, 10). Future writers
   should expect 30-50% overshoot vs an English-language word
   target. The verification rule «~600 words soft floor unless
   explicitly exempted» is a floor, not a ceiling — articles
   come in well above this number regardless.

10. **Task-11 (`quality/`) gets only 2 articles** —
    `lib-eslint-plugin-boundaries.md` and `test-strategy.md`.
    The latter should honour the deferred follow-up from
    `_carryover-09.md` §«Suggested adjustments» #«the
    `OTEL_SDK_DISABLED=true` test-context»; that deferral is now
    one task closer to home.

11. **Forward-link audit for task-12 (glossary + final pass).**
    The glossary will need to dedupe «port», «adapter», «DI
    symbol», «use case», «aggregate root», «value object»
    between the application-layer articles and earlier groups
    (concepts, observability, auth). Approximate dedupe count:
    20-25 terms appear in 2+ articles.
