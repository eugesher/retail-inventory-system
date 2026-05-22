---
id: epic-12
title: Hardening — idempotency keys on mutating ops + optimistic concurrency on StockLevel / Cart / Order
source_stages: [hardening]
depends_on: [epic-05, epic-07]
microservices: [api-gateway, retail-microservice, inventory-microservice]
task_subfolder: tmp/tasks/epic-12-idempotency-and-optimistic-concurrency/
docs_subfolder: docs/implementation/epic-12-idempotency-and-optimistic-concurrency/
---

# Epic 12 — Hardening — idempotency keys on mutating ops + optimistic concurrency on StockLevel / Cart / Order

## Goal

Convert the "header accepted, not enforced" idempotency story from `epic-05` (Place Order, Capture Payment) and `epic-08`/`epic-09` (Ship Fulfillment, Issue Refund) into real, deduplicating storage-backed idempotency. Each producing service gets a local `idempotency_key` table (per Q10 + the user-confirmed default of per-service local storage). Two requests with the same `Idempotency-Key` + same body fingerprint return the same response; same-key-different-body returns `422`. Convert the "version column ships now, enforcement later" placeholder on `Cart`, `Order`, `StockLevel`, `Reservation`, `Fulfillment`, `ReturnRequest` into a real OCC layer: every mutating use case reads-then-writes with version, and a `OptimisticLockVersionMismatchError → 409 Conflict` translator lives at the gateway. Tighten the no-oversell invariant by adding more concurrent-write tests on the stock and cart paths.

## In-Scope Entities and Operations

- **idempotency_key** (per service): `key` (VARCHAR(64) PK), `scope` (VARCHAR(64) — e.g. `place-order` / `capture-payment` / `ship-fulfillment` / `issue-refund` / `reserve-stock`), `body_fingerprint` (CHAR(64) — SHA-256 of canonicalized request body), `response_status` (INT), `response_body` (JSON), `created_at` (TIMESTAMP), `expires_at` (TIMESTAMP — default `created_at + IDEMPOTENCY_KEY_TTL_HOURS` env var, default 24).
- **OCC enforcement on:**
  - `StockLevel.version` — every Reserve / Release / Allocate / Cancel-Allocation / Commit-Sale / Receive / Adjust path becomes read-version-then-write-with-version. On mismatch, retry up to `OCC_RETRY_ATTEMPTS` (env, default 3) then surface `409`.
  - `Reservation.version` — same.
  - `Cart.version` — Add to Cart / Remove / Change Quantity / Place Order check version; mismatch returns `409`.
  - `Order.version` — every Order status transition (Place / Cancel / status-flip-from-Ship-Fulfillment) checks version.
  - `Fulfillment.version`, `ReturnRequest.version` — status transitions are version-checked.
- **Operations updated:**
  - **Place Order** (epic-05) — Idempotency-Key enforced; Cart-version-checked; on success, the response is cached under `(scope='place-order', key)`. Replay with same key + same body returns cached response (200 with idempotent flag); same key + different body returns `422 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY`.
  - **Capture Payment** (epic-05) — Idempotency-Key enforced.
  - **Ship Fulfillment** (epic-08) — Idempotency-Key enforced; Fulfillment-version-checked.
  - **Issue Refund** (epic-09) — Idempotency-Key enforced.
  - **Reserve Stock** (epic-07; system-internal RPC, not customer-facing) — idempotency via the `(cartId, variantId)` natural key from `epic-07` already; OCC tightened on the `StockLevel` write.
  - **Add to Cart / Remove / Change Quantity** (epic-05) — Cart-version checked; client may pass an `If-Match: <version>` header; mismatch returns `409`. If header absent, optimistic-locking still applies, conflict returns `409` after `OCC_RETRY_ATTEMPTS`.

## Non-Goals

- **Cross-service distributed idempotency** (one shared `idempotency_key` store across all services) — out of scope per user-confirmed default-a (per-service local).
- **Per-customer rate-limiting on Idempotency-Key reuse** — out of scope.
- **Distributed lock manager / Redlock** — not needed; OCC + retry suffices for the report's concurrency targets.
- **Idempotency on read endpoints** — N/A.
- **Long-running operation tracking via Idempotency-Key beyond the response body** (e.g. async job ids) — out of scope; all mutating ops in this system are synchronous-to-the-API-caller.

