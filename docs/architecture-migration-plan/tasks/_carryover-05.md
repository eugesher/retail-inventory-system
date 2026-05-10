# _carryover-05.md — Align API Gateway to hexagonal layout (Phase 2)

> Generated 2026-05-10 by the task-05 session on branch
> `RIS-29-Architecture-migration-Phase-5-Align-API-Gateway-to-hexagonal-layout`.
> Entry-gate commit: `1796f46` (the merge of task-04 into `main`).
> The next task (`task-06-build-auth-from-scratch.md`) reads this
> file as its first action and fails fast if it is missing.

## 1. Entry-gate result

`yarn test:e2e` — **24 passed, 42 snapshots**. The wire-format
routing-key rename from task-04 is verified working end-to-end.
Carryover-04 §6 explicitly deferred this gate to task-05; it now
passes, so the dotted format is locked in.

## 2. File-rename map (gateway)

| Old path | New path |
|----------|----------|
| `apps/api-gateway/src/app/api/order/order.controller.ts` | `apps/api-gateway/src/modules/retail/presentation/order.controller.ts` |
| `apps/api-gateway/src/app/api/order/order.module.ts` | merged into `apps/api-gateway/src/modules/retail/infrastructure/retail.module.ts` |
| `apps/api-gateway/src/app/api/order/pipes/order-confirm.pipe.ts` | `apps/api-gateway/src/modules/retail/presentation/pipes/order-confirm.pipe.ts` |
| `apps/api-gateway/src/app/api/order/providers/order-create.service.ts` | `apps/api-gateway/src/modules/retail/application/use-cases/create-order.use-case.ts` |
| `apps/api-gateway/src/app/api/order/providers/order-confirm.service.ts` | `apps/api-gateway/src/modules/retail/application/use-cases/confirm-order.use-case.ts` |
| `apps/api-gateway/src/app/api/product/product.controller.ts` | `apps/api-gateway/src/modules/inventory/presentation/product.controller.ts` |
| `apps/api-gateway/src/app/api/product/product.module.ts` | merged into `apps/api-gateway/src/modules/inventory/infrastructure/inventory.module.ts` |
| `apps/api-gateway/src/app/api/product/dto/product-stock-get-query.dto.ts` | `apps/api-gateway/src/modules/inventory/presentation/dto/product-stock-get-query.dto.ts` |
| `apps/api-gateway/src/app/api/product/providers/product-stock-get.service.ts` | `apps/api-gateway/src/modules/inventory/application/use-cases/get-product-stock.use-case.ts` |
| `apps/api-gateway/src/app/common/utils/throw-rpc-error.util.ts` | `apps/api-gateway/src/common/utils/throw-rpc-error.util.ts` |
| `apps/api-gateway/src/app/common/utils/index.ts` | `apps/api-gateway/src/common/utils/index.ts` |

### New files (no pre-image)

| New path | Role |
|----------|------|
| `apps/api-gateway/src/modules/retail/application/ports/retail-gateway.port.ts` | `IRetailGatewayPort` interface + `RETAIL_GATEWAY_PORT` DI symbol. |
| `apps/api-gateway/src/modules/retail/application/ports/index.ts` | Barrel. |
| `apps/api-gateway/src/modules/retail/application/use-cases/index.ts` | Barrel. |
| `apps/api-gateway/src/modules/retail/infrastructure/messaging/retail-rabbitmq.adapter.ts` | `RetailRabbitmqAdapter implements IRetailGatewayPort`. Holds the injected `ClientProxy`. |
| `apps/api-gateway/src/modules/retail/infrastructure/retail.module.ts` | Top-level Nest module for the retail bounded context; binds the port to the adapter. |
| `apps/api-gateway/src/modules/retail/presentation/pipes/index.ts` | Barrel. |
| `apps/api-gateway/src/modules/inventory/application/ports/inventory-gateway.port.ts` | `IInventoryGatewayPort` + `IGetProductStockQuery` + `INVENTORY_GATEWAY_PORT`. |
| `apps/api-gateway/src/modules/inventory/application/ports/index.ts` | Barrel. |
| `apps/api-gateway/src/modules/inventory/application/use-cases/index.ts` | Barrel. |
| `apps/api-gateway/src/modules/inventory/infrastructure/messaging/inventory-rabbitmq.adapter.ts` | `InventoryRabbitmqAdapter implements IInventoryGatewayPort`. |
| `apps/api-gateway/src/modules/inventory/infrastructure/inventory.module.ts` | Top-level Nest module for inventory; binds port to adapter. |
| `apps/api-gateway/src/modules/inventory/presentation/dto/index.ts` | Barrel. |
| `docs/adr/009-port-adapter-at-the-gateway.md` | New ADR. |

