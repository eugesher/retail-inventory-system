---
created: 2026-05-15
updated: 2026-05-16
tags: [retail-inventory-system, persistence, naming, snake-case]
status: review
related:
  - "[[typeorm-overview]]"
  - "[[base-entity-and-base-repository]]"
  - "[[entity-vs-domain-model]]"
  - "[[shared-libs-philosophy]]"
---

# SnakeNamingStrategy

> [!abstract] Кратко
> TypeScript-сообщество пишет идентификаторы в **camelCase**
> (`productId`, `createdAt`, `refreshTokenHash`). MySQL-сообщество
> пишет колонки в **snake_case** (`product_id`, `created_at`,
> `refresh_token_hash`). `SnakeNamingStrategy` из
> `typeorm-naming-strategies` — это тонкий переводчик
> между двумя мирами, переэкспортированный из
> `@retail-inventory-system/database`.

## Проблема, которую решает

Два сообщества — два naming-конвенции. TypeScript-стиль —
`camelCase` для полей и методов (`Array#flatMap`, `Date#getFullYear`),
SQL/MySQL-стиль — `snake_case` для колонок и таблиц
(`information_schema`, `processlist`). Каждый из стилей
самосогласован внутри своего домена; смешивать их в одном
коде дорого.

Без naming-strategy у нас остаются три плохих варианта:

1. **camelCase в БД**. `CREATE TABLE order (productId INT NOT
   NULL, createdAt TIMESTAMP ...)`. Технически работает, но
   ломает SQL-конвенцию: `SELECT productId FROM order` —
   синтаксически валидно, но любой DBA, открывший
   `pt-query-digest`-отчёт, спотыкается. Кроме того в MySQL
   идентификаторы case-insensitive по умолчанию (в зависимости
   от платформы), что добавляет багов.
2. **snake_case в TypeScript-коде entity**. `@Column()
   public product_id: number;` Технически работает, но
   ломает linter (`@typescript-eslint/naming-convention`
   будет ругаться) и заставляет domain-код тоже использовать
   `productId` для одного и того же поля, что вводит
   неконсистентность.
3. **Декларировать имя в каждом `@Column`**. `@Column({ name:
   'product_id' }) public productId: number;` Работает,
   уже decent — но превращает каждый entity-файл в дублирующий
   шум: «product_id для productId, created_at для createdAt,
   refresh_token_hash для refreshTokenHash». Контракт «camel↔
   snake» становится размазан по сотне `@Column`-вызовов; если
   кто-то его забудет, у поля «магически» появится колонка с
   именем поля.

Стратегия именования — это **fourth option**: один файл-настройка,
прокидываемая в `DataSource`, говорит TypeORM'у «при build'е
SQL'я переводи имена полей/таблиц/индексов/FK из camelCase в
snake_case автоматически». Decorator'ы остаются чистыми,
колонки в БД остаются snake_case'овыми, никто не
дублирует контракт.

## Применение в проекте

### Сам файл

```typescript
// libs/database/snake-naming.strategy.ts
export { SnakeNamingStrategy } from 'typeorm-naming-strategies';
```

