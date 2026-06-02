---
epic: epic-02
task_number: 9
title: Kulala http/catalog.http file
depends_on: [task-01, task-02, task-03, task-04, task-05, task-06, task-07, task-08]
doc_deliverable: docs/implementation/02-catalog-product-and-variant/08-kulala-catalog-http-file.md
adr_deliverable: none
---

# Task 09 — Kulala `http/catalog.http` file

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the `docs/adr/` documents related to this task.

`tmp/tasks/execution-requirements.md` §9 is the spec for `.http` files. Match the
conventions of the existing `http/auth.http`, `http/iam.http`, `http/order.http`,
`http/product.http`, and `http/http-client.env.json`.

## Goal

Author `http/catalog.http` so every catalog gateway endpoint can be driven
locally end-to-end: a `# Prereqs:` block that logs in the seeded admin and
captures the bearer token into `@accessToken`, the four protected write requests
(with representative payloads, citing the controller path), and the three public
read requests. The file must be runnable top-to-bottom against a seeded, running
stack.

## Entry state assumed

- task-01–08 carryover present. The gateway exposes the seven `/api/catalog/...`
  endpoints (task-08). `http/http-client.env.json` defines
  `dev.ENV_BASE_URL = http://localhost:3000/api`.
- Seeded admin: `admin@example.com` / `admin1234` (all permissions). The staff
  login route is `POST /api/auth/staff/login` (confirm the exact path + response
  field that carries the access token by reading
  `apps/api-gateway/src/modules/auth/presentation/` and `http/auth.http`).

## Scope

**In**

- `http/catalog.http` only.

**Out**

- Any code change; the seed of standing products (task-10).

## `http/catalog.http` shape

- `@baseUrl = {{ENV_BASE_URL}}` at the top.
- A header comment block citing the controller path
  `apps/api-gateway/src/modules/catalog/presentation/catalog.controller.ts` and a
  one-line description of the module.
- A `# Prereqs:` block explaining: start the stack + seed
  (`docker compose up -d`, `yarn migration:run`, `yarn test:seed`, `yarn start:dev`),
  then run the login request first so `@accessToken` is populated.
- A login request that captures the token, e.g.:

  ```
  # @name login
  POST {{baseUrl}}/auth/staff/login
  Content-Type: application/json

  { "email": "admin@example.com", "password": "admin1234" }

  ###
  @accessToken = {{login.response.body.$.accessToken}}
  ```

  (Adjust the JSON path to the real response field — confirm against
  `http/auth.http` / the login response DTO.)
- `###` separators between requests; a `# @name <id>` line per request; header
  comments citing the route, path params, and body/query shape.
- The seven requests, each with a representative payload:
  - `registerProduct` — `POST /catalog/products` (Bearer) `{ "name": "...", "slug": "...", "description": "..." }`.
  - `addVariant` — `POST /catalog/products/:productId/variants` (Bearer)
    `{ "sku": "...", "gtin": "...", "optionValues": { "color": "red", "size": "M" }, "weightG": 250, "dimensionsMm": { "l": 100, "w": 60, "h": 30 } }`.
  - `publishProduct` — `POST /catalog/products/:productId/publish` (Bearer).
  - `archiveProduct` — `POST /catalog/products/:productId/archive` (Bearer).
  - `listProducts` — `GET /catalog/products?status=active&page=1&pageSize=20` (no auth — public).
  - `getProductBySlug` — `GET /catalog/products/:slug` (no auth).
  - `getVariant` — `GET /catalog/variants/:variantId` (no auth).
- Protected requests send `Authorization: Bearer {{accessToken}}`; the public
  GETs send no auth header (proving the `@Public()` routes work unauthenticated).
- Make the write requests chain naturally (capture the created `productId` /
  `variantId` from earlier responses into variables so publish/archive/get target
  the just-created rows), so the file runs top-to-bottom without manual edits.
- **No** `tmp/` references and **no** "epic"/"task" words anywhere in the file.

## Files to add

- `http/catalog.http`

## Files to modify

- `http/http-client.env.json` — only if a new env value is genuinely needed
  (the existing `dev.ENV_BASE_URL` should suffice; prefer no change).

## Files to delete

- None.

## Tests

- No unit/e2e specs. Manual verification: with a seeded, running stack, run the
  requests top-to-bottom (login → register → add two variants → publish → list →
  get-by-slug → get-variant → archive → list) and confirm each returns the
  expected status/shape. Capture the exact commands in the carryover.

## Doc deliverable

`docs/implementation/02-catalog-product-and-variant/08-kulala-catalog-http-file.md`.
Outline: what `http/catalog.http` covers; the prereq login-and-capture flow; how
to run it locally (env file, base URL, seeded admin); which requests need the
bearer token and which are public; how the request chaining threads
`productId`/`variantId`. No planning-process references.

## Carryover to read

`carryover-01.md` … `carryover-08.md`.

## Carryover to produce

Write `carryover-09.md` capturing: `http/catalog.http` exists and runs
top-to-bottom; the login-capture mechanism + the exact token JSON path used; any
env-file change (ideally none); that the standing-product seed + README/CLAUDE +
lint fixtures remain for task-10; verification commands.

## Exit criteria

- [ ] `http/catalog.http` covers all seven endpoints with representative
      payloads, a `# Prereqs:` block, the admin login capturing `@accessToken`,
      controller-path header comments, and request chaining.
- [ ] Protected requests carry the bearer token; public GETs carry none.
- [ ] The file runs top-to-bottom against a seeded, running stack.
- [ ] `yarn lint` passes (`--max-warnings 0`); `yarn test:unit` passes;
      `yarn test:e2e` passes (regression — no code change).
- [ ] `docs/implementation/02-catalog-product-and-variant/08-kulala-catalog-http-file.md` is written.
- [ ] The self-containment grep is clean (note: `http/catalog.http` is in scope):
      `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
- [ ] `carryover-09.md` is written.
