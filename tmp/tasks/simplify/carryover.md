# Simplification Carryover

This document is the **only shared state** across clean-context simplification phases. Each phase reads it on entry and updates it on exit. Treat all content here as load-bearing; do not delete entries from prior phases.

## How to use this document
- On phase entry: read every section in full.
- "Established patterns" is normative — apply listed conventions consistently in your phase.
- "Files modified" tells you what has already been touched; do not re-simplify out of scope.
- "Open / deferred" is a working triage list; consult it for items that may be in your phase's scope.
- On phase exit: update the relevant sections per your task file's Procedure step 5. Do not remove prior entries.

## Phase ledger
### Completed
- phase-01 — foundational-libs. Net diff: 10 files changed, 20 insertions / 52 deletions. The five libs were already extremely lean — most of the surface is plain types, enums, re-export barrels, and abstract base classes. The actionable findings clustered in three areas: (1) stale task-ID narrative comments in `libs/common/index.ts`, `libs/contracts/microservices/microservice-message-pattern.enum.ts`, `libs/contracts/retail/events/order-cancelled.event.ts`, and `libs/contracts/inventory/inventory.constants.ts` (removed/trimmed, preserving the WHY portions about dual-registry intent and cross-service threshold sharing); (2) `libs/ddd` base classes carrying introductory narration that the type signatures already convey (entity / aggregate-root / value-object / domain-event / repository-port headers trimmed to WHY-only); (3) one truly-unused public getter — `AggregateRoot.domainEvents` (only the spec read it, no production caller) — was deleted, and the two spec tests covering it were merged into a single "buffers added events and drains them on pull" test. Also collapsed the redundant `if (other === undefined || other === null)` pair in `Entity#equals` / `ValueObject#equals` to `if (other == null)`. `libs/config` (Joi schema) and `libs/database` (BaseEntity, BaseTypeormRepository, DatabaseModule, SnakeNamingStrategy re-export) had no changes — the Hard Constraint freezing their public surface ruled out the agents' "dead methods" suggestions, and the schemas were already minimal. No exported name in `libs/contracts` was renamed.

### Pending
- phase-02 — infrastructure-libs
- phase-03 — notification-microservice
- phase-04 — inventory-microservice
- phase-05 — retail-microservice
- phase-06 — api-gateway
- phase-07 — tests-and-scripts

## Established patterns
- **Comments earn their place by carrying WHY**, not WHAT. In particular: leading-class narrations that paraphrase the class name and its type signature ("Framework-free domain entity. Identity is by `id`...") are deleted; comments that carry a non-obvious invariant (e.g. "props must be JSON-stable (no Date / Map / cycles)") are kept and tightened. Phase-01 trimmed these in `libs/ddd/*.ts`.
- **Task-ID / migration-pass references in comments are rot** — `task-04`, `task-09 brief`, `removed in task-14`, "ADR-XYZ records the rationale", and similar pointers were deleted in phase-01. ADR catalogue and git history are the durable records; comments referencing transient task numbers age out fast. Pure ADR-number references that explain a current decision (e.g. "kept in sync with `ROUTING_KEYS`" — the dual-registry policy) are kept because they describe a live constraint, not a past pass.
- **Null/undefined check pattern**: prefer `if (x == null) return ...` over `if (x === undefined || x === null) return ...`. This is the only `==` form the codebase reaches for; everywhere else uses `===`. Applied uniformly in `libs/ddd` (entity-base, value-object-base).
- **Public getters with no production callers are dead surface** even when a spec depends on them — rewrite the spec against the still-public API and drop the getter. Verified in phase-01 by grep across `apps/**`, `libs/**`, and `tests/**` before deletion. Pattern: removing the `domainEvents` getter on `AggregateRoot` collapsed two redundant tests into one without losing meaningful coverage.
- **Hard-constraint frozen surface trumps agent simplification suggestions.** The reuse / quality review agents flagged `BaseTypeormRepository.find/save/softDelete` as potentially dead and `BaseEntity.id` as not-yet-`readonly`; both were correctly left untouched because the phase brief explicitly freezes that public surface. When the simplify review and a hard constraint disagree, the hard constraint wins — note the deferral but make no change.

