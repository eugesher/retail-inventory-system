---
created: 2026-05-15
updated: 2026-05-16
tags: [retail-inventory-system, caching, library]
status: review
related:
  - "[[cache-stack-overview]]"
  - "[[lib-cache-manager]]"
  - "[[lib-keyv-redis]]"
  - "[[lib-cacheable]]"
  - "[[shared-libs-philosophy]]"
---

# Библиотека: `keyv`

> [!abstract] Кратко
> `keyv` — это **абстракция over storage-adapter**: один
> tiny-интерфейс `KeyvStoreAdapter` с тремя методами
> `get/set/delete` плюс namespace'инг и сериализация. Сам по
> себе `keyv` ничего не хранит — он **seam** в стеке, в
> который подключается конкретный storage-клиент. У нас в
> этот seam воткнут `@keyv/redis` (см. [[lib-keyv-redis]]).
> Та же абстракция бесплатно даёт переключиться на
> `@keyv/sqlite`, `@keyv/mongo`, in-memory или что-то ещё без
> изменений в верхних слоях (cache-manager, cacheable,
> RedisCacheAdapter, app-код). В проекте `keyv` напрямую не
> упоминается ни разу — но мы пользуемся им через
> `cache-manager@7+`, который держит `stores: Keyv[]`.

## Зачем оно нам

`cache-manager` (см. [[lib-cache-manager]]) до v7 имел свой
собственный `Store`-интерфейс с тремя-четырьмя кастомными
методами; каждый адаптер (Redis, mongo, fs) писался под
этот интерфейс отдельно. С v7 команда `cache-manager`
сменила стратегию: вместо «делать свой стандарт для
адаптеров» — переиспользовать **существующий, уже
стандартный** интерфейс `KeyvStoreAdapter` из npm-экосистемы
keyv. Это даёт `cache-manager`-у бесплатный доступ к ~20
готовым backend'ам keyv'а (Redis, etcd, sqlite, postgresql,
mongo, dynamodb, lru-memory, ...).

В нашем стеке `keyv` — это **shim**: цепочка
`cache-manager → keyv → @keyv/redis → Redis`. Подмена
`@keyv/redis` на `@keyv/sqlite` поменяет один файл
конфигурации; app-код не заметит.

## Что этот пакет делает

### Узкий интерфейс `KeyvStoreAdapter`

Минимальный контракт, который должен реализовать любой
конкретный adapter (`@keyv/redis`, `@keyv/mongo`, ...):

```typescript
interface KeyvStoreAdapter {
  get(key: string): Promise<StoredValue | undefined>;
  set(key: string, value: StoredValue, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  // optional:
  clear?(): Promise<void>;
  has?(key: string): Promise<boolean>;
  // and adapter-specific niceties:
  // — Iterator (для backend'ов, что умеют list keys);
  // — disconnect (для управляемого reconnect'а).
}
```

Это не наш интерфейс, и мы его не определяем — это
интерфейс npm-пакета `keyv`. Реализации (вроде `KeyvRedis`)
просто implement'ят его и опционально добавляют **свои**
дополнительные методы поверх — например, `KeyvRedis` имеет
public `client: RedisClient` для доступа к нижележащему
Redis-клиенту (это критично для нашего reach-through на
SCAN; см. [[lib-keyv-redis]]).

### Namespacing и keyPrefixSeparator

Чтобы один Redis-инстанс могли делить несколько систем,
`keyv` поддерживает namespace'инг. Каждый ключ перед уходом
в storage оборачивается:

```
${namespace}${keyPrefixSeparator}${key}
```

— например, `myapp:user:42` где `myapp` — namespace,
`:` — separator. У нас в проекте namespace **не задан**
(default — пусто), поэтому ключи попадают в Redis ровно
такими, как вы их видите в `CACHE_KEYS.inventoryStock(...)`.

Это важный нюанс для `RedisCacheAdapter.delByPrefix`: он
читает `adapter.namespace` и `adapter.keyPrefixSeparator`,
чтобы правильно построить SCAN-pattern:

```typescript
// libs/cache/redis-cache.adapter.ts
const keyPrefix = adapter.namespace
  ? `${adapter.namespace}${adapter.keyPrefixSeparator}`
  : '';
const pattern = `${keyPrefix}${prefix}*`;
```

