# ADR-009: Port-and-adapter split at the API gateway

- **Date**: 2026-05-10
- **Status**: Accepted

---

## Context

ADR-004 commits the project to a per-module hexagonal layout for every
service in `apps/`. Task-05 lands the structural change for the API
gateway (`apps/api-gateway/`).

Pre-task-05 the gateway was flat:

```
apps/api-gateway/src/app/api/
├── order/
│   ├── order.controller.ts
│   ├── order.module.ts
│   ├── pipes/order-confirm.pipe.ts
│   └── providers/
│       ├── order-create.service.ts
│       └── order-confirm.service.ts
└── product/
    ├── product.controller.ts
    ├── product.module.ts
    ├── dto/product-stock-get-query.dto.ts
    └── providers/product-stock-get.service.ts
```

Each provider injected `ClientProxy` from `@nestjs/microservices`
directly, called `client.send(MicroserviceMessagePatternEnum.X, …)`,
and returned the response to the controller. The pipe also held a
`ClientProxy` and sent `RETAIL_ORDER_GET` inline. There was no seam
between "what this gateway needs to ask the downstream service" and
"how the message reaches RabbitMQ" — replacing the transport (or
faking it for unit tests) required substituting the Nest microservice
client globally.

The migration recommendation
([`docs/architecture-migration-plan/parts/recommendation.md`](../architecture-migration-plan/parts/recommendation.md)
§5) explicitly forbids `ClientProxy` injection from a controller and
calls for a `*.gateway.port.ts` adapter pair. The gateway needs the
same layered shape as every other service so that the architecture-lint
rules in task-12 can apply uniformly.

## Decision

### Per-module hexagonal layout

The gateway moves from `app/api/<feature>/` to
`modules/<feature>/{application,infrastructure,presentation}/`:

```
apps/api-gateway/src/
├── app/app.module.ts
├── common/utils/throw-rpc-error.util.ts
├── main.ts                              # first import: @retail-inventory-system/observability/tracer
└── modules/
    ├── retail/
    │   ├── application/
    │   │   ├── ports/retail-gateway.port.ts        # IRetailGatewayPort + RETAIL_GATEWAY_PORT
    │   │   └── use-cases/
    │   │       ├── confirm-order.use-case.ts       # ConfirmOrderUseCase
    │   │       └── create-order.use-case.ts        # CreateOrderUseCase
    │   ├── infrastructure/
    │   │   ├── messaging/retail-rabbitmq.adapter.ts
    │   │   └── retail.module.ts                    # @Module — wires the adapter
    │   └── presentation/
    │       ├── order.controller.ts                 # POST/PUT /api/order…
    │       └── pipes/order-confirm.pipe.ts
    └── inventory/
        ├── application/
        │   ├── ports/inventory-gateway.port.ts     # IInventoryGatewayPort + INVENTORY_GATEWAY_PORT
        │   └── use-cases/get-product-stock.use-case.ts
        ├── infrastructure/
        │   ├── messaging/inventory-rabbitmq.adapter.ts
        │   └── inventory.module.ts
        └── presentation/
            ├── product.controller.ts               # GET /api/product/:id/stock
            └── dto/product-stock-get-query.dto.ts
```

The two top-level modules are named **retail** and **inventory** —
after the *downstream* service the proxy talks to, not the public URL
prefix. This keeps the gateway's internal mental model consistent
with the microservice it fronts (`retail-microservice` →
`modules/retail`) regardless of how the URL is later rewritten.

### Gateway has no `domain/`

The gateway holds no aggregate state of its own — it is presentation
plus an outbound transport adapter. The `domain/` folder is therefore
omitted from the retail and inventory modules. Task-06 introduces
`modules/auth/` with a real `domain/` (User, Role) — that is the only
module on the gateway that owns enforced state.

### Controllers, use-cases, and pipes never inject `ClientProxy`

The boundary rule is: `ClientProxy` (and any other transport-layer
type from `@nestjs/microservices`) is allowed only in
`infrastructure/messaging/*-rabbitmq.adapter.ts`. Every other layer
depends on the port symbol.

| Layer | Talks to RabbitMQ via | Notes |
|-------|----------------------|-------|
| `presentation/` (controller, pipe) | use-case (controller) or port (pipe) | Pipes are presentation but operate before the controller; they may inject the port directly when their job is to validate via a transport call. |
| `application/use-cases/` | port symbol injected via Nest DI | Logging, error translation, business intent live here. |
| `application/ports/` | — | Port file declares an interface and a DI symbol. No `@nestjs/microservices` import. |
| `infrastructure/messaging/<svc>-rabbitmq.adapter.ts` | `ClientProxy` from the per-service `MicroserviceClient*Module` | Single place that knows about routing keys and `client.send()`. |
| `infrastructure/<svc>.module.ts` | binds `provide: <PORT>, useClass: <Adapter>` | Single Nest module per gateway-side bounded context. |

