# ADR-016: Обобщённый cache-aside — ключи `ris:<service>:<aggregate>:<id>` + инвалидация через порт

- **Date**: 2026-05-14
- **Status**: Принято

---

## Контекст

[ADR-002](002-redis-cache-aside-product-stock.md) ввёл cache-aside для запроса остатков товара в inventory-микросервисе. Подключение жило в `apps/inventory-microservice/src/.../product-stock-common.service.ts` и обращалось напрямую к `@nestjs/cache-manager`, `@keyv/redis` и `cacheable` для выполнения инвалидации SCAN+UNLINK.

Task-04 архитектурной миграции извлёк общую кеш-абстракцию в `libs/cache`: `ICachePort` (get/set/del/wrap), `CACHE_PORT` (DI-символ), `RedisCacheAdapter` (конкретная реализация над `@nestjs/cache-manager` + `@keyv/redis`), реестр `CACHE_KEYS` и скелет декоратора `@Cacheable()`. Task-08 переместил фасад stock-cache в `apps/inventory-microservice/src/modules/stock/infrastructure/cache/`, но он всё ещё обращался напрямую к `@nestjs/cache-manager` для выполнения SCAN+UNLINK.

К task-11 аудит в `docs/audits/audit-2026-05-08.md` идентифицировал двенадцать находок `CACHE-*`. Три из них — баги формы ключа (`CACHE-010` компаратор сортировки storage-id, `CACHE-011` литеральный sentinel `*`), и одна — архитектурная хрупкость (`CACHE-006` reach-through через `cacheable`). Остальные — открытые пункты по архитектуре/конфигурации, не блокирующие обобщение.

Брифинг task-11: обобщить кеш-слой так, чтобы приложения зависели только от `libs/cache` (никаких прямых импортов `cache-manager`/`keyv`/`redis` в `apps/*/src`), централизовать ключи кеша в `libs/cache/cache-keys.ts` и попутно устранить баги формы ключа из аудита.

## Решение

### 1. Соглашение о ключах

Каждый новый ключ кеша следует `ris:<service>:<aggregate>:<id>[:<facet>]`. Ведущий префикс `ris:` ограничивает кеш этим проектом (инстанс Redis может быть разделён со смежными сервисами); `<service>` и `<aggregate>` квалифицируют ключ так, что кросс-агрегатные коллизии невозможны по построению.

Построители живут в `libs/cache/cache-keys.ts` и экспортируются как `CACHE_KEYS.*`. Приложения в `apps/*/src` НЕ ДОЛЖНЫ писать строковые литералы ключей кеша — каждый ключ приходит из построителя. Спеки могут утверждать литеральные строки (они фиксируют продакшен-контракт).

Существующие ключи под legacy-префиксом `stock:<productId>:*` продолжают инвалидироваться в течение post-deploy-окна перехода (см. §3 ниже). В них активно не пишет новый код; они истекают по TTL.

### 2. `delByPrefix` на кеш-порту

Множественная инвалидация ключей требует итерации по набору ключей на backend кеша. Предыдущая конструкция обращалась через `Cache → Cacheable.primary → store → KeyvRedis → adapter.client`, чтобы выпустить SCAN+UNLINK. Этот reach-through хрупок против мажорных бампов `cacheable` (`CACHE-006`) и вынуждает каждое приложение, нуждающееся в множественной инвалидации, повторять тот же танец.

Task-11 добавляет `delByPrefix(prefix: string): Promise<number>` к `ICachePort`. Реализация `RedisCacheAdapter` обходит `cache.stores[0].store` (цепочка Keyv → KeyvRedis) и выпускает `SCAN MATCH ${prefix}*` с последующим `UNLINK [...matchedKeys]`. На backends без Redis-адаптера (например, in-memory-store под юнит-тестами) она возвращает 0; вызов там — no-op, и устаревшие записи истекают по TTL.

Приложения инвалидируют через `CACHE_KEYS.<aggregate>Prefix(...)` + `port.delByPrefix(...)`. Stock-адаптер (`StockCache` в inventory-микросервисе) оборачивает порт и экспонирует domain-shaped `invalidate({ items, correlationId })`, который раскрывает `delByPrefix` per уникальному productId. Он вызывает `delByPrefix` один раз для нового префикса и один раз для legacy-префикса `stock:`, чтобы записи, написанные до cut-over, стирались на первой post-deploy-записи.

