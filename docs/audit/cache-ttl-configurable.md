# Audit: Make Cache TTL Configurable

Scope: read-only Phase 1 audit. No code changes proposed in this document; the
change plan lives in Phase 2 of the original task brief.

## 1. ConfigModule structure

Directory: `libs/config/config-module/`

| File                                              | Exports                                                                                                                          | Purpose                                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `index.ts`                                        | re-exports `./enums`, `./config-module.config`                                                                                   | Barrel for the sub-package.                                                                              |
| `config-module.config.ts`                         | `ConfigModuleConfig` (class implementing `ConfigModuleOptions`)                                                                  | Constructed in each app's `app.module.ts`. Wires `validationSchema`, `envFilePath`, two `registerAs` factories (global + per-app). |
| `enums/index.ts`                                  | re-exports the three enum files                                                                                                  | Barrel.                                                                                                  |
| `enums/config-factory-token.enum.ts`              | `ConfigFactoryTokenEnum` (`GLOBAL`, `API_GATEWAY`, `INVENTORY_MICROSERVICE`, `RETAIL_MICROSERVICE`, `NOTIFICATION_MICROSERVICE`) | Tokens passed to `registerAs(...)` and used as the namespace prefix in `ConfigPropertyPathEnum`.        |
| `enums/config-property-key.enum.ts`               | `ConfigPropertyKeyEnum` (`DATABASE_LOGGING`, `USE_API_REFERENCE`)                                                                | Property keys *inside* a namespace.                                                                      |
| `enums/config-property-path.enum.ts`              | `ConfigPropertyPathEnum` (`GLOBAL_DATABASE_LOGGING`, `API_GATEWAY_USE_API_REFERENCE`)                                            | Computed `${factoryToken}.${propertyKey}` paths used at the call site of `configService.get(path)`.     |
| `interfaces/index.ts`                             | re-exports `IConfigModuleConfigurationOptions`                                                                                   | Barrel.                                                                                                  |
| `interfaces/config-module-configuration.interface.ts` | `IConfigModuleConfigurationOptions` (`{ token: ConfigFactoryTokenEnum, configObject: ConfigObject }`)                            | Constructor input shape for `ConfigModuleConfig`.                                                        |
| `objects/index.ts`                                | re-exports `configObjectGlobal`, `configValidationSchema`                                                                        | Barrel.                                                                                                  |
| `objects/config-object-global.ts`                 | `configObjectGlobal: ConfigObject` (currently `{ [DATABASE_LOGGING]: <derived> }`)                                                | Registered under the `GLOBAL` factory token.                                                             |
| `objects/config-validation-schema.ts`             | `configValidationSchema: Joi.ObjectSchema`                                                                                       | Joi schema applied to `process.env` (`allowUnknown: true`, `abortEarly: false`).                         |

Outer barrel: `libs/config/index.ts` re-exports the `config-module` sub-package
plus `cacheModuleConfig`, `LoggerModuleConfig`, and `TypeormModuleConfig`.

### Import sites across the monorepo (resolved via `@retail-inventory-system/config`)

| File                                                         | Imported symbols                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `apps/api-gateway/src/main.ts`                               | `ConfigPropertyPathEnum`, `LoggerModuleConfig`                                                |
| `apps/api-gateway/src/config/config-object.ts`               | `ConfigPropertyKeyEnum`                                                                       |
| `apps/api-gateway/src/app/app.module.ts`                     | `ConfigFactoryTokenEnum`, `ConfigModuleConfig`, `LoggerModuleConfig`                          |
| `apps/inventory-microservice/src/main.ts`                    | `LoggerModuleConfig`                                                                          |
| `apps/inventory-microservice/src/app/app.module.ts`          | `cacheModuleConfig`, `ConfigFactoryTokenEnum`, `ConfigModuleConfig`, `LoggerModuleConfig`, `TypeormModuleConfig` |
| `apps/retail-microservice/src/main.ts`                       | `LoggerModuleConfig`                                                                          |
| `apps/retail-microservice/src/app/app.module.ts`             | `ConfigFactoryTokenEnum`, `ConfigModuleConfig`, `LoggerModuleConfig`, `TypeormModuleConfig`   |
| `apps/notification-microservice/src/main.ts`                 | `LoggerModuleConfig`                                                                          |
| `apps/notification-microservice/src/app/app.module.ts`       | `ConfigFactoryTokenEnum`, `ConfigModuleConfig`, `LoggerModuleConfig`                          |

