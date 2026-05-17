---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, caching, overview, stack]
status: final
related:
  - "[[cache-aside-pattern]]"
  - "[[lib-nestjs-cache-manager]]"
  - "[[lib-cache-manager]]"
  - "[[lib-keyv]]"
  - "[[lib-keyv-redis]]"
  - "[[lib-cacheable]]"
  - "[[hexagonal-architecture]]"
  - "[[shared-libs-philosophy]]"
  - "[[module-boundaries]]"
---

# Обзор cache-стека

> [!abstract] Кратко
> Между application-кодом проекта и Redis'ом сидят пять
> NPM-библиотек, у которых на поверхности — пересекающиеся
> названия и роли. Чтобы reader не путался, эта статья —
> «диаграмма с одной стороны и порт↔адаптер с другой», а каждый
> per-library-разбор живёт в `[[lib-*]]`-статьях рядом. Слой
> сверху вниз: app-use-case → `IStockCachePort` (domain-shaped
> обёртка) → `ICachePort` из `libs/cache` (generic-port) →
> `RedisCacheAdapter` → `@nestjs/cache-manager` (DI-binding) →
> `cache-manager` (façade `get/set/del/wrap`) → `cacheable`
> (multi-tier primitive) → `keyv` (storage-adapter abstraction)
> → `@keyv/redis` (собственно Redis-клиент) → `redis://` →
> Redis.

## Проблема, которую решает

В чём вообще проблема обзора? Кэш-стек у нас — пять
библиотек со словами **cache** в названии (двух — с буквальной
строкой «cache»), и роли у них пересекаются:

- `@nestjs/cache-manager` — NestJS-обёртка над cache-manager;
- `cache-manager` — façade `get/set/del/wrap` поверх stores;
- `cacheable` — multi-tier primitive под cache-manager v7+;
- `keyv` — абстракция over storage-adapter;
- `@keyv/redis` — конкретный Redis-клиент под keyv.

Запутаться легко: казалось бы, «cache-manager — это NestJS
cache-manager?» Нет: первое — пакет на NPM, второе — Nest-обёртка
вокруг первого. «keyv — это уже Redis?» Нет: keyv — генерик
интерфейс, Redis-клиент в нём подключается через `@keyv/redis`.

Этот обзор даёт **слой за слоем** — чтобы потом per-library
статья по любой из пяти не повторяла стек целиком, а уточняла
**свой** уровень. Все названия в этой статье — пакеты
NPM или классы из них; ничего «нашего» в этом списке нет,
кроме `libs/cache`.

## Концепция

### Все слои разом

```mermaid
flowchart TB
  UC["GetStockUseCase<br/>(application)"]
  IS["IStockCachePort<br/>(application-port)"]
  SA["StockCache<br/>(infrastructure-adapter)"]
  IP["ICachePort<br/>(libs/cache, generic-port)"]
  RA["RedisCacheAdapter<br/>(libs/cache, generic-adapter)"]
  NM["@nestjs/cache-manager<br/>(NestJS DI-binding)"]
  CM["cache-manager<br/>(façade: get/set/del/wrap)"]
  CB["cacheable<br/>(multi-tier primitive)"]
  KV["keyv<br/>(storage-adapter abstraction)"]
  KR["@keyv/redis<br/>(Redis-клиент)"]
  RC[("Redis<br/>(redis://...)")]

  UC -->|inject STOCK_CACHE| IS
  IS -.binding.-> SA
  SA -->|inject CACHE_PORT| IP
  IP -.binding.-> RA
  RA -->|@Inject CACHE_MANAGER| NM
  NM -.creates.-> CM
  CM -->|stores[]| CB
  CB -->|primary.store| KV
  KV -->|store| KR
  KR -->|TCP| RC

  style IS fill:#eef
  style IP fill:#eef
  style SA fill:#fec
  style RA fill:#fec
```

Сразу четыре наблюдения:

- **Каждый слой добавляет ровно одну новую вещь.** `IStockCachePort`
  добавляет **знание domain-формы** (`{ productId, storageIds }`,
  не строка). `ICachePort` добавляет **общий контракт**
  (`get/set/del/wrap/delByPrefix`). `RedisCacheAdapter` добавляет
  **OTel-spans и SCAN-reach-through**. `cache-manager` —
  **wrap-API** и multi-store сворачивание. `cacheable` —
  multi-tier-стратегию. `keyv` — **намespacing/serialize**.
  `@keyv/redis` — **TCP-Redis-client**. Если убрать любой
  слой, в проекте нечем будет заменить именно эту функцию.
- **Граница «наше» / «чужое» — на `RedisCacheAdapter`.**
  Слои выше — наш код. Слои ниже — NPM. Граница — это место
  port↔adapter ([[hexagonal-architecture]]).
- **Слои dirty-cooperate, не stack-cleanly.** `RedisCacheAdapter.delByPrefix`
  читает `cache.stores[0].store`, чтобы добраться до
  `@keyv/redis.client.scanIterator(...)`. Это «reach-through»
  через четыре слоя. ADR-016 §2 явно ставит **это** как
  единственную причину держать reach-through в одном файле —
  чтобы поломка от cacheable-major-bump'а не растеклась по
  app'у.
- **App видит только верх стека.** Use-case инжектит
  `IStockCachePort` (или `ICachePort` напрямую — для не-stock-кэшей);
  про cache-manager / keyv / @keyv/redis app-код знать
  ничего не должен и **не может** ([[module-boundaries]] —
  линт-правило).

### Кто за что отвечает

Слой-за-слоем, сверху вниз — а конкретные строки кода
в `[[lib-*]]`-статьях:

| Слой | Концерн | Кто принимает решение |
|---|---|---|
| `GetStockUseCase` / `ReserveStockForOrderUseCase` | Когда читать кэш, когда инвалидировать, что считать stale | Application-логика проекта |
| `IStockCachePort` | Domain-shape (`productId`, `storageIds`) | `libs/cache` не знает про domain — wrapper port в app'е |
| `StockCache` | Связь domain-shape ↔ generic key (через `CACHE_KEYS`) | App-infrastructure |
| `ICachePort` | Generic-API `get/set/del/wrap/delByPrefix` | `libs/cache` |
| `RedisCacheAdapter` | OTel-spans + структурный reach-through к Redis-клиенту | `libs/cache` |
| `@nestjs/cache-manager` | DI-binding `CACHE_MANAGER` → `Cache` instance | NPM (`@nestjs/cache-manager`) |
| `cache-manager` | Façade `get/set/del/wrap`, multi-store dispatch | NPM (`cache-manager`) |
| `cacheable` | Multi-tier primitive (L1 + L2 + ...) под `cache-manager v7+` | NPM (`cacheable`) |
| `keyv` | KeyvStoreAdapter-интерфейс, namespacing, default TTL | NPM (`keyv`) |
| `@keyv/redis` | TCP-клиент Redis: connection-pool, SCAN, UNLINK, RESP-protocol | NPM (`@keyv/redis`) |
| Redis | Сам storage | docker / managed Redis |

### Граница «наш код / чужой код»

В каждом app'е (`apps/*/src`) **запрещены** импорты:

- `@nestjs/cache-manager`
- `cache-manager`
- `cacheable`
- `keyv`
- `@keyv/redis`

— любые. Это правило `eslint-plugin-boundaries` (см.
[[module-boundaries]] + [ADR-017](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/adr/017-architecture-lint-via-eslint-boundaries.md)
+ ADR-016 §2). Единственное место в репозитории, где эти
пакеты импортируются — `libs/cache/`. Это даёт три follow-up'а:

1. **Бамп cacheable major.** В одном файле — `redis-cache.adapter.ts`.
2. **Замена keyv на что-то ещё.** В двух файлах — `redis-cache.adapter.ts`
   и `cache-module.config.ts`.
3. **Полная замена Redis на in-memory для unit'ов.** Внутри
   `libs/cache` подменяется `cacheModuleConfig`, app-код не
   меняется.

Лицо границы — `ICachePort` и `RedisCacheAdapter`:

```typescript
// libs/cache/cache.port.ts
export const CACHE_PORT = Symbol('CachePort');

export interface ICachePort {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  delByPrefix(prefix: string): Promise<number>;
  wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
}
```

> [GitHub: libs/cache/cache.port.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/cache/cache.port.ts#L1-L20)

```typescript
// libs/cache/cache.module.ts
@Global()
@Module({
  imports: [NestCacheModule.registerAsync(cacheModuleConfig)],
  providers: [RedisCacheAdapter, { provide: CACHE_PORT, useExisting: RedisCacheAdapter }],
  exports: [NestCacheModule, CACHE_PORT, RedisCacheAdapter],
})
export class CacheModule {}
```

> [GitHub: libs/cache/cache.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/cache/cache.module.ts#L15-L21)

`@Global()` означает «один раз импортирован в app-root, и
`CACHE_PORT` resolves везде» — feature-модули не должны заново
импортировать `CacheModule`. Под капотом тот же
`NestCacheModule.registerAsync(...)` — но это деталь
infrastructure'ы (см. [[lib-nestjs-cache-manager]]).

### Конфиг — одна factory, единственный связник app'а с пакетами

```typescript
// libs/cache/cache-module.config.ts
import KeyvRedis from '@keyv/redis';
import { CacheModuleAsyncOptions } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';

export const cacheModuleConfig: CacheModuleAsyncOptions = {
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => ({
    stores: [new KeyvRedis(configService.get<string>('REDIS_URL'))],
    ttl: configService.get<number>('CACHE_TTL_MS_DEFAULT'),
  }),
  isGlobal: true,
};
```

> [GitHub: libs/cache/cache-module.config.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/cache/cache-module.config.ts#L1-L12)

Десять строк. Что они говорят:

- `new KeyvRedis(REDIS_URL)` — создаём storage-adapter `keyv`
  с Redis-клиентом под капотом (это и есть `@keyv/redis`).
  Здесь — единственное место в проекте, где имя пакета
  `@keyv/redis` встречается.
- `stores: [...]` — `cache-manager v7+` принимает массив,
  потому что под капотом ему передают `cacheable`-primitive
  с поддержкой L1+L2 multi-tier. У нас только L2 (Redis); L1
  (in-process) добавится без изменения app-кода.
- `ttl: CACHE_TTL_MS_DEFAULT` — глобальный default для
  любого `set()` без явного TTL. См. [[cache-aside-pattern]] —
  переопределяется `CACHE_TTL_MS_PRODUCT_STOCK` в stock-обёртке.
- `isGlobal: true` — `CACHE_MANAGER` доступен повсюду без
  re-import'а Nest-модуля.

### Адаптер: внутренности reach-through'а

`RedisCacheAdapter.delByPrefix` — единственная функция в
проекте, которая «знает все слои стека» и расковыривает
их структурно. Она же даёт hands-on демонстрацию, **почему**
у нас именно эти пять библиотек, а не одна:

```typescript
// libs/cache/redis-cache.adapter.ts
public async delByPrefix(prefix: string): Promise<number> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan('cache.delByPrefix', async (span) => {
    span.setAttribute('cache.prefix', prefix);
    try {
      const adapter = this.getRedisAdapter();
      if (!adapter) {
        span.setAttribute('cache.backend', 'non-redis');
        span.setAttribute('cache.keys_unlinked', 0);
        return 0;
      }

      const rawClient = adapter.client;
      // ...

      const client = rawClient as unknown as IRedisScanClient;
      const keyPrefix = adapter.namespace
        ? `${adapter.namespace}${adapter.keyPrefixSeparator}`
        : '';
      const pattern = `${keyPrefix}${prefix}*`;

      const matchedKeys = new Set<string>();
      for await (const batch of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        for (const key of batch) matchedKeys.add(key);
      }

      if (matchedKeys.size === 0) {
        // ...
        return 0;
      }

      await client.unlink([...matchedKeys]);
      // ...
      return matchedKeys.size;
    } finally {
      span.end();
    }
  });
}

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

> [GitHub: libs/cache/redis-cache.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/cache/redis-cache.adapter.ts#L95-L166)

Прочитаем сверху вниз через линзу стека:

1. **`this.cache`** — `@nestjs/cache-manager`'s `Cache`
   instance, инжектится через `@Inject(CACHE_MANAGER)`.
2. **`cache.stores`** — массив `Keyv`-инстансов (новое в
   cache-manager v7+, потому что под капотом — `cacheable`).
3. **`stores[0]?.store`** — `Keyv`'s underlying storage —
   instanceof `KeyvRedis`.
4. **`adapter.client`** — `@keyv/redis`'s underlying redis
   client (`@redis/client`).
5. **`client.scanIterator({ MATCH: pattern, COUNT: 100 })`** —
   bone-naked Redis-SCAN.
6. **`client.unlink([...matchedKeys])`** — bone-naked
   Redis-UNLINK.

Поверх этого — OTel-span'ы (`cache.prefix`, `cache.keys_unlinked`,
`cache.backend`) для дебага в Jaeger. Об этом канале трейсинга
— в [[trace-log-correlation]] (forward-link).

«Defensively» — если `stores[]` пустой или `.store` не `KeyvRedis`
(in-memory store в unit-тестах), возвращаем 0. Cluster/Sentinel
тоже branch'нем в no-op, потому что у них SCAN устроен иначе.

### Что вне стека

Не входит в стек, но связано:

- **`libs/observability/tracer.ts`** — настройка OTel-SDK;
  патчит `@redis/client` через
  `@opentelemetry/auto-instrumentations-node` так, что каждая
  Redis-команда уже становится span'ом сама по себе. Наш
  `cache.*` span — это **поверх** auto-instrumentation, для
  domain-уровневой видимости hit/miss.
- **`libs/cache/decorators/cacheable.decorator.ts`** —
  декоратор `@Cacheable({ key, ttlMs })`. На сегодня нигде
  не применён (опциональный read-through-sugar), но шаблон
  заложен — `[[lib-cacheable]]` имеет в виду пакет, не
  декоратор; не путать.

## Применение в проекте

Сводя всё к конкретике: один RPC `inventory.product-stock.get`
ходит по стеку так.

1. **`StockController.@MessagePattern(...)`** принимает payload.
2. **`GetStockUseCase.execute(payload)`** инжектит
   `IStockCachePort` (DI-символ `STOCK_CACHE`).
3. **`StockCache.get({ productId, storageIds, correlationId })`** строит
   ключ через `CACHE_KEYS.inventoryStock(...)` и зовёт
   `this.cache.get(cacheKey)`, где `this.cache` — `ICachePort`
   (DI-символ `CACHE_PORT`).
4. **`RedisCacheAdapter.get(key)`** оборачивает в OTel-span
   `cache.get` и зовёт `this.cache.get(key)`, где `this.cache`
   — `Cache` из `@nestjs/cache-manager`.
5. **`@nestjs/cache-manager`'s `Cache`** делегирует в
   `cache-manager`'s façade.
6. **`cache-manager`** диспетчеризует в `stores[0]` — наш
   единственный `Keyv`(-`@keyv/redis`)-store.
7. **`cacheable`** (под капотом `cache-manager v7+`) исполняет
   multi-tier стратегию — у нас единственный tier (`primary`).
8. **`keyv`** инкапсулирует ключ namespace'ом (у нас пусто) и
   сериализацией (JSON по умолчанию), вызывает
   `keyvRedis.get(key)`.
9. **`@keyv/redis`** делает `GET <namespaced-key>` через
   `@redis/client`.
10. **Redis** возвращает значение или nil.

И обратно — по 10 кадрам того же стека, в обратную сторону.
Латентность реального hit'а — два-три миллисекунды (это в
основном TCP); промах + DB-агрегация — 30-50ms. Cost/benefit
оправдан.

Для invalidate стек тот же, но в `delByPrefix`-форме (SCAN +
UNLINK на 5-м слое сверху, минуя 6–8 — потому что
`cacheable` / `cache-manager` / `keyv` не имеют primitive'а
для prefix-iterate).

## Связанные решения

- [[cache-aside-pattern]] — паттерн от первых принципов,
  read и invalidate-flow.
- [[lib-nestjs-cache-manager]] — Nest-обёртка над cache-manager,
  что она делает и **не делает**.
- [[lib-cache-manager]] — façade `get/set/del/wrap`, multi-store
  dispatch.
- [[lib-keyv]] — storage-adapter abstraction; `keyv` сам по себе
  ни к чему не подключён.
- [[lib-keyv-redis]] — Redis-клиент, который встаёт **в** `keyv`.
- [[lib-cacheable]] — multi-tier-primitive под cache-manager v7+;
  через него `RedisCacheAdapter` reach-through'ит до
  `@keyv/redis`.
- [[hexagonal-architecture]] — почему `ICachePort` — в
  application/, а `RedisCacheAdapter` — в infrastructure/.
- [[shared-libs-philosophy]] — почему `libs/cache` отдельная.
- [[module-boundaries]] — линт-правило, запрещающее
  `cache-manager` / `keyv` / `@keyv/redis` / `cacheable` в `apps/*/src`.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `@nestjs/cache-manager` | NPM-пакет. NestJS-обёртка над `cache-manager`: `NestCacheModule`, `CACHE_MANAGER`-токен, `Cache`-инжектируемый. |
| `cache-manager` | NPM-пакет. Façade-уровень: `get/set/del/wrap`, multi-store. |
| `cacheable` | NPM-пакет. Multi-tier primitive под `cache-manager v7+`. |
| `keyv` | NPM-пакет. Storage-adapter abstraction. Сам по себе ничего не хранит. |
| `@keyv/redis` | NPM-пакет. Redis-клиент в форме keyv-store. |
| `Cache` (тип) | Класс из `@nestjs/cache-manager`. Поинтер на сложенный façade. |
| `CACHE_MANAGER` | DI-токен (Symbol) от `@nestjs/cache-manager`. |
| `Store` | Концепт `cache-manager v7+`/cacheable — один tier из `stores[]`. |
| `KeyvStoreAdapter` | Интерфейс keyv. Реализации: `@keyv/redis`, `@keyv/mongo`, in-memory… |
| `KeyvRedis` | Класс `@keyv/redis`. `KeyvStoreAdapter`-имплементация over Redis. |
| Reach-through | Структурный доступ через несколько слоёв стека. У нас — в одном файле. |
| Multi-tier cache | L1 (in-process) + L2 (shared, e.g. Redis) + ...; `cacheable` это умеет. |
| Namespace (keyv) | Prefix к каждому ключу; у нас пусто (см. cache-module.config.ts). |
| `keyPrefixSeparator` | Разделитель между namespace и ключом в keyv. |

> [!faq]- Проверь себя
> 1. Если завтра выйдет `cacheable@3` с breaking changes, в
>    скольких файлах придётся менять код?
> 2. Зачем `cache-manager v7+` поверх `cacheable`, а не
>    напрямую `cacheable`? Что у первого есть, чего нет у
>    второго?
> 3. Где **единственное** место в репозитории, в котором
>    инстанциируется `new KeyvRedis(...)`?
> 4. Почему `RedisCacheAdapter` не использует
>    `cache-manager.del(key)` для invalidate-by-prefix?
>    (Подсказка: cache-manager не имеет primitive'а под
>    SCAN.)
> 5. Что произойдёт, если в `apps/inventory-microservice/.../get-stock.use-case.ts`
>    добавить `import { Cache } from '@nestjs/cache-manager'`?

## Что почитать дальше

- [`cache-manager` README](https://github.com/jaredwray/cache-manager)
  — текущее состояние API после v7, multi-store, поднимавшийся
  cacheable.
- [`keyv` README](https://keyv.org/) — список адаптеров, философия
  «один интерфейс ко всем хранилищам».
- [`@keyv/redis` README](https://www.npmjs.com/package/@keyv/redis)
  — что унаследовано от `@redis/client v5`, что добавлено keyv-обёрткой.
- [Redis docs — SCAN+UNLINK](https://redis.io/commands/scan/) —
  как итерироваться по ключам без блокировки event-loop'а.
