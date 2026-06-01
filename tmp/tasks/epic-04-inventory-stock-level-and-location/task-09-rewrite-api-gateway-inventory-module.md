---
epic: epic-04
task_number: 9
title: Rewrite the api-gateway modules/inventory + Kulala HTTP file
depends_on: [01, 02, 03, 04, 05, 06, 07, 08]
doc_deliverable: docs/implementation/04-inventory-stock-level-and-location/08-inventory-http-file.md
---

# Task 09 — Rewrite the api-gateway `modules/inventory/` + author `http/inventory.http`

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Replace the legacy `productId`-keyed inventory module on the api-gateway with the new `variantId`-keyed module that surfaces the four HTTP endpoints the epic charters: `GET /api/inventory/locations` (list locations), `GET /api/inventory/variants/:variantId/stock` (read availability — public), `POST /api/inventory/variants/:variantId/stock/receive` (Receive Stock — admin), `POST /api/inventory/variants/:variantId/stock/adjust` (Adjust Stock — admin). Delete the legacy `product.controller.ts` plus `http/product.http`; author `http/inventory.http` as the replacement Kulala flow. Each new endpoint gets a DTO with class-validator decorators + an optional pipe; the controller's responses are typed by the projection shapes from `libs/contracts/inventory/stock-availability/`.

The hexagonal shape of the api-gateway module is **preserved** — every existing file gets renamed-and-rewritten in place; no new directories. The RMQ adapter (`inventory-rabbitmq.adapter.ts`) gets new methods matching the new RPC routing keys from task-08. The DI binding (`INVENTORY_GATEWAY_PORT`) stays.

## Entry state assumed

Task-08 carryover present:

- Inventory microservice's `stock.controller.ts` has three `@MessagePattern` handlers (`INVENTORY_STOCK_RECEIVE`, `INVENTORY_STOCK_ADJUST`, `INVENTORY_STOCK_QUERY_AVAILABILITY`) and one deprecation handler (`INVENTORY_ORDER_CONFIRM`).
- `libs/messaging/routing-keys.constants.ts` carries the three new RPC routing keys.
- `libs/contracts/inventory/stock-availability/` exports `IStockAvailabilityProjection` + `IStockLevelProjection`.
- `libs/contracts/inventory/product-stock/` is gone (deleted by task-05).
- The api-gateway side still has the legacy module: `presentation/product.controller.ts`, `presentation/dto/product-stock-get-query.dto.ts`, `application/use-cases/get-product-stock.use-case.ts`, `application/ports/inventory-gateway.port.ts` (with the `IGetProductStockQuery` shape), `infrastructure/messaging/inventory-rabbitmq.adapter.ts`. None of these compile against the new `libs/contracts/inventory/` exports — verify the build is currently red and that this task's first job is to make it green.

## Scope

**In:**

- Rewrite `apps/api-gateway/src/modules/inventory/application/ports/inventory-gateway.port.ts`:
  - `IInventoryGatewayPort` now has **four methods**: `listLocations(correlationId)`, `queryAvailability(query, correlationId)`, `receiveStock(payload, correlationId)`, `adjustStock(payload, correlationId)`.
  - `IGetProductStockQuery` is deleted; new request/payload types are defined: `IQueryAvailabilityQuery`, `IReceiveStockRequest`, `IAdjustStockRequest`. Each carries the `variantId` (from the URL path) + body fields.
- Rewrite `apps/api-gateway/src/modules/inventory/infrastructure/messaging/inventory-rabbitmq.adapter.ts`:
  - Four new methods implementing the port. Each one uses `ClientProxy.send(...)` (RPC) with the corresponding `ROUTING_KEYS.INVENTORY_STOCK_*` routing key from task-08.
  - The `INVENTORY_MICROSERVICE` client token is unchanged (the same client connects to the inventory queue from the gateway).
  - `listLocations` is a special case — the inventory microservice's controller does **not** expose a `@MessagePattern` handler for "list locations" in task-05 (it only added `receive` / `adjust` / `query-availability`). This task adds **one more** `@MessagePattern` handler on the inventory side: `@MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_LOCATIONS_LIST)` returning `StockLocation[]` projections. The handler delegates to a new `ListStockLocationsUseCase` (also added in this task on the inventory side). The routing-key constant `INVENTORY_STOCK_LOCATIONS_LIST: 'inventory.stock-locations.list'` is added to `libs/messaging/routing-keys.constants.ts`. **Justification for adding this scope spillover from task-08 → task-09**: the listing endpoint is a gateway-driven need that did not exist until this task; folding the routing-key registration here keeps the API surface delivery atomic.
