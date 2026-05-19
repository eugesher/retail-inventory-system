# ADR-019: TypeORM + MySQL как стек персистентности

- **Date**: 2026-05-14
- **Status**: Принято

---

## Контекст

retail-inventory-system хранит три независимых среза состояния: агрегат
orders, принадлежащий retail-микросервису (`order`, `order_product`,
`customer`, справочные таблицы `order_status` / `order_product_status`);
агрегат stock, принадлежащий inventory-микросервису (`product`,
`product_stock`, `storage`); и состояние user/auth, принадлежащее
модулю `auth` gateway (`user`). Каждый сервис подключается к MySQL
через единственную env-переменную `DATABASE_URL` и TypeORM `DataSource`.
Миграции живут в `migrations/` и управляются через CLI TypeORM
(`yarn migration:run` / `:revert` / `:create` / `:show`).

Пара TypeORM + MySQL предшествует миграции. Она неявная в каждом ADR
о персистентности до сих пор —
[ADR-002](002-redis-cache-aside-product-stock.md) кеширует TypeORM-
агрегацию `SUM/GROUP BY`,
[ADR-005](005-split-shared-common-into-bounded-libs.md) вводит
библиотеку `libs/database` с `BaseEntity` / `BaseTypeormRepository` /
`SnakeNamingStrategy`, [ADR-010](010-jwt-rbac-at-the-gateway.md)
добавляет таблицу `user` к gateway через
`DatabaseModule.forRoot([UserEntity])`, а
[ADR-012](012-stock-aggregate-and-port-adapter.md) /
[ADR-013](013-order-aggregate-and-cross-service-confirm.md) описывают
TypeORM-backed-адаптеры, реализующие порты репозитория inventory и
retail. Однако ни одно из них не фиксирует, **почему именно TypeORM и
MySQL**, какие альтернативы были взвешены и каковы компромиссы.

Решение значимо, потому что ограничивает рабочий процесс миграций
(CLI TypeORM, а не Prisma migrate, Sqitch, Atlas и т. д.), тестовую
инфраструктуру (`yarn test:infra:up` провижионит контейнер MySQL, а
не Postgres), соглашение об именовании (snake_case-колонки,
отображаемые на camelCase-поля TypeScript через `SnakeNamingStrategy`)
и поверхность гексагонального порта (исключение с утечкой
`EntityManager` `ARCH-LINT-EX-01`, задокументированное в
[ADR-017](017-architecture-lint-via-eslint-boundaries.md) §6,
коренится в форме unit-of-work TypeORM).

---

## Решение

Стек персистентности — это **TypeORM с MySQL** для каждого сервиса,
держащего долговечное состояние.

**Object-relational mapper.** TypeORM, регистрируемый через
`@nestjs/typeorm` на границе приложения. Реализации репозитория
расширяют `BaseTypeormRepository<TEntity, TDomain>` из
`@retail-inventory-system/database` и владеют отображением
сущность ↔ домен; доменный код (агрегаты, value objects)
framework-free и TypeORM-free по разделению ADR-005.

**База данных.** MySQL, доступ через `mysql2`. Строка подключения
читается из env-переменной `DATABASE_URL`; Joi обеспечивает её
наличие на boot через схему модуля конфигурации в `libs/config`. Файл
docker-compose провижионит единый контейнер `mysql`, разделяемый
сегодня всеми тремя срезами персистентности; продакшен может
разделить его позже (одна схема на сервис) без изменения ADR.

**Стратегия именования.** `SnakeNamingStrategy` из
`typeorm-naming-strategies` (ре-экспортируется
`@retail-inventory-system/database`). Каждая сущность объявляет поля
в camelCase (`createdAt`, `productId`, `refreshTokenHash`); стратегия
именования отображает их на `created_at`, `product_id`,
`refresh_token_hash` в MySQL. Соглашение единообразно по каждой
сущности.

**Базовая сущность.** Все долговечные сущности расширяют `BaseEntity`
из `libs/database`. `BaseEntity` несёт автоинкрементный целочисленный
`id` (`@PrimaryGeneratedColumn()`), `createdAt`, `updatedAt` и
nullable `deletedAt` для soft-delete (`@DeleteDateColumn`). Выбор
автоинкрементного целого зафиксирован в ADR-005 §3 — UUID v7 —
будущая возможность, но не несущая сегодня.

