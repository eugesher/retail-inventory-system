---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, persistence, ddd, hexagonal]
status: final
related:
  - "[[typeorm-overview]]"
  - "[[mappers-and-repositories]]"
  - "[[base-entity-and-base-repository]]"
  - "[[hexagonal-architecture]]"
  - "[[clean-architecture-layers]]"
  - "[[shared-libs-philosophy]]"
---

# Entity vs Domain Model

> [!abstract] Кратко
> В проекте **два разных типа «сущностей»**: TypeORM-`@Entity`,
> описывающий строку таблицы (живёт **только** в
> `infrastructure/persistence/`), и domain-модель, кодирующая
> бизнес-инварианты (живёт в `domain/` и не знает ничего ни про
> TypeORM, ни про NestJS). Граница между ними проходит через
> мэппер; репозиторий-адаптер — единственное место, где эти
> два мира встречаются. Anchor — ADR-004 + ADR-019 + ADR-005.

## Проблема, которую решает

Если в одном классе живёт и `@Entity()`, и бизнес-логика
(«нельзя резервировать больше, чем есть на остатке»), то этот
класс получает два несовместимых набора ограничений:

- Со стороны TypeORM ему нужна пустая публичная схема:
  каждое поле — `@Column`, каждый FK — `@ManyToOne`, конструктор
  пустой (чтобы `repository.findOne(...)` мог инстанцировать
  его рефлексивно). Это, по сути, **DTO с метаданными**.
- Со стороны бизнес-логики нужны **инварианты** и **поведение**:
  закрытые setter'ы, валидация в конструкторе, явные методы
  состояния-перехода (`reserve(amount)`, `confirm()`).

Объединить их в одном классе можно — большая часть
NestJS-стартеров так и делает — но цена очевидна: domain-логика
сливается с фреймворком. Юнит-тест на инвариант теперь требует
TypeORM-bootstrapping. Сменить базу или ORM нельзя без переписывания
бизнес-логики. И главное — **любой код, импортирующий domain-класс,
транзитивно тащит TypeORM**, что ломает гексагональный принцип
«domain ничего не знает про инфраструктуру» (см.
[[hexagonal-architecture]]).

ADR-004 декларирует разделение per-service hexagonal-target.
ADR-019 закрепляет TypeORM/MySQL как stack. ADR-005 разнесёт
foundation-libs (`libs/ddd`, `libs/contracts`, `libs/database`),
чтобы domain-слой можно было физически не связать с TypeORM
в дереве импортов. На уровне `eslint-plugin-boundaries`
правило формализовано — см. [[module-boundaries]] — и
лента «`@Entity` only inside `infrastructure/persistence/`»
проверяется в CI grep'ом.

## Концепция

### Что такое TypeORM-`@Entity`

Это **POJO с декораторами**, описывающий ровно одну строку
таблицы. Полный список его обязанностей:

- маппинг поле↔колонка (`@Column`, имя через
  [[snake-naming-strategy|SnakeNamingStrategy]]);
- primary key (`@PrimaryGeneratedColumn`);
- связи (`@ManyToOne`, `@OneToMany`, `@JoinColumn`);
- автополе timestamp'ов (`@CreateDateColumn`,
  `@UpdateDateColumn`, `@DeleteDateColumn` — см.
  [[base-entity-and-base-repository]]);
- enum-маппинг (`@Column({ type: 'enum', enum: …})`).

Никакой бизнес-логики. Никаких инвариантов. Это **persistence
contract**, а не **domain model**.

### Что такое domain-model

Это **класс с поведением**, отвечающий на вопрос «что эта
сущность может делать и какие у неё инварианты». Чек-лист:

- private/protected поля; readonly где возможно;
- ctor валидирует входные данные;
- public-методы — это **доменные операции**
  (`reserve(amount)`, `release(amount)`, `confirm()`);
- ни одного импорта `@nestjs/*` или `typeorm`;
- импорты допустимы только из `libs/ddd`, `libs/common`,
  `libs/contracts`.

Domain-классы наследуются от примитивов из
`@retail-inventory-system/ddd` (`Entity<TId>`,
`AggregateRoot<TId>`, `ValueObject<TProps>`,
`DomainEvent<TAggregateId>`), и больше ни от чего.

### Граница: мэппер

Между этими двумя мирами стоит **мэппер** —
обычный TypeScript-класс со статическими методами
`toDomain(entity)` и `toEntity(domain)` (последний — где нужно).
Мэппер живёт в `infrastructure/persistence/` рядом с entity:
он один из двух — наряду с самим entity и
TypeORM-репозиторием — имеет право знать оба мира.

