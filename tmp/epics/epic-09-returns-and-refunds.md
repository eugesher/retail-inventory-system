---
id: epic-09
title: Returns + Refunds — ReturnRequest, ReturnLine, Refund, RMA lifecycle, Restock from Return
source_stages: [production-core]
depends_on: [epic-08]
microservices: [api-gateway, retail-microservice, inventory-microservice]
task_subfolder: tmp/tasks/epic-09-returns-and-refunds/
docs_subfolder: docs/implementation/09-returns-and-refunds/
---

# Epic 09 — Returns + Refunds — ReturnRequest, ReturnLine, Refund, RMA lifecycle, Restock from Return

## Goal

Close the report's Stage-2 buyer-side loop: a customer (or staff on their behalf) opens a return request, the warehouse receives and inspects the goods, the stock that is fit-for-resale flows back into `StockLevel` via a `return`-type StockMovement, and a Refund is issued against the original Payment. Implement the Stage-2 operations: Open Return Request, Authorize Return, Reject Return, Receive Return, Inspect & Disposition, Issue Refund, Restock from Return. Consume the `flagged_for_refund` Payment flag set by `epic-08`'s Cancel Order so cancellations of captured orders also issue refunds (without needing a physical Return). After this epic, the system supports a full order → ship → return → refund cycle, which is the report's Stage-2 acceptance criterion.

## In-Scope Entities and Operations

- **ReturnRequest**: `id`, `rmaNumber` (human-facing, e.g. `RMA-2026-00000001`), `orderId`, `customerId`, `status` (`requested` | `authorized` | `rejected` | `received` | `inspected` | `closed`), `reasonCategory` (e.g. `defective` | `not-as-described` | `changed-mind` | `wrong-item`), `notes` (TEXT nullable), `requestedAt`, `authorizedAt` (nullable), `closedAt` (nullable), `version` (INT default 0), timestamps.
- **ReturnLine**: `id`, `returnRequestId`, `orderLineId`, `quantity` (INT), `condition` (`new` | `damaged` | `used` nullable until inspected), `disposition` (`restock` | `scrap` | `quarantine` nullable until inspected), `lineRefundAmountMinor` (BIGINT nullable until inspected).
- **Refund**: `id`, `orderId`, `paymentId`, `amountMinor`, `currency`, `status` (`pending` | `issued` | `failed`), `reason` (VARCHAR), `gatewayReference` (VARCHAR nullable), `issuedAt` (nullable), timestamps.
- **Operations:**
  - **Open Return Request** (Customer or User; bearer required) — preconditions: Order delivered (or shipped + within return window — env `RETURN_WINDOW_DAYS`, default `30`); requested quantities don't exceed remaining-returnable per OrderLine. Outcome: ReturnRequest in `requested`; emits `ReturnRequested`.
  - **Authorize Return** (User; `order:return-authorize`) — eligibility check by policy (window, condition); status → `authorized`; `authorizedAt = now`; emits `ReturnAuthorized`.
  - **Reject Return** (User; `order:return-authorize`) — status → `rejected`; `closedAt = now`.
  - **Receive Return** (User; `inventory:receive-return`) — status → `received` (parcel arrived at warehouse).
  - **Inspect & Disposition** (User; `inventory:receive-return`) — per-ReturnLine condition + disposition + lineRefundAmount recorded; status → `inspected`. For `restock` dispositions, automatically triggers **Restock from Return** in inventory.
  - **Restock from Return** (System; triggered by Inspect & Disposition) — inventory writes a `return`-type StockMovement (positive quantity) and increments `stock_level.quantityOnHand`; emits `StockReturned` (alias of `inventory.stock.movement.recorded` with `type=return`, but exposed as a distinct routing key for filtering convenience).
  - **Issue Refund** (User; `order:refund` — explicit op) — preconditions: Payment exists and is captured. Outcome: Refund row in `pending`; calls `PAYMENT_GATEWAY.refund(paymentId, amount)`; on success Refund → `issued`; updates `payment.status` to `refunded` (partial: stays `captured` but `payment.refundedAmountMinor` increments); clears `payment.flagged_for_refund` if fully refunded; emits `RefundIssued`. Idempotency-key required (Q10).
  - **Auto-issue refund from Cancel Order** (System) — a background worker (or inline call from Cancel Order in `epic-08`) consumes the `flagged_for_refund` flag; for each flagged Payment, issues a full Refund automatically. This epic implements the consumer.
  - **Close Return** (User; `order:return-authorize`) — status → `closed`; final state.

