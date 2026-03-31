# Codebase Audit Report

**Project:** Retail Inventory System (NestJS Monorepo)
**Date:** 2026-03-31
**Auditor:** Claude Code (Opus 4.6)
**Scope:** Full codebase — apps/, libs/, migrations/, test/, config files, Dockerfiles

---

## 1.1 Correctness & Bugs

### BUG-001 · `critical`

**Race condition in stock reservation — no row-level locking**

| | |
|---|---|
| File | `apps/inventory-microservice/src/app/api/product-stock/providers/product-stock-order-confirm.service.ts` |
| Lines | 44–51 |

The stock balance query inside the transaction does not use `SELECT ... FOR UPDATE`. MySQL's default `REPEATABLE READ` isolation allows two concurrent confirmations for the same product to both read the same available quantity, both insert a `-1` stock record, and both succeed — causing **overselling**.

```typescript
// Current: reads snapshot without locking
const stockBalances = await entityManager
  .createQueryBuilder(ProductStock, 'ps')
  .select('ps.productId', 'productId')
  .addSelect('SUM(ps.quantity)', 'totalQuantity')
  .where('ps.productId IN (:...productIds)', { productIds })
  .groupBy('ps.productId')
  .getRawMany();
```

**Fix:** Add `.setLock('pessimistic_read')` or use `FOR UPDATE` on the stock balance query within the transaction.

---

### BUG-002 · `major`

**CLAUDE.md incorrectly states no test runner exists**

| | |
|---|---|
| File | `CLAUDE.md` |
| Line | 32 |

The file states: *"There is no test runner configured — no test commands exist."*

In reality, the project has:
- `yarn test:unit` — Jest unit tests (`jest.unit.config.js`)
- `yarn test:e2e` / `yarn test:e2e:run` — Jest E2E tests with full microservice stack (`jest.e2e.config.js`)
- A comprehensive E2E suite in `test/system-api.e2e-spec.ts` (20+ test cases with snapshot testing)
- A unit test for domain logic in `apps/retail-microservice/src/app/api/order/domain/spec/order-confirm.domain.spec.ts`

This is misleading for anyone onboarding via this file (including AI assistants).

---

### BUG-003 · `major`

**CLAUDE.md describes non-existent event-driven stock reservation flow**

| | |
|---|---|
| File | `CLAUDE.md` |
| Lines | 54–55 |

States: *"Event flow: Retail Microservice emits `RETAIL_ORDER_CREATED` after order creation → Inventory Microservice consumes it for stock reservation."*

**Actual flow:** Stock reservation is performed via **synchronous RPC** (`INVENTORY_ORDER_CONFIRM`) during order confirmation, not via events after order creation. No code in the codebase emits or consumes `RETAIL_ORDER_CREATED` or `RETAIL_ORDER_CONFIRMED`. The `MicroserviceEventPatternEnum` defines these events but they are unreferenced.

Also missing from the message pattern documentation: `INVENTORY_ORDER_CONFIRM` (RPC) and `RETAIL_ORDER_GET` (RPC).

---

### BUG-004 · `minor`

**Non-null assertion on database query result**

| | |
|---|---|
| File | `apps/retail-microservice/src/app/api/order/providers/order-confirm.service.ts` |
| Line | 120 |

```typescript
return (await builder.getOne())!;
```

The `getOrder()` private method is called after the confirmation transaction completes. If the order were deleted between the transaction commit and this read (however unlikely), `getOne()` would return `null`, and the non-null assertion would propagate `null` as a valid `OrderConfirmResponseDto` — corrupting the RPC response.

---

### BUG-005 · `minor`

**Gateway OrderConfirmPipe omits correlationId from RPC payload**

| | |
|---|---|
| File | `apps/api-gateway/src/app/api/order/pipes/order-confirm.pipe.ts` |
| Lines | 31–35 |

```typescript
this.retailMicroserviceClient.send<{ statusId: OrderStatusEnum } | null, number>(
  MicroserviceMessagePatternEnum.RETAIL_ORDER_GET,
  id, // ← bare number, no correlationId wrapper
)
```

Every other RPC call in the gateway wraps the payload with `correlationId`. This call sends a bare `number`, breaking trace continuity for the order status pre-check.

---

## 1.2 Architecture & Structure

### ARCH-001 · `major`

**libs/inventory depends on libs/retail — cross-library coupling**