Подробно про мэппер и pair port/adapter — в
[[mappers-and-repositories]]; здесь сосредоточимся на самой
паре.

### Что делать с инвариантами на стороне БД

Domain хранит инвариант. Schema — отражает его в виде
constraint'ов (NOT NULL, FK, UNIQUE, CHECK где поддерживается).
Дублирование сознательное: домен проверяет инвариант **раньше**
БД, чтобы сообщение об ошибке было осмысленным
(`StockItem.reserve: requested 7 exceeds available 5`, а не
mysql'евское `1452 (23000): Cannot add or update a child row`).
БД остаётся последней защитной линией от багов в коде.

## Применение в проекте

Рассмотрим пару `StockItem` (domain) — `ProductStock` (entity)
из inventory-микросервиса. Это самый показательный пример: два
класса с почти одинаковыми полями, но с принципиально разными
обязанностями.

### Domain: `StockItem`

```typescript
// apps/inventory-microservice/src/modules/stock/domain/stock-item.model.ts
export class StockItem {
  public readonly productId: number;
  public readonly storageId: string;
  private _quantity: number;
  private _reservedQuantity: number;
  public readonly updatedAt: Date | null;

  constructor(props: IStockItemProps) {
    const reservedQuantity = props.reservedQuantity ?? 0;

    if (!Number.isFinite(props.quantity) || props.quantity < 0) {
      throw new Error(
        `StockItem: quantity must be a non-negative finite number, got ${props.quantity}`,
      );
    }
    if (!Number.isFinite(reservedQuantity) || reservedQuantity < 0) {
      throw new Error(
        `StockItem: reservedQuantity must be a non-negative finite number, got ${reservedQuantity}`,
      );
    }
    if (reservedQuantity > props.quantity) {
      throw new Error(
        `StockItem: reservedQuantity (${reservedQuantity}) must not exceed quantity (${props.quantity})`,
      );
    }

    this.productId = props.productId;
    this.storageId = props.storageId;
    this._quantity = props.quantity;
    this._reservedQuantity = reservedQuantity;
    this.updatedAt = props.updatedAt ?? null;
  }

  public reserve(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`StockItem.reserve: amount must be a positive finite number, got ${amount}`);
    }
    if (amount > this.availableQuantity) {
      throw new Error(
        `StockItem.reserve: requested ${amount} exceeds available ${this.availableQuantity}`,
      );
    }
    this._reservedQuantity += amount;
  }
}
```

> [GitHub: apps/inventory-microservice/src/modules/stock/domain/stock-item.model.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/domain/stock-item.model.ts#L20-L75)

Что здесь интересно:

- **Конструктор валидирует**. `quantity >= 0`,
  `reservedQuantity >= 0`, `reservedQuantity <= quantity`.
  Невозможно создать `StockItem`, нарушающий инвариант — это
  принципиально для domain-кода.
- **`_quantity` и `_reservedQuantity` — приватные**. Снаружи
  доступ через getter'ы (`quantity`, `reservedQuantity`,
  `availableQuantity`). Изменить состояние можно только
  доменной операцией (`reserve`, `release`), не присваиванием.
- **Никаких декораторов**. Никаких `@Column`, `@Entity`,
  `@Injectable`. Этот файл компилируется без TypeORM/NestJS
  в classpath.
- **`reservedQuantity` живёт в domain, хотя в БД его нет.**
  Сегодняшний `product_stock` — единый signed ledger; колонки
  `reserved_quantity` пока нет. Тем не менее семантика
  резервирования — это **бизнес-понятие**, и место ему в
  domain'е. Эволюция персистенса (отдельная колонка или ledger
  резервов) будет невидима callers'ам. См. ADR-012 §2.

### Persistence-entity: `ProductStock`

```typescript
// apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product-stock.entity.ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('product_stock')
export class ProductStock {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public productId: number;

  @Column()
  public storageId: string;

  @Column()
  public actionId: string;

  @Column()
  public quantity: number;

  @Column({ nullable: true, type: 'bigint' })
  public orderProductId: number | null;

  @CreateDateColumn()
  public createdAt: Date;
}
```

> [GitHub: apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product-stock.entity.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product-stock.entity.ts#L1-L26)

Принципиальные отличия:

- **Полностью публичный shape**. Все поля — `public`, без
  частных, без readonly. TypeORM-репозитории читают и пишут их
  напрямую при материализации.
- **Имя таблицы — `product_stock`**, а доменное имя —
  `StockItem`. Это сознательное расхождение из ADR-012 §1:
  название бизнес-модели следует agregat'у (`Stock` / `StockItem`),
  а название таблицы — join'у БД-уровня (`product_stock`).
  Переименовывать таблицу под доменное имя — лишний
  риск-в-данных без выгоды.
- **Поля, которых нет в domain'е** (`id`, `actionId`,
  `orderProductId`, `createdAt`): это **детали реализации
  ledger'а** — каждая строка `product_stock` это «дельта»
  (положительная или отрицательная) с указанием действия и
  привязки к заказу. Domain-агрегат `StockItem` про это не
  знает: он видит только агрегированный (`SUM`) остаток.