### Removed files

- `apps/api-gateway/src/app/api/` — entire subtree (controllers, modules, pipes, providers, dto barrels) collapsed into `modules/`.
- `apps/api-gateway/src/app/common/utils/` — moved out to `apps/api-gateway/src/common/utils/`. The whole `app/common/` folder is now empty and deleted.
- `apps/api-gateway/src/app/api/index.ts` and `apps/api-gateway/src/app/common/utils/index.ts` — superseded by the new locations.

`apps/api-gateway/src/app/app.module.ts` and `apps/api-gateway/src/app/index.ts` are kept where they are. The `tsconfig.json` and `jest.e2e.config.js` path aliases for `@retail-inventory-system/apps/api-gateway` continue to point at `apps/api-gateway/src/app/app.module`. Moving `app.module.ts` to the `src/` root (matching the recommendation diagram exactly) is cosmetic and is deferred to task-14 cleanup — see ADR-009 §"Alternatives considered".

## 3. Use-case map (old service class → new class)

| Old class | New class | New file |
|-----------|-----------|----------|
| `OrderCreateService` | `CreateOrderUseCase` | `modules/retail/application/use-cases/create-order.use-case.ts` |
| `OrderConfirmService` | `ConfirmOrderUseCase` | `modules/retail/application/use-cases/confirm-order.use-case.ts` |
| `ProductStockGetService` | `GetProductStockUseCase` | `modules/inventory/application/use-cases/get-product-stock.use-case.ts` |

The use-case bodies preserve the prior logging structure (intent log on entry, success/warn log on result, error log on catch). The "Sending RPC to … service" log line that pre-task-05 controllers emitted was dropped — the adapter is the only layer that knows about the routing key, so the log no longer has a sensible class to live in. This is a deliberate simplification and a snapshot-irrelevant log change (the e2e snapshots do not assert on log output).

## 4. Port + adapter contracts

### `IRetailGatewayPort` (3 methods)

```ts
createOrder(dto: OrderCreateDto, correlationId: string): Promise<OrderCreateResponseDto>
confirmOrder(id: number, correlationId: string): Promise<OrderConfirmResponseDto>
getOrderStatus(id: number): Promise<{ statusId: OrderStatusEnum } | null>
```