- Delete `apps/api-gateway/src/modules/inventory/application/use-cases/get-product-stock.use-case.ts`. Replace with four use cases:
  - `list-stock-locations.use-case.ts`
  - `query-availability.use-case.ts`
  - `receive-stock.use-case.ts`
  - `adjust-stock.use-case.ts`
  Each delegates to the corresponding port method. Each one wraps the call in `throwRpcError` per the project's existing pattern.
- Rewrite `apps/api-gateway/src/modules/inventory/presentation/`:
  - Delete `product.controller.ts`.
  - New `apps/api-gateway/src/modules/inventory/presentation/inventory.controller.ts` with the four endpoints.
  - Delete `presentation/dto/product-stock-get-query.dto.ts`.
  - New DTOs under `presentation/dto/`:
    - `stock-availability-query.dto.ts` — for `GET /variants/:variantId/stock`. Carries `stockLocationIds?: string[]` query param (parsed via `@Transform(JSON.parse)` from the URL-encoded array — match the existing project pattern from `product-stock-get-query.dto.ts`).
    - `receive-stock.dto.ts` — for `POST /variants/:variantId/stock/receive`. Carries `stockLocationId?: string` and `quantity: number` (positive integer).
    - `adjust-stock.dto.ts` — for `POST /variants/:variantId/stock/adjust`. Carries `stockLocationId?: string`, `quantityDelta: number` (non-zero integer), `reasonCode: string` (non-empty).
  - A new pipe under `presentation/pipes/` only if the project's existing conventions require it for `variantId: ParseIntPipe` (verify against `retail/presentation/pipes/order-confirm.pipe.ts`; reuse the built-in `ParseIntPipe` if no custom pipe is needed — for `variantId` no custom validation beyond positive-int is required).
- Update `apps/api-gateway/src/modules/inventory/infrastructure/inventory.module.ts`:
  - Provide the four new use cases.
  - Re-wire the controller from `ProductController` to `InventoryController`.
- Delete `http/product.http`.
- Author `http/inventory.http`. Sections:
  - Header explaining the seeded `default-warehouse` id (`'default-warehouse'`) and the rule "omit `stockLocationId` ⇒ target the default".
  - One Kulala-named request per endpoint. The flow exercises: list locations → receive 50 → adjust −3 → query availability → public read against an unauthenticated request.
- Doc deliverable `08-inventory-http-file.md`.

**Out:**

- Seed extensions — task-10.
- E2E tests — task-10.
- README / CLAUDE.md updates — task-10.

## `inventory.controller.ts` — concrete shape

