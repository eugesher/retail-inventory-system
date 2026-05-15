---
created: 2026-05-15
updated: 2026-05-16
tags: [retail-inventory-system, caching, library, redis]
status: review
related:
  - "[[cache-stack-overview]]"
  - "[[cache-aside-pattern]]"
  - "[[lib-keyv]]"
  - "[[lib-cacheable]]"
  - "[[lib-cache-manager]]"
  - "[[shared-libs-philosophy]]"
---

# Библиотека: `@keyv/redis`

> [!abstract] Кратко
> `@keyv/redis` — это **собственно Redis-клиент** в нашем
> стеке. Он реализует `KeyvStoreAdapter`-интерфейс из
> [[lib-keyv]] и под капотом держит официальный
> Redis-клиент `@redis/client` (он же `redis@5+`). Connection
> pool, реконнект, RESP-протокол, SCAN, UNLINK, EXPIRE,
> Pub/Sub — всё это `@keyv/redis` через `@redis/client`. В
> нашем стеке он живёт в `cache-module.config.ts`
> (единственное `new KeyvRedis(REDIS_URL)`) и в
> `redis-cache.adapter.ts` (где мы достаём `keyvRedis.client` для
> SCAN+UNLINK через структурный reach-through). Слово
> «namespace» — НЕ его работа: namespacing'ом занимается
> `keyv` сверху; `@keyv/redis` пишет в Redis ровно тот
> ключ, что ему дают (плюс свой namespace-префикс, если он
> задан в `keyv`'е).

## Что этот пакет делает

### Connection и RESP-протокол

`new KeyvRedis(REDIS_URL)` создаёт связку:

- Внутренний `@redis/client`-инстанс с парсингом URL'а
  (`redis://`, `rediss://`, `redis://user:pass@host:port`).
- Connection pool (default — single connection с автоматическим
  reconnect'ом).
- Обработка повторных подключений после network-blip'а
  (exponential backoff под капотом `@redis/client v5`).

Подключение **ленивое**: первый `keyv.set(...)` инициирует
TCP-handshake; последующие операции используют тот же
connection. Никакой блокировки на старте Nest-приложения —
`@keyv/redis` не делает eager-connect.

### `keyvStore.get/set/delete`

Три обязательных метода `KeyvStoreAdapter` под капотом:

- `get(key)` → `GET <namespaced-key>` через `@redis/client`.
- `set(key, value, ttlMs?)` → `SET <namespaced-key> <serialized-value>` плюс
  опционально `PEXPIRE <namespaced-key> <ttlMs>`. Серилизация
  — JSON, делается на уровне `keyv` (см. [[lib-keyv]]).
- `delete(key)` → `DEL <namespaced-key>`.

Где `namespaced-key` — `${namespace}${separator}${rawKey}` если
keyv-namespace задан; иначе `rawKey` как есть (наш случай).

### Public `client: @redis/client`

`@keyv/redis` оставляет нижележащий `@redis/client`-инстанс
как public-property `client`. Это то, что мы используем для
SCAN+UNLINK в `RedisCacheAdapter.delByPrefix`:

```typescript
// libs/cache/redis-cache.adapter.ts
// KeyvRedis prefixes stored keys with `${namespace}${keyPrefixSeparator}`
// when a namespace is configured. With no namespace (the project
// default — see libs/cache/cache-module.config.ts) the prefix is empty
// and stored keys match cache.set() input verbatim.
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

// UNLINK frees memory asynchronously on the Redis side — preferred
// over DEL when invalidating potentially-large key sets, since DEL
// is O(N) synchronous from Redis's main thread.
await client.unlink([...matchedKeys]);
```

> [GitHub: libs/cache/redis-cache.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/cache/redis-cache.adapter.ts#L107-L147)

Что здесь происходит:

- **`client.scanIterator({ MATCH, COUNT: 100 })`** — `@redis/client v5+`
  exposes SCAN как async-iterator. `COUNT: 100` — hint
  Redis'у: «бери 100 ключей за iteration» (это не лимит, а
  оценка). Iterator завершается, когда Redis возвращает
  cursor `0`.
- **`client.unlink([...keys])`** — `@redis/client v5+` принимает
  массив. На Redis-стороне UNLINK кладёт ключи в очередь и
  освобождает память асинхронно в background-thread'е,
  не блокируя main-thread Redis'а. Для DEL это синхронная
  O(N)-операция.

То есть `@keyv/redis` — это **и keyv-store, и
escape-hatch** в нижележащий Redis-клиент. Без public `client`
SCAN/UNLINK были бы недоступны нашему стеку.

### Connection-string

В `cache-module.config.ts`:

```typescript
new KeyvRedis(configService.get<string>('REDIS_URL'))
```

`REDIS_URL` — Joi-валидируется в `libs/config`:

```typescript
// libs/config/config-module.config.ts
REDIS_URL: Joi.string().uri({ scheme: 'redis' }).required(),
```

> [GitHub: libs/config/config-module.config.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/config/config-module.config.ts#L20-L20)

Локально (`.env.local`) — `redis://localhost:6379`. В docker —
`redis://redis:6379`. В проде — managed Redis по
`rediss://` (TLS).

## Что этот пакет НЕ делает

- **Не делает namespacing'а сам.** Namespace — забота
  `keyv`-обёртки над ним. `@keyv/redis` берёт уже
  префиксированный ключ.
- **Не делает сериализацию.** Сериализация — `keyv`. `@keyv/redis`
  получает string'у-value и SET'ит её в Redis как есть.
- **Не обёрнут в Nest-DI напрямую.** В DI у нас `Cache`
  (из `cache-manager`); до `KeyvRedis` мы добираемся через
  `cache.stores[0].store`.
- **Не управляет lifecycle вне Redis-клиента.** Никакого
  graceful-shutdown на `app.close()` — `@redis/client`
  закроет connection при exit'е процесса. Для unit-тестов
  это нужно учесть (вручную `keyvRedis.disconnect()`).
- **Не делает Pub/Sub.** Технически `@redis/client` это умеет;
  `@keyv/redis` Pub/Sub-API не экспонирует. Если когда-нибудь
  понадобится — adapter обойдёт `@keyv/redis` и пойдёт прямо
  в `client` (как мы делаем для SCAN).
- **Не делает Redis-Cluster / Sentinel-агностично.** В коде
  есть defensive-branch:

  ```typescript
  if (!('scanIterator' in rawClient) || !('unlink' in rawClient)) {
    span.setAttribute('cache.backend', 'redis-no-scan');
    span.setAttribute('cache.keys_unlinked', 0);
    return 0;
  }
  ```

  > [GitHub: libs/cache/redis-cache.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/cache/redis-cache.adapter.ts#L108-L116)

  Cluster/Sentinel-клиенты `@redis/client` имеют другую форму
  (методы SCAN живут per-shard); адаптер их видит и делает
  no-op. У нас single-instance Redis, так что эта ветка не
  стреляет.

### Слово про `@redis/client v5+`

`@keyv/redis@5+` использует `@redis/client v5+`. У `@redis/client`
до v4 SCAN был callback-based; в v4+ его перевели на
async-iterator (`scanIterator`). Если кто-то в проекте
проапгрейдит до v6-major (когда выйдет) или, наоборот,
случайно поставит v3, наш `delByPrefix` сломается на
несовпадении сигнатуры. Защита — narrow-type
`IRedisScanClient`:

```typescript
// libs/cache/redis-cache.adapter.ts
interface IRedisScanClient {
  scanIterator(options: { MATCH: string; COUNT?: number }): AsyncIterable<string[]>;
  unlink(keys: string[]): Promise<number>;
}
```

> [GitHub: libs/cache/redis-cache.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/cache/redis-cache.adapter.ts#L16-L19)

— описываем структурно ровно то, что используем; на
compile-time'е любое расхождение виден сразу.

## Связанные решения

- [[cache-stack-overview]] — где `@keyv/redis` в общей
  диаграмме (под `keyv`, поверх Redis).
- [[lib-keyv]] — keyv-обёртка, в которой стоит
  `@keyv/redis`.
- [[lib-cache-manager]] — кто запрашивает `keyvStore.get/set`.
- [[lib-cacheable]] — почему reach-through к `keyvRedis.client`
  живёт в одном файле (`redis-cache.adapter.ts`).
- [[cache-aside-pattern]] — `delByPrefix` через
  SCAN+UNLINK — invalidate-side cache-aside'а.
- [[shared-libs-philosophy]] — `@keyv/redis` импортируется
  ровно в двух файлах `libs/cache`.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `@keyv/redis` | NPM-пакет. Keyv-store, работающий с Redis через `@redis/client`. |
| `KeyvRedis` (class) | Класс из `@keyv/redis`. Implementor `KeyvStoreAdapter`. |
| `@redis/client` | NPM-пакет. Официальный Redis-клиент Node.js. |
| `RedisClient` | Класс из `@redis/client`. Public-property `KeyvRedis.client`. |
| `SCAN` | Redis-команда: incremental-итерация ключей по pattern'у. Не блокирует. |
| `UNLINK` | Redis-команда: async-удаление ключей с фоновым освобождением памяти. |
| `scanIterator` | API `@redis/client v5+`: async-iterator над SCAN. |
| `COUNT` | Hint Redis'у к SCAN: «бери N ключей за iteration». |
| `RESP` | REdis Serialization Protocol; wire-формат Redis. `@redis/client` его говорит. |

> [!faq]- Проверь себя
> 1. Почему `RedisCacheAdapter.delByPrefix` использует
>    `UNLINK`, а не `DEL` после SCAN?
> 2. Где задаётся `REDIS_URL` и кто его валидирует?
> 3. Что произойдёт, если в стек подмешать Redis Cluster или
>    Sentinel — как поведёт `delByPrefix`?
> 4. Какой тип `keyvRedis.client` (фактический NPM-пакет)?
>    Зачем мы narrow'или его до `IRedisScanClient`?

## Что почитать дальше

- [`@keyv/redis` README](https://www.npmjs.com/package/@keyv/redis)
  — public-API, опции (namespace, useUnlink, ...).
- [`@redis/client` (v5) docs](https://redis.js.org/docs)
  — async-iterator'ы, multi-key команды, cluster-API.
- [Redis docs — SCAN+UNLINK](https://redis.io/commands/scan/)
  — почему SCAN не блокирует, как UNLINK освобождает память.
- [[lib-keyv]] — слой над `@keyv/redis`.
