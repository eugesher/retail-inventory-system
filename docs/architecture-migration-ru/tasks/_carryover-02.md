# _carryover-02.md — Write foundational concepts (Phase: concepts/)

> Generated 2026-05-15 by the task-02 session of the **architecture
> migration guide** writing flow. Builds on `_carryover-01.md` (HEAD
> SHA `84b1507c68fd9ee02b185eef3c4594b6fe02f664`).

## Entry-gate result

`_carryover-01.md` was read in full. The HEAD SHA recorded there
(`84b1507c68fd9ee02b185eef3c4594b6fe02f664`) is used for every
GitHub permalink in every concept article. The current branch is
`migration-guide`; the working tree at session start is clean, and
`git rev-parse HEAD` now points at the task-01 commit
`41ec4e9` — but article permalinks remain pinned to the
`84b1507` SHA per the task-01 contract.

Build was not re-run for this docs-only task; task-01 recorded the
green build at the same `84b1507` SHA, and this session adds no
code under `apps/` or `libs/`.

## Articles written

Five concept articles. Each was reshaped from the task-01 stub
(frontmatter only + `Заглушка` callout) into a stand-alone
mid-level-NestJS tutorial that grounds every example in the project's
real code.

| Path                                                                       | One-line Russian summary                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/architecture-migration-ru/concepts/hexagonal-architecture.md`        | Гексагональная архитектура (Ports & Adapters): driving/driven-порты, inversion, и реализация на примере `Order` ↔ `IOrderRepositoryPort` ↔ `OrderTypeormRepository`. Anchor — ADR-004. ~2086 слов. |
| `docs/architecture-migration-ru/concepts/domain-driven-design.md`          | Тактический DDD в проекте: `Aggregate`, `Entity`, `Value Object`, `Domain Event`, `Repository`. Примитивы из `libs/ddd`; `Order` и `StockItem` как rich-model примеры. ~2069 слов.               |
| `docs/architecture-migration-ru/concepts/clean-architecture-layers.md`     | Четыре слоя `domain/application/infrastructure/presentation`, dependency rule «внутрь», поток одного вызова `POST /api/order` через все пересечения слоёв. ~1748 слов.                            |
| `docs/architecture-migration-ru/concepts/module-boundaries.md`             | Архитектурные границы как исполняемые правила: element-types, `capture: ['app','module']`, `default: 'disallow'` + правило 0, регрессионный спек, `ARCH-LINT-EX-01`. ~1805 слов.                  |
| `docs/architecture-migration-ru/concepts/architecture-decision-records.md` | Формат Nygard-hybrid, 3-значное паддингование, статусы, когда писать ADR и когда нет, back-fill (ADR-018/019/020), почему ADR-001 без даты. ~1582 слова.                                          |

All five articles flipped `status: draft` → `status: review` in
frontmatter; the `updated:` date is `2026-05-15`. The `related:`
arrays now list the cross-references introduced in this session.

## Glossary terms collected

Pairs of EN→RU terminology introduced in this group. These feed the
consolidated `glossary.md` in the final task. Within each article the
table is replicated locally so the article reads stand-alone.

| Source article                | EN term                          | RU explanation (short)                                                                          |
| ----------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------- |
| hexagonal-architecture        | Port                             | Порт — TypeScript-интерфейс, описывающий, что приложение умеет или что ему нужно.                |
| hexagonal-architecture        | Adapter                          | Адаптер — реализация порта под конкретную технологию.                                            |
| hexagonal-architecture        | Driving port (primary)           | Входящий порт — то, через что мир дёргает приложение.                                            |
| hexagonal-architecture        | Driven port (secondary)          | Исходящий порт — то, через что приложение дёргает мир.                                          |
| hexagonal-architecture        | Dependency inversion             | Инверсия зависимостей — оба слоя зависят от одной абстракции.                                    |
| hexagonal-architecture        | Hexagonal core                   | «Ядро» — domain + application.                                                                   |
| hexagonal-architecture        | Anti-corruption layer            | Слой защиты от чужой модели; у нас роль ACL играет маппер.                                       |
| hexagonal-architecture        | Transaction script               | Анти-паттерн: пошаговый сценарий внутри одного метода use-case'а.                                 |
| domain-driven-design          | Aggregate                        | Аггрегат — группа объектов, меняющихся как одно целое.                                           |
| domain-driven-design          | Aggregate Root                   | Корень аггрегата — единственный объект, к которому разрешено обращаться извне.                   |
| domain-driven-design          | Entity                           | Сущность — объект с идентичностью; равенство по id.                                              |
| domain-driven-design          | Value Object                     | Объект-значение — без идентичности, неизменяемый, равенство по структурному значению.            |
| domain-driven-design          | Invariant                        | Инвариант — правило, нарушение которого делает объект невалидным.                                |
| domain-driven-design          | Rich domain model                | Богатая модель — модель с поведением; противоположность анемичной.                              |
| domain-driven-design          | Domain Event                     | Доменное событие — факт, который произошёл в домене.                                             |
| domain-driven-design          | Pull semantics                   | Pull-модель публикации: aggregate накапливает события, выгружаются по запросу.                  |
| domain-driven-design          | Repository                       | Репозиторий — «коллекция aggregate'ов» с интерфейсом findById/save.                              |
| domain-driven-design          | Reconstitute                     | Восстановление aggregate'а из персистентных данных без событий и инвариант-проверок.            |
| clean-architecture-layers     | Clean Architecture               | Чистая архитектура; направление зависимости — внутрь.                                            |
| clean-architecture-layers     | Dependency Rule                  | Правило зависимости: внешний слой импортирует внутренний, не наоборот.                          |
| clean-architecture-layers     | Domain layer                     | Слой `domain/` — самое внутреннее кольцо.                                                        |
| clean-architecture-layers     | Application layer                | Слой `application/` — use-cases, ports, application-DTO.                                         |
| clean-architecture-layers     | Infrastructure layer             | Слой `infrastructure/` — адаптеры конкретных технологий.                                         |
| clean-architecture-layers     | Presentation layer               | Слой `presentation/` — controllers, pipes, RPC-handlers.                                         |
| clean-architecture-layers     | Composition root                 | Корень композиции — место сборки DI-графа; у нас `<module>.module.ts`.                          |
| module-boundaries             | Architecture lint                | Архитектурный линт — статическая проверка правил импорта (ESLint).                              |
| module-boundaries             | Element type                     | Тип элемента — категория файла в `eslint-plugin-boundaries`.                                     |
| module-boundaries             | Capture                          | Захват — переменные, извлекаемые из пути файла (`app`, `module`).                                |
| module-boundaries             | `default: 'disallow'`            | «По умолчанию запрещено» — каждое ребро должно быть явно разрешено.                              |
| module-boundaries             | Forbidden imports                | Раздел `CLAUDE.md` со словесным дублированием ключевых границ.                                  |
| module-boundaries             | `ARCH-LINT-EX-01`                | Документированное исключение: `EntityManager` в stock-репозитории/use-case.                      |
| module-boundaries             | Regression spec                  | `tests/lint/architecture-lint.spec.ts` — fixture-based защита самого конфига.                   |
| architecture-decision-records | ADR                              | Architecture Decision Record — markdown-документ, фиксирующий одно решение.                      |
| architecture-decision-records | Nygard hybrid format             | Nygard + MADR гибрид: Date, Status, Context, Decision, Alternatives, Consequences.              |
| architecture-decision-records | Slug                             | Kebab-case-описание решения в имени файла; описывает **что** решили.                             |
| architecture-decision-records | Status: Accepted                 | Решение в силе. Большинство наших ADR — Accepted.                                                |
| architecture-decision-records | Status: Superseded by ADR-NNN    | Решение отменено более новым ADR; старый файл не редактируется.                                  |
| architecture-decision-records | Back-fill                        | Написание ADR постфактум для давно существующего решения (у нас — ADR-018/019/020).             |
| architecture-decision-records | Decision atom                    | Атомарность решения — один ADR = одно решение.                                                   |

Approximately **40 unique terms** introduced. The final glossary
(task-12) will merge duplicates between this group and later groups
(`Adapter`, `Port`, `Repository` will likely reappear).

## Cross-references added

### Within `concepts/` (peer links)

- `hexagonal-architecture` ↔ `clean-architecture-layers` (bi-directional)
- `hexagonal-architecture` ↔ `domain-driven-design` (bi-directional)
- `hexagonal-architecture` → `module-boundaries`
- `clean-architecture-layers` → `module-boundaries`
- `module-boundaries` ↔ `clean-architecture-layers`
- `module-boundaries` → `hexagonal-architecture`
- `module-boundaries` → `architecture-decision-records`
- `architecture-decision-records` → `hexagonal-architecture`
- `architecture-decision-records` → `module-boundaries`
- `domain-driven-design` → `clean-architecture-layers`

### Forward links into other groups (out of `concepts/`)

The following `[[wiki-link]]`s now point out of `concepts/` into
articles in other groups. Each target file exists as a stub today;
all will be filled by tasks 03–11.

| From article                  | To article (group)                            | Purpose                                                                  |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| `hexagonal-architecture`      | `[[mappers-and-repositories]]` (persistence/) | Подробности про адаптер-репозиторий и `*.mapper.ts`.                     |
| `hexagonal-architecture`      | `[[entity-vs-domain-model]]` (persistence/)   | Почему `@Entity` живёт только в `infrastructure/persistence/`.            |
| `domain-driven-design`        | `[[entity-vs-domain-model]]` (persistence/)   | Граница TypeORM-entity ↔ domain-модель.                                 |
| `domain-driven-design`        | `[[mappers-and-repositories]]` (persistence/) | Маппер на границе и `ARCH-LINT-EX-01`.                                   |
| `domain-driven-design`        | `[[notifier-port-and-adapters]]` (application-layer/) | Канонический per-module template — notification.                |
| `domain-driven-design`        | `[[microservices-split]]` (project-shape/)    | Один BC на сервис; нет настоящего context-map'а.                         |
| `clean-architecture-layers`   | `[[use-cases-vs-fat-services]]` (application-layer/) | Что класть в use-case, что — нет.                                |
| `clean-architecture-layers`   | `[[dto-by-direction]]` (application-layer/)   | Пять суффиксов DTO и где они живут.                                      |
| `module-boundaries`           | `[[shared-libs-philosophy]]` (project-shape/) | За что отвечает каждая `libs/<name>`.                                    |
| `module-boundaries`           | `[[lib-eslint-plugin-boundaries]]` (quality/) | Детальный разбор плагина.                                                |
| `architecture-decision-records` | `[[shared-libs-philosophy]]` (project-shape/) | ADR-005 определяет таксономию libs.                                   |

11 forward links from `concepts/` to other groups. Every target
resolves to a file that exists today (as a stub); none will become
orphaned by the writing flow.

## Verification results

- [x] Every article slot listed in task-02 is filled (no `заглушка`
      callout remains in any `concepts/*.md` file).
- [x] Every code excerpt has a GitHub permalink pinned to the SHA
      `84b1507c68fd9ee02b185eef3c4594b6fe02f664` (verified by
      `grep -c 'blob/84b1507c…' docs/architecture-migration-ru/concepts/*.md` —
      30 permalinks total across 5 articles).
- [x] Every `[[wiki-link]]` resolves to a file that exists under
      `docs/architecture-migration-ru/` (verified by `find` per slug;
      all 13 distinct targets present).
- [x] No orphans under `docs/architecture-migration-ru/` — the root
      file already linked every stub from task-01; the new content
      doesn't break that, and adds further internal links.
- [x] Each article has the mandatory `> [!abstract] Кратко` block at
      the top (verified by `grep -c`).
- [x] Each article has a `## Глоссарий` section (verified by
      `grep -c`).
- [x] Each article exceeds ~600 words (smallest is
      `architecture-decision-records.md` at **1582 слов**; largest is
      `hexagonal-architecture.md` at **2086 слов**).
- [x] Each article has a self-check `> [!faq]-` collapsible block
      with 5 questions.

## Suggested adjustments to upcoming tasks

1. **The DDD article already covers `pullDomainEvents` end-to-end,
   including the «pull vs push» rationale and the after-commit
   publication contract** (see § «Domain Event»). The
   `application-layer/use-cases-vs-fat-services.md` and the
   `messaging/message-vs-event-patterns.md` articles can lean on this
   instead of re-explaining the mechanism — just link back to
   `[[domain-driven-design]]` § «Domain Event».

2. **`module-boundaries.md` already enumerates `ARCH-LINT-EX-01`** in
   the dedicated «Когда границу нужно ослабить» subsection. The
   `persistence/mappers-and-repositories.md` article (task-04) should
   cite this section rather than re-deriving the exception; it should
   add the **adapter-side** detail (the `EntityManager` parameter on
   port methods) that `module-boundaries.md` deliberately leaves to
   the persistence chapter.

3. **`hexagonal-architecture.md` defined «driving» vs «driven»**.
   `messaging/message-vs-event-patterns.md` can use those terms when
   distinguishing `@MessagePattern` (driving) from
   `@EventPattern` (also driving — incoming side); the
   `IOrderEventsPublisherPort` and `IInventoryConfirmGatewayPort`
   are the «driven» counterparts, which the messaging chapter can
   cross-reference back here.

4. **`clean-architecture-layers.md` traced the end-to-end flow** of
   `POST /api/order` through all four services. Don't repeat it in
   the project-shape group; instead, in
   `project-shape/api-gateway-pattern.md`, focus on **what makes the
   gateway-side** of that flow (auth, pipe, RetailRabbitmqAdapter)
   different from the microservice side. The big-picture walkthrough
   is now «owned» by `clean-architecture-layers.md`.

5. **`architecture-decision-records.md` is short on purpose (~1.5k
   words)**. It does not duplicate ADR-003 — it teaches Russian
   readers what an ADR is and how to read this catalogue. If future
   tasks want to point new contributors at «how to write an ADR for
   the migration», link to ADR-003 directly, not back to this
   concept article.

6. **The notification microservice is referenced as canonical
   per-module template** in two places (the DDD article and the
   layers article). Task-10's `notifier-port-and-adapters.md` article
   should reinforce — not contradict — this framing. If the layout
   has subtly drifted in the notification service since task-01's
   inventory snapshot, surface that in the article rather than in a
   silent retroactive edit to the concept group.

7. **No new ADRs were necessary** during this writing session.
   `architecture-decision-records.md` documents the conventions
   that already shipped (ADR-003); nothing about how-to-write-ADR
   was changed by this task.
