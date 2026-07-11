# ADR-042: One bounded context, one module — collapsing the event store's sibling split

- **Date**: 2026-07-11
- **Status**: Accepted

---

## Context

[ADR-034](034-isolated-eventstore-database.md) gave the event store a single bounded context, `audit-and-events`, and split it into **two sibling modules**: `domain-events/` (the `#` firehose sink, `domain_event`) and `audit-log/` (the staff trail, `audit_log_entry`). [ADR-039](039-audit-and-event-store-query-surface.md) then added the read surface on top of that split.

The split made the event store the only service in the repository whose `modules/` folder does not look like every other service's. Six differences, all of them consequences of the one decision:

1. **Three production files sat directly under `modules/`** — `audit-and-events.module.ts`, `firehose.consumer.ts`, `audit-query.controller.ts`. Both controllers inject use cases from **both** modules, and `eslint-plugin-boundaries` lets a module's `presentation/` reach only its own module. Belonging to neither, they were pushed outside the hexagon entirely.
2. **`AuditAndEventsModule` was an aggregator** — a `@Module` that is neither a module nor the app root, whose only job was to import the two siblings and register those two homeless controllers. Nothing else in the repo has one (catalog's two colocated modules are imported straight from `app.module.ts`).
3. **Neither module had a `presentation/` layer** — the only modules in the repo without one.
4. **Both modules had to `export` their use cases**, so the context-root controllers could resolve them through DI. No other module in the repo exports a use case.
5. **The correlation trace was duplicated three times over.** `TraceByCorrelationUseCase` lives in `audit-log/` and must read `domain_event`, which the sibling owns. Forbidden from injecting the sibling's repository port, it reached the table through `TRACE_DOMAIN_EVENT_READER` — a port plus a 108-line raw-parameterized-SQL adapter (with its own BIGINT coercion, JSON-column guard, and `Date` coercion), plus `ITraceDomainEventRow` (a field-for-field copy of `DomainEvent`), plus a private `toDomainEventView` copy of the factory sitting one folder away. The comments said so plainly: *"This deliberately does NOT reuse the sibling module's `toDomainEventView` factory… importing either would cross the same isolation line the reader port exists to respect."* A fourth copy followed the same logic: `parseInstant` + `ZONELESS_DATE_TIME` were duplicated verbatim in both repositories.
6. **[ADR-041](041-nest-module-as-the-module-composition-root.md) minted a `context-root` element type** whose only members were the three files in (1).

The reader port was not a mistake in itself — it is the established seam (`ORDER_CART_READER`, `RETURN_ORDER_READER`, `CONSENT_READER`). But those three cross **real** ownership lines, between modules that own genuinely different aggregates, often in different services. This one crossed a line inside a single bounded context, between two tables in the same schema, on the same connection, in the same deployable.

### The comparison that settles it

Two tables do not make two modules in this codebase. `modules/orders/` holds **five** sibling aggregates (`Order`, `Address`, `Payment`, `Fulfillment`, `Refund`) with five repository ports in **one** module; `modules/catalog/` holds three. The unit of a module here is the **bounded context**, and ADR-034 already named `audit-and-events` as exactly one of those.

The tell was the asymmetry in the ports: `IAuditLogRepositoryPort` has `append` / `query` / `listByCorrelationId`, while `IDomainEventRepositoryPort` had only `append` / `query` — and a comment explaining that a `listByCorrelationId` here *"would be a dead one"* because the trace reaches the table through the reader seam instead. The same read, expressed twice, once as a first-class port method and once as hand-rolled SQL, because a boundary was drawn between two halves of one thing.

## Decision

### 1. The `audit-and-events` context is one module

`apps/event-store-microservice/src/modules/audit-and-events/`, with the canonical four layers plus its composition root (ADR-041). The two logs are two **aggregates** in it, exactly as `Order` and `Payment` are two aggregates of `modules/orders/`:

- `domain/` — `DomainEvent`, `AuditLogEntry` (both still frozen value objects, not `AggregateRoot`s).
- `application/ports/` — `DOMAIN_EVENT_REPOSITORY`, `AUDIT_LOG_REPOSITORY`. One port per aggregate seam, the standing convention.
- `application/use-cases/` — the five use cases, the two view factories, `firehose-extractors.ts`.
- `infrastructure/persistence/` — both entities, mappers, and append-only repositories, plus the now-shared `parse-instant.ts`.
- `presentation/` — `firehose.consumer.ts` and `audit-query.controller.ts`.

Everything the split forced is deleted: the aggregator module, the context root, the use-case exports, and the `context-root` element type ADR-041 introduced for it. The event store's `modules/` folder now reads like every other service's.

### 2. `IDomainEventRepositoryPort` gains `listByCorrelationId`

The exact mirror of its sibling's — unpaginated, `occurred_at ASC, id ASC`. `TraceByCorrelationUseCase` injects both repository ports and calls the same method on each. `TRACE_DOMAIN_EVENT_READER`, its raw-SQL adapter, `ITraceDomainEventRow`, and the private view-factory copy are **deleted**; the trace projects through the real `toDomainEventView`.

This is a strict improvement in more than line count. The raw-SQL adapter had to re-derive, by hand and untyped, what the mapper already knows: that `id` arrives as a string from a BIGINT, that `payload` is a JSON column that may or may not arrive parsed, that `occurred_at` may arrive as a string. Routing the read through the entity and its mapper deletes all three hazards along with the code.

### 3. Nothing about the storage, the transports, or the wire changes

Two tables, one isolated `ris_eventstore` schema (ADR-034), one connection, two queues, the same three `audit.*` RPCs and the same `#` firehose (ADR-035/039). This decision moves TypeScript files and deletes a seam; it does not touch a migration, a routing key, or a payload.

## Consequences

### Positive

- The event store stops being the exception. Every service in the repo now has the same `modules/<m>/{domain,application,infrastructure,presentation}` shape with the composition root beside it.
- **119 lines added, 440 deleted.** The four duplications (reader, row type, view factory, `parseInstant`) are gone, and with them four independent decay sites.
- The trace's two reads are now symmetric — one port method per log, same signature, same ordering contract — instead of a port method and a bespoke SQL string.
- The `boundaries` taxonomy loses a bespoke element type. `context-root` existed for exactly three files; those files are ordinary `presentation/` members now.
- The firehose consumer and the query controller are testable and placeable like every other controller in the repo.

### Negative

- The two logs no longer have a compiler-enforced wall between them. A future use case *could* now touch both tables without anyone noticing — the wall was doing that job, at the cost of the duplication above. The counter is that they were never independently deployable, never independently schema'd, and the one use case that needed both was already crossing the wall through a hole cut for it.
- `modules/audit-and-events/` is a larger module than either sibling was. It is still smaller than `modules/orders/`.

### Open

- If the audit trail ever becomes its own deployable, this decision must be revisited — but that is a service split, not a module split, and it would be its own ADR with its own schema and queue.

## Alternatives considered

- **Keep the split; keep the context root.** ADR-041 had just typed those three files, so they were at least no longer invisible to the linter. Rejected: a documented anomaly is still an anomaly, and it left the four duplications, the aggregator, the missing `presentation/` layers, and the exported use cases all in place. Typing an odd shape is not the same as not needing the odd shape.
- **Keep the split; move `TraceByCorrelationUseCase` to the context root.** It could inject both modules' use cases from there, which deletes the reader port and the duplication. Rejected: it buys the smallest win by adding the worst anomaly — a *use case* living outside any module is a deeper layering break than a controller doing so, and differences 1–4 all survive.
- **Keep the split; let `audit-log/` import `domain-events/`'s port.** That is precisely the cross-module edge the isolation rule exists to forbid, and weakening the rule to fit is what `CLAUDE.md` prohibits outright. If the boundary should not hold, the answer is to remove the boundary, not to punch through it.
- **Split further — a third module for the shared query surface.** More structure to justify the original structure. Rejected without much thought.

---

## References

- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) — the per-module hexagon this restores.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — the cross-module isolation rule that forced the reader seam.
- [ADR-034](034-isolated-eventstore-database.md) — the isolated `ris_eventstore` DB (unchanged) and the original two-sibling-modules decomposition (**superseded here**).
- [ADR-039](039-audit-and-event-store-query-surface.md) — the query surface; its RPCs, queues, and semantics are unchanged, but its context-root controllers are now ordinary `presentation/` members.
- [ADR-041](041-nest-module-as-the-module-composition-root.md) — introduced the `context-root` element type, **removed here** as unused.
