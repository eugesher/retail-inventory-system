# _carryover-04.md — Write persistence articles (Phase: persistence/)

> Generated 2026-05-16 by the task-04 session of the **architecture
> migration guide** writing flow. Builds on `_carryover-03.md` (which
> built on `_carryover-02.md` → `_carryover-01.md`, the source of the
> SHA pin `84b1507c68fd9ee02b185eef3c4594b6fe02f664`).

## Entry-gate result

`_carryover-03.md` was read in full. The four project-shape articles
it produced are all on `status: review` and are now wiki-link
targets from this task's persistence articles (`microservices-split`,
`shared-libs-philosophy` show up most often). The HEAD SHA recorded
in `_carryover-01.md` (`84b1507c68fd9ee02b185eef3c4594b6fe02f664`) is
used for every GitHub permalink in every persistence article.

Build smoke-check: `yarn build` was run at session entry and
completed successfully — all four apps compiled. Working tree was
clean at session start; branch is `migration-guide`. No code under
`apps/` or `libs/` was modified during this docs-only session.

## Articles written

Five persistence articles. Each was reshaped from the task-01 stub
(frontmatter + `Заглушка` callout) into a stand-alone Russian-language
mid-level-NestJS article that grounds every claim in production code.

| Path                                                                                       | One-line Russian summary                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/architecture-migration-ru/persistence/typeorm-overview.md`                           | TypeORM + MySQL как persistence-стек (ADR-019): `DataSource` runtime'ный и CLI'ный, миграции через TypeORM-CLI, `synchronize: false` обязательное правило во всех окружениях, `migration:create/run/revert/show`. ~1767 слов.                                       |
| `docs/architecture-migration-ru/persistence/entity-vs-domain-model.md`                     | TypeORM-`@Entity` vs domain-model. Side-by-side `StockItem` (domain, инварианты, framework-free) vs `ProductStock` (entity, `@Entity`, public mutable). Та же пара для `Order`. Honest callout `ARCH-LINT-EX-01`. ~1925 слов.                                       |
| `docs/architecture-migration-ru/persistence/mappers-and-repositories.md`                   | Mapper (boundary entity ↔ domain) + Repository port (контракт в терминах домена) + Adapter (единственное место `Repository<TEntity>`). Полный walkthrough на retail orders (port/adapter/mapper/module/use case). Подробный разбор `ARCH-LINT-EX-01` в port'е stock'а. ~1910 слов. |
| `docs/architecture-migration-ru/persistence/base-entity-and-base-repository.md`            | Три load-bearing-абстракции `libs/database`: `BaseEntity` (id + timestamp'ы + soft-delete), `BaseTypeormRepository<TEntity, TDomain>` (mapper-aware), `DatabaseModule.forRoot/forFeature`. Anchor — ADR-005 §3. ~1334 слов.                                          |
| `docs/architecture-migration-ru/persistence/snake-naming-strategy.md`                      | camelCase в TS ↔ snake_case в MySQL. Тонкий re-export из `typeorm-naming-strategies` в `libs/database`. Сравнение с антипаттерном `@Column({ name: 'product_id' })`. ~949 слов.                                                                                  |

All five articles flipped `status: draft` → `status: review` in
their frontmatter; `updated:` set to `2026-05-16`. Each carries the
mandatory `> [!abstract] Кратко` block, `## Глоссарий` section, and
`> [!faq]- Проверь себя` collapsible (3–5 questions per article).

Across the five articles: **26 GitHub permalinks** pinned to
`84b1507c68fd9ee02b185eef3c4594b6fe02f664` (6 + 5 + 6 + 6 + 3 = 26).
Code anchors include all the files suggested by task-04 step 3 plus
a few that helped tell the story:

