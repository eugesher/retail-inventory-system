---
created: 2026-05-15
updated: 2026-05-16
tags: [retail-inventory-system, persistence, typeorm, mysql, migrations]
status: review
related:
  - "[[entity-vs-domain-model]]"
  - "[[mappers-and-repositories]]"
  - "[[base-entity-and-base-repository]]"
  - "[[snake-naming-strategy]]"
  - "[[shared-libs-philosophy]]"
  - "[[hexagonal-architecture]]"
---

# Обзор TypeORM

> [!abstract] Кратко
> Persistence-стек проекта — **TypeORM + MySQL** через драйвер
> `mysql2`. Каждый сервис, владеющий состоянием
> (`retail-microservice`, `inventory-microservice`, `api-gateway`'s
> `auth`), подключается к единому экземпляру MySQL через
> переменную окружения `DATABASE_URL` и общий хелпер
> `DatabaseModule.forRoot(entities)` из `@retail-inventory-system/database`.
> Миграции живут в `migrations/` и применяются исключительно
> через TypeORM CLI; `synchronize: true` запрещён во всех
> окружениях. Anchor — ADR-019.

## Проблема, которую решает

Retail Inventory System хранит три независимых среза состояния:

- `orders` — агрегат `Order` retail-микросервиса
  (`order`, `order_product`, `customer`, справочники
  `order_status` / `order_product_status`).
- `stock` — агрегат `StockItem` inventory-микросервиса
  (`product`, `product_stock`, `storage`).
- `auth` — агрегат `User` модуля auth внутри API Gateway
  (`user`).

Каждый из этих срезов нужно где-то хранить, но требования у трёх
сервисов идентичны: реляционная схема с
foreign-key-ограничениями, прозрачная support транзакций
для случаев вроде «зарезервировать сток при подтверждении
заказа», явные миграции под review, и framework-free
domain-слой по [[hexagonal-architecture|гексагональной]]
архитектуре.

До формализации ADR-019 пара TypeORM+MySQL была негласным
консенсусом — ADR-002 уже кэшировал TypeORM-aggregation,
ADR-005 ввёл `libs/database` с `BaseEntity` и
`BaseTypeormRepository`, ADR-012 / ADR-013 спроектировали
ports через интерфейс над TypeORM-репозиторием. Но **почему
именно TypeORM и MySQL**, какие альтернативы рассматривались
и какие есть trade-off'ы, не было записано ни в одном
документе. ADR-019 закрывает эту дыру; настоящая статья
рассказывает, как стек используется в коде.

## Концепция

### Что такое TypeORM

TypeORM — это объектно-реляционный mapper для TypeScript, который
дает три самостоятельных API:

1. **Entity-декораторы** (`@Entity`, `@Column`, `@ManyToOne`,
   `@PrimaryGeneratedColumn`) — описание схемы как
   TypeScript-классов. Через рефлексию metadata компилируется
   в DDL.
2. **`Repository<TEntity>` / `EntityManager`** — runtime-API
   для CRUD: `find`, `findOne`, `save`, `update`, `delete`,
   плюс программируемый `QueryBuilder` для произвольных
   SQL-запросов с join'ами, aggregation'ами и lock'ами.
3. **CLI миграций** — генерация и применение
   timestamp'ованных файлов миграций; здесь TypeORM не
   опирается на decorator-метаданные, а работает напрямую
   с SQL через `QueryRunner`.

Драйвер MySQL — **`mysql2`** (НЕ deprecated-`mysql`); поддержка
prepared statements, promise-based API, нормальная работа
с большими responses. TypeORM подбирает его автоматически
при `type: 'mysql'`, если `mysql2` есть в зависимостях.

### Что такое `DataSource`

Главный объект TypeORM — это **`DataSource`**: единая точка
подключения к одной базе. Через него идёт всё — миграции,
открытие транзакций, regis репозиториев. В проекте таких
`DataSource`'ов два логических контура:

- **Runtime** — внутри NestJS, регистрируется
  `TypeOrmModule.forRootAsync(...)` через
  `DatabaseModule.forRoot(entities)`. Здесь живут entity-метаданные
  каждого сервиса.
- **CLI миграций** — отдельный `DataSource`, описанный в
  `migrations/config/data-source.ts`, БЕЗ списка entity. CLI'ю
  они не нужны: миграции пишутся вручную и не зависят от
  декораторов.

Разделение принципиальное. CLI'ный `DataSource` не должен
зависеть от Nest, иначе для `yarn migration:run` нужно было бы
поднимать весь app-граф (включая консьюмеры RabbitMQ и
Redis-клиенты), что превратило бы команду в долгий процесс
с побочными эффектами.

