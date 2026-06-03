---
epic: epic-02
task_number: 8
title: API-gateway catalog module
depends_on: [task-01, task-02, task-03, task-04, task-05, task-06, task-07]
doc_deliverable: docs/implementation/02-catalog-product-and-variant/07-api-gateway-catalog-module.md
adr_deliverable: none
---

# Task 08 — API-gateway catalog module

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the `docs/adr/` documents related to this task.

Most relevant ADRs: **ADR-009** (gateway per-module hexagonal; module named after
the downstream service; `ClientProxy` only in
`infrastructure/messaging/*-rabbitmq.adapter.ts`; gateway modules other than
`auth` have no `domain/`), **ADR-010 + ADR-024** (all routes protected by
default; opt out with `@Public()`; gate with `@RequiresPermission(<PermissionCodeEnum>)`;
inject `@CurrentUser()`), **ADR-008/020** (RPC via `ROUTING_KEYS`).

## Goal

Expose the catalog operations over HTTP at the gateway by adding
`apps/api-gateway/src/modules/catalog/`, mirroring the existing `retail/` and
`inventory/` gateway modules: a `CatalogGatewayPort`, a RabbitMQ adapter that
sends the seven catalog RPCs, the thin use cases, the controller with the seven
endpoints (write endpoints permission-gated, read endpoints public), and the
request/response DTOs. Add the end-to-end test that drives the whole flow.

## Entry state assumed

- task-01–07 carryover present. The catalog microservice handles all seven RPC
  patterns (`catalog.product.register`, `catalog.variant.create`,
  `catalog.product.publish`, `catalog.product.archive`, `catalog.product.list`,
  `catalog.product.get`, `catalog.variant.get`). `MicroserviceClientCatalogModule`
  and `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE` exist;
  `libs/contracts/catalog/` carries the payloads + view DTOs.
- The gateway has no `modules/catalog/` yet. The baseline seed provides staff
  users: `admin@example.com`/`admin1234` (all permissions), `catalog@example.com`/`catalog1234`
  (`catalog:read|write|publish`), `warehouse@example.com`/`warehouse1234`
  (inventory only — **no** catalog permissions), and a customer
  `customer@example.com`/`customer1234`.

## Scope

**In**

- The full `modules/catalog/` gateway module (ports, adapter, use cases,
  controller, DTOs, pipes if needed) + its registration in the gateway `AppModule`.
- `test/catalog.e2e-spec.ts`.

**Out**

- No new routing keys/contracts (all exist). No catalog-microservice changes.
- The `http/catalog.http` file (task-09) and seed of standing products (task-10).

## Module layout (mirror `apps/api-gateway/src/modules/inventory/`)

```
apps/api-gateway/src/modules/catalog/
  application/
    ports/
      catalog-gateway.port.ts     # ICatalogGatewayPort + CATALOG_GATEWAY_PORT
      index.ts
    use-cases/
      register-product.use-case.ts
      add-variant.use-case.ts
      publish-product.use-case.ts
      archive-product.use-case.ts
      list-products.use-case.ts
      get-product.use-case.ts      # by slug
      get-variant.use-case.ts
      index.ts
  infrastructure/
    messaging/
      catalog-rabbitmq.adapter.ts  # the ONLY ClientProxy holder; @Inject(CATALOG_MICROSERVICE)
      index.ts
    catalog.module.ts              # binds CATALOG_GATEWAY_PORT -> CatalogRabbitmqAdapter; imports MicroserviceClientCatalogModule
  presentation/
    catalog.controller.ts
    dto/                           # request + response DTOs (class-validator + Swagger)
    index.ts
  index.ts
```

The adapter sends each RPC via `firstValueFrom(client.send(ROUTING_KEYS.CATALOG_*, { ...payload, correlationId }))`
(model on `inventory-rabbitmq.adapter.ts`). Use cases inject `CATALOG_GATEWAY_PORT`,
never `ClientProxy`.

## HTTP endpoints (controller)

| Method | Path | Body / params | Auth | Response |
|---|---|---|---|---|
| `POST` | `/api/catalog/products` | `{ name, slug, description }` | `@RequiresPermission(PermissionCodeEnum.CATALOG_WRITE)` | `{ id, name, slug, description, status: 'draft' }` |
| `POST` | `/api/catalog/products/:productId/variants` | `{ sku, gtin?, optionValues, weightG?, dimensionsMm? }` | `@RequiresPermission(CATALOG_WRITE)` | `{ id, productId, sku, … }` |
| `POST` | `/api/catalog/products/:productId/publish` | — | `@RequiresPermission(CATALOG_PUBLISH)` | `{ id, status: 'active', publishedAt }` |
| `POST` | `/api/catalog/products/:productId/archive` | — | `@RequiresPermission(CATALOG_WRITE)` | `{ id, status: 'archived', archivedAt }` |
| `GET` | `/api/catalog/products` | `?status=active&page=&pageSize=&search=` | `@Public()` | paginated products + variants |
| `GET` | `/api/catalog/products/:slug` | — | `@Public()` | product + active variants |
| `GET` | `/api/catalog/variants/:variantId` | — | `@Public()` | variant + parent product header |