### 3. Ожидаемая инвалидация после коммита

До task-11 `ReserveStockForOrderUseCase` выпускал инвалидацию как fire-and-forget (`void this.stockCache.invalidate(...)`). Комментарий обосновывал это как оптимизацию задержки: SCAN+UNLINK был свободен накладываться на RPC-ответ.

Task-11 меняет это на `await this.stockCache.invalidate(...)`. Post-state успешного confirm-RPC теперь включает «кеш очищен для мутированных товаров» — немедленный следующий GET читает свежую строку БД. Стоимость SCAN+UNLINK — несколько миллисекунд на небольшом наборе ключей, заплаченных за более жёсткую семантику и детерминированный тестовый контракт.

Это НЕ закрывает `CACHE-001` (гонка чтения/записи между чтением БД читателем и коммитом+инвалидацией писателя); эта гонка ограничена TTL сегодня и отслеживается для будущего прохода single-flight / version-stamp.

### 4. Находки аудита, закрываемые этим ADR

- **CACHE-010** (компаратор сортировки): новый построитель `CACHE_KEYS.inventoryStock` сортирует storage ID через `localeCompare`, так что любая пара перестановок storage-id производит один и тот же ключ.
- **CACHE-011** (литеральный sentinel `*`): новый sentinel «все склады» — `__all__` (не-glob).
- **CACHE-006** (reach-through через слой): единственное место, где происходит reach-through к `KeyvRedis`, — это `libs/cache/redis-cache.adapter.ts`. Приложения зависят от `ICachePort`. Мажорный бамп `cacheable` теперь высаживается в одном lib-файле, а не в каждом приложении.

### 5. Трейсинг

`RedisCacheAdapter` открывает OTel-спан вокруг каждой операции (`cache.get`, `cache.set`, `cache.del`, `cache.wrap`, `cache.delByPrefix`) с `cache.key`/`cache.prefix`, `cache.hit` (для путей чтения) и `cache.keys_unlinked` (для prefix-удалений). Попадание/промах кеша теперь видны в Jaeger рядом с существующими спанами `redis-*`, эмитируемыми auto-instrumentation.

## Последствия

- Однодеплойное окно перехода, где записи под legacy-префиксом `stock:` сосуществуют с записями под `ris:inventory:stock:`. Инвалидация покрывает оба; чтения разрешаются только через новый префикс; legacy-записи, не получающие записи, истекают по TTL (по умолчанию 60 с).
- Гейт проверки (task-11): `grep -rE 'redis|cache-manager|keyv' apps/*/src` возвращает ноль совпадений. Класс `StockRedisCache` переименован в `StockCache`, а файл `stock-redis.cache.ts` — в `stock.cache.ts`, чтобы удовлетворить гейт также и по имени, а не только по импорту.
- `CACHE_PORT` предоставляется `@Global()` `CacheModule` в `libs/cache`. Feature-модули могут его инжектить без явного импорта модуля.
- Задержка Confirm-RPC увеличивается на стоимость SCAN+UNLINK. Приемлемо: типичные наборы ключей малы, UNLINK освобождает память асинхронно, а предыдущий fire-and-forget был латентным источником test-flake.

## Открытые вопросы

- `CACHE-001` (гонка чтения/записи cache-aside / нет single-flight)
- `CACHE-002` (контракт инвалидации после коммита, обеспечиваемый комментарием)
- `CACHE-003` (нет сегмента версии схемы в ключах)
- `CACHE-004` (нет джиттера TTL)
- `CACHE-005` (дублирующиеся warn-логи при недоступном Redis)
- `CACHE-007` / `CACHE-008` (отсутствует покрытие skip-cache / tx-failure)
- `CACHE-009` (нет tenant-сегмента)
- `CACHE-012` (резервный путь combo-key покрывает только single-storage-ключи; больше недостижим, потому что non-Redis-путь `delByPrefix` — задокументированный no-op)
