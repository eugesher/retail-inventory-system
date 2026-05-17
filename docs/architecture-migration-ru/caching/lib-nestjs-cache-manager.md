---
created: 2026-05-15
updated: 2026-05-17
tags: [retail-inventory-system, caching, library, nest]
status: final
related:
  - "[[cache-stack-overview]]"
  - "[[cache-aside-pattern]]"
  - "[[lib-cache-manager]]"
  - "[[lib-cacheable]]"
  - "[[shared-libs-philosophy]]"
---

# Библиотека: `@nestjs/cache-manager`

> [!abstract] Кратко
> `@nestjs/cache-manager` — это **тонкая NestJS-обёртка** над
> NPM-пакетом `cache-manager` (см. [[lib-cache-manager]]). Она
> делает три вещи: даёт `NestCacheModule.registerAsync(...)` для
> асинхронной конфигурации, регистрирует Cache-instance под
> DI-токеном `CACHE_MANAGER` и опционально подключает
> HTTP-`CacheInterceptor` (мы им не пользуемся). Всё. Что
> хранить, как хранить, как сериализовать, как iterate'ить
> ключи — это уже `cache-manager`, `cacheable`, `keyv` и
> `@keyv/redis`. В проекте пакет упоминается ровно три
> раза — в `cache-module.config.ts`, `cache.module.ts` и
> `redis-cache.adapter.ts`.

## Зачем оно нам

Чтобы взять любой NPM-пакет и нормально использовать его в
NestJS, обычно нужны три вещи:

1. **Async-config через `ConfigService`**. Большинство
   NPM-пакетов конструируются синхронно или с factory; Nest
   хочет, чтобы factory увидел `ConfigService` через DI,
   значит нужен `*Module.registerAsync({ useFactory, inject })`.
2. **Регистрация инстанса под DI-токеном**. Чтобы в любой
   сервис можно было сказать `@Inject(CACHE_MANAGER)` и
   получить готовый `Cache`.
3. **Опциональная HTTP-интеграция**. Для пакетов с очевидным
   HTTP-применением — Cache среди них — Nest обычно даёт
   готовый interceptor (`CacheInterceptor`).

Все три вещи `@nestjs/cache-manager` и реализует. Это — его
**вся** работа.

## Что этот пакет делает

### Async-конфигурация через `CacheModuleAsyncOptions`

`cache-module.config.ts` — единственное место в проекте, где
тип `CacheModuleAsyncOptions` встречается:

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

`useFactory`-результат — это объект, который дальше «голым»
способом передаётся в `cache-manager.createCache(...)` (см.
[[lib-cache-manager]]). То есть: `@nestjs/cache-manager` —
переходник между «синтаксис NestJS-модуля» и «синтаксис
NPM-пакета `cache-manager`».

### Регистрация под `CACHE_MANAGER`-токеном

```typescript
// libs/cache/cache.module.ts
import { CacheModule as NestCacheModule } from '@nestjs/cache-manager';

@Global()
@Module({
  imports: [NestCacheModule.registerAsync(cacheModuleConfig)],
  providers: [RedisCacheAdapter, { provide: CACHE_PORT, useExisting: RedisCacheAdapter }],
  exports: [NestCacheModule, CACHE_PORT, RedisCacheAdapter],
})
export class CacheModule {}
```