**Миграции.** Авторятся вручную в
`migrations/<timestamp>-<slug>.ts` и применяются через CLI TypeORM
(`yarn migration:run`). Синхронизация (`synchronize: true`)
**отключена** в каждом окружении, включая локальный dev. Миграции —
единственный путь, мутирующий схему. Test-seeds живут под
`scripts/seeds/*.sql` и применяются `yarn test:seed` после миграций.

**Подключение модулей.** Приложения потребляют БД через
`DatabaseModule.forRoot(entities)` на уровне AppModule и
`DatabaseModule.forFeature(entities)` per модуль. Фабрика внутри
`DatabaseModule.forRoot` — единственное место, конструирующее
`TypeOrmModuleOptions` из `ConfigService` — приложения никогда не
импортируют `@nestjs/typeorm` напрямую.

**Поверхность репозитория.** Per-aggregate-порты
(`IStockRepositoryPort`, `IOrderRepositoryPort`,
`IUserRepositoryPort`) живут в прикладном слое и TypeORM-free. Их
реализации (`StockTypeormRepository`, `OrderTypeormRepository`,
`UserTypeormRepository`) живут в `infrastructure/persistence/` и
являются единственными файлами, которым разрешено импортировать
`typeorm`, `@nestjs/typeorm` или использовать `InjectRepository`.
Исключение
([ADR-017](017-architecture-lint-via-eslint-boundaries.md) §6,
`ARCH-LINT-EX-01`) — утечка типизации `EntityManager` на порту
репозитория stock — будущий рефакторинг `ITransactionPort` в
task-14 / -15 его закрывает.

---

## Рассмотренные альтернативы

**Prisma.** Отклонено для этого проекта. Эргономика разработчика
Prisma (типизированный query builder, opinionated migration tooling)
превосходна для прямолинейных CRUD-workload, но per-aggregate-
гексагональная модель миграции опирается на TypeORM-специфические
фичи, которые Prisma либо не экспонирует, либо экспонирует совсем
иначе:

- Append-only-журнал `product_stock` использует `SELECT … FOR UPDATE`
  для сериализации параллельных резервирований; `EntityManager.transaction`
  TypeORM + поддержка сырых запросов обрабатывают это напрямую,
  `$queryRaw` Prisma работает, но отключает выгоды типизированного
  клиента, на которых лежит всё value proposition Prisma.
- Кросс-агрегатный cache-aside в ADR-002 / ADR-016 требует, чтобы
  прикладной use case разделял `EntityManager` с
  transaction-scoped-вызовом репозитория; `EntityManager` TypeORM —
  это unit-of-work-примитив, против которого сформирован этот
  паттерн.
- Миграция предпочитает тонкий слой отображения
  (`BaseTypeormRepository` + per-aggregate-mappers), где ORM
  экспонирует SQL-поверхность честно. Клиент Prisma оборачивает
  схему в сгенерированный типизированный API; абстракция выше и её
  сложнее изгибать для низкоуровневых паттернов.

Prisma была бы разумным выбором для greenfield-CRUD-проекта. Этот —
не такой. Переключение позже остаётся возможным (порты репозитория
ORM-агностичны по дизайну), но стоимость переключения растёт со
схемой, поэтому это ADR закрепляет TypeORM как текущее обязательство.

**MikroORM.** Близкий конкурент TypeORM с более сильной моделью
unit-of-work и лучшей историей явного flush. Отклонено, потому что
миграция уже инвестировала в TypeORM через существующие сущности,
базовый класс `BaseEntity` и инструменты миграций. Инкрементальный
выигрыш реален, но не несущий для какого-либо решения, которое
миграция действительно принимает, а стоимость rip-and-replace
затмила бы структурную работу, которую миграция поставляет.

**ObjectionJS / Knex.** Отклонено. ObjectionJS — тонкий слой моделей
поверх query builder'а Knex; это позволило бы кодовой базе писать
SQL вручную и сохранять type safety через объявленные схемы. Компромисс
— больше SQL-работы на репозиторий и значительно меньшее сообщество
по сравнению с TypeORM. У кодовой базы нет необычных потребностей в
запросах, оправдывающих ручную SQL-поверхность, а `QueryBuilder`
TypeORM покрывает случаи, когда декларативного API недостаточно.

**Сырой `mysql2` с handwritten-mappers.** Отклонено. Формы агрегатов
достаточно малы сегодня, чтобы это работало, но отсутствие фреймворка
становится налогом на сопровождение, как только joins, soft-delete,
audit-колонки и migration tooling насаждаются вручную. Каждое другое
ADR в каталоге предполагает ORM как слой, который оборачивает порт
репозитория.