```ts
import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';

import { Public, RequiresPermission } from '@retail-inventory-system/auth';
import {
  IStockAvailabilityProjection,
  IStockLevelProjection,
  IStockLocationProjection,
} from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import {
  AdjustStockUseCase,
  ListStockLocationsUseCase,
  QueryAvailabilityUseCase,
  ReceiveStockUseCase,
} from '../application/use-cases';
import { AdjustStockDto, ReceiveStockDto, StockAvailabilityQueryDto } from './dto';

@ApiTags('Inventory')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly listLocations: ListStockLocationsUseCase,
    private readonly queryAvailability: QueryAvailabilityUseCase,
    private readonly receiveStock: ReceiveStockUseCase,
    private readonly adjustStock: AdjustStockUseCase,
  ) {}

  @ApiOperation({ summary: 'List all stock locations' })
  @ApiBearerAuth()
  @RequiresPermission('inventory:read')
  @Get('locations')
  public async getLocations(
    @CorrelationId() correlationId: string,
  ): Promise<IStockLocationProjection[]> {
    return this.listLocations.execute(correlationId);
  }

  @ApiOperation({
    summary: 'Get current stock availability for a variant',
    description: 'Public endpoint. Returns per-location availability + total. Omit stockLocationIds to get all locations.',
  })
  @Public()
  @Get('variants/:variantId/stock')
  public async getStock(
    @Param('variantId', ParseIntPipe) variantId: number,
    @Query() query: StockAvailabilityQueryDto,
    @CorrelationId() correlationId: string,
  ): Promise<IStockAvailabilityProjection> {
    return this.queryAvailability.execute(variantId, query.stockLocationIds, correlationId);
  }

  @ApiOperation({ summary: 'Receive stock for a variant' })
  @ApiBearerAuth()
  @RequiresPermission('inventory:adjust')
  @Post('variants/:variantId/stock/receive')
  @HttpCode(200)
  public async receive(
    @Param('variantId', ParseIntPipe) variantId: number,
    @Body() body: ReceiveStockDto,
    @CorrelationId() correlationId: string,
  ): Promise<IStockLevelProjection> {
    return this.receiveStock.execute(
      { variantId, stockLocationId: body.stockLocationId, quantity: body.quantity },
      correlationId,
    );
  }

  @ApiOperation({ summary: 'Apply a signed adjustment to stock' })
  @ApiBearerAuth()
  @RequiresPermission('inventory:adjust')
  @Post('variants/:variantId/stock/adjust')
  @HttpCode(200)
  public async adjust(
    @Param('variantId', ParseIntPipe) variantId: number,
    @Body() body: AdjustStockDto,
    @CorrelationId() correlationId: string,
  ): Promise<IStockLevelProjection> {
    return this.adjustStock.execute(
      {
        variantId,
        stockLocationId: body.stockLocationId,
        quantityDelta: body.quantityDelta,
        reasonCode: body.reasonCode,
      },
      correlationId,
    );
  }
}
```

Notes for the implementer:

- The `@Public()` decorator on `getStock` overrides the gateway's default `@ApiBearerAuth()` requirement — verify the project's auth module exposes this decorator (from epic-01); if not, an `@Public` placeholder + a comment forward-linking epic-01 task-04's `PermissionsGuard` is the substitute. The customer-facing route is unauthenticated; the cache-aside read path is the same.
- `inventory:read` and `inventory:adjust` are seeded into the `warehouse-staff` + `admin` roles by epic-01's permission floor (verify in `scripts/seeds/permissions.sql` or the equivalent).
- `IStockLocationProjection` is a thin DTO mirroring the domain `StockLocation` getters; defined in `libs/contracts/inventory/stock-availability/stock-location.projection.ts` in this task.

## DTOs

```ts
// stock-availability-query.dto.ts
import { Transform } from 'class-transformer';
import { IsArray, IsOptional, IsString } from 'class-validator';

export class StockAvailabilityQueryDto {
  @Transform(({ value }) => (value ? JSON.parse(value) : undefined))
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public stockLocationIds?: string[];
}
```

```ts
// receive-stock.dto.ts
import { IsInt, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

export class ReceiveStockDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public stockLocationId?: string;

  @IsInt()
  @IsPositive()
  public quantity: number;
}
```

```ts
// adjust-stock.dto.ts
import { IsInt, IsOptional, IsString, MaxLength, MinLength, NotEquals } from 'class-validator';

export class AdjustStockDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public stockLocationId?: string;

  @IsInt()
  @NotEquals(0)
  public quantityDelta: number;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public reasonCode: string;
}
```

`class-validator` is the project's existing validation framework (the gateway uses the global `ValidationPipe` already — verify in `apps/api-gateway/src/main.ts`). No new pipe registration is needed; the global `ValidationPipe` covers all three DTOs.

## `inventory-rabbitmq.adapter.ts` — concrete shape