> [GitHub: libs/database/snake-naming.strategy.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/database/snake-naming.strategy.ts#L1-L1)

Это **тонкая re-export-шина**. Зачем lib `database` держит
собственный re-export вместо того, чтобы apps импортировали
из `typeorm-naming-strategies` напрямую?

- **Один источник истины**. Кому-то понадобится подменить
  strategy (например, на `SnakeNamingStrategy` своего fork'а
  или на `CustomNamingStrategy`) — это меняется в одном
  файле, не во всех `app.module.ts`.
- **Единый набор импортов из `lib-database`**. Apps
  импортируют `BaseEntity`, `BaseTypeormRepository`,
  `DatabaseModule`, `SnakeNamingStrategy` из одного места —
  `@retail-inventory-system/database`. Это согласуется с
  принципом lib-as-public-API из [[shared-libs-philosophy]].
- **Возможность будущего custom-override'а**. Если когда-то
  понадобится дополнительная логика (например, переход от
  `OrderEntity` к таблице `t_order` с префиксом), это можно
  сделать здесь же:

  ```typescript
  // hypothetical future change — not in production today
  import { SnakeNamingStrategy as BaseStrategy } from 'typeorm-naming-strategies';
  export class SnakeNamingStrategy extends BaseStrategy {
    tableName(className: string, customName?: string): string {
      return customName ?? `t_${super.tableName(className)}`;
    }
  }
  ```

  Сегодня этого нет; re-export по semantics-у эквивалентен
  тому, что есть в `typeorm-naming-strategies@^4.1.0`.

### Где применяется

```typescript
// libs/database/database.module.ts
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
```

> [GitHub: libs/database/database.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/database/database.module.ts#L17-L24)

Одна строка — `namingStrategy: new SnakeNamingStrategy()` —
делает всё. С этого момента TypeORM:

- маппит `class ProductStock` → table `product_stock`;
- маппит `public productId: number` → column `product_id`;
- маппит `public refreshTokenHash: string` → column
  `refresh_token_hash`;
- маппит `@CreateDateColumn() public createdAt` → column
  `created_at`;
- генерирует имена FK-ограничений в snake_case:
  `FK_PRODUCT_STOCK_PRODUCT` (если задано явно) или
  автогенерированное со snake'овым шаблоном.

### Пример entity с camelCase-полем и snake_case-колонкой

```typescript
// apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product-stock.entity.ts
@Entity('product_stock')
export class ProductStock {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public productId: number;     // → product_id

  @Column()
  public storageId: string;     // → storage_id

  @Column()
  public actionId: string;      // → action_id

  @Column()
  public quantity: number;      // → quantity

  @Column({ nullable: true, type: 'bigint' })
  public orderProductId: number | null;  // → order_product_id

  @CreateDateColumn()
  public createdAt: Date;       // → created_at
}
```

> [GitHub: apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product-stock.entity.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product-stock.entity.ts#L1-L26)

Из шести `@Column`-вызовов **ни один** не явно задаёт `name:`.
Эта же entity, если бы strategy не была подключена, потребовала
бы:

```typescript
// антипаттерн (без strategy)
@Column({ name: 'product_id' }) public productId: number;
@Column({ name: 'storage_id' }) public storageId: string;
@Column({ name: 'action_id' })  public actionId: string;
// ...
```

Сравнение очевидно — strategy сокращает шум и убирает
возможность забыть.

### Имя таблицы — это исключение

В декораторе `@Entity('product_stock')` имя таблицы задано
явно. Здесь strategy НЕ применяется, потому что класс
называется `ProductStock`, и strategy перевела бы его в
`product_stock` (что совпадает). Но `Order` → table нужно
называть **`order`**, а не `orders` (strategy не делает
плюрализации). Поэтому имя таблицы — всегда явное, чтобы
не зависеть от поведения strategy с pluralization'ом.

## Связанные решения

- [[typeorm-overview]] — где strategy регистрируется внутри
  `DataSource`.
- [[base-entity-and-base-repository]] — `BaseEntity` идёт в
  паре с strategy: автополе `createdAt` маппится в
  `created_at` благодаря strategy.
- [[entity-vs-domain-model]] — почему camelCase в entity не
  «загрязняет» domain-слой.
- [[shared-libs-philosophy]] — почему re-export живёт в
  `lib-database`.

## Глоссарий

| Термин (EN)              | Перевод / пояснение (RU)                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| Naming strategy          | TypeORM-объект, переводящий имена классов/полей в имена таблиц/колонок при build'е SQL.                |
| `SnakeNamingStrategy`    | Реализация strategy из пакета `typeorm-naming-strategies`. camelCase ↔ snake_case.                     |
| camelCase                | TypeScript-конвенция: `productId`, `createdAt`. Идентификаторы без разделителей, заглавная начинает слово. |
| snake_case               | SQL-конвенция: `product_id`, `created_at`. Слова разделены подчёркиваниями, всё нижнем регистре.        |
| `@Column({ name })`      | Явное указание имени колонки. Используется, когда strategy не угадывает (плюрализация, префиксы).      |
| `typeorm-naming-strategies` | npm-пакет, в котором живут naming-strategy'и для TypeORM. У нас зафиксирован на `^4.1.0`.            |

## Что почитать дальше

- ADR-019 — `docs/adr/019-typeorm-and-mysql-for-persistence.md`
  (где naming strategy упомянута как часть стека).
- `typeorm-naming-strategies` — [GitHub repo](https://github.com/tonivj5/typeorm-naming-strategies).
- TypeORM Docs — Naming Strategies.

> [!faq]- Проверь себя
> 1. Почему имя таблицы в `@Entity('product_stock')` задано
>    явно, хотя strategy сама умеет переводить класс
>    `ProductStock` → `product_stock`?
> 2. Что произойдёт, если убрать `namingStrategy: new
>    SnakeNamingStrategy()` из `forRoot`-конфига?
> 3. Где живёт сам файл strategy и почему он сделан тонким
>    re-export'ом, а не custom-классом?
