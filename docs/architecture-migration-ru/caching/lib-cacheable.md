---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, caching, library, multi-tier]
status: final
related:
  - "[[cache-stack-overview]]"
  - "[[cache-aside-pattern]]"
  - "[[lib-cache-manager]]"
  - "[[lib-keyv]]"
  - "[[lib-keyv-redis]]"
  - "[[shared-libs-philosophy]]"
  - "[[module-boundaries]]"
---

# Библиотека: `cacheable`

> [!abstract] Кратко
> `cacheable` — npm-пакет, который стоит **внутри**
> `cache-manager v7+` и реализует **multi-tier** cache primitive
> (L1 in-process + L2 shared + ...). У нас L1 — отсутствует
> сегодня; единственный tier — `@keyv/redis`. Но именно через
> `cacheable` `cache-manager v7+` хранит и dispatch'ит свои
> stores. **`RedisCacheAdapter.delByPrefix` не использует
> `cacheable` напрямую** — он реализует SCAN+UNLINK через
> reach-through `cache.stores[0].store → KeyvRedis → client`.
> Это — единственное оставшееся reach-through-чувствительное
> место, и ADR-016 §2 формально это допускает в обмен на то,
> что в `apps/*/src` не остаётся ни одного импорта чужих
> кэш-библиотек. Audit-finding `CACHE-006` (хрупкость reach-through'а
> при cacheable-major-bump) **закрыт** этим переездом — теперь
> поломка локализована в один файл.

## Что этот пакет делает

`cacheable` — это primitive, который умеет:

- хранить **массив** `KeyvStoreAdapter`-инстансов (`primary`,
  `secondary`, ... в общем «`stores`»);
- на `get(key)` — пытаться L1 → L2 → ... до первого hit'а;
- на `set(key, value, ttl)` — писать **во все** tier'ы;
- на `del(key)` — удалять из всех;
- опционально — promote L2-hit в L1 (warm-up).

В `cache-manager v7+` его роль: хранить state. Если до v7
`Cache.stores` был просто `Store[]`, то в v7+ под капотом
живёт `cacheable`-instance с тем же массивом, переименованным
в `keyv[]`. Поэтому `cache.stores` — это всё ещё public,
читать его можно (и нужно — для reach-through), но
семантически это уже keyv-уровень.

В нашем стеке нет L1 (in-process LRU нету пока) — поэтому
`cacheable` сводится к pass-through-обёртке. Это нормально —
мы платим за абстракцию ноль runtime-cost'а (один лишний
indirection), и в момент, когда добавим L1, изменения коснутся
только `cache-module.config.ts`.

## Что этот пакет НЕ делает

- **Не реализует `wrap`.** `wrap` — это уровень
  `cache-manager`'а; `cacheable` ничего про read-through-семантику
  не знает.
- **Не делает single-flight / stampede protection.** Два
  параллельных miss'а на один ключ оба пробивают до L2 —
  никакой dedup'ации.
- **Не делает SCAN / pattern-iterate.** Это решающий момент
  для проекта: если бы `cacheable` имел primitive
  `iterateMatching(pattern)`, наш `RedisCacheAdapter` мог бы
  через него ходить и не лезть в `KeyvRedis.client`
  напрямую. Но такого primitive'а **нет**.

## Reach-through, audit `CACHE-006` и почему он закрыт

История finding'а `CACHE-006` важна для понимания, **почему**
у нас `cacheable` упоминается лишь как «слой стека», и почему
он не виден в репо как импортируемый пакет.

### Пре-task-11: reach-through в app-коде

До ADR-016 SCAN+UNLINK жили внутри инвентори-микросервиса:

```typescript
// (исторический фрагмент)
const cacheableInstance = (cache as Cache & { primary: { store: { client: ... } } }).primary;
const keyvRedis = cacheableInstance.store as KeyvRedis;
const redisClient = keyvRedis.client;
await redisClient.scanIterator(...);
```

Этот reach-through ходил через `Cache → cacheable.primary →
KeyvRedis → @redis/client` — **в app'е**. Audit'у это не нравилось
по двум причинам:

1. **Fragility.** `cacheable`-major-bump (например, переименует
   `primary` в `tiers[0]`) ломал бы app-код в нескольких
   местах одновременно.
2. **Layer-leak.** App-код знал о существовании `cacheable` —
   слое, который должен быть деталью cache-manager'а.

### Post-task-11 / ADR-016 §2

Этот reach-through перенесён в `libs/cache/redis-cache.adapter.ts`
и спрятан за `ICachePort.delByPrefix(prefix)`:

```typescript
// libs/cache/redis-cache.adapter.ts
private getRedisAdapter(): KeyvRedis<unknown> | undefined {
  // `cache-manager.createCache()` returns an object whose `stores` array
  // holds Keyv instances. Each Keyv exposes its underlying adapter via
  // the `store` getter — for our config that adapter is `KeyvRedis`.
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

Что изменилось:

- App'ы импортируют **только** `ICachePort` (через `CACHE_PORT`).
  `cacheable`, `cache-manager`, `keyv`, `@keyv/redis` — ни
  одного импорта в `apps/*/src`.
- `cacheable`-major-bump теперь ломает **один файл**
  (`redis-cache.adapter.ts`), и `instanceof KeyvRedis`-guard
  гарантирует, что мы не дёрнем не тот объект.
- ADR-017-grep (`grep -rE 'redis|cache-manager|keyv' apps/*/src`)
  возвращает ноль матчей; этот grep — verification-gate в
  `_carryover-11`.

Сегодня `CACHE-006` помечен как `resolved by task-11 / ADR-016`
в [audit-2026-05-08](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/docs/audits/audit-2026-05-08.md).

### Reach-through через `cache.stores[0].store`

Заметьте формулировку: `stores[0].store`. Это не `primary.store`
и не `cacheable.tiers[0]`. Поверхность того, как `cache-manager`
держит свои tier'ы, **публична** через `Cache.stores: Keyv[]`.
То, что внутри — `cacheable` — деталь cache-manager'а; мы
её не видим и не используем по имени.

Поэтому правильнее сказать: «у нас `cacheable` под капотом,
но мы про него ничего не знаем». Если завтра cache-manager
перейдёт от cacheable на что-то ещё с тем же
`Cache.stores: Keyv[]`-публикой, наш код не заметит.

## `lib-cacheable` vs декоратор `@Cacheable`

Имя путает. Есть **два** разных «cacheable» в нашем мире:

- **NPM-пакет `cacheable`** — про что эта статья. Multi-tier
  primitive под cache-manager v7+. Установлен в проекте как
  транзитивная зависимость.
- **Декоратор `@Cacheable({ key, ttlMs })`** — наш
  собственный, из `libs/cache/decorators/cacheable.decorator.ts`.
  Это method-decorator-syntactic-sugar над
  `ICachePort.wrap(...)`. На сегодня нигде в проекте не
  применён (опциональный, ADR-006 §«@Cacheable» оставил его
  «прижатым на полку»).

```typescript
// libs/cache/decorators/cacheable.decorator.ts
export function Cacheable(options: ICacheableOptions): MethodDecorator {
  return (target, propertyKey, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    const portKey = '__cachePort__';

    Inject(CACHE_PORT)(target, portKey);

    descriptor.value = async function (
      this: { [portKey]: ICachePort } & Record<string, unknown>,
      ...args: unknown[]
    ): Promise<unknown> {
      const port = this[portKey];
      const key = renderKey(options.key, args);
      return port.wrap(key, options.ttlMs, () => original.apply(this, args));
    };

    return descriptor;
  };
}
```

> [GitHub: libs/cache/decorators/cacheable.decorator.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/cache/decorators/cacheable.decorator.ts#L20-L38)

Декоратор пользуется `CACHE_PORT.wrap(...)` под капотом — то
есть тем же интерфейсом, что и `StockCache`. Cache-stack ниже
порта остаётся прежним; `cacheable`-пакет тут не упоминается
ни разу.

## Связанные решения

- [[cache-stack-overview]] — где `cacheable` в стеке (под
  `cache-manager v7+`, поверх `keyv`).
- [[cache-aside-pattern]] — какой паттерн обслуживается; почему
  `delByPrefix` — invalidate-side, а не альтернативный read.
- [[lib-cache-manager]] — кто использует cacheable изнутри.
- [[lib-keyv]] — слой ниже cacheable.
- [[lib-keyv-redis]] — конкретный Redis-store, до которого мы
  reach-through'им.
- [[module-boundaries]] — линт-правило, запрещающее `cacheable`
  в `apps/*/src`.
- [[shared-libs-philosophy]] — почему весь reach-through собран
  в одном файле libs/cache.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `cacheable` (npm) | NPM-пакет: multi-tier cache primitive под `cache-manager v7+`. |
| Multi-tier cache | Несколько уровней (L1 in-process + L2 shared + ...); cacheable их объединяет. |
| L1 / L2 | Уровни кэша. У нас сегодня — только L2 (Redis). |
| `primary` | Историческое имя первого tier'а в `cacheable`; в новых версиях — `stores[0]`. |
| Reach-through | Структурный доступ через несколько слоёв стека; у нас локализован в `redis-cache.adapter.ts`. |
| `@Cacheable` (наш декоратор) | Method-decorator-syntactic-sugar над `ICachePort.wrap`. Не используется сегодня. |
| `CACHE-006` | Audit-item «layer reach-through fragility». **Закрыт** ADR-016 / task-11. |

> [!faq]- Проверь себя
> 1. Что такое `cache.stores[0].store` в runtime'е? До какого
>    NPM-пакета спускается?
> 2. Почему `RedisCacheAdapter` не зовёт `cacheable`-методы
>    напрямую, а ходит через `cache.stores[0]`?
> 3. В чём разница между NPM-пакетом `cacheable` и нашим
>    декоратором `@Cacheable({ key, ttlMs })`?
> 4. Что произойдёт, если `cacheable` выйдет в `@3.x`-major и
>    переименует `cache.stores` обратно в `primary`? Какие
>    файлы будут затронуты?

## Что почитать дальше

- [`cacheable` README](https://github.com/jaredwray/cacheable)
  — multi-tier-strategy, `primary`/`secondary`, миграция с
  `node-cache`.
- [[lib-cache-manager]] — слой над cacheable.
- [[lib-keyv]] — слой под cacheable.