## Non-Goals

- **Exchanges as a first-class entity** — Exclusions Register (`epic-15`); the report models exchange as Return + new Order.
- **Repair workflows, advance replacement, vendor RMAs, refund-to-store-credit, return-fraud scoring** — Exclusions Register (`epic-15`).
- **Return shipping label generation** — out of scope.
- **Real refund-gateway integration** — `FakePaymentGatewayAdapter` from `epic-05` is extended with a `refund()` method that always succeeds.
- **Carrier RMA tracking** — out of scope.
- **Per-line refund-method override** (refund some lines via gift card, others via card) — Exclusions Register (`epic-15`).

## Architectural Decisions Honored

- **Cross-Cutting "Event emission":** `ReturnRequested`, `ReturnAuthorized`, `RefundIssued` are mandatory. This epic emits all three. `StockReturned` is added as a typed alias for the `return`-type StockMovement event for downstream consumer filtering convenience.
- **Cross-Cutting "Auditability":** Refunds are in the always-audit set. Every Refund operation invokes `AUDIT_LOG_PUBLISHER` with the actor, the amount, the reason, and a before/after snapshot of Payment.
- **Cross-Cutting "Soft delete vs hard delete":** ReturnRequest, Refund, the resulting StockMovement are **append-only / never delete**. ReturnRequest cancellation is via the `rejected` status, not a row delete.
- **Cross-Cutting "Concurrency & consistency":** Inspect & Disposition is transactional — Inspection + StockMovement insert + StockLevel update are all in one transaction. The Issue Refund operation is naturally idempotent via the gateway reference + idempotency-key (Q10) — the local `idempotency_key` table arrives in `epic-12`; the header is accepted from day one.
- **ADR-008** (dotted routing keys): new keys `retail.return.requested/authorized/rejected/received/inspected/closed`, `retail.refund.issued/failed`, `inventory.stock.returned` (typed alias for `return`-type StockMovement).
- **ADR-013** (cross-service confirm flow pattern): the existing pattern is the model for the new `INVENTORY_RESTOCK_GATEWAY` port that Inspect & Disposition uses.
- **ADR-016 + ADR-022** (cache keys): no version bump on inventory cache — the StockLevel payload shape is unchanged. Cache invalidation routes through ADR-023.
- **ADR-019** (TypeORM + MySQL): new tables via migration.
- **ADR-010** (RBAC): new permission codes `order:return-authorize`, `order:refund`, `inventory:receive-return` seeded into `order-support` and `warehouse-staff`.

## Persistence Changes

**Added (in retail-microservice):**

- `return_request` table: `id` (BIGINT PK), `rma_number` (VARCHAR(20) unique), `order_id` (FK), `customer_id`, `status` (ENUM), `reason_category` (ENUM), `notes` (TEXT nullable), `requested_at` (TIMESTAMP), `authorized_at` (nullable), `closed_at` (nullable), `version` (INT default 0), timestamps.
- `return_line` table: `id`, `return_request_id` (FK), `order_line_id` (FK), `quantity` (INT), `condition` (ENUM nullable), `disposition` (ENUM nullable), `line_refund_amount_minor` (BIGINT nullable), timestamps.
- `refund` table: `id` (BIGINT PK), `order_id` (FK), `payment_id` (FK), `amount_minor` (BIGINT), `currency` (CHAR(3)), `status` (ENUM), `reason` (VARCHAR(255)), `gateway_reference` (VARCHAR(255) nullable), `issued_at` (TIMESTAMP nullable), timestamps.
- `payment.refunded_amount_minor` (BIGINT default 0) column added; tracks cumulative refunds.