- `libs/database/{base.entity,base-typeorm.repository,database.module,snake-naming.strategy,index}.ts` — every file in the lib.
- `migrations/config/data-source.ts`, `migrations/1772600000000-InitStarterEntities.ts`, `migrations/1774134626155-AddOrderProductIdToProductStock.ts`.
- `package.json` (migration:* scripts + test:infra scripts).
- `apps/inventory-microservice/src/modules/stock/domain/stock-item.model.ts` (the pure-domain class).
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product-stock.entity.ts` (the TypeORM entity).
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-typeorm.repository.ts` (the adapter using `BaseTypeormRepository`).
- `apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts` (the documented `ARCH-LINT-EX-01` exception).
- `apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts` (the clean retail port).
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/{order.entity,order.mapper,order-typeorm.repository}.ts` (the retail entity/mapper/adapter triplet).
- `apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts` (DI wiring).
- `apps/retail-microservice/src/modules/orders/application/use-cases/create-order.use-case.ts` (use case consuming the port via DI symbol).
- `apps/retail-microservice/src/modules/orders/domain/order.model.ts` (the `AggregateRoot<number | null>` aggregate).

## Glossary terms collected

EN→RU pairs introduced across the five articles. These get rolled
into the consolidated `glossary.md` in task-12.

| Source article                       | EN term                       | RU explanation (short)                                                                                                |
| ------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| typeorm-overview                     | ORM                           | Object-Relational Mapper — слой, преобразующий строки таблиц в объекты языка.                                          |
| typeorm-overview                     | TypeORM                       | ORM для TypeScript/Node.js; основной выбор проекта (ADR-019).                                                          |
| typeorm-overview                     | `DataSource`                  | Главный объект TypeORM: одна точка подключения к одной БД.                                                              |
| typeorm-overview                     | `EntityManager`               | Контекст для CRUD-операций внутри `DataSource`; ключ к транзакциям.                                                     |
| typeorm-overview                     | `QueryRunner`                 | Низкоуровневый исполнитель сырого SQL; на нём работают миграции.                                                        |
| typeorm-overview                     | `QueryBuilder`                | Программируемый builder произвольных SQL-запросов с join'ами и lock'ами.                                                |
| typeorm-overview                     | Driver                        | Низкоуровневый клиент СУБД; здесь — `mysql2`.                                                                            |
| typeorm-overview                     | `mysql2`                      | Promise-based MySQL-клиент для Node.js. Используется TypeORM'ом при `type: 'mysql'`.                                    |
| typeorm-overview                     | `DATABASE_URL`                | Connection-string в формате `mysql://user:pass@host:port/db`. Joi-валидируется при boot и при CLI-запуске миграций.    |
| typeorm-overview                     | Migration                     | Timestamp'ованный TS-файл с парой `up`/`down`-методов; единственный канал изменения схемы.                              |
| typeorm-overview                     | `synchronize`                 | Опция TypeORM «синхронизируй схему при старте». Запрещена. Только миграции.                                              |
| typeorm-overview                     | `MigrationInterface`          | Тип-интерфейс TypeORM для миграции. Требует `up(qr)` и `down(qr)`.                                                       |
| typeorm-overview                     | Seed                          | Тестовые данные, вставляемые в already-migrated схему.                                                                  |
| entity-vs-domain-model               | Entity (TypeORM)              | POJO с декораторами, описывающий ровно одну строку таблицы.                                                            |
| entity-vs-domain-model               | Domain model                  | Класс с инвариантами и поведением, framework-free.                                                                    |
| entity-vs-domain-model               | Invariant                     | Условие, всегда истинное для domain-объекта.                                                                            |
| entity-vs-domain-model               | Ledger                        | Append-only таблица со знаковыми дельтами. `product_stock` — ledger.                                                  |
| entity-vs-domain-model               | `ARCH-LINT-EX-01`             | Documented exception: leaked `EntityManager` в `IStockRepositoryPort`. ADR-017 §6.                                    |
| entity-vs-domain-model               | `AggregateRoot<TId>`          | Базовый класс из `libs/ddd` с `pullDomainEvents()`-методом.                                                            |
| entity-vs-domain-model               | `Entity<TId>`                 | Базовый класс из `libs/ddd` для child-сущностей агрегата.                                                              |
| entity-vs-domain-model               | `ValueObject<TProps>`         | Базовый класс из `libs/ddd` для VO; структурное равенство через `equals`.                                              |
| entity-vs-domain-model               | `DomainEvent<TId>`            | Базовый класс in-process domain-события из `libs/ddd`.                                                                 |
| mappers-and-repositories             | Mapper                        | Класс boundary entity ↔ domain. Static-методы, no state.                                                              |
| mappers-and-repositories             | Repository port               | Интерфейс persistence-контракта в терминах домена.                                                                    |
| mappers-and-repositories             | Repository adapter            | `@Injectable()`-класс, implementing port.                                                                              |
| mappers-and-repositories             | `Repository<TEntity>`         | Низкоуровневый TypeORM-репозиторий.                                                                                    |
| mappers-and-repositories             | Unit of work                  | Транзакционный scope, в котором несколько операций атомарны.                                                          |
| mappers-and-repositories             | DI symbol                     | `Symbol('X_REPOSITORY')` — токен, через который use case инжектит port-implement'а.                                    |
| mappers-and-repositories             | `useExisting`                 | Nest-провайдер «alias»: одна instance видна по двум token'ам.                                                          |
| mappers-and-repositories             | Test double                   | In-memory реализация порта для unit-тестов; не bootstrap'ит TypeORM.                                                  |
| mappers-and-repositories             | `reconstitute(...)`           | Второй factory-метод агрегата — восстановление из persisted state.                                                    |
| base-entity-and-base-repository      | `BaseEntity`                  | Абстрактный родитель всех TypeORM-entity'ев. id + timestamp'ы + soft-delete.                                          |
| base-entity-and-base-repository      | `BaseTypeormRepository`       | Mapper-aware-обёртка над `Repository<TEntity>`; даёт `find`, `save`, `softDelete`.                                      |
| base-entity-and-base-repository      | `DatabaseModule`              | DynamicModule из `libs/database`.                                                                                     |
| base-entity-and-base-repository      | `forRoot`                     | Глобальная регистрация TypeORM `DataSource`. Один вызов в AppModule сервиса.                                          |
| base-entity-and-base-repository      | `forFeature`                  | Per-module регистрация entity для `@InjectRepository`.                                                                |
| base-entity-and-base-repository      | `@PrimaryGeneratedColumn`     | Декоратор auto-increment-PK.                                                                                          |
| base-entity-and-base-repository      | `@CreateDateColumn`           | Декоратор auto-fill `created_at`.                                                                                      |
| base-entity-and-base-repository      | `@UpdateDateColumn`           | Декоратор auto-update `updated_at`.                                                                                    |
| base-entity-and-base-repository      | `@DeleteDateColumn`           | Декоратор soft-delete-маркера.                                                                                          |
| base-entity-and-base-repository      | Soft-delete                   | Логическое удаление: метка времени вместо `DELETE FROM`.                                                              |
| snake-naming-strategy                | Naming strategy               | TypeORM-объект, переводящий имена классов/полей в имена таблиц/колонок при build'е SQL.                                |
| snake-naming-strategy                | `SnakeNamingStrategy`         | Реализация strategy из пакета `typeorm-naming-strategies`. camelCase ↔ snake_case.                                     |
| snake-naming-strategy                | camelCase                     | TypeScript-конвенция.                                                                                                  |
| snake-naming-strategy                | snake_case                    | SQL-конвенция.                                                                                                          |
| snake-naming-strategy                | `@Column({ name })`           | Явное указание имени колонки. Используется, когда strategy не угадывает.                                              |
| snake-naming-strategy                | `typeorm-naming-strategies`   | npm-пакет, в котором живут naming-strategy'и для TypeORM.                                                              |