```ts
import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IStockAvailabilityProjection,
  IStockLevelProjection,
  IStockLocationProjection,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  IAdjustStockRequest,
  IInventoryGatewayPort,
  IQueryAvailabilityQuery,
  IReceiveStockRequest,
} from '../../application/ports';

@Injectable()
export class InventoryRabbitmqAdapter implements IInventoryGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly client: ClientProxy,
  ) {}

  public listLocations(correlationId: string): Promise<IStockLocationProjection[]> {
    return firstValueFrom(
      this.client.send(ROUTING_KEYS.INVENTORY_STOCK_LOCATIONS_LIST, { correlationId }),
    );
  }

  public queryAvailability(
    query: IQueryAvailabilityQuery,
    correlationId: string,
  ): Promise<IStockAvailabilityProjection> {
    return firstValueFrom(
      this.client.send(ROUTING_KEYS.INVENTORY_STOCK_QUERY_AVAILABILITY, { ...query, correlationId }),
    );
  }

  public receiveStock(
    payload: IReceiveStockRequest,
    correlationId: string,
  ): Promise<IStockLevelProjection> {
    return firstValueFrom(
      this.client.send(ROUTING_KEYS.INVENTORY_STOCK_RECEIVE, { ...payload, correlationId }),
    );
  }

  public adjustStock(
    payload: IAdjustStockRequest,
    correlationId: string,
  ): Promise<IStockLevelProjection> {
    return firstValueFrom(
      this.client.send(ROUTING_KEYS.INVENTORY_STOCK_ADJUST, { ...payload, correlationId }),
    );
  }
}
```

## Inventory microservice side: `ListStockLocationsUseCase` + the new `@MessagePattern` handler

The api-gateway's `listLocations` requires a matching handler on the inventory microservice. This task adds (on the inventory side):

- New use case `apps/inventory-microservice/src/modules/stock/application/use-cases/list-stock-locations.use-case.ts`. Constructor injects `STOCK_LOCATION_REPOSITORY`. Body: `return this.repository.list({ activeOnly: true });` + a `toProjection` mapper. ≥3 spec cases.
- New `@MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_LOCATIONS_LIST)` handler in `stock.controller.ts` delegating to the new use case.
- The use case is exported through `application/use-cases/index.ts`; the module's provider list grows by one.

This is the only scope addition this task makes to the inventory microservice — every other inventory-side change was completed by tasks 01–08.

## `http/inventory.http` — concrete content