**Indexes & constraints:**

- Unique index on `return_request.rma_number`.
- Index on `return_request (order_id, requested_at DESC)` and `(customer_id, requested_at DESC)`.
- Index on `refund (order_id)` and `(payment_id)`.
- CHECK / application-level: `SUM(return_line.quantity for an order_line) ≤ order_line.quantity − cancelled`.
- `@VersionColumn` on ReturnRequest.

## Eventing / Messaging

- **New routing keys (`libs/messaging/routing-keys.constants.ts`):**
  - `retail.return.requested` — `{ rmaId, rmaNumber, orderId, customerId, requestedAt, lineCount, eventVersion: 'v1', correlationId }`.
  - `retail.return.authorized` / `retail.return.rejected` / `retail.return.received` / `retail.return.inspected` / `retail.return.closed` — similar shapes with the status-specific timestamp.
  - `retail.refund.issued` — `{ refundId, orderId, paymentId, amountMinor, currency, issuedAt, eventVersion: 'v1', correlationId }`.
  - `retail.refund.failed` — same shape with `failureReason`.
  - `inventory.stock.returned` — `{ variantId, stockLocationId, quantity, returnRequestId, returnLineId, eventVersion: 'v1', correlationId }`.
- **New RPC:** `inventory.stock.restock-from-return` — request `{ returnRequestId, lines: [{ variantId, stockLocationId, quantity }] }` → response `{ restocked: [...] }`. Idempotent on `(returnRequestId, returnLineId)`.
- **New auto-refund consumer in retail:** subscribes to its own `retail.order.cancelled` event with `paymentFlaggedForRefund=true` and invokes Issue Refund inline. (Inline-in-this-epic; not a separate microservice.)
- **Notification consumer wiring (inline):** notification-microservice gets a new consumer for `retail.return.requested`/`authorized`/`received`/`inspected` and `retail.refund.issued`. (Template rendering arrives in `epic-10`; here the log adapter logs the event.)

## API Surface

**New HTTP endpoints in `api-gateway`** (extending `modules/orders/` + a new `modules/returns/` sub-module):

| Method | Path | Body / params | Auth | Notes |
|---|---|---|---|---|
| `POST` | `/api/orders/:orderId/returns` | `{ reasonCategory, notes?, lines: [{ orderLineId, quantity }] }` | bearer (owner OR `order:return-authorize`) | Open Return Request. |
| `POST` | `/api/returns/:rmaId/authorize` | — | bearer + `order:return-authorize` | Authorize. |
| `POST` | `/api/returns/:rmaId/reject` | `{ reason }` | bearer + `order:return-authorize` | Reject. |
| `POST` | `/api/returns/:rmaId/receive` | — | bearer + `inventory:receive-return` | Mark Received. |
| `POST` | `/api/returns/:rmaId/inspect` | `{ lines: [{ returnLineId, condition, disposition, lineRefundAmountMinor }] }` | bearer + `inventory:receive-return` | Inspect & Disposition; triggers Restock for `restock` dispositions. |
| `POST` | `/api/returns/:rmaId/close` | — | bearer + `order:return-authorize` | Close. |
| `GET` | `/api/returns/:rmaId` | — | bearer (owner OR `order:read`) | Full return state. |
| `GET` | `/api/orders/:orderId/returns` | — | bearer (owner OR `order:read`) | List returns for an order. |
| `POST` | `/api/orders/:orderId/refunds` | `{ paymentId, amountMinor, reason }`, header `Idempotency-Key` | bearer + `order:refund` | Manual refund (no Return required — goodwill / chargeback). |
| `GET` | `/api/orders/:orderId/refunds` | — | bearer (owner OR `order:read`) | List refunds. |

