---
epic: epic-07
task_number: 12
title: Extend http/inventory.http with the new endpoints
depends_on: [01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11]
doc_deliverable: docs/implementation/07-inventory-reservation-and-stock-movement/09-movements-audit-endpoint-and-http-file.md
---

# Task 12 — Extend `http/inventory.http` (Kulala)

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-010](../../../docs/adr/010-jwt-rbac-at-the-gateway.md) — each request carries a bearer token; the movements read needs `inventory:read`, the release/transfer need `inventory:adjust`/`inventory:transfer`. The file documents which seeded staff user has which permission.
  - [ADR-009](../../../docs/adr/009-port-adapter-at-the-gateway.md) — the endpoints exercised here are the gateway HTTP surface added in tasks 07 + 09.

## Goal

Extend the existing `http/inventory.http` Kulala file (created by `epic-04` task-09) with the three new endpoints this epic added at the gateway:

- `GET /api/inventory/variants/:variantId/movements` (with the `?page=&pageSize=&type=&from=&to=` filters).
- `POST /api/inventory/reservations/:reservationId/release`.
- `POST /api/inventory/variants/:variantId/stock/transfer`.

The reserve/allocate flow itself is **not** given new public requests — it is exercised through the existing `http/cart.http` and `http/order.http` requests (those are internal RPCs triggered by the cart/order endpoints, whose behavior changed in task-08 but whose signatures did not). This task only adds the three genuinely-new public endpoints. It writes the Kulala half of doc `09-…`.

## Entry state assumed

Tasks 01–11 complete:

- The three endpoints are live at the gateway (tasks 07 + 09).
- `http/inventory.http` exists from `epic-04` task-09 with the variant-keyed stock requests and a documented login/token bootstrap + the seeded `default-warehouse` id in the header.
- `http/cart.http` / `http/order.http` exist from `epic-05`.

## Scope

**In:**

- Append three request blocks to `http/inventory.http`, reusing the file's existing token/login variables and header conventions.
- A short comment block at the top of the new section noting that reserve/allocate are exercised via `http/cart.http` + `http/order.http` (no new requests for them).
- Append the Kulala half to doc `09-movements-audit-endpoint-and-http-file.md`.

**Out:**

- Any new endpoint (all three exist already).
- New requests for reserve/allocate (internal RPCs).
- Seed/README/CLAUDE — task-13.

## The added requests (shape)

Match the existing file's variable style (`@baseUrl`, `@accessToken`, the `# @name login` bootstrap, the seeded `@variantId` / `@warehouseId`):

```http
### Movements audit (staff; inventory:read)
GET {{baseUrl}}/api/inventory/variants/{{variantId}}/movements?page=1&pageSize=20
Authorization: Bearer {{accessToken}}

### Movements audit filtered by type + date window
GET {{baseUrl}}/api/inventory/variants/{{variantId}}/movements?type=allocation&from=2026-01-01T00:00:00.000Z&to=2026-12-31T23:59:59.999Z
Authorization: Bearer {{accessToken}}

### Manual release a reservation (ops/debug; inventory:adjust)
# @prompt reservationId Reservation UUID to release
POST {{baseUrl}}/api/inventory/reservations/{{reservationId}}/release
Authorization: Bearer {{accessToken}}

### Transfer stock between locations (warehouse-staff; inventory:transfer)
POST {{baseUrl}}/api/inventory/variants/{{variantId}}/stock/transfer
Authorization: Bearer {{accessToken}}
Content-Type: application/json

{
  "fromLocationId": "{{warehouseId}}",
  "toLocationId": "secondary-warehouse",
  "quantity": 5
}
```

- The transfer request documents that `toLocationId` may be a not-yet-existing location (the destination row is auto-initialized — task-07); the file's header should note how to create a second `stock_location` if the seed doesn't include one, or reference the seeded secondary location task-13 adds.
- The manual-release request uses a Kulala prompt for the reservation id (a runtime value produced by an add-to-cart in `http/cart.http`); the comment cross-references the cart flow.

## Files to add

None (the doc file already exists from task-09; this task appends to it).

## Files to modify

- `http/inventory.http` — the three new request blocks + the section comment.
- `docs/implementation/07-inventory-reservation-and-stock-movement/09-movements-audit-endpoint-and-http-file.md` — append the Kulala half.

## Files to delete

None.

## Tests

No automated test (Kulala files are run manually / in the e2e smoke). The verification is:

- Every new request in `http/inventory.http` executes against a running stack (`docker compose up -d && yarn start:dev`, seeded), returning the expected status (200 for movements/transfer, 200 for release).
- The movements request returns the timeline produced by the cart/order flow run from `http/cart.http` + `http/order.http`.

## Doc deliverable — appended to `09-movements-audit-endpoint-and-http-file.md` (Kulala half)

Append (~40 lines):

1. **The three new requests.** What each does, which seeded staff user/permission it needs, and the expected response.
2. **Reserve/allocate are exercised elsewhere.** Cross-reference `http/cart.http` (add/change/remove → reserve/release) and `http/order.http` (place → allocate) — no new requests because those are internal RPCs behind unchanged HTTP signatures.
3. **Runtime values.** The reservation id for the manual-release request comes from an add-to-cart response; the Kulala prompt captures it.

## Carryover produced (consumed by task-13)

- `http/inventory.http` exercises all three new endpoints.
- Doc `09-…md` is complete (API half from task-09 + Kulala half here).

## Exit criteria

- [ ] `yarn lint` passes (no code changes, but the repo-wide gate still runs clean).
- [ ] Every request in `http/inventory.http` executes against a seeded running stack with the expected status.
- [ ] The movements request returns the timeline produced by the cart/order Kulala flow.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `09-movements-audit-endpoint-and-http-file.md` carries the appended Kulala-half section.