### Почему именно TypeORM

ADR-019 рассмотрел и отверг Prisma, MikroORM, ObjectionJS+Knex,
сырой `mysql2`-сценарий и Postgres вместо MySQL.

- **Prisma** даёт лучший типизированный query-builder, но
  расходится с гексагональным `Repository<TEntity>`-шаблоном:
  ledger-flow ADR-002 нуждается в `SELECT … FOR UPDATE`, а
  cache-aside в ADR-016 — в общем `EntityManager` между
  use case'ом и repository call'ом. Prisma такие операции
  переключает на `$queryRaw`, и весь смысл типизированного
  клиента схлопывается.
- **MikroORM** — близкий конкурент TypeORM с лучшим
  unit-of-work, но миграция rip-and-replace не приносит
  никакого нового capability'я.
- **ObjectionJS / Knex** — больше SQL вручную, меньшее
  комьюнити; нет особых query-нужд, оправдывающих переход.
- **Сырой `mysql2` + ручные мапперы** — работало бы, но
  отсутствие фреймворка превратилось бы в техдолг, как
  только в схеме появятся joins, soft-delete и migration tooling.
- **PostgreSQL** вместо MySQL — JSONB, GiST-индексы,
  LISTEN/NOTIFY не используются; cross-service события идут
  через RabbitMQ. MySQL уже provisioned для compose'а и
  тестов; смена СУБД даёт нулевое преимущество.

TypeORM зрелый, его патерны хорошо документированы, есть
`EntityManager.transaction(...)` для unit-of-work,
`QueryBuilder` для сложных запросов, и контракт «миграции —
только через CLI» отлично ложится на review-driven flow.

### Что такое миграция

Миграция в TypeORM — это TypeScript-класс с timestamp'ом в
имени, реализующий `MigrationInterface` и описывающий
изменения схемы как «вверх» (`up`) и «вниз» (`down`)
через сырой SQL внутри `QueryRunner.query()`. Файлы лежат в
`migrations/` и применяются строго в timestamp-порядке. CLI
ведёт служебную таблицу `migrations` в самой базе и помнит,
что уже применено.

В проекте — три миграции:

- `1772600000000-InitStarterEntities.ts` — начальные таблицы
  (`product`, `storage`, `product_stock_action`,
  `product_stock`, `customer`, `order_status`,
  `order_product_status`, `order`, `order_product`).
- `1774134626155-AddOrderProductIdToProductStock.ts` —
  добавление FK-связки `product_stock.order_product_id →
  order_product.id`.
- `1778419765133-CreateUserTable.ts` — таблица `user`
  для JWT-авторизации (ADR-010).

## Применение в проекте

### Runtime-`DataSource`: `DatabaseModule.forRoot`

```typescript
// libs/database/database.module.ts
public static forRoot(entities: TypeOrmModuleOptions['entities']): DynamicModule {
  return {
    module: DatabaseModule,
    imports: [
      TypeOrmModule.forRootAsync({
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (configService: ConfigService): TypeOrmModuleOptions => ({
          type: 'mysql',
          url: configService.get<string>('DATABASE_URL'),
          logging: configService.get<boolean>('DATABASE_LOGGING'),
          synchronize: false,
          entities,
          namingStrategy: new SnakeNamingStrategy(),
        }),
      }),
    ],
    exports: [TypeOrmModule],
  };
}
```