**Kulala HTTP files** (under `http/`):

- **`http/returns.http`** — NEW; covers Open → Authorize → Receive → Inspect (restock disposition) → close.
- **`http/refunds.http`** — NEW; covers manual Issue Refund + the auto-refund-from-cancel-order trace.

## Test Strategy

**Unit tests:**

- `apps/retail-microservice/src/modules/returns/domain/spec/return-request.model.spec.ts` — status state machine; window check.
- `apps/retail-microservice/src/modules/returns/domain/spec/return-line.model.spec.ts` — quantity invariants vs OrderLine.
- `apps/retail-microservice/src/modules/orders/domain/spec/refund.model.spec.ts` — amount ≤ Payment.amount − previousRefunds; status transitions.
- `apps/retail-microservice/src/modules/returns/application/use-cases/spec/open-return-request.use-case.spec.ts` — window check; over-quantity rejected; rma-number generation.
- `apps/retail-microservice/src/modules/returns/application/use-cases/spec/authorize-return.use-case.spec.ts`, `reject-return.use-case.spec.ts`, `receive-return.use-case.spec.ts`, `inspect-and-disposition.use-case.spec.ts` — last one verifies the Restock RPC is invoked exactly once per `restock` line.
- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/issue-refund.use-case.spec.ts` — over-refund rejected; gateway-failure path; idempotency.
- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/auto-refund-from-cancel.consumer.spec.ts` — consumes own `retail.order.cancelled` with the flag; calls Issue Refund.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/restock-from-return.use-case.spec.ts` — produces `return`-type StockMovement; idempotent on `(returnRequestId, returnLineId)`; emits `inventory.stock.returned`.

**E2E tests:**

- `test/return-restock-refund.e2e-spec.ts`: full chain — place order → ship → deliver → open return → authorize → receive → inspect with `restock` disposition → assert StockLevel.quantityOnHand increased → issue refund → Payment.refundedAmountMinor reflects.
- `test/return-rejected.e2e-spec.ts`: outside-window or policy rejection path.
- `test/auto-refund-from-cancel.e2e-spec.ts`: ship-then-cancel-after-capture path (cancel-after-ship is blocked from `epic-08`, so this case uses cancel-before-ship-after-capture if capture-on-place was explicit; alternatively the manual flag-then-cancel admin path).
- `test/manual-refund.e2e-spec.ts`: goodwill refund without a Return.

**Concurrency tests:** double-issue Refund with the same Idempotency-Key — only one Refund row created, only one gateway call. (Note: idempotency-key dedupe enforcement lands in `epic-12`; in this epic the test asserts the gateway-reference-based natural idempotency.)

**Seed data required:**

- `RETURN_WINDOW_DAYS=30` in `.env.example`.
- Permission codes seeded.

## Documentation Deliverables

**Per-task markdown files** under `docs/implementation/09-returns-and-refunds/`:

- `01-rma-lifecycle.md` — the 6-state machine; status transitions table; cross-link to the report's RMA convergence note (Adobe Commerce / Vendure / ReverseLogix).
- `02-return-line-disposition-and-restock.md` — `restock` / `scrap` / `quarantine` semantics; the cross-service Restock RPC.
- `03-refund-as-distinct-entity.md` — why Refund is separate from ReturnRequest (chargebacks, goodwill, partial refunds, refund-without-return).
- `04-auto-refund-from-cancel-order.md` — consuming the `flagged_for_refund` flag from `epic-08`.
- `05-fake-gateway-refund-method.md` — extension of `FakePaymentGatewayAdapter`.
- `06-returns-and-refunds-api-and-http-files.md`.

**`README.md` updates required:**

- **System diagram**: add Returns / Refunds boxes; show the Restock cross-service RPC.
- **API → Returns** new section.
- **API → Refunds** new section.
- **Authentication → Roles** updated for `order:return-authorize`, `order:refund`, `inventory:receive-return`.

**`CLAUDE.md` updates required:**

- New section: **Returns sub-module** inside retail microservice file-listing.
- **Message patterns** extended with the eight new keys + the new RPC.

**Exclusions Register documents owned by this epic:** None (all under `epic-15`).

## Tasks (decomposition hint)

1. **Add ReturnRequest + ReturnLine entities + persistence + domain specs + migration.**
2. **Add Refund entity + persistence + migration** + `payment.refunded_amount_minor` column.
3. **Implement Open Return Request + Authorize + Reject + Receive + Close use cases.**
4. **Implement Inspect & Disposition use case** — including the cross-service Restock call.
5. **Add `restock-from-return.use-case.ts` in inventory** + `inventory.stock.restock-from-return` RPC handler + new routing key.
6. **Add `INVENTORY_RESTOCK_GATEWAY` port + RMQ adapter in retail.**
7. **Extend `FakePaymentGatewayAdapter` with `refund()`.**
8. **Implement Issue Refund use case + endpoint** — idempotency-key header accepted.
9. **Implement auto-refund consumer** for `retail.order.cancelled` with the flag.
10. **Wire api-gateway endpoints** (returns + refunds + admin lists).
11. **Add notification consumers** for the new return/refund events.
12. **Author `http/returns.http` + `http/refunds.http`.**
13. **Seed + docs pass.**

## Carryover Between Tasks

| Task | Entry state assumed | Carryover artifacts produced (never under `tmp/`) |
|---|---|---|
| 1 | `epic-08` complete. | ReturnRequest + ReturnLine entities + mappers + repository + specs + migration; `01-…md`. |
| 2 | Task 1 complete. | Refund entity + mapper + repository + migration; updated Payment entity. |
| 3 | Tasks 1–2 complete. | Five use cases + specs; status transition tests; `01-…md` complete. |
| 4 | Tasks 1–3 complete. | Inspect & Disposition use case + spec; `02-…md`. |
| 5 | Tasks 1–4 complete. | Inventory use case + RPC handler + spec + routing key. |
| 6 | Tasks 1–5 complete. | New port + RMQ adapter in retail. |
| 7 | Tasks 1–6 complete. | Updated `FakePaymentGatewayAdapter`; spec; `05-…md`. |
| 8 | Tasks 1–7 complete. | Issue Refund use case + spec + endpoint; `03-…md`. |
| 9 | Tasks 1–8 complete. | Auto-refund consumer + spec; `04-…md`. |
| 10 | Tasks 1–9 complete. | api-gateway controller + DTOs + pipes for returns + refunds. |
| 11 | Tasks 1–10 complete. | Notification consumers for the new events. |
| 12 | Task 10 complete. | `http/returns.http`, `http/refunds.http`; `06-…md`. |
| 13 | All prior tasks complete. | Updated seed, README, CLAUDE.md, fixtures. |

## Exit Criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; ≥10 new specs green.
- [ ] `yarn test:e2e` passes; four new e2e files green.
- [ ] Place → ship → deliver → return-and-restock-and-refund chain works end-to-end in the seeded environment — this is the **report's Stage 2 acceptance criterion**.
- [ ] After Inspect & Disposition with `restock`, the inventory's StockLevel.quantityOnHand has increased; a `return`-type StockMovement row is present.
- [ ] After Issue Refund, Refund.status='issued'; payment.refunded_amount_minor reflects.
- [ ] Auto-refund consumer issues a Refund for the `flagged_for_refund=true` case.
- [ ] Every request in `http/returns.http` and `http/refunds.http` executes end-to-end.
- [ ] Per-task docs present under `docs/implementation/09-returns-and-refunds/`.
- [ ] `README.md` + `CLAUDE.md` updated.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.

## Self-Containment Notice

> Tasks generated from this epic must produce outputs that contain no references to anything under `tmp/`. The orchestration scratch space is not part of the final deliverable.