The file is the deliverable; its content is reproduced almost verbatim by Kulala when the user opens it. Target structure (Kulala syntax — match the project's existing `order.http` style):

```http
# Inventory endpoints (apps/api-gateway/src/modules/inventory/presentation/inventory.controller.ts)
#
# All write endpoints require a bearer token with the `inventory:adjust`
# permission. The list-locations endpoint requires `inventory:read`. The
# variant-stock read is @Public() and works without a token.
#
# The seeded default location is:
#   id   = 'default-warehouse'
#   code = 'DEFAULT-WAREHOUSE'
# Omitting `stockLocationId` in any write body targets the default.

@baseUrl = {{ENV_BASE_URL}}
@adminToken = {{ENV_ADMIN_BEARER_TOKEN}}
@variantId = 1
@locationId = default-warehouse

###

# @name listLocations
# GET /api/inventory/locations
# Returns every StockLocation row (active=true filter applied server-side).
GET {{baseUrl}}/inventory/locations
Authorization: Bearer {{adminToken}}

###

# @name getStockAllLocations
# GET /api/inventory/variants/:variantId/stock
# Public — no auth header required. Returns per-location availability.
GET {{baseUrl}}/inventory/variants/{{variantId}}/stock

###

# @name getStockFiltered
# GET /api/inventory/variants/:variantId/stock?stockLocationIds=…
# The stockLocationIds value MUST be a JSON-encoded array literal,
# URL-encoded — same pattern as the legacy product.http used. Repeating
# the param will NOT work.
#   ["default-warehouse"]   →   %5B%22default-warehouse%22%5D
GET {{baseUrl}}/inventory/variants/{{variantId}}/stock?stockLocationIds=%5B%22default-warehouse%22%5D

###

# @name receiveStock
# POST /api/inventory/variants/:variantId/stock/receive
# Increment quantityOnHand by the body's quantity at the named location
# (or the default warehouse if stockLocationId is omitted).
POST {{baseUrl}}/inventory/variants/{{variantId}}/stock/receive
Authorization: Bearer {{adminToken}}
Content-Type: application/json

{
  "stockLocationId": "{{locationId}}",
  "quantity": 50
}

###

# @name adjustStockNegative
# POST /api/inventory/variants/:variantId/stock/adjust
# Apply a signed delta. reasonCode is mandatory; the value is carried into
# the emitted inventory.stock.adjusted event but not persisted in a column
# (the future-StockMovement table is owned by epic-07).
POST {{baseUrl}}/inventory/variants/{{variantId}}/stock/adjust
Authorization: Bearer {{adminToken}}
Content-Type: application/json

{
  "stockLocationId": "{{locationId}}",
  "quantityDelta": -3,
  "reasonCode": "damaged"
}

###

# @name adjustStockExcessiveNegative
# Same endpoint, body deliberately drives quantityOnHand below zero.
# Expected: 409 Conflict (StockInvariantViolationError).
POST {{baseUrl}}/inventory/variants/{{variantId}}/stock/adjust
Authorization: Bearer {{adminToken}}
Content-Type: application/json

{
  "stockLocationId": "{{locationId}}",
  "quantityDelta": -1000,
  "reasonCode": "test-conflict"
}
```

The `adjustStockExcessiveNegative` request is what the e2e test in task-10 maps to step 6 of `test/inventory-receive-and-adjust.e2e-spec.ts`.

## Files to add

- `apps/api-gateway/src/modules/inventory/presentation/inventory.controller.ts`
- `apps/api-gateway/src/modules/inventory/presentation/dto/stock-availability-query.dto.ts`
- `apps/api-gateway/src/modules/inventory/presentation/dto/receive-stock.dto.ts`
- `apps/api-gateway/src/modules/inventory/presentation/dto/adjust-stock.dto.ts`
- `apps/api-gateway/src/modules/inventory/application/use-cases/list-stock-locations.use-case.ts`
- `apps/api-gateway/src/modules/inventory/application/use-cases/query-availability.use-case.ts`
- `apps/api-gateway/src/modules/inventory/application/use-cases/receive-stock.use-case.ts`
- `apps/api-gateway/src/modules/inventory/application/use-cases/adjust-stock.use-case.ts`
- `apps/inventory-microservice/src/modules/stock/application/use-cases/list-stock-locations.use-case.ts` + spec
- `libs/contracts/inventory/stock-availability/stock-location.projection.ts`
- `http/inventory.http`
- `docs/implementation/04-inventory-stock-level-and-location/08-inventory-http-file.md`

## Files to modify

- `apps/api-gateway/src/modules/inventory/application/ports/inventory-gateway.port.ts` — four-method port; new request types.
- `apps/api-gateway/src/modules/inventory/application/ports/index.ts` — re-export the new request types.
- `apps/api-gateway/src/modules/inventory/application/use-cases/index.ts` — drop legacy use case; add the four new ones.
- `apps/api-gateway/src/modules/inventory/infrastructure/messaging/inventory-rabbitmq.adapter.ts` — four-method adapter.
- `apps/api-gateway/src/modules/inventory/infrastructure/inventory.module.ts` — controller swap; new providers.
- `apps/api-gateway/src/modules/inventory/index.ts` — re-export the new controller.
- `apps/api-gateway/src/app/app.module.ts` — if the inventory module is imported by name, no change; if it imports the legacy `ProductController` directly anywhere, fix.
- `libs/messaging/routing-keys.constants.ts` — add `INVENTORY_STOCK_LOCATIONS_LIST: 'inventory.stock-locations.list'`.
- `libs/messaging/spec/routing-keys.constants.spec.ts` — assert the new key.
- `apps/inventory-microservice/src/modules/stock/presentation/stock.controller.ts` — new `@MessagePattern` handler for the list-locations RPC.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/index.ts` — re-export the new use case.
- `apps/inventory-microservice/src/modules/stock/infrastructure/stock.module.ts` — register the new use case.
- `libs/contracts/inventory/stock-availability/index.ts` — re-export the location projection.

## Files to delete

- `apps/api-gateway/src/modules/inventory/presentation/product.controller.ts`
- `apps/api-gateway/src/modules/inventory/presentation/dto/product-stock-get-query.dto.ts`
- `apps/api-gateway/src/modules/inventory/application/use-cases/get-product-stock.use-case.ts`
- `http/product.http`

## Tests

- Inventory-side `list-stock-locations.use-case.spec.ts` — ≥3 cases: returns all rows when `activeOnly: false`; filters when `activeOnly: true`; empty list on no rows.
- Api-gateway side: existing test patterns for the catalog/retail modules are controller-level integration via supertest (verify in `test/auth.e2e-spec.ts` or similar). Unit specs for the four new use cases are not added here — the gateway use cases are thin proxies. The e2e tests in task-10 cover the integration.
- `yarn build` passes across all microservices.
- `yarn lint` passes.
- Manual smoke: `docker compose up -d && yarn start:dev`, then run the entire `http/inventory.http` flow end-to-end. Each request returns the expected payload; the legacy `http/product.http` is gone (the request file does not exist on disk).

## Doc deliverable

Write `docs/implementation/04-inventory-stock-level-and-location/08-inventory-http-file.md`. Target ~120 lines. Sections:

1. **Endpoint surface recap.** The four endpoints + their auth model (one `@Public()`, two `inventory:adjust`-gated, one `inventory:read`-gated). The HTTP method, path, body, and response type for each.
2. **The seeded `default-warehouse` rule.** Why omitting `stockLocationId` in a write body targets the default (the use case's static `DEFAULT_STOCK_LOCATION_ID` constant). When a future contributor adds a second location, they explicitly pass the id.
3. **The Kulala flow.** Walk through the named requests in order: `listLocations` → `getStockAllLocations` (expect 0 units on a freshly-auto-init'd variant; non-zero on a seeded one) → `receiveStock` (50 units) → `adjustStockNegative` (`-3`) → `getStockAllLocations` (expect 47 units; second call should be a cache hit but the user can't observe that from the API alone — the response is the same shape) → `adjustStockExcessiveNegative` (expect 409 Conflict).
4. **DTO conventions.** The `@Transform(JSON.parse)` rule for the array query parameter; the `class-validator` decorators for the body DTOs; the global `ValidationPipe` that enforces them at the gateway boundary.
5. **The `http/product.http` deletion.** Why the file is gone (the `/api/product/:productId/stock` route no longer exists; the routing-key it proxied is retired). A grep across `http/` ensures the file is gone and `http-client.env.json` does not reference any product-specific variables.
6. **Forward links.** Task-10 (the seed extensions that make the Kulala flow work against the seeded `variantId = 1`; the e2e tests that automate the flow).

## Carryover produced (consumed by task-10)

- `inventory.controller.ts` exists with four endpoints; the legacy `product.controller.ts` is gone.
- Four new use cases on the gateway side; one new use case on the inventory side (`ListStockLocationsUseCase`).
- New routing key `INVENTORY_STOCK_LOCATIONS_LIST` registered.
- New DTOs with class-validator decorators.
- `http/inventory.http` exists; `http/product.http` is gone.
- Doc `08-inventory-http-file.md` exists.

## Exit criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; the new `list-stock-locations.use-case.spec.ts` is green with ≥3 cases.
- [ ] `yarn build` passes.
- [ ] `git ls-files http/` shows `http-client.env.json`, `order.http`, `inventory.http`, but no `product.http`.
- [ ] Manual smoke: every request in `http/inventory.http` executes against the seeded `default-warehouse` and a seeded `variantId = 1`. The `adjustStockExcessiveNegative` request returns `409 Conflict` with a typed error body.
- [ ] `curl -sS -X GET http://localhost:3000/api/inventory/variants/1/stock` returns a 200 without an Authorization header (the `@Public()` decorator works).
- [ ] `curl -sS -X POST http://localhost:3000/api/inventory/variants/1/stock/receive -d '{"quantity":1}'` returns 401/403 without a bearer token (the `@RequiresPermission` gate works).
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `08-inventory-http-file.md` exists with the six sections above filled.
