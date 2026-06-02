# Carryover 09 → task-10

Task-09 ("Kulala `http/catalog.http` file") is complete. This note is the entry
state for task-10 (the standing-product seed + docs finalization).

## Entry state for task-10

- **`http/catalog.http` exists and runs top-to-bottom** against a seeded,
  running stack. It drives all seven catalog gateway endpoints plus the admin
  login, with request chaining so it runs straight through without manual edits.
- No code change in this task — only the `.http` file and its implementation
  doc were added. The gateway/microservice surface from task-08 is unchanged.
- All gates green on a fresh run:
  - `yarn lint` — exit 0 (`--max-warnings 0`).
  - `yarn test:unit` — **371 passed, 55 suites** (unchanged).
  - `yarn test:e2e` — **6 suites / 67 tests / 38 snapshots** (unchanged;
    `test/catalog.e2e-spec.ts` green).
  - Self-containment grep — clean (exit 1, no matches).
  - **Live curl smoke** of the exact `.http` flow against the booted stack
    (driver `start --reset`): 12/12 checks passed (see "How to verify").

## What `http/catalog.http` contains

Ten `# @name`-labelled blocks (covering all seven endpoints; add-variant and the
browse-list appear twice on purpose):

| Block | Method + path | Auth |
|---|---|---|
| `login` | `POST /api/auth/staff/login` | — |
| `registerProduct` | `POST /api/catalog/products` | Bearer (`catalog:write`) |
| `addVariantBlack` | `POST /api/catalog/products/:productId/variants` | Bearer (`catalog:write`) |
| `addVariantGraphite` | `POST /api/catalog/products/:productId/variants` | Bearer (`catalog:write`) |
| `publishProduct` | `POST /api/catalog/products/:productId/publish` | Bearer (`catalog:publish`) |
| `listProducts` | `GET /api/catalog/products?status=active&page=1&pageSize=20` | public |
| `getProductBySlug` | `GET /api/catalog/products/:slug` | public |
| `getVariant` | `GET /api/catalog/variants/:variantId` | public |
| `archiveProduct` | `POST /api/catalog/products/:productId/archive` | Bearer (`catalog:write`) |
| `listProductsAfterArchive` | `GET /api/catalog/products?status=active&search=aeron` | public |

## Key decisions & mechanics task-10 must respect

- **Login-capture mechanism + exact token JSON path.** The `login` block posts
  the seeded admin (`admin@example.com` / `admin1234`) to the **canonical**
  `POST /api/auth/staff/login` route, and the token is captured immediately
  after with:
  ```
  ###
  @accessToken = {{login.response.body.$.accessToken}}
  ```
  The path `{{login.response.body.$.accessToken}}` matches `TokenResponseDto`
  (`{ accessToken, refreshToken, expiresIn }`) — the same field `http/auth.http`
  / `http/iam.http` read. (Note: the catalog **e2e** uses the deprecated
  `/api/auth/login` alias; the `.http` file intentionally uses the canonical
  `/api/auth/staff/login`, matching `http/auth.http`'s `staffLogin` block. Both
  resolve to the same handler — `StaffLoginController` is mounted at
  `@Controller(['auth', 'auth/staff'])`.)
- **Request chaining via file variables** (same pattern as the login token):
  - `registerProduct` → `@productId` / `@productSlug`
  - `addVariantBlack` → `@variantId`
  - `publish` / `archive` / `addVariantGraphite` target `{{productId}}` in the
    path; `getProductBySlug` uses `{{productSlug}}`; `getVariant` uses
    `{{variantId}}`.
- **Public vs protected split is honored in the file:** the three GETs send **no**
  `Authorization` header (proving the `@Public()` routes work unauthenticated);
  the five write blocks send `Authorization: Bearer {{accessToken}}`.
- **No env-file change.** `http/http-client.env.json` was left unchanged — the
  existing `dev.ENV_BASE_URL = http://localhost:3000/api` suffices; the file
  declares `@baseUrl = {{ENV_BASE_URL}}` at the top, as the siblings do.
- **Fixed slug/SKU values.** The product slug (`aeron-chair`) and the variant
  SKUs (`AERON-CHAIR-BLK-M`, `AERON-CHAIR-GRPH-L`) are literals; the catalog
  enforces slug/SKU uniqueness, so a second top-to-bottom run wants a fresh DB
  (`yarn test:infra:reload`). The `# Prereqs:` block documents this. **task-10's
  standing-product seed should avoid reusing the `aeron-chair` slug / these SKUs**
  if it wants the `.http` file to stay runnable against a seeded DB without a
  collision (or simply pick different standing products).