> [GitHub: libs/cache/cache.module.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/cache/cache.module.ts#L1-L21)

`NestCacheModule.registerAsync(...)` — это и **есть**
`@nestjs/cache-manager` в работе: он принимает наш конфиг,
зовёт `cache-manager.createCache(stores, ttl)` под капотом и
регистрирует получившийся `Cache` под DI-токеном
`CACHE_MANAGER`.

После этого любой Nest-провайдер может его инжектить:

```typescript
// libs/cache/redis-cache.adapter.ts
import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';

@Injectable()
export class RedisCacheAdapter implements ICachePort {
  constructor(
    @Inject(CACHE_MANAGER)
    private readonly cache: Cache,
  ) {}
  // ...
}
```

> [GitHub: libs/cache/redis-cache.adapter.ts](https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/libs/cache/redis-cache.adapter.ts#L1-L31)

`Cache` — тип, **переэкспортированный** из `cache-manager`.
То есть `@nestjs/cache-manager` не определяет свой Cache —
он берёт чужой и пристёгивает к нему DI-токен. Это — буквально
adapter в hexagonal-смысле.

## Что этот пакет НЕ делает

Чёткий список — это самое полезное, что про NestJS-обёртки
можно сказать. По одной строке на пункт:

- **Не определяет, где хранить кэш.** Backend — это
  `cacheModuleConfig.stores`, через `@keyv/redis` (или другой
  keyv-адаптер). `@nestjs/cache-manager` про Redis ничего не
  знает.
- **Не реализует `get/set/del/wrap`.** Все четыре метода
  приходят из `Cache`-инстанса, который дал
  `cache-manager.createCache(...)` — наш пакет только
  регистрирует его в Nest-DI.
- **Не управляет TTL.** Default TTL приходит из `useFactory`
  (мы передаём `CACHE_TTL_MS_DEFAULT`), per-key TTL — это
  третий аргумент `cache.set(key, value, ttlMs)`. Сам пакет
  про политику TTL ничего не решает.
- **Не сериализует.** Сериализация — внутри `keyv` (JSON по
  default'у), `@nestjs/cache-manager` про byte-форму
  значения не знает.
- **Не делает namespacing / prefixing.** Это уровень `keyv`
  и `@keyv/redis`. Если мы захотим один Redis под несколько
  систем — namespace задаётся в `new KeyvRedis(url, { namespace })`,
  не в Nest-конфиге.
- **Не выполняет SCAN / KEYS / UNLINK.** Pattern-iterate'у
  через `cache-manager`-façade нет; для prefix-invalidate
  адаптер обходит façade и идёт прямо в `KeyvRedis.client`
  (см. [[lib-cacheable]] §«reach-through»).
- **Не делает HTTP-cache.** Пакет даёт `CacheInterceptor` для
  HTTP-кэширования контроллеров, но мы его **не**
  используем — ADR-002 §«Alternatives» отверг HTTP-caching на
  gateway'е, потому что он не видит RMQ-flow и не умеет
  invalidate-on-write.
- **Не управляет connection lifecycle.** Подключение к
  Redis — забота `@keyv/redis`. Реконнект — задача
  `@redis/client` под `@keyv/redis`.
- **Не делает retry / circuit breaker.** Никакой
  fault-tolerance-логики в пакете нет; всё, что нужно — на
  уровне Redis-client'а или вызывающего кода (у нас —
  try/catch + warn в `StockCache`).

### Тривия: версионная пара с cache-manager

Версия `@nestjs/cache-manager` — `3.x` в проекте
(`package.json`); под ней — `cache-manager@7.x`. Мажор '7' у
`cache-manager` был breaking — раньше `Cache` имел одно
backend'е через `store: Store`; теперь несколько через
`stores: Store[]`. `@nestjs/cache-manager@3.x` — обёртка
именно над этим новым API. Если в зависимостях окажется
`cache-manager@5`, обёртка работать не будет — это уже не
forward-compat.

Подробнее о changes между `cache-manager v4` и `v7+` — в
[[lib-cache-manager]] §«stores[] и cacheable».

## Связанные решения

- [[cache-stack-overview]] — где `@nestjs/cache-manager`
  стоит на общей диаграмме (между app-DI и façade-уровнем
  `cache-manager`).
- [[lib-cache-manager]] — что такое `Cache` под капотом и кто
  его создаёт.
- [[lib-cacheable]] — multi-tier primitive, который
  cache-manager v7+ использует внутри.
- [[cache-aside-pattern]] — паттерн от первых принципов; этот
  пакет — деталь его реализации, не сам паттерн.
- [[shared-libs-philosophy]] — почему импорт
  `@nestjs/cache-manager` живёт **только** в `libs/cache`.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| `@nestjs/cache-manager` | NPM-пакет: NestJS-обёртка над `cache-manager`. |
| `CacheModule` (Nest) | Nest-модуль из `@nestjs/cache-manager`. В `libs/cache` импортируется как `NestCacheModule`. |
| `CacheModuleAsyncOptions` | Тип-конфиг для `CacheModule.registerAsync`. |
| `CACHE_MANAGER` | DI-токен (Symbol), под которым `@nestjs/cache-manager` регистрирует `Cache`. |
| `Cache` (тип) | Класс из `cache-manager`, переэкспортированный `@nestjs/cache-manager`. |
| `CacheInterceptor` | HTTP-interceptor для GET-кэширования из `@nestjs/cache-manager`. **Не используется в проекте.** |

> [!faq]- Проверь себя
> 1. Что произойдёт, если в `cache-module.config.ts` убрать
>    `import { CacheModuleAsyncOptions } from '@nestjs/cache-manager'`
>    и просто описать тип литералом? Будет ли работать?
> 2. Где живёт код, реализующий метод `cache.set(key, value)`?
>    Это `@nestjs/cache-manager`, `cache-manager` или
>    `@keyv/redis`?
> 3. Почему мы не используем `CacheInterceptor` из
>    `@nestjs/cache-manager` для HTTP-эндпоинта
>    `GET /api/product/:id/stock`?

## Что почитать дальше

- [`@nestjs/cache-manager` README](https://docs.nestjs.com/techniques/caching)
  — официальный гид Nest, разбирает `registerAsync` и
  `CacheInterceptor`.
- [[lib-cache-manager]] — следующий слой стека.