- **Нет `reservedQuantity`**. В БД его нет потому, что
  ledger-модель кодирует резервы как отрицательные дельты с
  `actionId = 'reserved'`. Domain-абстракция от этого не
  страдает: aggregation возвращает чистый остаток, а
  `reservedQuantity` обновляется в памяти.
- **Нет валидации**. Никаких ctor-throws, никаких
  invariant-проверок. TypeORM использует Reflect-API и
  ожидает publicly-mutable shape.

### Side-by-side

| Аспект                       | `StockItem` (domain)                                          | `ProductStock` (entity)                                    |
| ---------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| Расположение                 | `domain/stock-item.model.ts`                                  | `infrastructure/persistence/product-stock.entity.ts`         |
| Декораторы                   | Нет.                                                          | `@Entity`, `@Column`, `@PrimaryGeneratedColumn`,             |
|                              |                                                                | `@CreateDateColumn`.                                          |
| Импорты                      | Только из локальной papyrus.                                  | `typeorm`.                                                   |
| Видимость полей              | private + getters; readonly где можно.                        | public, mutable.                                              |
| Валидация                    | В конструкторе.                                                | Нет (на уровне `@Column({ nullable: false })`).              |
| Семантика                    | Aggregat'ed остаток с правилами резерва.                     | Одна строка ledger'а с действием и timestamp'ом.             |
| Поля, что не совпадают       | `reservedQuantity` (domain-only).                              | `id`, `actionId`, `orderProductId`, `createdAt`              |
|                              |                                                                | (entity-only).                                               |
| Кто его инстанцирует         | Mapper, тесты, factory-методы.                                | TypeORM через `Repository.findOne/save/insert`.              |

Эта таблица — самая короткая возможная формулировка правила
[[hexagonal-architecture]] на уровне persistence-слоя.

### То же самое в retail: `Order` vs `OrderEntity`

В retail-микросервисе доменный `Order` сделан ещё дальше: он
наследуется от `AggregateRoot<number | null>` из
`@retail-inventory-system/ddd`, держит закрытый
`_products: OrderProduct[]` и кодирует переходы статусов через
`applyInventoryConfirmation(...)`. Entity `Order` —
обычный TypeORM-класс:

```typescript
// apps/retail-microservice/src/modules/orders/infrastructure/persistence/order.entity.ts
@Entity('order')
export class Order {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public customerId: number;

  @Column({ type: 'enum', enum: OrderStatusEnum })
  public statusId: OrderStatusEnum;

  @ManyToOne(() => OrderStatus)
  @JoinColumn({ name: 'status_id' })
  public status: OrderStatus;

  @OneToMany(() => OrderProduct, ({ order }) => order, { cascade: ['insert', 'update'] })
  public products: OrderProduct[];

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
```