> [GitHub: libs/cache/redis-cache.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/cache/redis-cache.adapter.ts#L119-L128)

Если namespace добавится в `cache-module.config.ts` позже,
этот код продолжит работать без правки — pattern будет
правильно ставить prefix.

### Сериализация

Default-сериализатор keyv'а — JSON. Когда вы пишете
`cache.set(key, { foo: 1 })`, между `cache-manager` и
`@keyv/redis` keyv делает `JSON.stringify`; на чтении —
`JSON.parse`. У нас всё хранимое — `ProductStockGetResponseDto`,
которое успешно JSON-roundtrip'ится; serialization-edge-cases
(Date, BigInt, Map) у нас отсутствуют.

`keyv` позволяет подменить сериализатор (например, на
msgpack), но в проекте этим не пользуемся — default подходит.

## Что этот пакет НЕ делает

- **`keyv` — не Redis-клиент.** Это seam, в который втыкается
  конкретный клиент. Сам `npm install keyv` ничего к Redis
  подключить не сможет — нужен `@keyv/redis`.
- **Не определяет single-flight / stampede protection.** Это
  ответственность вызывающего кода (или, в нашем случае,
  открытый аудит-item `CACHE-001`).
- **Не делает SCAN / KEYS / pattern-match как часть
  интерфейса.** `KeyvStoreAdapter` знает только точные
  ключи. SCAN — это нативная фича Redis, и достучаться до неё
  через `keyv` нельзя — только через
  `KeyvRedis-instance.client` (см. [[lib-keyv-redis]]).
- **Не делает retry / connection-pool / fault-tolerance.**
  Подключение к storage — забота конкретного адаптера.
- **Не управляет TTL за вас.** TTL приходит из `cache.set`-вызова
  (третий аргумент); keyv лишь прокидывает его в адаптер.
  Сам keyv не имеет какой-либо «политики TTL по
  default'у» — глобальный default приходит с уровня
  `cache-manager`'а.
- **Не делает namespacing'а content-aware.** Namespace —
  плоский префикс; никаких иерархий по
  `service:aggregate:id` keyv не понимает — это уже наш
  `CACHE_KEYS`-builder.

## В коде проекта

`keyv` явно нигде не импортируется. Он попадает в зависимости
транзитивно — `@keyv/redis` требует `keyv` peer-dep'ом.
`cache-manager v7+` принимает `Keyv`-инстансы в `stores: []`.
Наша единственная точка соприкосновения — `new KeyvRedis(REDIS_URL)`
в `cache-module.config.ts`: этот вызов создаёт `Keyv`-инстанс,
**внутри которого** стоит `KeyvRedis`-store.

Реальная структура объекта в runtime:

```
Cache (cache-manager)
└── stores: [
      Keyv {                          ← keyv
        namespace: '',
        keyPrefixSeparator: ':',
        opts: {...},
        store: KeyvRedis {            ← @keyv/redis
          client: RedisClient {...}    ← @redis/client
        }
      }
    ]
```

`RedisCacheAdapter.getRedisAdapter()` ровно по этой структуре
и спускается:

```typescript
// libs/cache/redis-cache.adapter.ts
private getRedisAdapter(): KeyvRedis<unknown> | undefined {
  const cache = this.cache as unknown as {
    stores?: readonly { store?: unknown }[];
  };
  const stores = cache.stores;
  if (!stores || stores.length === 0) return undefined;
  const underlying = stores[0]?.store;
  return underlying instanceof KeyvRedis ? (underlying as KeyvRedis<unknown>) : undefined;
}
```

> [GitHub: libs/cache/redis-cache.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/cache/redis-cache.adapter.ts#L154-L165)

`stores[0]?.store` — это и есть наш `KeyvRedis`-инстанс
**внутри** Keyv-обёртки. Иными словами, `keyv` стоит между
`cache-manager` и `@keyv/redis`, как и обещано на диаграмме
[[cache-stack-overview]].

## Связанные решения

- [[cache-stack-overview]] — где `keyv` в общей диаграмме
  (между cache-manager и @keyv/redis).
- [[lib-cache-manager]] — кто потребляет `Keyv`-store.
- [[lib-keyv-redis]] — конкретный Redis-клиент в keyv-обёртке.
- [[lib-cacheable]] — multi-tier primitive, который тоже
  читает `keyv`-store структурно.
- [[shared-libs-philosophy]] — почему весь стек `keyv +
  @keyv/redis` собран в `libs/cache`.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `keyv` | NPM-пакет. Storage-adapter abstraction для cache-backend'ов. |
| `Keyv` (class) | Класс-обёртка, который держит `KeyvStoreAdapter`-implementor + namespace + сериализатор. |
| `KeyvStoreAdapter` | Интерфейс адаптера `keyv`. Три обязательных метода: `get`, `set`, `delete`. |
| Namespace (keyv) | Префикс ко всем ключам; default — пусто. |
| `keyPrefixSeparator` | Разделитель namespace ↔ key. Default — `:`. |

> [!faq]- Проверь себя
> 1. Если завтра переключить cache-backend с Redis на
>    in-memory для unit-тестов, в скольких файлах поменяется
>    код?
> 2. Где задаётся namespace для `keyv`-ключей в нашей
>    конфигурации? (Подсказка: нигде — он пустой.)
> 3. Какие три метода обязан реализовать любой
>    `KeyvStoreAdapter`? Что произойдёт, если адаптер не
>    реализует `clear`?
> 4. Почему `cache-manager v7+` отказался от своего
>    `Store`-интерфейса в пользу `KeyvStoreAdapter`'а?

## Что почитать дальше

- [`keyv` README](https://keyv.org/) — философия пакета, список
  адаптеров, кастомные сериализаторы.
- [[lib-keyv-redis]] — конкретный Redis-store, который
  стоит в нашем стеке.