**PostgreSQL вместо MySQL.** Рассмотрено. PostgreSQL имеет более
сильную поддержку JSON, более богатое индексирование и `LISTEN/NOTIFY`
для некоторых классов event-работы. Ни одно из них не несущее в
текущей схеме: агрегаты нормализованы; JSON не используется;
кросс-сервисные уведомления идут через RabbitMQ (ADR-020). MySQL уже
был провижионирован seed-проектом, и гейты проверки миграции
предполагают его. Будущая работа, нуждающаяся в Postgres-специфических
фичах (генерированные колонки `tsvector`, GiST-индексы, операторы
запросов JSONB) — это убедительное ADR для пересмотра; сегодня у
проекта такой потребности нет.

**SQLite для локальной разработки, MySQL в продакшене.** Отклонено.
Поведенческий дрейф между двумя — семантика блокировок, дефолтная
collation, поведение `ON DELETE` cascade — всплыл бы как тестовая
дивергенция между dev и CI/prod. Контейнер MySQL docker-compose
загружается за секунды; стоимость использования одного и того же
engine сквозно тривиальна.

---

## Последствия

### Положительные

- Зрелый, проторённый стек: TypeORM и MySQL имеют на порядок больше
  community-tested-паттернов, чем любая из альтернатив, для операций,
  которые проект действительно выполняет.
- `EntityManager.transaction(...)` — это unit-of-work-примитив для
  потока резервирования остатков и ротации user-row + refresh-hash в
  модуле auth. Не требуется кастомной обёртки транзакций.
- Миграции явные, рецензируемые и version-controlled. Никакая
  магия auto-`synchronize` никогда не запускается против реальной
  базы данных.
- `SnakeNamingStrategy` позволяет доменному коду оставаться camelCase
  без дрейфа схемы тоже в camelCase — удерживает SQL идиоматичным.
- Форма портов репозитория (per-aggregate, mapper-aware) была
  сформирована против API TypeORM; ADR-012 и ADR-013 опираются на те
  же соглашения, что удерживает поверхность проекта единообразной.

### Отрицательные / компромиссы

- Каденция релизов TypeORM и история breaking-changes заметны.
  Major-version-бампы требуют осторожной миграции декораторов
  сущностей, query builder'а и вызовов `EntityManager`. Смягчается
  закреплением major-версии в `package.json`; пересматривается при
  возникновении реальной потребности апгрейда.
- Паттерн `EntityManager`-как-unit-of-work утекает через поверхность
  прикладного порта в одном месте — задокументированное исключение
  `ARCH-LINT-EX-01`. Чистый фикс — абстракция `ITransactionPort`;
  отслеживается для task-14 / -15.
- Автоинкрементные ID (по ADR-005 §3) ограничивают проект отказом
  от клиентогенерируемых идентификаторов и шардинга по первичному
  ключу. Оба пересматриваются, если будущее ADR потребует UUID v7.
- Единственный инстанс MySQL, хостящий сегодня три логические схемы,
  — это разделённая точка операционного сбоя. Миграция принимает
  это для масштаба проекта-портфолио; разделение per-service-баз —
  будущее ADR, если независимое масштабирование станет необходимым.

---

## Ссылки

- `libs/database/` — `BaseEntity`, `BaseTypeormRepository`, фабрика
  `DatabaseModule.forRoot/forFeature`.
- `migrations/` — каждое изменение схемы с bootstrap проекта.
- [ADR-005](005-split-shared-common-into-bounded-libs.md) — разделение
  библиотек, давшее персистентности свой дом `libs/database` и
  выбравшее integer-PK-стратегию для `BaseEntity`.
- [ADR-002](002-redis-cache-aside-product-stock.md) — кеширует
  TypeORM-агрегацию; контракт, который сохраняют кеш-адаптеры.
- [ADR-012](012-stock-aggregate-and-port-adapter.md) — TypeORM-
  репозиторий stock + задокументированная утечка `EntityManager`.
- [ADR-013](013-order-aggregate-and-cross-service-confirm.md) —
  TypeORM-репозиторий order + кросс-агрегатный транзакционный поток
  подтверждения.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) §6 —
  исключение `ARCH-LINT-EX-01`, upstream-причиной которого является
  выбор ORM в этом ADR.