> [GitHub: libs/database/database.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/database/database.module.ts#L9-L34)

Это единственное место в кодовой базе, где конструируется
`TypeOrmModuleOptions`. App-модули микросервисов никогда не
импортируют `@nestjs/typeorm` напрямую; они зовут
`DatabaseModule.forRoot([Entity1, Entity2, ...])` в корневом
модуле и `DatabaseModule.forFeature([...])` внутри каждого
бизнес-модуля. Подробности контракта — в
[[base-entity-and-base-repository]].

Четыре важные настройки:

- `type: 'mysql'` — выбор драйвера. TypeORM сам подберёт
  `mysql2` из `package.json`.
- `url: configService.get<string>('DATABASE_URL')` — строка
  подключения. По compose-конвенции это
  `mysql://retail:retailpass@mysql:3306/retail_db`; в
  production задаётся через секреты.
- `synchronize: false` — **обязательно**. См. ниже.
- `namingStrategy: new SnakeNamingStrategy()` —
  camelCase-поля entity ↔ snake_case-колонки в MySQL.
  Подробности — в [[snake-naming-strategy]].

### Правило «`synchronize: false` всегда»

`synchronize: true` — это режим TypeORM «при старте сверь
описанные entity со схемой и `ALTER TABLE` где надо». Звучит
удобно для прототипа; в production это путь к стиранию
данных. В проекте этот режим запрещён во **всех** окружениях,
включая dev и тесты.

Единственный канал изменений схемы — миграции:

```bash
yarn migration:create migrations/AddOrderProductIdToProductStock
yarn migration:run
yarn migration:show
yarn migration:revert
```

Все они — обёртки над одним `typeorm:migration-cli`
script'ом:

```json
"typeorm:migration-cli": "ts-node --project tsconfig.json -r tsconfig-paths/register ./node_modules/typeorm/cli.js -d ./migrations/config/data-source.ts",
"migration:create": "ts-node ./scripts/migration-create.ts",
"migration:run": "yarn typeorm:migration-cli migration:run",
"migration:revert": "yarn typeorm:migration-cli migration:revert",
"migration:show": "yarn typeorm:migration-cli migration:show",
```

> [GitHub: package.json](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/package.json#L28-L32)

- `migration:create` — генерирует пустой `<timestamp>-<slug>.ts`
  через тонкий wrapper-script (`scripts/migration-create.ts`),
  чтобы CLI правильно резолвил `tsconfig-paths`.
- `migration:run` — применяет все pending миграции в
  timestamp-порядке и кладёт запись в служебную таблицу
  `migrations`.
- `migration:revert` — откатывает **одну** последнюю
  применённую миграцию, выполняя её `down`-метод.
- `migration:show` — выводит список миграций с
  пометкой `[X]` для применённых.

### CLI-`DataSource`: отдельный от Nest

```typescript
// migrations/config/data-source.ts
for (const relative of ['../../.env.local', '../../.env']) {
  const result = dotenv.config({ path: path.join(__dirname, relative) });
  if (result.parsed) break;
}

const schema = Joi.object().keys({ DATABASE_URL: Joi.string().required() }).unknown();
const result = schema.validate(process.env);
if (result.error) throw new Error(`Config validation error: ${result.error.message}`);

export default new DataSource({
  type: 'mysql',
  url: result.value['DATABASE_URL'],
  migrations: [path.join(__dirname, '../*{.ts,.js}')],
});
```

> [GitHub: migrations/config/data-source.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/migrations/config/data-source.ts#L1-L26)

Здесь нет ни `entities`, ни Nest'а, ни NestConfigModule. Это
сделано умышленно: CLI должно стартовать секунды, а не
минуты, и не должно подтягивать побочные эффекты на старте
(консьюмеры RMQ, OTel-инструменты, Redis-клиенты). Joi
сверяет наличие `DATABASE_URL` — если переменная не задана,
команда падает с понятным сообщением.

### Как выглядит сама миграция

```typescript
// migrations/1772600000000-InitStarterEntities.ts
export class InitStarterEntities1772600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE product (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(255) NOT NULL,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      );
    `);
    // … остальные CREATE TABLE
  }
}
```

> [GitHub: migrations/1772600000000-InitStarterEntities.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/migrations/1772600000000-InitStarterEntities.ts#L1-L60)

Миграции пишутся **руками сырым SQL** через
`queryRunner.query()`, не через цепочку
`queryRunner.createTable(...)` высокоуровневого API.
Это сознательное решение: review-инженеру проще читать SQL,
чем переводить chain-builder обратно в DDL; плюс некоторые
конструкции (`AUTO_INCREMENT`, MySQL-specific
`utf8mb4_unicode_ci`, MySQL'ные `ENUM`-колонки) выражаются на
сыром SQL короче и точнее.

Пример инкрементальной миграции — добавление FK на `product_stock`:

```typescript
// migrations/1774134626155-AddOrderProductIdToProductStock.ts
public async up(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    ALTER TABLE product_stock
      ADD COLUMN order_product_id BIGINT UNSIGNED NULL AFTER quantity,
      ADD CONSTRAINT FK_PRODUCT_STOCK_ORDER_PRODUCT FOREIGN KEY (order_product_id)
        REFERENCES order_product (id);
  `);
}

public async down(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    ALTER TABLE product_stock
      DROP FOREIGN KEY FK_PRODUCT_STOCK_ORDER_PRODUCT,
      DROP COLUMN order_product_id;
  `);
}
```

> [GitHub: migrations/1774134626155-AddOrderProductIdToProductStock.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/migrations/1774134626155-AddOrderProductIdToProductStock.ts#L1-L21)

Обратите внимание: `down` — **симметричен** `up`. Это
требование code-review; миграция, которая не умеет откатиться,
не пропускается. На практике откат используется редко (в
production обычно «забыть и накатить fix-миграцию»), но
наличие осмысленного `down` — это invariant, который держит
автора от безрассудных DDL.

### Тестовая инфраструктура

```bash
yarn test:infra:up          # docker compose up mysql redis rabbitmq --wait
yarn test:infra:reload      # down -v + up + migration:run + test:seed
yarn test:e2e               # reload infra, then run jest e2e
```

> [GitHub: package.json](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/package.json#L34-L39)

Тесты прогоняются на **той же MySQL**, что и production-сборка,
с теми же миграциями. ADR-019 явно отверг
SQLite-для-dev-MySQL-для-prod подход: расхождение поведения
(locking, collation, `ON DELETE`) — это техдолг, который
выстреливает на CI/prod.

`yarn test:seed` запускает `scripts/test-db-seed.ts`, который
вставляет фикстуры в already-migrated схему — seed'ы это
**данные**, а не **schema**, и они никогда не пересекаются с
миграциями.

## Связанные решения

- [[entity-vs-domain-model]] — правило «`@Entity()` живёт
  только в `infrastructure/persistence/`».
- [[mappers-and-repositories]] — port vs adapter и где
  применяется `EntityManager.transaction`.
- [[base-entity-and-base-repository]] —
  `BaseEntity`, `BaseTypeormRepository`,
  `DatabaseModule.forRoot/forFeature`.
- [[snake-naming-strategy]] — почему camelCase ↔ snake_case.
- [[shared-libs-philosophy]] — место `libs/database` в
  таксономии shared-libs.
- [[hexagonal-architecture]] — зачем вообще нужны
  repository ports.

## Глоссарий

| Термин (EN)           | Перевод / пояснение (RU)                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| ORM                   | Object-Relational Mapper — слой, преобразующий строки таблиц в объекты языка.                                          |
| TypeORM               | ORM для TypeScript/Node.js; основной выбор проекта (ADR-019).                                                          |
| `DataSource`          | Главный объект TypeORM: одна точка подключения к одной БД.                                                              |
| `EntityManager`       | Контекст для CRUD-операций внутри `DataSource`; ключ к транзакциям.                                                     |
| `QueryRunner`         | Низкоуровневый исполнитель сырого SQL; на нём работают миграции.                                                        |
| `QueryBuilder`        | Программируемый builder произвольных SQL-запросов с join'ами и lock'ами.                                                |
| Driver                | Низкоуровневый клиент СУБД; здесь — `mysql2`.                                                                            |
| `mysql2`              | Promise-based MySQL-клиент для Node.js. Используется TypeORM'ом при `type: 'mysql'`.                                    |
| `DATABASE_URL`        | Connection-string в формате `mysql://user:pass@host:port/db`. Joi-валидируется при boot и при CLI-запуске миграций.    |
| Migration             | Timestamp'ованный TS-файл с парой `up`/`down`-методов; единственный канал изменения схемы.                              |
| `synchronize`         | Опция TypeORM «синхронизируй схему при старте». Запрещена. Только миграции.                                              |
| `MigrationInterface`  | Тип-интерфейс TypeORM для миграции. Требует `up(qr)` и `down(qr)`.                                                       |
| `SnakeNamingStrategy` | Naming-strategy из `typeorm-naming-strategies`; маппит camelCase ↔ snake_case.                                          |
| Seed                  | Тестовые данные, вставляемые в already-migrated схему. Никогда не пересекаются с миграциями.                            |

## Что почитать дальше

- ADR-019 — `docs/adr/019-typeorm-and-mysql-for-persistence.md`.
- ADR-005 §3 — выбор `BaseEntity` ID strategy
  (`@PrimaryGeneratedColumn()`).
- ADR-017 §6 — exception `ARCH-LINT-EX-01` для leak'ed
  `EntityManager` в `IStockRepositoryPort`.
- TypeORM Migrations Docs — [typeorm.io](https://typeorm.io/migrations).

> [!faq]- Проверь себя
> 1. Почему `synchronize: false` обязателен в **dev**, а не
>    только в production?
> 2. Где находится единственное место в кодовой базе, где
>    конструируется `TypeOrmModuleOptions`?
> 3. Зачем CLI'ный `DataSource` отдельный от runtime'ного и
>    почему у него нет списка `entities`?
> 4. В каком файле и какая команда yarn применяет накопившиеся
>    миграции?
> 5. Почему миграции пишутся сырым SQL, а не цепочкой
>    `queryRunner.createTable(...)`?
