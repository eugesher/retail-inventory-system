# ADR-004: Adopt Hexagonal Architecture Per Service

- **Date**: 2026-05-09
- **Status**: Accepted

---

## Context

The retail-inventory-system today uses a "fat service" layout: each
microservice keeps its features under `app/api/<feature>/` with
per-action services that inject `Repository<X>` and `ClientProxy`
directly. The pattern is consistent and the per-action split is a real
strength (already partially in place at the start of the architecture
migration), but the lack of a port/adapter inversion means that:

- TypeORM is bound to the service surface — there is no place to
  exercise the service against a fake repository, so unit tests today
  either mock the repository per call or skip persistence concerns
  entirely.
- The `ClientProxy` to RabbitMQ is the same shape as the inventory
  service holds for retail, leaking transport concerns into business
  logic and making the inter-service contract non-obvious.
- New cross-cutting concerns (OpenTelemetry — task-10, generalized
  cache-aside — task-11, notification dispatch — task-07) have no
  obvious seam to attach to other than directly inside the service
  classes, which would compound the coupling.

The pre-migration recommendation that drove this work identified
hexagonal architecture (Ports & Adapters) as the target pattern: it is
the only TypeORM-compatible pattern with a star-validated reference in
the NestJS ecosystem, it lets the project keep its current stack
(TypeORM/MySQL/RabbitMQ/Redis/Pino), and it provides a clean seam for
the cache, OTel, and notification work that followed the structural
migration. This ADR records the *commitment* to that target.
Architecture-lint enforcement that prevents drift is recorded in
[ADR-017](017-architecture-lint-via-eslint-boundaries.md).

---

## Decision

The project will be restructured so that **each microservice follows
a per-module hexagonal layout**.

**Bounded contexts.** The migration treats the following four units as
its top-level structural divisions, mirroring the `apps/` folder:

- **retail** (`apps/retail-microservice`) — orders, customers.
- **inventory** (`apps/inventory-microservice`) — products, product
  stock, storage.
- **notification** (`apps/notification-microservice`) — outbound
  notifications (built fresh in task-07; today a stub).
- **gateway** (`apps/api-gateway`) — HTTP edge plus authentication
  (built fresh in task-06).

The retail and inventory contexts are bounded contexts in the DDD
sense; notification is an application service over an external
channel; gateway is the edge / aggregator. The hexagonal layout
applies to all four uniformly even though only the first two carry
non-trivial domain logic today, so that the placement rules and lint
boundaries are the same everywhere.

**Per-module layout.** Within each microservice, every module
(`auth`, `order`, `product-stock`, `notification`, …) follows the
four-layer split:

```
modules/<module-name>/
├── domain/             # entities, value objects, domain services, ports (interfaces)
├── application/        # use-cases, application services — orchestrates the domain via ports
├── infrastructure/     # adapters: TypeORM repositories, RabbitMQ clients, Redis caches, HTTP clients
└── presentation/       # NestJS controllers (HTTP for gateway, @MessagePattern for microservices)
```

The detailed layer responsibilities, allowed dependencies, and naming
conventions are codified in `CLAUDE.md`'s "Forbidden imports"
paragraph and enforced by
[ADR-017](017-architecture-lint-via-eslint-boundaries.md). Highlights:

- `domain/` may import from nothing outside its own module (no
  `@nestjs/*`, no TypeORM, no `class-validator` decorators on
  entities).
- `application/` may import from `domain/` and from injected ports;
  it does not import infrastructure adapters directly.
- `infrastructure/` implements ports declared in `domain/` and
  contains the only allowed imports of TypeORM, RabbitMQ, Redis, etc.
- `presentation/` contains controllers that depend on `application/`
  use-cases through `@Inject(...)`; no business logic lives here.
- Cross-module imports go through `@retail-inventory-system/<lib>`
  contracts, never through deep paths into another module.

**Naming.** The `I*` prefix for interfaces and the `*Enum` suffix for
enums (already enforced in `eslint.config.mjs`) are preserved.
Use-cases end in `*.use-case.ts`; ports are named `I<Aggregate>Port`
or `I<Aggregate>Repository` and live under `domain/ports/`; adapters
live under `infrastructure/<concern>/` and end in `*.adapter.ts` or
`*.repository.ts`.