| | |
|---|---|
| File | `libs/inventory/product-stock/product-stock-order-confirm/product-stock-order-confirm.types.ts` |
| Line | 2 |

```typescript
import { IOrderProductConfirm } from '../../../retail';
```

`IProductStockOrderConfirmPayload` imports `IOrderProductConfirm` from `libs/retail`. This creates a dependency: **inventory → retail**. Domain libraries should be independent or have a clear dependency direction. If retail types change, inventory types must change too. The fix is to either define the shared type in `libs/common` or duplicate the minimal interface in `libs/inventory`.

---

### ARCH-002 · `minor`

**Notification microservice is an empty shell consuming resources**

| | |
|---|---|
| File | `apps/notification-microservice/src/app/app.module.ts` |

The notification microservice has no controllers, no `@MessagePattern` or `@EventPattern` handlers, and no business logic. It connects to RabbitMQ (consuming a connection) and is listed as a docker-compose service with health-check dependencies on MySQL and Redis — adding startup latency for the entire stack.

---

### ARCH-003 · `minor`

**Orphan empty file in libs/config/microservice-client/**

| | |
|---|---|
| File | `libs/config/microservice-client/microservice-client-configuration.ts` |

An empty file (0 bytes of content) in an untracked directory. Appears to be an aborted migration of `libs/common/config/microservice-client-configuration.ts`. Not exported from `libs/config/index.ts`. Should be deleted.

---

## 1.3 Naming & Conventions

### NAME-001 · `minor`

**Unused enum values in MicroserviceEventPatternEnum**

| | |
|---|---|
| File | `libs/common/enums/microservice-event-pattern.enum.ts` |

Both `RETAIL_ORDER_CREATED` and `RETAIL_ORDER_CONFIRMED` are defined but **never referenced** outside this file. No `@EventPattern` decorator exists anywhere in the codebase. These are dead code that implies an event-driven flow which does not exist yet. This directly feeds the inaccuracy in CLAUDE.md (BUG-003).

---

### NAME-002 · `minor`

**MicroserviceClientNotificationModule defined but never imported**

| | |
|---|---|
| File | `libs/common/modules/microservice-client-notification.module.ts` |

Fully implemented (22 lines) but not imported by any module in any service. Dead code.

---

### NAME-003 · `nit`

**ProductStockGetDto lacks "query" qualifier**

| | |
|---|---|
| File | `apps/api-gateway/src/app/api/product/dto/product-stock-get.dto.ts` |

This DTO represents **query parameters** (optional `storageIds` filter), not the response body. `ProductStockGetQueryDto` would avoid confusion with `ProductStockGetResponseDto` (the response DTO in `libs/inventory`).

---

## 1.4 Code Quality & Maintainability

### QUAL-001 · `minor`

**throwRpcError uses unsafe type cast without guard**

| | |
|---|---|
| File | `apps/api-gateway/src/app/common/utils/throw-rpc-error.util.ts` |
| Line | 9 |

```typescript
const { statusCode, message } = error as Record<string, unknown>;
```

If `error` is a string, `null`, or a non-object type, destructuring produces `undefined` values silently. The function still falls through to `InternalServerErrorException(undefined)`, which works but loses the original error context. A type guard would make intent explicit and preserve the original error message.

---

### QUAL-002 · `nit`

**Untracked workspace artifacts**

| | |
|---|---|
| Files | `a.md`, `libs/config/microservice-client/` |

Scratch files visible in `git status`. Should be deleted or added to `.gitignore`.

---

## 1.5 Configuration & DevOps

### CONF-001 · `critical`

**Dockerfiles incompatible with monorepo structure**

| | |
|---|---|
| Files | `apps/api-gateway/Dockerfile`, `apps/inventory-microservice/Dockerfile`, `apps/retail-microservice/Dockerfile`, `apps/notification-microservice/Dockerfile` |
| Also | `docker-compose.yml` (build context declarations) |

All four Dockerfiles assume a **standalone** project layout:

```dockerfile
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build
```

But docker-compose sets build context to the service directory (e.g., `context: ./apps/api-gateway`). The build depends on files **outside** this context:
- `libs/` (shared libraries imported by all services)
- Root `tsconfig.json`, `webpack.config.js`, `nest-cli.json`
- Root `package.json` and `yarn.lock` (monorepo deps)

**Result:** `docker build` will fail for every service. The Dockerfiles need to be rewritten with the project root as build context, or use a multi-stage approach that copies the necessary files.

---

### CONF-002 · `major`

**docker-compose dev volumes exclude shared libraries**

| | |
|---|---|
| File | `docker-compose.yml` |
| Lines | 72–73, 96–97, 120–121, 144–145 |

```yaml
volumes:
  - ./apps/api-gateway:/app
  - /app/node_modules
```

Only the service's own directory is mounted. The `libs/` directory is not available inside the container at runtime. Additionally, file-watch mode (`yarn start:dev`) won't detect changes to shared libraries.

---

### CONF-003 · `major`

**nest-cli.json references non-existent tsconfig.build.json**

| | |
|---|---|
| File | `nest-cli.json` |
| Line | 12 |

```json
"tsConfigPath": "tsconfig.build.json"
```

No `tsconfig.build.json` exists in the project. Per-project overrides (`tsconfig.app.json`) compensate for individual builds, but CLI commands that operate at the workspace level (e.g., `nest build --all`) may fall back to this path and fail or use the wrong config.

---

### CONF-004 · `major`

**source-map-support not in explicit dependencies**

| | |
|---|---|
| File | `webpack.config.js` |
| Lines | 50–54 |

```javascript
new webpack.BannerPlugin({
  banner: 'require("source-map-support").install();',
  raw: true,
  entryOnly: true,
})
```

Every built bundle starts with `require("source-map-support")`. This package is **not listed** in `package.json`. It may exist as a transitive dependency of `ts-node`, but:
- `webpack-node-externals` marks it as external (not bundled)
- A production `yarn install --production` might not include it
- Transitive dependency availability can change on any update

---

### CONF-005 · `minor`

**Build-time packages in production dependencies**

| | |
|---|---|
| File | `package.json` |
| Lines | 42, 64–69 |

The following packages are in `dependencies` but only needed at build time:
- `@nestjs/cli`
- `ts-loader`
- `tsconfig-paths-webpack-plugin`
- `webpack`
- `webpack-node-externals`

This inflates the production `node_modules` size and the Docker image (if Dockerfiles are fixed). They should be in `devDependencies`.

---

### CONF-006 · `minor`

**Redis infrastructure provisioned but unused**

| | |
|---|---|
| Files | `docker-compose.yml:39–50`, `libs/config/configuration/objects/config-validation-schema.ts:14`, `.env.local:10` |

Redis is started in docker-compose, all services declare `depends_on: redis`, and the Joi schema **requires** `REDIS_URL`. However, no service imports a Redis client or uses caching. This adds startup latency (health-check wait) and a mandatory config entry for an unused dependency.

---

### CONF-007 · `minor`

**LOG_LEVEL used by logger but absent from env config and validation**

| | |
|---|---|
| Files | `libs/config/logger/logger.config.ts:29`, `.env.local`, `libs/config/configuration/objects/config-validation-schema.ts` |

```typescript
level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
```

`LOG_LEVEL` is read from the environment but is not present in `.env.local` and not validated by the Joi schema. Users cannot discover this option without reading the logger source code.

---

### CONF-008 · `minor`

**jest.setup.ts duplicates .env.local values**

| | |
|---|---|
| File | `test/jest.setup.ts` |

All environment variables are hardcoded:

```typescript
process.env.DATABASE_URL = 'mysql://retail:retailpass@localhost:3306/retail_db';
process.env.RABBITMQ_URL = 'amqp://guest:guest@localhost:5672';
// ...
```

These duplicate the values in `.env.local`. If infrastructure ports or credentials change, both files must be updated in sync. Consider loading `.env.local` (or a `.env.test`) via `dotenv` instead.

---

### CONF-009 · `minor`

**Migration CLI script has absolute path**

| | |
|---|---|
| File | `package.json` |
| Line | 28 |

```json
"typeorm:migration-cli": "ts-node ... -d /migrations/config/data-source.ts"
```

The leading `/` makes this an **absolute filesystem path** (`/migrations/config/data-source.ts`). This relies on TypeORM CLI internally joining it with `process.cwd()` — an implementation detail that could change. The conventional form is `./migrations/config/data-source.ts`.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| Major | 5 |
| Minor | 10 |
| Nit | 2 |
| **Total** | **19** |
