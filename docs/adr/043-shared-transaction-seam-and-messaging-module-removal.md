# ADR-043: A shared transaction seam, and the removal of `MessagingModule`

- **Date**: 2026-07-12
- **Status**: Accepted

---

## Context

A structural audit of the six services, run after the module-layout work ([ADR-041](041-nest-module-as-the-module-composition-root.md), [ADR-042](042-one-bounded-context-one-module.md)), turned up two independent asymmetries. Both are small; both are the kind that quietly accrete.

### 1. The transaction seam existed in three identical copies

[ADR-017 §6](017-architecture-lint-via-eslint-boundaries.md) introduced `ITransactionPort` to close the `ARCH-LINT-EX-01` exception: a use case composes several repository writes into one atomic unit by asking the port to run its work, receiving an opaque `ITransactionScope`, and passing that scope down into repository-port methods. Only the infrastructure adapter knows the scope is really an `EntityManager`.

The seam is entirely domain-neutral — 11 lines of port, 17 of adapter, not one domain type between them. And it existed **three times**, byte-for-byte identical modulo comments:

| | `transaction.port.ts` | `typeorm-transaction.adapter.ts` |
| --- | --- | --- |
| inventory `stock` | ✓ | ✓ |
| retail `orders` | ✓ | ✓ |
| retail `returns` | ✓ | ✓ |

Not by choice: cross-module isolation forbids one module importing another's port, so the third module to need a transaction had no way to reuse the second's. The only legal way to share is to lift it into a lib — which nobody did, so it was copied.

This is the same failure mode ADR-042 diagnosed inside the event store: *when an isolation rule forces you to duplicate code in order to obey it, the thing that is usually wrong is not the rule but the placement.* Here the placement was module-local for something that was never module-specific.

### 2. `MessagingModule` was dead

`libs/messaging/messaging.module.ts` bundled two `ClientProxy` registrations — `retail_queue` and `inventory_queue` — and re-exported them. [ADR-008](008-rabbitmq-via-libs-messaging.md) describes it as a *"convenience aggregator"*, from a time when those two were the only microservices.

Six services later, exactly one of them imported it: the **event store** — which is a pure *consumer*. It never sends to retail or inventory; its transports are configured server-side in `main.ts`. It injected nothing from the module. Every other service imports the specific `MicroserviceClient*Module` it needs, inside the feature module that needs it.

So the aggregator had one importer, and that importer did not use it. The cost was modest — `ClientProxy` connects lazily, so this was two unused DI providers, not two open sockets — but a lib export with no real consumer is a trap: the next service to copy the event store's `app.module.ts` inherits it.

## Decision

### 1. The transaction seam moves into the shared libs — but into *two* of them

- **`ITransactionPort` / `ITransactionScope` / `TRANSACTION_PORT` → `libs/ddd`** (`transaction.port.ts`).
- **`TypeormTransactionAdapter` → `libs/database`** (`typeorm-transaction.adapter.ts`).

The split is not aesthetic; the boundaries taxonomy forces it. `application/ports` may import only `lib-ddd` and `lib-contracts`, and `application/use-cases` may not import `lib-database` at all. A transaction port declared in the database lib would therefore be **unreachable from the two layers that exist to consume it**. Framework-freedom is the precondition for the seam working, not a style preference — which is exactly why the port belongs beside `IRepositoryPort` in the domain kernel.

The adapter, which imports `@nestjs/typeorm` and `typeorm`, belongs where the other TypeORM base classes live.

Each module's `application/ports/index.ts` **re-exports** the three symbols from `libs/ddd`, so the module's ports remain one barrel and every consumer keeps writing `from '../ports'` unchanged. The three `<m>.module.ts` files bind `TRANSACTION_PORT` to the adapter imported from `@retail-inventory-system/database`.

### 2. A new lint edge: `lib-database` → `lib-ddd`

Previously `lib-database`'s allow list was `[lib-database, lib-common, lib-contracts]`. It gains `lib-ddd`.

This is a **widening, not a weakening**, and the direction is the whole argument: an infrastructure adapter depending on an abstraction the domain kernel owns is dependency inversion working as intended — the same relationship `BaseTypeormRepository` already has with the domain it serves. The dangerous direction stays shut by construction: `lib-ddd`'s allow list is `[lib-ddd]` alone and its denylist forbids `typeorm` and `@nestjs/*`, so no cycle is even expressible. Three fixtures in `spec/architecture-lint.spec.ts` pin both halves — the forward edge passes, the reverse edge fails, and a use case can reach the seam through `lib-ddd` but not through `lib-database`.

### 3. `MessagingModule` is deleted

Removed from `apps/event-store-microservice/src/app/app.module.ts`, from `libs/messaging/index.ts`, and from the tree. The per-service `MicroserviceClient*Module`s — which is what every service actually uses — are untouched. ADR-008's table entry is amended.

## Consequences

### Positive

- One transaction port and one adapter, in the libs, instead of six files in three modules. A fourth module needing a transaction now imports it; it does not copy it.
- The `EntityManager` downcast contracts from three files to one. ADR-017 §6's claim that the downcast "lives only in `TypeormTransactionAdapter` and `StockTypeormRepository`" becomes literally true — it was three `TypeormTransactionAdapter`s.
- `libs/messaging` no longer exports something with no consumer.
- The `lib-database → lib-ddd` edge makes the libs' dependency graph state the hexagon's direction explicitly, rather than by the accident of nothing having needed it yet.

### Negative

- `libs/ddd` now holds a DI symbol (`TRANSACTION_PORT = Symbol(...)`). It is plain JavaScript — no `@nestjs/*` import, so the lib stays framework-free — but the lib is no longer *purely* about DDD building blocks; it is the domain-facing contract kernel. That is the honest reading of what it already was (`IRepositoryPort` is a port, not a DDD primitive).
- One more allowed lib-to-lib edge to reason about.

## Alternatives considered

- **Put both the port and the adapter in `libs/database`, and allow `application-port` / `application-use-case` to import `lib-database`.** Rejected outright: that edge would let a use case import `BaseTypeormRepository` and `EntityManager`, which is precisely the leak ADR-017 §6 closed. It trades a duplication for the exception it was designed to remove.
- **Put the port in `libs/common`.** `libs/common` is already framework-free and holds `Result` / `IPage`. Rejected because `application-port`'s allow list does not include `lib-common` — the port would be unreachable from repository ports without also widening *that* rule, and widening it opens `lib-common`'s whole surface to every port, not just the seam.
- **Leave the three copies and document them.** The `retry-then-log-for-replay.ts` precedent (duplicated in `orders` and `returns` because returns may not import orders) shows the project accepts a duplicate when the alternative is a broken boundary. It does not apply here: nothing about this code is retail-specific, and lifting it to a lib breaks no boundary at all.
- **Keep `MessagingModule` as a convenience API.** Rejected: it bundles an arbitrary pair of the six queues, chosen when there were two. Any service that wants two clients imports two modules; that is one line more and says what it means.

---

## References

- [ADR-008](008-rabbitmq-via-libs-messaging.md) — introduced `MessagingModule`; **that entry is superseded**.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — the boundaries taxonomy the split obeys; §6 introduced `ITransactionPort`, and its `EntityManager`-downcast note becomes accurate here.
- [ADR-019](019-typeorm-and-mysql-for-persistence.md) — `libs/database` and the TypeORM base classes the adapter joins.
- [ADR-042](042-one-bounded-context-one-module.md) — the same diagnosis one level down: duplication forced by an isolation rule usually means the boundary is misplaced.