## Files modified by phase
### phase-01
- `libs/common/index.ts` — removed stale "removed in task-14" header comment.
- `libs/contracts/microservices/microservice-message-pattern.enum.ts` — trimmed task-04 migration narrative; preserved the dual-registry rationale (legacy enum + `ROUTING_KEYS`).
- `libs/contracts/retail/events/order-cancelled.event.ts` — stripped the "see task-09 brief" pointer; kept the "reserved, no producer today" WHY.
- `libs/contracts/inventory/inventory.constants.ts` — trimmed the "ADR-012 records the rationale" trailing pointer; kept the cross-service threshold WHY.
- `libs/ddd/entity.base.ts` — removed introductory class-narrating comment; replaced `if (other === undefined || other === null)` with `if (other == null)`.
- `libs/ddd/value-object.base.ts` — same null-check collapse; trimmed the class-narrating header; added a one-line WHY noting that props must be JSON-stable because comparison uses `JSON.stringify`.
- `libs/ddd/aggregate-root.base.ts` — trimmed the class-narrating header; removed the unused `domainEvents` readonly getter (production callers only ever invoke `pullDomainEvents()` / `addDomainEvent`).
- `libs/ddd/domain-event.base.ts` — trimmed the class-narrating header; kept the transport-agnostic WHY.
- `libs/ddd/repository.port.ts` — removed the entire leading comment; the interface name + type parameters are self-documenting.
- `libs/ddd/spec/aggregate-root.base.spec.ts` — merged the two `domainEvents`-getter-dependent tests ("records added events until pulled" + "drains events on pull") into one "buffers added events and drains them on pull" test that asserts via `pullDomainEvents()` only. Test count dropped from 177 → 176, intentionally.
### phase-02
_(initially empty)_
### phase-03
_(initially empty)_
### phase-04
_(initially empty)_
### phase-05
_(initially empty)_
### phase-06
_(initially empty)_
### phase-07
_(initially empty)_

## Test status checkpoints
### phase-01
- `yarn lint` — exit 0, no output (clean).
- `yarn test:unit` — 30 suites passed, 176 tests passed (down from 177 baseline due to the spec merge described above; no test failures). One Jest worker did not exit gracefully — pre-existing condition observed at baseline, unrelated to phase-01 changes.
- E2E — not run (out of scope per phase brief: "These libs are pure types / Joi schema / TypeORM base classes; they have no wire-format or DB-state surface that e2e would exercise distinctly").
### phase-02
_(initially empty)_
### phase-03
_(initially empty)_
### phase-04
_(initially empty)_
### phase-05
_(initially empty)_
### phase-06
_(initially empty)_
### phase-07
_(initially empty)_

## Open / deferred
- `ValueObject#equals` (`libs/ddd/value-object.base.ts`) uses `JSON.stringify` deep-compare, which is order-sensitive, drops `undefined`, lossy on `Date`/`BigInt`/`Map`, and throws on cycles. Phase-01 added an inline WHY noting the JSON-stable-props invariant rather than swap the algorithm — a structural rewrite risks behavior-changing existing VOs that may pass nested objects or `Date` props. If a future phase introduces a VO with non-JSON-stable props (or a Subagent reports a correctness bug in equality), revisit and consider a shallow `Object.keys` + `===` loop (or a curated deep-equal helper that stays framework-free).
- `BaseTypeormRepository.find / save / softDelete` (`libs/database/base-typeorm.repository.ts`) appear unused by the only current subclass (`StockTypeormRepository`, which constructs its own `productStockRepository` and bypasses the base). The Hard Constraint freezes the public surface, so phase-01 left them. If a future phase relaxes the constraint (or audits and confirms zero downstream callers across all aggregates), these methods could be removed to unblock further refactors — but the abstract `toDomain` / `toEntity` hooks may still be load-bearing for other adapters that have not yet adopted the base.
- `BaseEntity.id` (`libs/database/base.entity.ts`) is mutable. A `readonly` flip would prevent accidental PK overwrites at the domain level; TypeORM's `PrimaryGeneratedColumn` should tolerate it (assignment is via `Object.assign` during hydration). Not done in phase-01 because it's a public-surface change on a frozen file; flag for an explicit follow-up if entity hydration is verified safe.
- `IDomainEventEnvelope` consolidation — four event interfaces (`IRetailOrderCreatedEvent`, `IRetailOrderConfirmedEvent`, `IRetailOrderCancelledEvent`, `IInventoryStockLowEvent`) each redeclare `occurredAt: string` on top of `ICorrelationPayload`. The reuse-review agent suggested extracting a shared `IDomainEventEnvelope extends ICorrelationPayload { occurredAt: string }`. Phase-01 skipped it: ABI-frozen field names mean the indirection saves only ~4 lines while adding a new contracts file, and inline declarations are more self-contained for wire-format reading. Worth revisiting only if a fifth event with the same envelope ships.