**Migration sequence.** The structural moves are not part of this
ADR's scope; they are sequenced through task-03 (foundation libs),
task-04 (integration libs), task-05 (gateway align), task-06 (auth
fresh build), task-07 (notification fresh build), task-08 (inventory
align), task-09 (retail-orders align). Architecture-lint enforcement
(`eslint-plugin-boundaries` rules) is queued for task-12 once every
service has reached the target shape; until then, the rules would
generate noise faster than the migration can resolve it.

**Out of scope of this ADR.** The choice of CQRS, domain events, or
event sourcing is deferred. Hexagonal architecture is compatible with
all three but does not require them; layering them in selectively is
a future ADR if the need materializes.

---

## Alternatives Considered

**Awesome Nest Boilerplate / Tony133 (flat layout).** Rejected because
both are flat and would lock the project into the "fat services"
shape we are leaving. Neither offers a place to attach the cache,
OTel, and notification work without re-introducing the same coupling
we are trying to remove.

**Domain-Driven Hexagon / Ultimate Backend.** Rejected as
disproportionate to this project's current scale and as carrying
incompatible persistence layers (Mikro-ORM + CQRS event sourcing).
The per-module hexagonal split here is roughly an 80/20 of those
templates: same boundary discipline, none of the ceremony.

**Keep the current `app/api/<feature>/` layout and add lint rules
without restructuring.** Rejected because lint rules cannot manufacture
a port — services would still inject `Repository<X>` directly, and
the inter-module contract would still leak via the message-pattern
enums in `libs/common`. Without the structural move, the seams the
migration is trying to create simply don't exist to be enforced.

**Per-bounded-context monorepo with shared `core` library.** A
plausible alternative if the project were larger. Rejected for now
because the existing four-app split is already the right granularity
and the libs we already have (`common`, `config`, `inventory`,
`retail`) cover the cross-app contract needs without a separate
`core` lib — the migration is a re-mapping of those libs, not a rewrite.

---

## Consequences

### Positive

- Use-cases become unit-testable against fakes for every port,
  removing the current dependency on TypeORM mocks for service-level
  tests. Coverage of the application layer can climb without spinning
  up a real database.
- The `infrastructure/` layer is the only place adapters live, so
  swapping (e.g., MySQL → Postgres, RabbitMQ → Kafka, KeyV/Redis →
  another store) is a contained change rather than a project-wide
  edit.
- Cross-cutting concerns from later phases (cache-aside generalization
  in task-11, OTel spans in task-10, notification dispatch in
  task-07) attach at the application/infrastructure boundary rather
  than threading through service classes.
- Architecture lint (task-12) gains a clear target: element types map
  directly to `domain | application | infrastructure | presentation`
  globs.

### Negative / Trade-offs

- The folder count per module roughly triples (one `*.service.ts`
  becomes a port, a use-case, an adapter, and a controller). For
  modules with thin logic — notification today, gateway pass-through
  controllers — the structure can feel ceremonial. Accepted as the
  cost of uniformity, since the architecture-lint rules require the
  same shape everywhere.
- Migration is multi-PR (tasks 03–09) and inevitably reshapes the
  diff surface. Each PR is scoped to one structural move so that
  reviewers can verify the shape one boundary at a time.
- Lint rules (task-12) will catch back-edges (e.g., `domain/`
  importing TypeORM) only after the structural moves are complete;
  intermediate task PRs may briefly violate the target shape. This is
  acceptable because each task is reviewed and merged before the next
  begins.
- Choosing not to adopt CQRS or event sourcing now means a future
  decision if the read/write asymmetry grows; left as a future ADR
  rather than over-investing today.

---

## References

- [ADR-018](018-nestjs-monorepo-apps-and-libs.md) — the NestJS
  monorepo shape this layout lives inside.
- [ADR-005](005-split-shared-common-into-bounded-libs.md) — the lib
  split that gives the hexagonal layout its shared seams.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — the
  lint rules that enforce the layer boundaries this ADR commits to.