- Read codes are gated by the JWT `permissions` claim (ADR-024). Customer tokens
  carry no `permissions`, so the write routes are staff-only by construction; the
  read routes are `@Public()` so unauthenticated browse works.
- Request DTOs use `class-validator`; `:productId` / `:variantId` parse via
  `ParseIntPipe`. Use a presentation pipe only if you need pre-controller data
  (none is required here — keep it simple). Register the gateway `CatalogModule`
  in `apps/api-gateway/src/app/app.module.ts`.

## Files to add

- The `apps/api-gateway/src/modules/catalog/**` tree above.
- `test/catalog.e2e-spec.ts`.

## Files to modify

- `apps/api-gateway/src/app/app.module.ts` (import `CatalogModule`).

## Files to delete

- None.

## Tests

`test/catalog.e2e-spec.ts` (through the gateway; model on `test/iam.e2e-spec.ts`
/ `test/auth.e2e-spec.ts`):

1. Admin logs in (`admin@example.com`), registers a Product → `201`/`200` with
   `status: 'draft'`.
2. Admin adds two Variants (distinct `sku`s) → each returns the variant.
3. Admin publishes the Product → `status: 'active'`.
4. Customer (or unauthenticated) `GET /api/catalog/products` → the new Product
   appears with both Variants.
5. Admin archives the Product → `status: 'archived'`.
6. `GET /api/catalog/products` (default `status=active`) → the Product no longer
   appears.
7. **Permission tests:**
   - A seeded staff user **without** catalog permissions (`warehouse@example.com`)
     gets `403` on `POST /api/catalog/products` and on
     `POST /api/catalog/products/:id/publish`.
   - An unauthenticated request gets `200` on the public `GET`s.
   (If you want a precise "has `catalog:write` but not `catalog:publish`"
   assertion, mint such a role via the IAM endpoints inside the test; the
   no-catalog-permissions user above already satisfies the epic's negative
   intent for both POST and publish.)

`yarn test:e2e` must pass on a fresh `yarn test:infra:reload`.

## Doc deliverable

`docs/implementation/02-catalog-product-and-variant/07-api-gateway-catalog-module.md`.
Outline: the gateway module mirrors the retail/inventory shape (ADR-009); the
`ClientProxy`-in-adapter-only boundary; the permission-gating decisions
(`catalog:write` for register/add-variant/archive, `catalog:publish` for publish,
`@Public()` for reads) and why customer tokens can't reach the write routes; the
seven-endpoint surface. Cross-link ADR-009/010/024.

## Carryover to read

`carryover-01.md` … `carryover-07.md`.

## Carryover to produce

Write `carryover-08.md` capturing: the gateway `modules/catalog/` surface (port
symbol, adapter, use cases, controller routes); how it wires to
`MicroserviceClientCatalogModule`; the e2e spec name + which seeded users it
relies on; that `http/catalog.http` (task-09) and the standing-product seed
(task-10) are still pending; verification commands (`yarn test:e2e`).

## Exit criteria

- [ ] `apps/api-gateway/src/modules/catalog/` exists with the full hexagonal
      layout; `ClientProxy` lives only in `catalog-rabbitmq.adapter.ts`
      (boundaries green); the module is registered in the gateway `AppModule`.
- [ ] All seven endpoints work; write routes are gated by
      `@RequiresPermission(CATALOG_WRITE|CATALOG_PUBLISH)`, reads are `@Public()`.
- [ ] `test/catalog.e2e-spec.ts` covers the register→add-variants→publish→browse→archive→browse
      flow plus the permission tests, and is green on a fresh
      `yarn test:infra:reload`.
- [ ] `yarn lint` passes (`--max-warnings 0`); `yarn test:unit` passes;
      `yarn test:e2e` passes.
- [ ] `docs/implementation/02-catalog-product-and-variant/07-api-gateway-catalog-module.md` is written.
- [ ] The self-containment grep is clean:
      `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
- [ ] `carryover-08.md` is written.