The pipe (`OrderConfirmPipe`) also injects the port. It calls
`getOrderStatus(id)`, the third method on `IRetailGatewayPort`,
which exists specifically because the pipe needs a pre-confirm
status read. Putting the pipe behind the port keeps the
"`ClientProxy` lives in adapters only" rule absolute.

### Routing keys: use the new `ROUTING_KEYS` constants

Adapters reference `ROUTING_KEYS.RETAIL_ORDER_CREATE` etc. from
`@retail-inventory-system/messaging` rather than the
`MicroserviceMessagePatternEnum` (kept for back-compat per ADR-008).
This is a fresh-write rule — task-05 did not flip existing call sites
in microservices, that's a focused cleanup pass at task-14.

### `main.ts` boots OpenTelemetry first

The first executable line of `apps/api-gateway/src/main.ts` is

```ts
import '@retail-inventory-system/observability/tracer';
```

The body of `tracer.ts` is empty today (filled in task-10). The
import is wired now so the cutover in task-10 needs no change to
`main.ts`. OTel must initialize before `NestFactory.create*()` so
auto-instrumentation can patch HTTP, MySQL (TypeORM), Redis, and
AMQP modules in time — that requirement constrains the bootstrap
ordering even though the body is currently a no-op.

### `RETAIL_ORDER_GET` payload preserved as-is

The pre-task-05 pipe sent only the numeric order id over
`RETAIL_ORDER_GET` (no `correlationId`). The new
`getOrderStatus(id)` adapter method preserves that wire shape
verbatim — flipping it to include a `correlationId` would have
required a coordinated change on the retail microservice
`@MessagePattern` handler, which is out of scope for the gateway
alignment. The gap is acknowledged in `_carryover-05.md`; a fix lands
together with the publisher-port introduction in task-08/task-09.

## Consequences

- **+** The gateway matches the hexagonal layout the rest of the
  services adopt in tasks 06–09. The architecture-lint rules in
  task-12 can treat all `apps/*` uniformly.
- **+** Replacing RabbitMQ with another transport at the gateway is
  now a single-file change (the adapter). Use-cases and the pipe
  stay untouched.
- **+** Use-cases are unit-testable against an in-memory port stub
  (no Nest microservice harness required).
- **−** One extra layer of indirection per outbound call. The
  controller now calls a use-case which calls a port; the use-case
  body stays slim today (it logs, translates errors, and forwards),
  but the indirection is the seam ADR-004 commits to.
- **−** Two methods on `IRetailGatewayPort` carry `correlationId` as
  an explicit parameter; `getOrderStatus` does not. The asymmetry
  reflects the wire format and is documented at the port — a
  follow-up task aligns it.

## Alternatives considered

- **Skip the use-case layer; controllers call the port directly.**
  Rejected: would produce a layout where the gateway's
  `application/` is empty, breaking the uniform shape ADR-004
  prescribes. The use-case is intentionally slim today; it carries
  the logging and error-translation concerns that previously lived
  in the per-action service, and gives task-06 an obvious place to
  layer `auth`-aware logic.
- **Keep the pipe injecting `ClientProxy`.** Rejected: the
  "no `ClientProxy` outside adapters" verification gate would fail,
  and the pipe would become an exception that future readers have to
  remember. Cheaper to add `getOrderStatus` to the port.
- **Name the modules `order/` and `product/` (matching the URL).**
  Rejected: the URL is a presentation detail; the *bounded context*
  the proxy talks to is `retail-microservice` / `inventory-microservice`.
  Naming after the downstream service makes the cross-app boundary
  visible at the directory level and matches the layout the
  microservices themselves adopt in tasks 08–09.
- **Move `app.module.ts` out of `apps/api-gateway/src/app/` to the
  `src/` root** (matching the recommendation diagram exactly).
  Deferred: requires updating `tsconfig.json` and
  `jest.e2e.config.js` path aliases. Cosmetic; the load-bearing
  structure (per-module folders, port/adapter split) is in place.
  Tracked for task-14 cleanup.

---

## References

- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) — the
  per-service hexagonal target this gateway alignment realizes.
- [ADR-008](008-rabbitmq-via-libs-messaging.md) — the routing-key
  wire format the gateway adapters consume.
- [ADR-018](018-nestjs-monorepo-apps-and-libs.md) — the monorepo
  apps/libs layout the gateway sits inside.
- [ADR-020](020-rabbitmq-as-inter-service-bus.md) — the transport
  the messaging adapter wraps.