## Architectural Decisions Honored

- **Open Question Q10** — idempotency keys are required on `Place Order` and `Capture Payment`. Extended in this epic to also cover `Ship Fulfillment` and `Issue Refund` for symmetry — same problem (replay of a mutating call), same solution.
- **Cross-Cutting "Concurrency & consistency":** the no-oversell invariant lives on `StockLevel`. OCC on `StockLevel.version` is mandated by the report's §1; this epic delivers it as enforced contract (the version column shipped in `epic-04`). `Cart` mutations are also OCC-protected to prevent cart-line duplication under double-clicks. `Order` placement does not require pessimistic locking; OCC is sufficient.
- **Cross-Cutting "Soft delete vs hard delete":** the `idempotency_key` table is **live ephemeral** — periodically purged after `expires_at` (TTL sweeper added by a future hardening epic OR colocated with the reservation sweeper in `epic-14`'s scope — colocate in this epic for simplicity).
- **Cross-Cutting "Auditability":** OCC retries are logged at `info` with the version values + retry count; OCC failures are logged at `warn` + emitted as a `notifications.delivery.failed`-style optional alert event (out of scope here; a future hardening epic). Idempotent replays log at `debug`.
- **ADR-019** (TypeORM + MySQL): each producing service gets its own `idempotency_key` table (5 services × 1 table each; some services don't need it — only api-gateway proxies + retail + inventory have mutating endpoints requiring keys). Concretely: api-gateway has none (it proxies; the keys live in the downstream services); retail-microservice has one (for Place / Capture / Ship / Refund); inventory-microservice has one (for the Reserve RPC, used by Cart's Add-to-Cart proxy).
- **ADR-017** (boundaries): no new module. Adds an `IDEMPOTENCY_STORE` port per service under `application/ports/` and a TypeORM adapter under `infrastructure/persistence/`.
- **ADR-008** (dotted routing keys): no new keys.
- **ADR-010** (RBAC): existing gating preserved; no new permissions.

## Persistence Changes

**Added (in retail-microservice + inventory-microservice — separate identical tables):**

- `idempotency_key` table: `key` (VARCHAR(64) PK), `scope` (VARCHAR(64)), `body_fingerprint` (CHAR(64)), `response_status` (INT), `response_body` (JSON), `created_at` (TIMESTAMP), `expires_at` (TIMESTAMP).

**Indexes & constraints:**

- Unique composite on `(scope, key)` (the same `key` is OK across different scopes — different operations).
- Index on `expires_at` for the purge sweeper.

**No new columns** on existing entities. The `version` columns added by earlier epics (Cart, Order, StockLevel, Reservation, Fulfillment, ReturnRequest) are now actually relied on.

## Eventing / Messaging

- **No new routing keys.**
- **No new consumers.**
- **Replays** (cached-response returns) DO NOT re-publish events. The handler short-circuits before reaching the publisher — replays are observable as `Idempotent-Replay: true` response header and as Pino `debug` lines.

## API Surface

**Modified behavior** (no new endpoints):

- `POST /api/cart/:cartId/place` — now hard-enforces `Idempotency-Key` header. Missing header → `400 IDEMPOTENCY_KEY_REQUIRED`. Replay (same key + same body) → `200` + previous response body + `Idempotent-Replay: true` header. Same key + different body → `422 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY`.
- `POST /api/orders/:orderId/payments/capture` — same.
- `POST /api/orders/:orderId/fulfillments/:fulfillmentId/ship` — same.
- `POST /api/orders/:orderId/refunds` — same.
- `POST /api/cart/:cartId/lines` / `PATCH .../:lineId` / `DELETE .../:lineId` — accepts optional `If-Match: <version>`; OCC failures after retries return `409` with the current Cart version.
- New global exception filter at the gateway: `OptimisticLockVersionMismatchError → 409 Conflict { code: 'VERSION_MISMATCH', currentVersion: <n> }`.

**No new Kulala HTTP files.** The existing `http/cart.http`, `http/order.http`, `http/fulfillment.http`, `http/refunds.http` files are UPDATED to:

- Add `Idempotency-Key: {{$uuid}}` (Kulala dynamic variable) to every mutating request that requires it.
- Add a documented "replay" block showing the second request reusing the same key.
- Add a documented `If-Match` block on Cart line updates.

## Test Strategy

**Unit tests:**

- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/place-order.use-case.spec.ts` — updated; idempotency hit-path (replay returns cached body); idempotency miss-different-body returns 422; OCC retry-then-success; OCC retry-then-409.
- Same for capture / ship / refund use cases.
- `apps/retail-microservice/src/modules/orders/infrastructure/idempotency/spec/idempotency-store.adapter.spec.ts` — store contract.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/reserve-stock.use-case.spec.ts` — OCC retry behavior with a controlled version-mismatch fake.
- Updated specs across stock use cases (`receive-stock`, `adjust-stock`, `allocate-stock`, `commit-sale`, `cancel-allocation`) — assert OCC retry semantics.
- `apps/api-gateway/src/common/spec/optimistic-lock.exception-filter.spec.ts` — 409 translation.

**E2E tests:**

- `test/idempotency-place-order.e2e-spec.ts`: two identical `POST /cart/:id/place` with the same key → both return the same `orderId`, only one Order exists in the DB, only one `retail.order.placed` event in the audit/event-store.
- `test/idempotency-different-body.e2e-spec.ts`: same key + different body → `422`.
- `test/idempotency-capture.e2e-spec.ts`, `test/idempotency-ship.e2e-spec.ts`, `test/idempotency-refund.e2e-spec.ts`.
- `test/occ-cart.e2e-spec.ts`: two concurrent PATCH on the same cart line → exactly one wins; the loser receives `409` with current version.
- `test/occ-order-status-race.e2e-spec.ts`: concurrent Ship + Cancel on the same order → exactly one wins.

**Concurrency tests (the headline of this epic):**

- The existing `test/concurrent-oversell.e2e-spec.ts` from `epic-07` is EXTENDED to also assert no duplicate `allocation` StockMovement rows under concurrent Place + Place races (the report's no-oversell invariant must hold under retry).
- New `test/concurrent-stock-write.e2e-spec.ts`: 50 parallel Receive Stock calls of +1 each against the same `(variantId, stockLocationId)` — final `quantityOnHand` is exactly the seed + 50; no lost updates; OCC retries logged.
- New `test/concurrent-place-order.e2e-spec.ts`: 10 customers race to checkout a 5-unit-supply variant — exactly 5 orders succeed, 5 receive `OUT_OF_STOCK`.

**Seed data required:**

- `IDEMPOTENCY_KEY_TTL_HOURS=24`, `OCC_RETRY_ATTEMPTS=3` in `.env.example`.

## Documentation Deliverables

**Per-task markdown files** under `docs/implementation/epic-12-idempotency-and-optimistic-concurrency/`:

- `01-idempotency-q10-restated.md` — restate Q10 + the per-service local store decision; body-fingerprinting strategy (canonical-JSON + SHA-256).
- `02-idempotency-key-store-and-ttl.md` — table shape; TTL sweep; replay vs reuse-different-body semantics.
- `03-occ-on-stocklevel-reservation.md` — read-version-then-write; retry policy; cache-invalidation ordering preserved (ADR-023).
- `04-occ-on-cart-order-fulfillment-returnrequest.md` — gateway translation to 409; `If-Match` header convention.
- `05-no-oversell-under-retry.md` — the canonical guarantee; the concurrent-place test described.
- `06-replay-does-not-republish-events.md` — short-circuit before publisher; observability via headers + logs.
- `07-http-files-updated-idempotency-blocks.md`.

**`README.md` updates required:**

- New section under **API**: **Idempotency** — lists the endpoints that require the header, documents the replay + reuse-different-body semantics, links to the report's Q10.
- New section under **Caching → Caveats** (or new section): **Concurrency model** — describes OCC + retry on stock-write, cart-write, order-status-write.
- Add **Environment variables** entries: `IDEMPOTENCY_KEY_TTL_HOURS`, `OCC_RETRY_ATTEMPTS`.

**`CLAUDE.md` updates required:**

- Add a top-level **Idempotency conventions** bullet under Operational notes.
- Add a top-level **OCC conventions** bullet — read-version-then-write, retry up to `OCC_RETRY_ATTEMPTS`, 409 translation at the gateway.
- Note: the `idempotency_key` table lives per-service; no shared store.

**Exclusions Register documents owned by this epic:** None (all under `epic-15`).

## Tasks (decomposition hint)

1. **Add the `idempotency_key` table + entity + repository (+ migration)** in retail-microservice and inventory-microservice.
2. **Define an `IDEMPOTENCY_STORE` port** in each service's `application/ports/`; bind the TypeORM adapter.
3. **Implement the body-fingerprint utility** (canonical-JSON + SHA-256); shared utility in `libs/common/`.
4. **Wire idempotency on Place Order** — the use case looks up the key, returns cached body if hit, validates body fingerprint, persists on success.
5. **Wire idempotency on Capture Payment, Ship Fulfillment, Issue Refund.**
6. **Wire OCC retry on stock-write use cases** (Receive, Adjust, Reserve, Release, Allocate, Cancel-Allocation, Commit-Sale).
7. **Wire OCC retry on cart-write use cases** + the `If-Match` header support.
8. **Wire OCC on order-status-write use cases** + on fulfillment + return-request status writes.
9. **Add the `OptimisticLockVersionMismatchError → 409` exception filter** at the api-gateway.
10. **Update Kulala HTTP files** to include `Idempotency-Key` + replay blocks + `If-Match` blocks.
11. **Author the new concurrency tests.**
12. **Wire a simple `idempotency_key` purge into the reservation sweeper from `epic-14`** OR add a standalone @nestjs/schedule cron (target: epic-14's sweeper for consolidation; track here as a forward dependency note in `02-…md`).
13. **Documentation pass.**

## Carryover Between Tasks

| Task | Entry state assumed | Carryover artifacts produced (never under `tmp/`) |
|---|---|---|
| 1 | `epic-05`, `epic-07`, `epic-08`, `epic-09` complete; version columns exist. | `idempotency_key` entities + repositories in two services; migrations; `01-…md`, `02-…md`. |
| 2 | Task 1 complete. | `IDEMPOTENCY_STORE` ports in each service; adapter bindings; module wiring. |
| 3 | Task 2 complete. | New `libs/common/idempotency/body-fingerprint.util.ts` + spec. |
| 4 | Tasks 1–3 complete. | Updated Place Order use case + spec; `01-…md` complete. |
| 5 | Tasks 1–4 complete. | Updated Capture / Ship / Refund use cases + specs. |
| 6 | Tasks 1–5 complete. | Updated stock use cases with OCC retry + specs; `03-…md`. |
| 7 | Tasks 1–6 complete. | Updated cart use cases + specs; presentation-level `If-Match` parsing in the api-gateway cart controller. |
| 8 | Tasks 1–7 complete. | Updated order/fulfillment/return-request use cases + specs; `04-…md`. |
| 9 | Tasks 1–8 complete. | New global exception filter at the gateway; spec; `04-…md` complete. |
| 10 | Tasks 1–9 complete. | Updated `http/cart.http`, `http/order.http`, `http/fulfillment.http`, `http/refunds.http`; `07-…md`. |
| 11 | Tasks 1–10 complete. | Three new e2e files; `05-…md`. |
| 12 | Tasks 1–11 complete. | A simple `@nestjs/schedule` task that DELETEs `idempotency_key` rows where `expires_at < now()` every 10 minutes (per service that has the table). |
| 13 | All prior tasks complete. | Updated README, CLAUDE.md, fixtures; `06-…md`. |

## Exit Criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; updated + new specs green.
- [ ] `yarn test:e2e` passes; all idempotency + OCC e2e files green; the canonical concurrent-oversell test from `epic-07` re-verified green.
- [ ] All four mutating endpoints (Place / Capture / Ship / Refund) require `Idempotency-Key` (missing → `400`); replays return cached body; reuse-different-body returns `422`.
- [ ] `idempotency_key` table is purged of expired rows automatically (verified by leaving a row, advancing simulated time, observing deletion).
- [ ] 50 concurrent Receive Stock +1 calls produce a final `quantityOnHand` of seed + 50 (no lost updates).
- [ ] 10 concurrent Place Order calls against a 5-supply variant produce exactly 5 successful orders.
- [ ] Per-task docs present under `docs/implementation/epic-12-idempotency-and-optimistic-concurrency/`.
- [ ] `README.md` Idempotency + Concurrency sections added; `CLAUDE.md` updated.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.

## Self-Containment Notice

> Tasks generated from this epic must produce outputs that contain no references to anything under `tmp/`. The orchestration scratch space is not part of the final deliverable.