> [GitHub: apps/retail-microservice/src/modules/orders/infrastructure/persistence/order.entity.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/retail-microservice/src/modules/orders/infrastructure/persistence/order.entity.ts#L17-L43)

```typescript
// apps/retail-microservice/src/modules/orders/domain/order.model.ts
export class Order extends AggregateRoot<number | null> {
  private _customer: CustomerRef;
  private _products: OrderProduct[];
  private _status: OrderStatusVO;

  public static create(props: {
    customer: CustomerRef;
    lines: { productId: number; quantity: number }[];
  }): Order {
    if (!props.lines.length) {
      throw new Error('Order.create: cannot create an order with no line items');
    }
    // … per-quantity expansion + factory invariants
  }
}
```

> [GitHub: apps/retail-microservice/src/modules/orders/domain/order.model.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/retail-microservice/src/modules/orders/domain/order.model.ts#L43-L88)

Опять — два класса с одинаковым именем (`Order`), но в разных
namespace'ах. В domain'е тип параметризуется `number | null`,
отражая транзитный (pre-persistence) state агрегата. В entity
тип `id` — просто `number`, потому что у строки в БД id
обязан существовать. Эти два «Order» никогда не пересекаются в
одном файле, кроме мэппера и репозитория.

### Открытая оговорка: `ARCH-LINT-EX-01`

ADR-017 §6 фиксирует одно honest исключение из правила «domain
не знает про TypeORM, и port — тоже не знает»: файл
`apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts`
импортирует `EntityManager` из TypeORM, чтобы методы порта
могли принять опциональный transaction-scope:

```typescript
// apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts
// TODO(task-14): introduce an `ITransactionPort` so callers can pass an
// opaque unit-of-work token instead of TypeORM's EntityManager. Tracked in
// _carryover-12.md as ARCH-LINT-EX-01.
import { EntityManager } from 'typeorm'; // eslint-disable-line boundaries/dependencies
```

> [GitHub: apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts#L1-L4)

Это **известный долг**, не пропуск. Use case
`ReserveStockForOrderUseCase` открывает unit-of-work и должен
прокидывать его в `aggregateForProduct(..., entityManager)` и
`lockedTotalsByProduct(..., entityManager)`. Чистое решение —
ввести абстрактный `ITransactionPort`, который скрывает
`EntityManager` за интерфейсом. Этот рефактор больше, чем
scope task-12, и trackingается в `_carryover-12.md`. Подробнее
о том, как `ARCH-LINT-EX-01` влияет на сам port surface —
в [[mappers-and-repositories]].

Важно: исключение — **точечное**, в одном файле, с
`eslint-disable-line` плюс TODO, ссылающимся на код-метку.
Снять disable — и линт мгновенно ловит violation. Архитектура
честно признаёт свой компромисс.

## Связанные решения

- [[hexagonal-architecture]] — общее правило «domain не знает
  инфраструктуры».
- [[clean-architecture-layers]] — куда что попадает по слоям.
- [[mappers-and-repositories]] — кто переводит entity ↔ domain
  и как ports принимают `EntityManager`.
- [[typeorm-overview]] — как entity регистрируется в
  `DatabaseModule.forFeature([...])`.
- [[base-entity-and-base-repository]] — общий predecessor
  всех entity и общая база mapper-aware-репозитория.
- [[shared-libs-philosophy]] — почему `lib-ddd`, `lib-database`
  и `lib-contracts` — разные libs.

## Глоссарий

| Термин (EN)            | Перевод / пояснение (RU)                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| Entity (TypeORM)       | POJO с декораторами, описывающий ровно одну строку таблицы.                                            |
| Domain model           | Класс с инвариантами и поведением, framework-free.                                                    |
| Aggregate root         | Domain-объект, владеющий child-ами и единственная точка входа в инварианты агрегата.                   |
| Value object           | Domain-объект без identity; равенство структурное.                                                    |
| Mapper                 | Граничный класс entity ↔ domain. Живёт в `infrastructure/persistence/`.                                |
| Invariant              | Условие, всегда истинное для domain-объекта (например, `reservedQuantity ≤ quantity`).                  |
| Ledger                 | Append-only таблица со знаковыми дельтами. `product_stock` — ledger.                                  |
| `ARCH-LINT-EX-01`      | Documented exception: leaked `EntityManager` в `IStockRepositoryPort`. ADR-017 §6.                    |
| `AggregateRoot<TId>`   | Базовый класс из `libs/ddd` с `pullDomainEvents()`-методом.                                            |
| `Entity<TId>`          | Базовый класс из `libs/ddd` для child-сущностей агрегата.                                              |
| `ValueObject<TProps>`  | Базовый класс из `libs/ddd` для VO; структурное равенство через `equals`.                              |
| `DomainEvent<TId>`     | Базовый класс in-process domain-события из `libs/ddd`.                                                 |

## Что почитать дальше

- ADR-004 — `docs/adr/004-adopt-hexagonal-architecture-per-service.md`.
- ADR-005 — `docs/adr/005-split-shared-common-into-bounded-libs.md`,
  §3 (`BaseEntity` ID strategy).
- ADR-019 — `docs/adr/019-typeorm-and-mysql-for-persistence.md`.
- ADR-017 §6 — exception `ARCH-LINT-EX-01`.
- Eric Evans, *Domain-Driven Design: Tackling Complexity in
  the Heart of Software* — главы про Aggregate и Entity.

> [!faq]- Проверь себя
> 1. Почему `StockItem` и `ProductStock` называются по-разному,
>    хотя описывают одну и ту же бизнес-сущность?
> 2. Где живёт инвариант «`reservedQuantity <= quantity`» —
>    в domain-модели, в entity, в миграции, или во всех трёх
>    одновременно?
> 3. Почему в `ProductStock.entity.ts` нет валидации в
>    конструкторе?
> 4. Какие TypeORM-декораторы запрещены в файлах под
>    `domain/`, и какое правило ESLint это проверяет?
> 5. Что такое `ARCH-LINT-EX-01` и почему этот файл —
>    единственное место в проекте, где `import { EntityManager }
>    from 'typeorm'` появляется в `application/`-слое?