`getOrderStatus` is the third method — the task spec listed only the first two (the controller's needs) but `OrderConfirmPipe` was also injecting `ClientProxy` and calling `RETAIL_ORDER_GET` inline. To honour the verification rule "no `ClientProxy` outside `infrastructure/messaging/*-rabbitmq.adapter.ts`," the pipe was moved behind the port too. **`getOrderStatus` does not take `correlationId`** because the pre-task-05 wire format for `RETAIL_ORDER_GET` was just the numeric id (no payload object) — preserved verbatim to avoid coordinating a change with the retail microservice's `@MessagePattern` handler. Closing this asymmetry is queued for task-08/task-09 alongside the publisher-port introduction.

### `IInventoryGatewayPort` (1 method)

```ts
getProductStock(query: IGetProductStockQuery, correlationId: string): Promise<ProductStockGetResponseDto>
```

`IGetProductStockQuery = { productId: number; storageIds?: string[] }` — exposes the same shape the use-case already had at the call site, decoupling the port from the presentation-layer `ProductStockGetQueryDto`.

### Adapter routing-key choice

Both adapters use `ROUTING_KEYS` from `@retail-inventory-system/messaging` (e.g. `ROUTING_KEYS.RETAIL_ORDER_CREATE`). Per carryover-04 §7 #4, this is the new idiomatic constants object for *fresh* call sites. Existing call sites in microservices still use `MicroserviceMessagePatternEnum` and are deliberately left alone — the flip is a focused cleanup at task-14 alongside shim removal.

## 5. `main.ts` ordering

`apps/api-gateway/src/main.ts` line 1 is now:

```ts
import '@retail-inventory-system/observability/tracer';
```

The body of `tracer.ts` is empty today (filled in task-10). The contract is encoded now so the cutover in task-10 needs no `main.ts` edit. The previous import block was reshuffled to keep the tracer import as a separate first-paragraph import; ESLint did not complain.

## 6. App-module wiring

`apps/api-gateway/src/app/app.module.ts` now imports `RetailModule` and `InventoryModule` from their new locations:

```ts
import { InventoryModule } from '../modules/inventory/infrastructure/inventory.module';
import { RetailModule } from '../modules/retail/infrastructure/retail.module';
```

The `CorrelationMiddleware` wiring is unchanged (already on `@retail-inventory-system/observability` after task-04). `LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.API_GATEWAY))` and `ConfigModule.forRoot(configModuleConfig)` are unchanged.

## 7. e2e snapshot drift

**None.** All 42 snapshots match byte-for-byte. The renames are internal (class names live inside services, not in the JSON response bodies) and the wire format (routing keys + payload shapes) is unchanged from the task-04 baseline. No `--updateSnapshot` was run.

## 8. Verification

```
$ yarn install
➤ YN0000: · Done in 0s 217ms (cache hit)

$ yarn build
webpack 5.106.0 compiled successfully in 8746 ms   # api-gateway
webpack 5.106.0 compiled successfully in 8510 ms   # inventory-microservice
webpack 5.106.0 compiled successfully in 8770 ms   # retail-microservice
webpack 5.106.0 compiled successfully in 9334 ms   # notification-microservice

$ yarn lint
# initial run produced 9 prettier-only errors on the new files (multi-line
#   single-name imports auto-formatted to single-line). `yarn lint:fix`
#   resolved all 9. Re-run is clean (exit 0, no output).

$ yarn test:unit
# Test Suites: 11 passed, 11 total
# Tests:       70 passed, 70 total
# (unchanged from carryover-04 — no new lib tests; gateway has no unit tests today)

$ yarn test:e2e
# Test Suites: 1 passed, 1 total
# Tests:       24 passed, 24 total
# Snapshots:   42 passed, 42 total
# Time:        11.353 s

$ grep -r 'ClientProxy' apps/api-gateway/src
apps/api-gateway/src/modules/retail/infrastructure/messaging/retail-rabbitmq.adapter.ts:2:import { ClientProxy } from '@nestjs/microservices';
apps/api-gateway/src/modules/retail/infrastructure/messaging/retail-rabbitmq.adapter.ts:21:    private readonly client: ClientProxy,
apps/api-gateway/src/modules/inventory/infrastructure/messaging/inventory-rabbitmq.adapter.ts:2:import { ClientProxy } from '@nestjs/microservices';
apps/api-gateway/src/modules/inventory/infrastructure/messaging/inventory-rabbitmq.adapter.ts:20:    private readonly client: ClientProxy,
# Only the two adapter files. Verification rule satisfied.

$ head -1 apps/api-gateway/src/main.ts
import '@retail-inventory-system/observability/tracer';
```

All seven verification gates pass.

## 9. Cross-cutting concerns deferred to later tasks

1. **Trace-context propagation across RabbitMQ headers.** The new adapters do not inject W3C `traceparent` headers into outbound `client.send()` calls. `tracer.ts` is empty and `TraceContextInterceptor` is a stub. Both land in **task-10** alongside the OTel exporter wiring. The gateway adapters will need a small edit then to attach trace context to outbound payloads (or to `RmqRecord` headers).
2. **`RETAIL_ORDER_GET` should carry a `correlationId`.** Pre-task-05 it didn't, and `getOrderStatus(id)` preserves that. The fix is coordinated with the publisher-port introduction in **task-08/task-09** — at that point `IMessagePublisher` shapes every outbound message uniformly and the gap closes naturally.
3. **`MicroserviceMessagePatternEnum` is still used by microservices.** Adapters in this task use `ROUTING_KEYS`; microservice `@MessagePattern` decorators still reference the enum. This is deliberate (carryover-04 §7 #4). The flip is **task-14** cleanup alongside shim removal.
4. **`apps/api-gateway/src/app/app.module.ts` location.** The recommendation diagram shows `app.module.ts` at the `src/` root; today it stays under `app/` to avoid a `tsconfig.json` + `jest.e2e.config.js` path-alias change. Cosmetic — deferred to **task-14**.
5. **No unit tests for the new gateway use-cases / adapters.** Pre-task-05 the gateway had no unit tests; task-05 did not add any. The use-cases are now port-injected and unit-testable against an in-memory stub; if task-12 (architecture lint) wants test coverage for the boundary, that's a focused addition there or in task-14.
6. **`docs/architecture-migration-plan/parts/recommendation.md`** still says "next free number is **003**" in its preamble. That preamble is a historical reference (frozen at the start of the migration); the live counter is in `CLAUDE.md` (now bumped to `010`). No action needed.

## 10. Suggested adjustments to task-06 (auth)

Concrete recommendations informed by what task-05 left in place:

1. **`modules/auth/` mounts at `apps/api-gateway/src/modules/auth/`.** Same parent as `modules/retail/` and `modules/inventory/`. The `app.module.ts` import goes alongside the existing two: `import { AuthModule } from '../modules/auth/infrastructure/auth.module';`. No structural surprises.
2. **`auth/` is the first gateway module to have a `domain/`.** Task-05 deliberately omitted `domain/` from retail and inventory because there's no aggregate state. Auth has User and Role; that's where `domain/` first appears on the gateway. The CLAUDE.md "Service Structure" block already calls this out.
3. **Use the same DI-symbol convention for `auth` ports** that task-05 established: `IXxxPort` interface + `XXX_PORT` `Symbol(...)` constant in the `application/ports/` file. `libs/cache` and `libs/observability` use the same shape (`ICachePort` + `CACHE_PORT`); task-05 mirrored it for the gateway ports.
4. **The `@retail-inventory-system/auth` library does not exist yet.** Task-06 builds it. Per the recommendation §2 it lives under `libs/auth/` and exports `JwtStrategy`, `RolesGuard`, `@CurrentUser()`, `@Public()`, and an `AuthModule`. The gateway-side `modules/auth/` consumes this library; the library itself is framework-glue, not a hexagonal module.
5. **Wire global guards in `app.module.ts`, not in `auth.module.ts`.** A global `JwtAuthGuard` (with `@Public()` opt-out) needs to apply across `RetailModule` and `InventoryModule` controllers. Provide it as `APP_GUARD` from `app.module.ts` so it shadows every controller route.
6. **`OrderConfirmPipe` is the precedent for "presentation injects a port."** When task-06 adds a `JwtStrategy` that needs to look up users via a port, the pattern is already in the codebase — see `apps/api-gateway/src/modules/retail/presentation/pipes/order-confirm.pipe.ts`.
7. **The `ROUTING_KEYS` registry currently has no `auth.*` entries.** If task-06 introduces user-related RPCs (e.g. `auth.user.lookup`), add them to `libs/messaging/routing-keys.constants.ts` *and* `libs/contracts/microservices/microservice-message-pattern.enum.ts` together — `libs/messaging/spec/routing-keys.constants.spec.ts` enforces alignment between the two.
8. **`throw-rpc-error.util` is at `apps/api-gateway/src/common/utils/`.** If `auth` has its own error-translation needs, prefer to extend that util (or add a sibling) rather than re-implementing inline.
