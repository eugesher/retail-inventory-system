---
created: 2026-05-15
updated: 2026-05-16
tags: [retail-inventory-system, caching, library]
status: review
related:
  - "[[cache-stack-overview]]"
  - "[[cache-aside-pattern]]"
  - "[[lib-nestjs-cache-manager]]"
  - "[[lib-cacheable]]"
  - "[[lib-keyv]]"
  - "[[shared-libs-philosophy]]"
---

# Библиотека: `cache-manager`

> [!abstract] Кратко
> `cache-manager` — npm-пакет, который даёт **façade-уровень
> get/set/del/wrap** поверх любого набора storage-back-end'ов.
> До v7 он сам хранил состояние через `Store`-интерфейс; с v7
> он делегирует это `cacheable`-primitive'у и принимает массив
> `stores[]`. В нашем стеке он стоит **между**
> `@nestjs/cache-manager` (которая его регистрирует в DI) и
> `cacheable` (который собственно держит multi-tier-state). В
> `apps/*/src` импорт `cache-manager` запрещён — единственный
> легальный потребитель, `RedisCacheAdapter`, инжектит `Cache`
> через `@Inject(CACHE_MANAGER)` и зовёт `cache.get/set/del`.
> SCAN/UNLINK через `cache-manager` сделать нельзя — пакет
> такого primitive'а не даёт; для этого `RedisCacheAdapter`
> обходит façade и идёт прямо в `KeyvRedis.client`.

## Что этот пакет делает

`cache-manager` — это узкая, на четыре метода façade-обёртка
над storage. Контракт `Cache` (тип, импортируемый через
`@nestjs/cache-manager` из `cache-manager`):

- **`get<T>(key): Promise<T | null>`** — прочитать значение.
- **`set(key, value, ttlMs?): Promise<void>`** — записать с
  optional TTL.
- **`del(key): Promise<void>`** — удалить.
- **`wrap(key, fn, ttlMs?): Promise<T>`** — single-call
  cache-aside: «прочитать, если есть; иначе вызвать `fn()` и
  закэшировать результат».

И полу-приватный:

- **`stores: Store[]`** (publicly accessible как
  `cache.stores`) — массив активных store'ов; читается
  `RedisCacheAdapter`'ом для reach-through (см.
  [[cache-stack-overview]]).

### Multi-store dispatch

С v7 `cache-manager` принимает массив stores и под капотом
делегирует `cacheable`-primitive'у. У нас один store:

```typescript
// libs/cache/cache-module.config.ts
useFactory: (configService: ConfigService) => ({
  stores: [new KeyvRedis(configService.get<string>('REDIS_URL'))],
  ttl: configService.get<number>('CACHE_TTL_MS_DEFAULT'),
}),
```