Approximately **45 new pairs** introduced. Some duplicate the
concept-group or project-shape glossary terms (`AggregateRoot`,
`Entity`, `ValueObject`); task-12 will dedupe.

## Cross-references added

### Within `persistence/` (peer links)

- `typeorm-overview` → `[[entity-vs-domain-model]]`, `[[mappers-and-repositories]]`, `[[base-entity-and-base-repository]]`, `[[snake-naming-strategy]]`
- `entity-vs-domain-model` → `[[typeorm-overview]]`, `[[mappers-and-repositories]]`, `[[base-entity-and-base-repository]]`
- `mappers-and-repositories` → `[[typeorm-overview]]`, `[[entity-vs-domain-model]]`, `[[base-entity-and-base-repository]]`
- `base-entity-and-base-repository` → `[[typeorm-overview]]`, `[[entity-vs-domain-model]]`, `[[mappers-and-repositories]]`, `[[snake-naming-strategy]]`
- `snake-naming-strategy` → `[[typeorm-overview]]`, `[[base-entity-and-base-repository]]`, `[[entity-vs-domain-model]]`

Every article links to most peers; reciprocal cross-linking is
maintained.

### Back to `concepts/` and `project-shape/` (per task-04 step 5)

- `typeorm-overview` → `[[hexagonal-architecture]]`, `[[shared-libs-philosophy]]`
- `entity-vs-domain-model` → `[[hexagonal-architecture]]`, `[[clean-architecture-layers]]`, `[[shared-libs-philosophy]]`
- `mappers-and-repositories` → `[[hexagonal-architecture]]`, `[[clean-architecture-layers]]`, `[[module-boundaries]]`, `[[shared-libs-philosophy]]`
- `base-entity-and-base-repository` → `[[shared-libs-philosophy]]`
- `snake-naming-strategy` → `[[shared-libs-philosophy]]`