Internal cross-imports inside `libs/config/`:

- `libs/config/typeorm-module.config.ts` → `ConfigPropertyPathEnum` (from `./config-module`)
- `libs/config/cache-module.config.ts` → no symbols from `config-module` (reads `REDIS_URL` directly via `configService.get<string>('REDIS_URL')`)

### Two coexisting access patterns

The codebase consumes `ConfigService` in **two distinct ways**:

1. **Namespaced/typed path access** — `configService.get(ConfigPropertyPathEnum.GLOBAL_DATABASE_LOGGING)`. Reads values produced by the `configObjectGlobal` / per-app `configObject` factories, which themselves derive their values from `process.env` at module-load time. Used for derived/computed config (e.g. boolean coercion of `DATABASE_LOGGING`).
2. **Direct env-var key access** — `configService.get<string>('REDIS_URL')`, `configService.get<string>('DATABASE_URL')`. Reads `process.env` straight through, validated by the Joi schema. Used for raw env vars without derivation.

The two patterns are not unified — each call site picks one. New raw env vars
follow pattern (2) by precedent (`REDIS_URL`, `DATABASE_URL`, `RABBITMQ_URL`,
`API_GATEWAY_PORT`, `LOG_LEVEL`, `NODE_ENV`).

## 2. CacheModule config — current TTL handling

File: `libs/config/cache-module.config.ts`

```ts
export const cacheModuleConfig: CacheModuleAsyncOptions = {
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => ({
    stores: [new KeyvRedis(configService.get<string>('REDIS_URL') ?? 'redis://localhost:6379')],
    ttl: 60_000,
  }),
  isGlobal: true,
};
```