> [GitHub: libs/cache/cache-module.config.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/cache/cache-module.config.ts#L1-L12)

Если бы их было два (например L1 in-memory + L2 Redis),
`cache-manager` спросил бы первый, при miss'е спросил второй,
при miss'е на втором отдал `null`. Конкретные политики
multi-tier-strategy — это `cacheable` (см. [[lib-cacheable]]),
не `cache-manager`.

### `wrap` — единственный нетривиальный метод

`wrap` — то, что в [[cache-aside-pattern]] называется «read-through
syntactic sugar над cache-aside»:

```typescript
const stock = await cache.wrap(
  cacheKey,
  async () => {
    return repository.aggregateForProduct(productId);
  },
  60_000,
);
```

Эквивалент в сухом виде:

```typescript
let value = await cache.get<typeof loader>(key);
if (value === null || value === undefined) {
  value = await loader();
  await cache.set(key, value, 60_000);
}
return value;
```

В нашем `RedisCacheAdapter.wrap` мы **не** вызываем
`cache-manager`-ный wrap — вместо этого пишем те же три шага
вручную, чтобы оборачивать каждый из них в OTel-span:

```typescript
// libs/cache/redis-cache.adapter.ts
public async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan('cache.wrap', async (span) => {
    span.setAttribute('cache.key', key);
    try {
      const cached = await this.get<T>(key);
      if (cached !== undefined) {
        span.setAttribute('cache.hit', true);
        return cached;
      }
      span.setAttribute('cache.hit', false);
      const value = await fn();
      await this.set(key, value, ttlMs);
      return value;
    } finally {
      span.end();
    }
  });
}
```

> [GitHub: libs/cache/redis-cache.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/cache/redis-cache.adapter.ts#L75-L93)

Это сознательный выбор: домен-уровневый `cache.wrap`-span с
атрибутом `cache.hit` ценнее, чем чистое делегирование в
`cache-manager.wrap`. Если ситуация поменяется, перейти
обратно — три строки.

### Тип `Cache` под капотом

`Cache` — это объект-instance, полученный из
`cache-manager.createCache(options)`. Он держит:

- `stores: Keyv[]` (Public, но обращаемся осторожно — см.
  [[cache-stack-overview]] §«Адаптер: внутренности reach-through»).
- Internal hooks `'set'`, `'get'`, `'del'`, `'clear'` —
  EventEmitter-style; мы их не используем.
- Bypass-logic для concurrent get's (минимальная — без
  single-flight; см. `CACHE-001` в [[cache-aside-pattern]]).

Сам `Cache` — `@nestjs/cache-manager`'s job — instantiation в
DI; см. [[lib-nestjs-cache-manager]].

## Что этот пакет НЕ делает

- **Не говорит с Redis.** `cache-manager` не знает, что
  такое Redis-протокол. Он умеет только `keyvStore.get/set/del`
  (где `keyvStore` — это что-то с `KeyvStoreAdapter`-shape'ом
  из [[lib-keyv]]).
- **Не делает сериализацию.** Сериализация — внутри Keyv (JSON
  по default'у). `cache-manager` принимает any и any же
  возвращает.
- **Не управляет connection-lifecycle.** Реконнект, pool,
  TLS — Redis-client'а под `@keyv/redis`.
- **Не делает SCAN / KEYS / pattern-match.** `cache-manager`
  знает только один точный ключ. Для prefix-iterate'а
  `RedisCacheAdapter` обходит façade — это и было причиной
  audit'а `CACHE-006` до его закрытия в ADR-016 (см.
  [[lib-cacheable]] и [[cache-aside-pattern]]).
- **Не разрешает namespace или key-prefix.** Это уровень
  `keyv` (`namespace`, `keyPrefixSeparator`).
- **Не делает single-flight / stampede-protection.** Два
  параллельных `cache.wrap(...)` на один ключ при cold-miss'е
  оба пойдут в `fn()`. `CACHE-001` это и фиксирует как
  открытый.
- **Не делает TTL-jitter.** TTL — буквальное число
  миллисекунд. Любые ±10%-jitter'ы — забота вызывающего;
  `CACHE-004` это фиксирует как открытый.

### stores[] и cacheable: версии v4 vs v7

До `cache-manager v5` API было:

```typescript
const cache = caching('redis', { /* ... */ });
```

Один backend, описан строкой. С `v7` пакет был полностью
переписан: storage идёт через `keyv`, multi-tier — через
`cacheable`. Поэтому в проекте `cache-manager@7.x` и
`@nestjs/cache-manager@3.x` (новая обёртка) — связанные
мажорные версии. Если кто-то увидит в чужом проекте
`cache-manager@4` с `store: redisStore` — это старый API; у
нас он не работает.

ADR-006 это явно отмечает: переезд на v7+ сделан до
введения `libs/cache`-port'а, и контракт `Cache` теперь —
тот, что описан выше.

## Связанные решения

- [[cache-stack-overview]] — где `cache-manager` стоит в
  стеке (между `@nestjs/cache-manager` и `cacheable`).
- [[lib-nestjs-cache-manager]] — кто строит `Cache`-инстанс и
  регистрирует его в Nest-DI.
- [[lib-cacheable]] — multi-tier-primitive, через который
  `cache-manager@7+` хранит state.
- [[lib-keyv]] — storage-adapter abstraction, через которую
  стек спускается к Redis-клиенту.
- [[cache-aside-pattern]] — где `cache.wrap` — это
  syntactic sugar над паттерном, а не альтернатива ему.
- [[shared-libs-philosophy]] — почему `cache-manager`
  импортируется только в `libs/cache`.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `cache-manager` | NPM-пакет façade-уровня. |
| `Cache` (тип) | Объект из `cache-manager.createCache(...)`. Имеет `get/set/del/wrap` и `stores`. |
| `Store` | Концепт `cache-manager v7+` — один tier multi-tier-кэша. У нас — один (Redis). |
| `wrap` | Метод single-call read-through. Эквивалент трёх шагов «get-miss → loader → set». |
| `createCache` | Фабрика `cache-manager`'а. У нас её не зовут напрямую — это делает `@nestjs/cache-manager`. |
| `cache.stores` | Массив `Keyv`-инстансов. Public, но обращаемся структурно (см. reach-through). |

> [!faq]- Проверь себя
> 1. Чем `Cache.wrap(...)` отличается от ручной пары
>    `cache.get(...)` + `cache.set(...)` в `if (miss) { ... }`?
> 2. Почему мы переписали `wrap` в `RedisCacheAdapter`, а
>    не использовали `Cache.wrap` как есть?
> 3. Что такое `cache.stores[0].store` в нашей конфигурации?
>    (Подсказка: тип ответа — `KeyvRedis`.)
> 4. Что произойдёт с проектом, если кто-то снизит
>    `cache-manager` до `^5.0.0`?

## Что почитать дальше

- [`cache-manager` README](https://github.com/jaredwray/cache-manager)
  — текущее v7-API, multi-store, migration guide с v5.
- [[lib-keyv]] — что такое keyv-store; формат
  `KeyvStoreAdapter`.
- [[lib-cacheable]] — multi-tier primitive под капотом.
