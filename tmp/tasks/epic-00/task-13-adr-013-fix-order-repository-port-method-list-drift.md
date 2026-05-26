---
epic: epic-00
task_number: 13
title: Correct ADR-013's `IOrderRepositoryPort` method list — 5 listed vs. 8 in live code (`findConfirmableOrder` / `customerExists` / `findExistingProductIds` absent from the ADR)
depends_on: []
doc_deliverable: null
---

# Task 13 — Correct ADR-013's `IOrderRepositoryPort` method enumeration

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** Open ADR-013 in full, then ADR-003 (ADR cadence / immutability rule), ADR-004 (hexagonal per service — the parent rule that puts ports under `application/ports/`), and ADR-009 (the gateway-side port/adapter pattern this ADR mirrors). The live file `apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts` is the source of truth for the drift. The two presentation pipes that need the new methods are `apps/retail-microservice/src/modules/orders/presentation/pipes/order-create.pipe.ts` and `apps/retail-microservice/src/modules/orders/presentation/pipes/order-confirm.pipe.ts`.

## ADR audited

[ADR-013 — Order aggregate and the cross-service confirm flow](../../../docs/adr/013-order-aggregate-and-cross-service-confirm.md). Accepted (2026-05-14).

## Discrepancy

ADR-013 §3 enumerates the surface of `IOrderRepositoryPort` as five methods:

> Methods: `findById`, `findHeaderById`, `findOrderResponse` (full JOIN'd `OrderConfirmResponseDto`), `save`, `confirmLines` (transactional line-status + header update).

The live port surface (`apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts`) has **eight** methods. Three were added after ADR-013 to absorb pipe-time lookups:

- `findConfirmableOrder(id)` — used by `OrderConfirmPipe` to load the line-items the confirm use case needs without a second round-trip.
- `customerExists(customerId)` — used by `OrderCreatePipe` to short-circuit a create with a 400 when the customer id is unknown.
- `findExistingProductIds(productIds)` — used by `OrderCreatePipe` to short-circuit a create with a 400 when any product id is unknown.

This is **CODE-DISCREPANCY (stale narrative)**, not a binding-rule break. The port's *role* (inbound persistence behind the `ORDER_REPOSITORY` DI symbol with `OrderTypeormRepository` as the adapter) is unchanged. The drift is the *enumeration* of the surface — a reader who treats §3 as the contract for the port will misread the shape of the module's persistence boundary.

Surface: `docs/adr/013-order-aggregate-and-cross-service-confirm.md` (the ADR prose itself).

## Evidence

ADR-013 §3 (`docs/adr/013-order-aggregate-and-cross-service-confirm.md:76-80`):

```text
- `IOrderRepositoryPort` (DI symbol `ORDER_REPOSITORY`) — inbound
  persistence. Methods: `findById`, `findHeaderById`,
  `findOrderResponse` (full JOIN'd `OrderConfirmResponseDto`), `save`,
  `confirmLines` (transactional line-status + header update). Adapter:
  `OrderTypeormRepository`.
```

Live port (`apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts:14-29`):

```ts
export interface IOrderRepositoryPort {
  findById(id: number): Promise<Order | null>;
  findHeaderById(id: number): Promise<{ statusId: Order['statusId'] } | null>;
  findOrderResponse(id: number): Promise<OrderConfirmResponseDto | null>;
  findConfirmableOrder(id: number): Promise<Omit<IOrderConfirm, 'correlationId'> | null>;
  customerExists(customerId: number): Promise<boolean>;
  findExistingProductIds(productIds: number[]): Promise<number[]>;
  save(order: Order): Promise<Order>;
  confirmLines(payload: {
    orderId: number;
    newlyConfirmedProductIds: number[];
    shouldFlipHeaderToConfirmed: boolean;
    correlationId?: string;
  }): Promise<void>;
}
```

The three extra methods are wired through the presentation pipes — `OrderConfirmPipe` calls `findConfirmableOrder` (verified by `grep -rn "findConfirmableOrder" apps/retail-microservice/`), `OrderCreatePipe` calls `customerExists` and `findExistingProductIds` (verified by `grep -rn "customerExists\\|findExistingProductIds" apps/retail-microservice/`). The pipes inject `ORDER_REPOSITORY` directly because the methods are pure lookups with no side effects — the same pattern the inventory and gateway pipes use.

## Why this matters

ADR-013 is the per-module hexagonal realization for the retail microservice — every later ADR that mentions retail orders (and CLAUDE.md §"Service Structure") points back here for the port shape. A reader who lands on §3 and takes the five-method list as the contract will hit one of two failure modes:

1. **Adding a new pipe lookup elsewhere.** A future "lookup line-items for some other pipe" instinctively gets added to `IOrderRepositoryPort` because the live code already mixes header-only / DTO / line-loader methods on the same port. ADR-013's five-method enumeration suggests the opposite — that lookups belong somewhere else (a query service?) — and either a brand-new port gets invented when one is not needed, or the existing port grows unaudited.
2. **A new microservice cargo-culting the retail orders shape.** The five-method enumeration is the shortest example of the port-and-adapter split in any ADR in the catalogue — `epic-02/task-03` and `epic-04/task-05` both reference ADR-013 as the per-module template for ports. If they treat the enumeration as authoritative they will not provide pipe-loader methods, and their pipes will end up injecting either the use case (wrong layer) or `EntityManager` (the very anti-pattern `ARCH-LINT-EX-01` is fighting in stock).

The same supersession-pointer / amend pattern is already filed for ADR-001 (epic-00/task-01), ADR-002 (epic-00/task-02), ADR-006 (epic-00/task-05), ADR-007 (epic-00/task-06), ADR-008 (epic-00/task-07), ADR-004 (epic-00/task-04), ADR-012 (epic-00/task-12). ADR-013 is the next case.

## Proposed resolution

Two options. Recommend **option A**.

**Option A — Amend ADR-013's `**Status**` line + add a one-bullet `## References` extension noting the post-ADR pipe-loader additions (recommended).**

ADR-003 §"Status flips" permits flipping the status and adding a one-line pointer; ADR-013 already has a `## References` section (lines 214-225), so the amendment slots in there. Concrete edits:

- Replace `**Status**: Accepted` (line 4) with `**Status**: Accepted (pipe-loader methods added to `IOrderRepositoryPort` post-ADR; see References)`.
- Add a sixth bullet to the existing `## References` section, after the ADR-020 entry:

  ```markdown
  - **§3 `IOrderRepositoryPort` method enumeration.** The live port at
    `apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts`
    has eight methods rather than the five enumerated here. The
    additional three — `findConfirmableOrder`, `customerExists`,
    `findExistingProductIds` — are pipe-time lookups added to support
    `OrderCreatePipe` / `OrderConfirmPipe` so the pipes can short-circuit
    invalid input at the presentation boundary without injecting the
    repository through a use case. The role of the port (inbound
    persistence behind `ORDER_REPOSITORY`, adapter `OrderTypeormRepository`)
    is unchanged.
  ```

Do **not** rewrite the §3 list in place. The Nygard immutability rule of ADR-003 keeps the historical decision text intact; the `## References` bullet is the forward-pointer for a future reader.

**Option B — Rewrite §3 in place to list all eight methods.**

Mechanically simpler for a future reader but violates ADR-003's immutability rule. Sets a precedent that erodes trust in the ADR set — historical context disappears in the rewrite, and "the surface as decided" is no longer recoverable. Rejected as the recommendation.

If option B is chosen anyway, the rewrite must (a) preserve the §3 rationale paragraph (the *why* of the port surface was correct at the time), (b) carry an inline footnote linking forward to this task / a follow-up ADR, and (c) clearly group the three pipe-loader methods as "added after the initial ADR-013 acceptance to support presentation pipes" so the original five remain readable as the original commit.

## Scope

**In:**

- Edit `docs/adr/013-order-aggregate-and-cross-service-confirm.md`:
  - Flip the `**Status**` line per option A.
  - Append one bullet to the existing `## References` section (or, per option B, rewrite §3 in place with the inline footnote).

**Out:**

- Any change to live code under `apps/retail-microservice/`.
- Any change to ADR-004 / ADR-009 / ADR-011 / ADR-012 (parent / sibling ADRs that are not the audited surface).
- Any change to the pipes themselves (`OrderCreatePipe` / `OrderConfirmPipe` continue to inject `ORDER_REPOSITORY` directly — the architecture decision is sound, only the ADR's enumeration is stale).
- Any change to CLAUDE.md (its §"Service Structure" already describes the retail module shape correctly; it does not enumerate the port surface).

## Exit criteria

- [ ] `docs/adr/013-order-aggregate-and-cross-service-confirm.md`'s `**Status**` line carries the forward-supersession pointer (or follows option B with an inline footnote on §3).
- [ ] `docs/adr/013-order-aggregate-and-cross-service-confirm.md`'s `## References` section has the new bullet (option A) — or §3 is rewritten in place with the inline footnote (option B).
- [ ] `grep -n "findConfirmableOrder\\|customerExists\\|findExistingProductIds" docs/adr/013-order-aggregate-and-cross-service-confirm.md` returns at least one match (proves the new bullet / rewrite landed).
- [ ] `yarn lint` still passes (this task edits only `docs/adr/*.md`).
- [ ] `tmp/adr-verification-progress.md` ADR-013 row reflects this task's findings.