- TTL is **hardcoded as the numeric literal `60_000`** at line 9.
- `ConfigService` is **already injected** into the factory (used for `REDIS_URL`).
- The `?? 'redis://localhost:6379'` fallback is now redundant since the Joi schema marks `REDIS_URL` as `required()` — but that is out of scope for this audit. (See issue #2 below.)

**Gap:** Wiring TTL to `ConfigService.get<number>('CACHE_TTL_MS_DEFAULT')` is a
single-line additive change inside this factory.

## 3. CacheHelper — current TTL handling

File: `libs/common/cache/cache.helper.ts`

```ts
export class CacheHelper {
  public static ttlValues = {
    productStock: 60_000,
  };
  public static keyPrefixes = { productStock: (productId: number) => `stock:${productId}:` };
  public static keys = { productStock: (productId, storageIds?) => /* ... */ };
}
```

`ttlValues.productStock` is a static numeric constant. It does **not** read from
`ConfigService`; it can't, because `CacheHelper` is a static utility with no DI
context.

### Call sites for the TTL value

| File                                                                                                                               | Line(s)   | Context                | Reads TTL? |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------- | ---------- |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-cache.service.ts`         | 78        | App code (`set` method)| Yes — `const ttl = CacheHelper.ttlValues.productStock;` then passed to `cache.set(...)` and into the debug log. |
| `apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-cache.service.spec.ts` | 207, 214  | Unit test              | Yes — used as the expected value in `toHaveBeenCalledWith(...)` and inside the expected log payload. |

### Call sites for the key helpers (no TTL involvement, listed for completeness)

- `apps/inventory-microservice/.../product-stock-common-cache.service.ts:54, 77, 148, 214, 215` — `keys.productStock(...)` and `keyPrefixes.productStock(...)`.
- `test/system-api.e2e-spec.ts:29, 34` — `keys.productStock(...)`. **Does NOT pass TTL.**

**Net:** TTL flows from `CacheHelper.ttlValues.productStock` to exactly **one
runtime call site** (`product-stock-common-cache.service.ts:78`) and **one test
call site** (`product-stock-common-cache.service.spec.ts:207, 214`). Removing
the TTL from `CacheHelper` requires updating those two files only.

## 4. ProductStockCommonCacheService — current TTL handling

File:
`apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/product-stock-common-cache.service.ts`

Current TTL source (line 78):

```ts
const ttl = CacheHelper.ttlValues.productStock;
```

Constructor:

```ts
constructor(
  @Inject(CACHE_MANAGER) private readonly cache: Cache,
  @InjectPinoLogger(ProductStockCommonCacheService.name) private readonly logger: PinoLogger,
) {}
```

- `ConfigService` is **NOT** currently injected.
- The service is `@Injectable()`, so adding a `ConfigService` constructor parameter is a standard NestJS additive change with no breaking effect on existing call sites (no manual `new ProductStockCommonCacheService(...)` exists in app code; the unit spec instantiates it directly and will need a mock added).

## 5. ConfigModule health assessment

**Recommendation: do NOT refactor ConfigModule for this task.**

Justification:

1. The current structure is small, functional, and unambiguous — three enums, one schema, one global config object, one wrapper class. Adding two new env vars touches only the Joi schema; no enum or interface change is required if we adopt pattern (2) (direct env-var key access).
2. The two coexisting access patterns are a real inconsistency, but resolving it is a *cross-cutting* refactor (touches every direct-env consumer: `REDIS_URL`, `DATABASE_URL`, `RABBITMQ_URL`, `API_GATEWAY_PORT`, `LOG_LEVEL`). It is unrelated to "make TTL configurable" and would inflate scope.
3. Conforming the new TTL vars to the existing direct-env pattern keeps the change additive and reversible.
4. The audit found **no exported symbol from `config-module/` that is unused or misnamed**, and **no missing test coverage** — there is no mechanical refactor opportunity that would shrink or clarify the module without an architectural change.

Any architectural unification (e.g. promoting all raw env vars into `ConfigPropertyPathEnum`, or generating a typed `IAppConfig` interface from the Joi schema) is a worthwhile follow-up but should be scoped as its own task.

## 6. Detected issues (bugs, architectural problems, inaccuracies)

1. **`libs/config/cache-module.config.ts:8` — redundant runtime fallback for `REDIS_URL`.** Severity: **low**. The Joi schema already marks `REDIS_URL` as `required()` with `uri({ scheme: 'redis' })`, so `configService.get<string>('REDIS_URL')` is guaranteed non-null at boot. The `?? 'redis://localhost:6379'` fallback is unreachable in practice and contradicts the validation contract. Recommended fix: drop the fallback; let the type narrow naturally. Out of scope for this task — recorded for a future cleanup pass.
2. **`libs/config/cache-module.config.ts:9` — TTL is hardcoded.** Severity: **medium** (the *subject of this task*). Recommended fix: `ttl: configService.get<number>('CACHE_TTL_MS_DEFAULT')`, with the Joi schema providing the default value (`Joi.number().integer().positive().default(60000)`).
3. **`libs/common/cache/cache.helper.ts:8–10` — TTL constant in a static helper.** Severity: **medium** (also subject of this task). Static helpers cannot read from `ConfigService`; the TTL belongs in the consuming service via DI. Recommended fix: remove `ttlValues` from `CacheHelper` entirely; have `ProductStockCommonCacheService` read its TTL from `ConfigService` and pass it to `cache.set(...)`.
4. **`apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-cache.service.spec.ts:207, 214` — test couples to helper constant.** Severity: **low**. Once `CacheHelper.ttlValues` is removed, these two assertions will need a literal `60000`. The convention recorded in the file's preamble ("cache-key assertions use exact string equality … part of the production cache contract") supports literals here.
5. **`docker-compose.yml` — none of the four service definitions enumerate `CACHE_TTL_MS_*`.** Severity: **low**. Once we add the variables, only the cache-using service (`inventory-microservice`) strictly needs them, but precedent is to enumerate every cross-cutting var in every service block (`NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `RABBITMQ_URL` appear in all four). Recommended fix: enumerate `CACHE_TTL_MS_DEFAULT` and `CACHE_TTL_MS_PRODUCT_STOCK` in the `inventory-microservice` block at minimum; whether to repeat them in the other three blocks is a stylistic call (the audit recommends keeping the existing "repeat everywhere" convention to avoid drift).
6. **No `.env.example`/`.env.template` exists.** Severity: **low–medium**. The project has only `.env.local` (a developer-local file, gitignored or near-gitignored — needs verification). Without a tracked example file, contributors cannot discover the required env-var contract without reading the Joi schema. Recommended fix: out of scope; the task brief says "*(or equivalent example/template file if it exists)*", which acknowledges the absence. Update `.env.local` directly as the closest equivalent in this repo.
