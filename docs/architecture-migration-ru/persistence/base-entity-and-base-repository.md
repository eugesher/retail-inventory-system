---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, persistence, base-classes, libs-database]
status: final
related:
  - "[[typeorm-overview]]"
  - "[[entity-vs-domain-model]]"
  - "[[mappers-and-repositories]]"
  - "[[snake-naming-strategy]]"
  - "[[shared-libs-philosophy]]"
---

# BaseEntity и BaseTypeormRepository

> [!abstract] Кратко
> `libs/database` содержит **три load-bearing-абстракции**:
> `BaseEntity` (общий predecessor entity'ев с id +
> timestamp'ами + soft-delete), `BaseTypeormRepository<TEntity,
> TDomain>` (mapper-aware-обёртка над `Repository<TEntity>`),
> и `DatabaseModule` (фабрика `TypeOrmModuleOptions` с
> правильной `SnakeNamingStrategy` и `synchronize: false`).
> Anchor — ADR-005 §3 (выбор ID-стратегии) + ADR-019
> (TypeORM/MySQL).

## Проблема, которую решает

До task-03 каждый микросервис конструировал свой
`TypeormModuleConfig(entities)` напрямую в `app.module.ts`.
В `libs/common` лежали и cache-helper, и RMQ-client-модули,
и middleware — общего места для persistence-инфраструктуры
не было. Из-за этого:

- автополя (`createdAt`, `updatedAt`, `deletedAt`) описывались
  на каждом entity вручную;
- soft-delete не использовался — все `DELETE` уходили
  hard'ом, потому что декларировать `@DeleteDateColumn` на
  каждой таблице — лишний шум;
- `SnakeNamingStrategy` подключалась через `libs/config/typeorm-module.config.ts`,
  но не было базового entity, который мог бы держать общую
  схему timestamp'ов;
- repository-классы дублировали mapper-вызовы (`toDomain` /
  `toEntity`) inline в каждом методе;
- не было общего места для `forFeature`-регистрации — каждый
  модуль звал `TypeOrmModule.forFeature([...])` напрямую,
  что обходило `DatabaseModule`-абстракцию.

ADR-005 §3 разбил `libs/common` на bounded-libs и завёл
`@retail-inventory-system/database`. Этот lib и держит сегодня
три обсуждаемые абстракции.

## Применение в проекте

### `BaseEntity`

```typescript
// libs/database/base.entity.ts
import {
  CreateDateColumn,
  DeleteDateColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export abstract class BaseEntity {
  @PrimaryGeneratedColumn()
  public id: number;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;

  @DeleteDateColumn({ nullable: true })
  public deletedAt: Date | null;
}
```

> [GitHub: libs/database/base.entity.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/database/base.entity.ts#L1-L20)

Четыре поля, фиксирующих универсальный «metadata-layer»
строки:

- **`id: number` через `@PrimaryGeneratedColumn()`.** Это
  auto-increment-integer, как в MySQL `BIGINT UNSIGNED
  AUTO_INCREMENT PRIMARY KEY`. ADR-005 §3 рассмотрел и
  отверг UUID v7: все существующие entity (`order`,
  `order_product`, `product`, `product_stock`, и т.д.) уже
  используют целочисленный PK, конверсия в UUID потребовала
  бы одноразовой data-migration и сломала бы все
  выданные публично id'ы. Минусы целочисленных id'ов
  (предсказуемость, утечка cardinality, неудобная
  client-генерация) сегодня не load-bearing'и. Переход на
  UUID v7 — это будущий ADR, когда возникнет multi-tenant
  или sharded use case.
- **`createdAt` через `@CreateDateColumn()`.** TypeORM
  выставляет значение при первом `INSERT`'е. Маппится в
  `created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`.
- **`updatedAt` через `@UpdateDateColumn()`.** Обновляется на
  каждом `UPDATE`'е. В MySQL — `updated_at TIMESTAMP NOT NULL
  DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`.
- **`deletedAt: Date | null` через `@DeleteDateColumn({ nullable: true })`.**
  Это **soft-delete-маркер**. Когда зовёшь
  `repository.softDelete({...})`, TypeORM выставляет
  `deletedAt = NOW()` вместо физического `DELETE FROM`.
  Все `find*`-запросы автоматически фильтруют по
  `deletedAt IS NULL`. Восстановить soft-deleted-строку
  можно `repository.restore({...})`.

`BaseEntity` — **абстрактный** класс; его нельзя
инстанцировать напрямую. Production-entity'и наследуются от
него:

```typescript
@Entity('user')
export class UserEntity extends BaseEntity {
  @Column({ type: 'char', length: 36 })
  public id: string;  // переопределение для CHAR(36)-id, см. CreateUserTable миграцию
  // …
}
```

(Пример из gateway'а; `user` использует `CHAR(36)` для совместимости
с argon2-вычислениями uid'а, поэтому переопределяет тип `id`
из родителя. Это случается редко; в retail/inventory entity
держат integer-id из `BaseEntity`.)

### `BaseTypeormRepository`

```typescript
// libs/database/base-typeorm.repository.ts
import { DeepPartial, FindOptionsWhere, ObjectLiteral, Repository } from 'typeorm';

export abstract class BaseTypeormRepository<TEntity extends ObjectLiteral, TDomain> {
  protected constructor(protected readonly repository: Repository<TEntity>) {}

  protected abstract toDomain(entity: TEntity): TDomain;

  protected abstract toEntity(domain: TDomain): DeepPartial<TEntity>;

  public async find(
    where: FindOptionsWhere<TEntity> | FindOptionsWhere<TEntity>[],
  ): Promise<TDomain[]> {
    const entities = await this.repository.find({ where });
    return entities.map((entity) => this.toDomain(entity));
  }

  public async save(domain: TDomain): Promise<TDomain> {
    const partial = this.toEntity(domain);
    const saved = await this.repository.save(partial);
    return this.toDomain(saved as TEntity);
  }

  public async softDelete(where: FindOptionsWhere<TEntity>): Promise<void> {
    await this.repository.softDelete(where);
  }
}
```

> [GitHub: libs/database/base-typeorm.repository.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/database/base-typeorm.repository.ts#L1-L26)

Это **mapper-aware-обёртка**. Дженерик-параметры:

- `TEntity` — TypeORM-entity (`OrderEntity`, `ProductStock`,
  …);
- `TDomain` — domain-модель (`Order`, `StockItem`, …).

Подкласс обязан реализовать **два абстрактных protected-метода**:

- `toDomain(entity): TDomain` — на стороне entity → domain;
  обычно делегирует mapper'у (`OrderMapper.toDomain(entity)`).
- `toEntity(domain): DeepPartial<TEntity>` — на стороне domain
  → entity; возвращает `DeepPartial`, чтобы TypeORM сам
  достроил отсутствующие поля (id для новой записи,
  created_at, и т.д.).

Базовый класс реализует три типовых операции (`find`, `save`,
`softDelete`), которые делегируют mapper'у. Конкретные
adapters (`OrderTypeormRepository`,
`StockTypeormRepository`) добавляют свои методы
(`findHeaderById`, `confirmLines`, `aggregateForProduct`,
`lockedTotalsByProduct`) поверх.

Пример наследования из inventory'я:

```typescript
@Injectable()
export class StockTypeormRepository
  extends BaseTypeormRepository<ProductStock, StockItem>
  implements IStockRepositoryPort
{
  constructor(
    @InjectRepository(ProductStock)
    private readonly productStockRepository: Repository<ProductStock>,
    @InjectPinoLogger(StockTypeormRepository.name)
    private readonly logger: PinoLogger,
  ) {
    super(productStockRepository);
  }

  protected toDomain(entity: ProductStock): StockItem {
    return StockItemMapper.toDomain(entity);
  }

  protected toEntity(domain: StockItem): DeepPartial<ProductStock> {
    return {
      productId: domain.productId,
      storageId: domain.storageId,
      quantity: domain.quantity,
    };
  }
  // … custom methods
}
```

> [GitHub: apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-typeorm.repository.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-typeorm.repository.ts#L25-L50)

Заметьте: класс — и `extends BaseTypeormRepository`, и
`implements IStockRepositoryPort`. Базовый класс даёт три
готовые операции; интерфейс из application/ports
гарантирует, что adapter имплементит правильный contract.

### `DatabaseModule.forRoot` и `forFeature`

```typescript
// libs/database/database.module.ts
@Module({})
export class DatabaseModule {
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

  public static forFeature(entities: EntityClassOrSchema[]): DynamicModule {
    return TypeOrmModule.forFeature(entities);
  }
}
```

> [GitHub: libs/database/database.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/database/database.module.ts#L9-L34)

Два метода с принципиально разной семантикой:

- **`forRoot(entities)`** — вызывается **один раз** в
  AppModule сервиса. Регистрирует глобальный `DataSource`,
  читает `DATABASE_URL` из ConfigService, выставляет
  `synchronize: false` (см. [[typeorm-overview]]) и
  `SnakeNamingStrategy` (см. [[snake-naming-strategy]]). Список
  entities — это **полный набор** entity'ев сервиса; на их
  metadata строится `DataSource`.
- **`forFeature(entities)`** — вызывается **по разу в каждом
  модуле**, регистрирующем доступ к своим entity. Это
  тонкая обёртка над `TypeOrmModule.forFeature(...)` —
  без неё `@InjectRepository(Entity)` не работает внутри
  модуля.

Пример полной wire'ировки в orders-модуле:

```typescript
@Module({
  imports: [
    DatabaseModule.forFeature([Customer, Order, OrderProduct, OrderProductStatus, OrderStatus]),
    // …
  ],
  providers: [
    OrderTypeormRepository,
    { provide: ORDER_REPOSITORY, useExisting: OrderTypeormRepository },
    // …
  ],
})
export class OrdersModule {}
```

> [GitHub: apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts#L30-L55)

`forFeature` принимает **только** те entity, к которым
данный модуль обращается. Это даёт два бенефита:

- `@InjectRepository(Entity)` ловится TS'ом, если entity не
  была зарегистрирована в этом конкретном модуле — Nest
  бросает чёткое сообщение при boot'е.
- Per-module ownership: если orders-модуль не
  зарегистрировал `ProductStock`, написать SQL-запрос к
  `product_stock` из него возможно только через явный
  `dataSource.query(...)` — это **видимый** signal, что
  модуль вторгся в чужой bounded context.

### Index-файл

```typescript
// libs/database/index.ts
export * from './base.entity';
export * from './base-typeorm.repository';
export * from './database.module';
export * from './snake-naming.strategy';
```

> [GitHub: libs/database/index.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/database/index.ts#L1-L5)

Четыре экспорта — public API lib'ы. Apps импортируют через
TS-path-alias:

```typescript
import {
  BaseEntity,
  BaseTypeormRepository,
  DatabaseModule,
  SnakeNamingStrategy,
} from '@retail-inventory-system/database';
```

`lib-database` — это **integration-lib** в таксономии
[[shared-libs-philosophy]]. Ей разрешено импортировать из
`typeorm`, `@nestjs/typeorm`, `@nestjs/config`. Ей запрещено
импортировать из `application/use-cases/*`, `domain/*`,
конкретных микросервисов. Эти запреты проверяются
`eslint-plugin-boundaries`.

## Связанные решения

- [[typeorm-overview]] — где регистрируется `DataSource`,
  и почему `synchronize: false`.
- [[entity-vs-domain-model]] — почему entity и domain — два
  разных класса.
- [[mappers-and-repositories]] — как adapter использует
  `BaseTypeormRepository`.
- [[snake-naming-strategy]] — почему `SnakeNamingStrategy`
  идёт пакетом с `BaseEntity`.
- [[shared-libs-philosophy]] — место `lib-database` в
  таксономии.

## Глоссарий

| Термин (EN)              | Перевод / пояснение (RU)                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `BaseEntity`             | Абстрактный родитель всех TypeORM-entity'ев. Держит id + timestamp'ы + soft-delete-колонку.                |
| `BaseTypeormRepository`  | Mapper-aware-обёртка над `Repository<TEntity>`; даёт `find`, `save`, `softDelete`.                          |
| `DatabaseModule`         | DynamicModule из `libs/database`. Два метода: `forRoot(entities)` и `forFeature(entities)`.                 |
| `forRoot`                | Глобальная регистрация TypeORM `DataSource`. Один вызов в AppModule сервиса.                                |
| `forFeature`             | Per-module регистрация entity для `@InjectRepository`.                                                     |
| `@PrimaryGeneratedColumn`| Декоратор auto-increment-PK.                                                                              |
| `@CreateDateColumn`      | Декоратор auto-fill `created_at`.                                                                          |
| `@UpdateDateColumn`      | Декоратор auto-update `updated_at` при `repository.save(...)`.                                              |
| `@DeleteDateColumn`      | Декоратор soft-delete-маркера. `softDelete()` выставляет `deletedAt`, find'ы игнорируют такие строки.       |
| Soft-delete              | Логическое удаление: метка времени вместо `DELETE FROM`. Восстановление через `repository.restore`.        |

## Что почитать дальше

- ADR-005 — `docs/adr/005-split-shared-common-into-bounded-libs.md`,
  §3 (выбор `BaseEntity` ID strategy и shim policy).
- ADR-019 — `docs/adr/019-typeorm-and-mysql-for-persistence.md`
  (общий persistence-стек).
- TypeORM Docs — Active Record vs Data Mapper (наш проект
  выбрал Data Mapper через `Repository<TEntity>` + mapper'ы).

> [!faq]- Проверь себя
> 1. Какая разница между `forRoot` и `forFeature`, и сколько
>    раз каждый из них вызывается?
> 2. Зачем `BaseTypeormRepository` объявляет два abstract
>    method'а, и кто их реализует?
> 3. Почему `BaseEntity` использует auto-increment-integer
>    вместо UUID v7? Где это обсуждается?
> 4. Что произойдёт, если в `forFeature` забыть включить
>    entity, который потом инжектируется через
>    `@InjectRepository`?
> 5. Зачем нужна колонка `deletedAt`, и как она влияет на
>    обычные `find*`-запросы?