All four required `concepts/` / `project-shape/` back-links from
task-04 step 5 are present.

### Forward links into other groups

No forward links into other groups were added in this batch — the
persistence articles are deep-dive references for other groups
(messaging, caching, auth will all link back to
`mappers-and-repositories` and `entity-vs-domain-model`), so the
back-link direction goes the other way. The two notable forward
references the task brief flagged are already covered:

- `microservices-split` from project-shape **already** forward-links
  to `[[mappers-and-repositories]]` ("Мэппер на границе процессов
  — domain-модель не пересекает RMQ"). Verified in
  `_carryover-03.md` §"Forward links into other groups".

This means no orphans were introduced and the persistence group
fits cleanly into the existing graph.

## Verification results

- [x] All five slot files filled; no `заглушка` callouts remain
      (verified by `grep -l 'заглушка\|Заглушка' docs/architecture-migration-ru/persistence/*.md`
      → 0 hits).
- [x] Every code excerpt has a GitHub permalink pinned to
      `84b1507c68fd9ee02b185eef3c4594b6fe02f664` (26 permalinks total: 6 + 5 + 6 + 6 + 3).
- [x] Every `[[wiki-link]]` resolves to a file that exists under
      `docs/architecture-migration-ru/` (verified by enumerating all
      unique link occurrences (`typeorm-overview`,
      `entity-vs-domain-model`, `mappers-and-repositories`,
      `base-entity-and-base-repository`, `snake-naming-strategy`,
      `hexagonal-architecture`, `clean-architecture-layers`,
      `module-boundaries`, `shared-libs-philosophy`) and matching
      against `find docs/architecture-migration-ru -name '*.md'`).
- [x] No orphans under `docs/architecture-migration-ru/` — the root
      file's `### persistence/` section already linked every stub
      from task-01 to all five articles (verified
      `grep -c "\[\[typeorm-overview\]\]\|\[\[entity-vs-domain-model\]\]\|\[\[mappers-and-repositories\]\]\|\[\[base-entity-and-base-repository\]\]\|\[\[snake-naming-strategy\]\]" architecture-migration-guide.md`
      → 5). Plus reciprocal links within persistence + the
      microservices-split forward-link.
- [x] Each article ≥ 600 words (smallest: `snake-naming-strategy.md`
      at **949 слов**; largest: `entity-vs-domain-model.md` at
      **1925 слов**). All articles match the per-article
      guidance from task-04.
- [x] Frontmatter valid on each touched file (`status: review`,
      `updated: 2026-05-16`, `related: [...]` populated).
- [x] Each article carries the mandatory `> [!abstract] Кратко`
      callout, `## Глоссарий` section, and `> [!faq]-` self-check
      block.
- [x] Documented exception `ARCH-LINT-EX-01` called out in
      **both** `entity-vs-domain-model.md` and
      `mappers-and-repositories.md` (per task-04 step 4). The
      `mappers-and-repositories` callout has more depth (port-level
      surface + future `ITransactionPort` solution); the
      `entity-vs-domain-model` callout is the
      single-paragraph aside the brief asks for.
- [x] No `git` mutating commands were run during this session.

## Suggested adjustments to upcoming tasks

1. **The `ARCH-LINT-EX-01` thread runs through three articles already**
   (`entity-vs-domain-model`, `mappers-and-repositories`, and later
   `lib-eslint-plugin-boundaries` from quality). When task-11 writes
   `quality/lib-eslint-plugin-boundaries.md`, it can refer back to
   the full discussion in `[[mappers-and-repositories]]` rather than
   re-deriving the exception — the persistence article now owns
   the "what is this exception and why is the fix non-trivial"
   explanation. The quality article focuses on **how** the
   `eslint-disable-line` + TODO mechanism works.

2. **The `EntityManager.transaction(...)` callback flow is anchored
   in `[[mappers-and-repositories]]` §"Adapter".** When task-08
   writes `caching/cache-aside-pattern.md` and needs to show
   `ReserveStockForOrderUseCase`'s post-commit-await contract, the
   transaction part is already documented — the cache article should
   focus on the cache-invalidation side and forward-link to
   `[[mappers-and-repositories]]` for the unit-of-work shape.

3. **The `useExisting` DI alias pattern is now explained in
   `[[mappers-and-repositories]]` §"DI-binding в module".** Future
   articles (`notifier-port-and-adapters`,
   `use-cases-vs-fat-services`) that show similar
   `{ provide: SYMBOL, useExisting: Class }` lines should not
   re-derive the pattern — link to the persistence article.

4. **`BaseEntity`'s integer-id choice (ADR-005 §3) is documented in
   `[[base-entity-and-base-repository]]`.** When task-06 writes
   `auth/jwt-and-rbac.md` and notes that `UserEntity` uses
   `CHAR(36)` instead (because argon2-derived uid'ы are 36-char
   strings), it should reference the persistence article's
   discussion of why `BaseEntity.id: number` is the default and
   why the user table overrides it — this is the kind of
   asymmetry that surprises readers.

5. **`snake-naming-strategy.md` is the shortest article in the
   group (~949 слов).** This was intentional — the topic is
   genuinely small. If task-12's audit finds that the article reads
   "too thin" for navigation purposes, the right fix is to add a
   second example (e.g. the gateway `auth/user.entity.ts` showing a
   `CHAR(36)`-id with all its snake_case columns), not to inflate
   the existing one with synthetic content.

6. **No new ADRs were necessary** during this writing session. The
   five articles document conventions already shipped (ADR-005,
   ADR-012, ADR-013, ADR-017, ADR-019). No architectural decisions
   were taken here.

7. **`migrations/config/data-source.ts` carries Joi-validation
   inside the CLI bootstrap** — this is a small but interesting
   architectural detail (CLI has its own minimal env-validation,
   not the full `libs/config` Joi-schema). If a future task writes
   `quality/test-strategy.md` or revisits `libs/config`, this is a
   useful counter-example: not every code path needs `ConfigModule`,
   sometimes a 3-line Joi-validate is enough.

8. **The `findOrderResponse` design decision (port returns DTO, not
   domain) is documented in `[[mappers-and-repositories]]`.** This is
   a deliberate departure from the "ports return domain types"
   rule, and the inline justification (avoid double round-trip
   for joined responses) is worth flagging when
   `application-layer/use-cases-vs-fat-services.md` is written.
   Either re-cite the persistence article, or generalize the
   pattern in the use-cases article and link to persistence for
   the canonical example.
