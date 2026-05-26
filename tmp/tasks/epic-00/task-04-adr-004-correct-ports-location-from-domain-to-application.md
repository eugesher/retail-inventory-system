---
epic: epic-00
task_number: 4
title: Correct ADR-004's ports location — `domain/ports/` → `application/ports/`
depends_on: []
doc_deliverable: null
---

# Task 04 — Correct ADR-004's ports location

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing. In particular, read ADR-004, ADR-003, ADR-009, ADR-011, ADR-012, ADR-013 in full before deciding the wording of the pointer. CLAUDE.md §"Service Structure" is the live authority on the layout.

## ADR audited

[ADR-004 — Adopt Hexagonal Architecture Per Service](../../../docs/adr/004-adopt-hexagonal-architecture-per-service.md). Accepted (2026-05-09).

## Discrepancy

ADR-004 specifies that ports live under `domain/ports/`. The implemented architecture places every port under `application/ports/`, and every later ADR that builds on ADR-004 (ADR-009, ADR-011, ADR-012, ADR-013) plus CLAUDE.md §"Service Structure" treats `application/ports/` as the binding rule.

A reader following ADR-004 literally would:

1. Create a `domain/ports/` directory that does not exist in any of the six active modules (auth, retail gateway, inventory gateway, stock, orders, notifications).
2. Trigger the `eslint-plugin-boundaries` rules (ADR-017) — the `lint-architecture` element types map `application/ports/**` as the port surface; a `domain/ports/**` file has no element type and either fails the boundary rule or pollutes the `domain` element.
3. Contradict the canonical wording in CLAUDE.md and the four downstream ADRs that direct call-sites to `application/ports/`.

The location of ports is a design choice (whether ports are owned by the domain layer or by the application layer is a real Ports-and-Adapters debate), but the choice that *shipped* — and that every subsequent ADR honours — is **application-owned**. ADR-004's prose is the lone stale surface.

Surface: `docs/adr/004-adopt-hexagonal-architecture-per-service.md` (the ADR prose itself).

## Evidence

ADR-004 prose says `domain/ports/`:

```text
docs/adr/004-adopt-hexagonal-architecture-per-service.md:70:├── domain/             # entities, value objects, domain services, ports (interfaces)
docs/adr/004-adopt-hexagonal-architecture-per-service.md:96:or `I<Aggregate>Repository` and live under `domain/ports/`; adapters
```

Real layout (verified by `find apps -type d -name ports`):

```text
apps/api-gateway/src/modules/auth/application/ports
apps/api-gateway/src/modules/inventory/application/ports
apps/api-gateway/src/modules/retail/application/ports
apps/inventory-microservice/src/modules/stock/application/ports
apps/notification-microservice/src/modules/notifications/application/ports
apps/retail-microservice/src/modules/orders/application/ports
```

No `domain/ports/` directory exists anywhere (verified by `find apps -type d -path '*domain/ports*'` → no output).

The four downstream ADRs and CLAUDE.md all describe the implemented location:

```text
docs/adr/009-port-adapter-at-the-gateway.md       # gateway ports under application/
docs/adr/011-notifier-port-and-adapters.md        # NotifierPort under application/ports/
docs/adr/012-stock-aggregate-and-port-adapter.md  # IStock*Port under application/ports/
docs/adr/013-order-aggregate-and-cross-service-confirm.md  # IOrder*Port under application/ports/
CLAUDE.md                                          # "ports/  + DI symbols" under application/
```

Decomposed tasks consistently follow the implemented location — e.g. `tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-05-customer-table-and-customer-auth-endpoints.md:83` adds `apps/api-gateway/src/modules/auth/application/ports/customer.repository.port.ts`, not `domain/ports/`. No task uses `domain/ports/`.

## Why this matters

ADR-004 is the foundational ADR for the entire per-module hexagonal architecture. The Decision section sets the binding folder layout that ADR-017's lint rules later enforce. An implementer who lands on ADR-004 and follows the `domain/ports/` instruction literally will:

- Build the wrong directory shape (no existing module has it).
- Get blocked by lint rules they cannot explain by reading the ADR alone (the lint config and CLAUDE.md tell a different story).
- Need to walk the forward-reference graph through four newer ADRs and the live code before realising ADR-004's prose is stale.

This is the same supersession-pointer pattern already filed for ADR-001 (epic-00/task-01) and ADR-002 (epic-00/task-02), and warranted by the same reasoning.

## Proposed resolution

Two options. Recommend **option A**.

**Option A — Amend ADR-004 with a one-line Status pointer and extend its References section (recommended).**

ADR-003 line 62 permits "flipping its `Status` and adding a one-line pointer." Use that allowance:

- Replace `**Status**: Accepted` with `**Status**: Accepted (ports-location wording superseded — ports live under `application/ports/`; see References)`.
- In the existing `## References` section (which currently lists ADR-005, ADR-017, ADR-018), add the four ADRs that establish `application/ports/` as the binding location, plus a CLAUDE.md pointer:
  - `[ADR-009](009-port-adapter-at-the-gateway.md)` — establishes the gateway's port/adapter shape with ports under `application/ports/`.
  - `[ADR-011](011-notifier-port-and-adapters.md)` — `INotifierPort` lives under `application/ports/`.
  - `[ADR-012](012-stock-aggregate-and-port-adapter.md)` — `IStockRepositoryPort` / `IStockCachePort` / `IStockEventsPublisherPort` under `application/ports/`.
  - `[ADR-013](013-order-aggregate-and-cross-service-confirm.md)` — `IOrderRepositoryPort` / `IOrderEventsPublisherPort` / `IInventoryConfirmGatewayPort` under `application/ports/`.
  - A `CLAUDE.md §"Service Structure"` reference (no link — it's at repo root) noting that CLAUDE.md is the live authority on the per-module layout.

Do **not** rewrite the body of ADR-004's Decision section. The folder-diagram on line 68-74 and the prose on line 95-97 stand as the historical record of the original decision; the supersession pointer + extended References redirect the reader to the current state.

**Option B — Rewrite ADR-004's body to match the implemented layout.**

Mechanically simpler for future readers, but violates ADR-003's "Never edit a prior ADR in place beyond flipping its `Status` and adding a one-line supersession pointer" rule. Weaker than option A because it sets a precedent for in-place rewrites that erodes the immutability promise of the ADR set.

**Option C — Move the ports from `application/ports/` to `domain/ports/` to match ADR-004.**

Rejected as the recommendation but listed for completeness. Would require touching every active module (6 ports directories), every consumer module's imports, the ADR-017 lint config, ADR-009/011/012/013 + CLAUDE.md, plus every decomposed task. Disproportionate to a wording discrepancy, and the `application/ports/` choice has been the load-bearing convention for the entire migration.

## Scope

**In:**

- Edit `docs/adr/004-adopt-hexagonal-architecture-per-service.md` Status line + extend `## References` section (option A).

**Out:**

- Any change to module code under `apps/**/modules/*/application/ports/` or `apps/**/modules/*/domain/`.
- Any change to ADR-009/011/012/013 (those already describe the correct location).
- Any change to CLAUDE.md (already correct).
- Any rewrite of ADR-004's `## Decision` body or folder diagram.

## Exit criteria

- [ ] A reader landing on ADR-004 sees an explicit signal that the `domain/ports/` wording is stale and that `application/ports/` is the binding location, with a forward-reference chain to ADR-009/011/012/013 and CLAUDE.md.
- [ ] No other ADR's text was edited beyond what the resolution requires.
- [ ] `yarn lint` still passes (touching only `docs/adr/*.md` should be a no-op for lint).
- [ ] `tmp/adr-verification-progress.md` ADR-004 row is updated to `HAS-CORRECTIONS` with a pointer back to this task.