- **No `tmp/` / "epic" / "task" strings** anywhere in `http/catalog.http` or the
  doc (§6 verified by the grep gate).

## Known gaps (owned by task-10, the last in this group)

- **Standing-product catalog seed** in `scripts/test-db-seed.ts` — the catalog
  tables are still empty after a reload (no catalog rows seeded). task-10 adds
  the standing products/variants, idempotently. (If those reuse `aeron-chair` or
  the SKUs above, the `.http` `registerProduct` block would 409 against a seeded
  DB — pick distinct values, or accept that the `.http` register block then
  requires a non-seeded catalog.)
- **CLAUDE.md "next free number" bump** — still reads `025`; ADR-025 is
  committed, so it should read `026`. (Untouched by task-09.)
- **Consolidated catalog domain section / stale app-tree one-liner** in
  CLAUDE.md ("domain + persistence + register/add-variant write use cases &
  events") — task-10's consolidated catalog section.
- **Precise catalog error→HTTP mapping** — still a documented gap (a domain
  rejection surfaces as 500 at the gateway because the catalog microservice
  raises a plain `DomainException`, not an `RpcException`). Requires a
  catalog-microservice change; **not** task-10.
- **Pricing capability** (the warn-not-block "≥1 active Price" publish
  precondition) and the inventory/retail `product_id → variantId` reshape remain
  out of this group's scope.

## Docs written vs pending

- **`docs/implementation/02-catalog-product-and-variant/08-kulala-catalog-http-file.md`**
  — written: §1 what the file covers (the ten-block table), §2 the prereq
  login-and-capture flow (with the exact JSON path), §3 how to run locally (env
  file, base URL, seeded admin, re-run caveat), §4 which requests need a bearer
  token vs which are public, §5 how the chaining threads `productId`/`variantId`
  (and how the order encodes the publish/archive lifecycle rules), §6
  verification. Cross-links doc 07 and ADR-024/025.
- Docs 01–07 unchanged.

## Files added

- `http/catalog.http`
- `docs/implementation/02-catalog-product-and-variant/08-kulala-catalog-http-file.md`

## Files modified

- None. (`http/http-client.env.json` deliberately left unchanged; README.md /
  CLAUDE.md do not enumerate `.http` files, and the catalog gateway routes were
  already documented there by task-08 — nothing in this task made them stale.)

## Files deleted

- None.

## How to verify

```bash
yarn lint                 # --max-warnings 0, exit 0
yarn test:unit            # 371 passed, 55 suites (unchanged)

# Full regression (infra reload → migrate → seed → all e2e incl. catalog):
yarn test:e2e             # 6 suites / 67 tests / 38 snapshots; catalog e2e green

# Self-containment gate (expected: no orchestration references, grep exit 1):
grep -rniE 'tmp/|\bepic\b|\btask\b' \
  docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md

# Live end-to-end of the .http flow (the deliverable itself), against a booted,
# seeded stack — the canonical "runs top-to-bottom" proof:
./.claude/skills/run-retail-inventory-system/driver.sh start --reset
#   then replay the http/catalog.http blocks in order against
#   http://localhost:3000/api with any .http runner (Kulala / REST Client) or
#   curl: login → register → addVariant ×2 → publish → list → get-by-slug →
#   get-variant → archive → list (hidden). On a fresh --reset the product lands
#   at id 1 / slug aeron-chair, variant id 1. Confirmed: register 201 'draft',
#   variants 201 'active', publish 200 'active'+publishedAt, public list 200
#   (1 item, 2 variants), get-by-slug 200, get-variant 200 (parent header),
#   archive 200 'archived'+archivedAt, post-archive list 200 total=0, get-by-slug
#   still 200, write-without-token 401.
./.claude/skills/run-retail-inventory-system/driver.sh stop
```

Note: the driver's dev infra and the e2e test infra are separate volumes. After
the e2e run the test infra is left up+seeded; `driver.sh start --reset` brings
up (and reseeds) the dev infra independently. Tear either down with
`yarn test:infra:down` / `driver.sh stop` + `docker compose down -v` as needed.
