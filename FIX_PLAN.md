# Fix Plan

Based on [AUDIT_REPORT.md](./AUDIT_REPORT.md) — 19 findings (2 critical, 5 major, 10 minor, 2 nit).

---

## Severity Breakdown

| Severity | IDs |
|----------|-----|
| Critical (2) | BUG-001, CONF-001 |
| Major (5) | BUG-002, BUG-003, ARCH-001, CONF-002, CONF-003, CONF-004 |
| Minor (10) | BUG-004, BUG-005, ARCH-002, ARCH-003, NAME-001, NAME-002, QUAL-001, CONF-005, CONF-006, CONF-007, CONF-008, CONF-009 |
| Nit (2) | NAME-003, QUAL-002 |

---

## Proposed Fix Batches

### Batch 1 — CLAUDE.md Accuracy (low-risk, high-impact)

| Finding | Change |
|---------|--------|
| BUG-002 | Rewrite the "Commands" section to include test commands |
| BUG-003 | Rewrite the "Architecture" section: correct the request flow, remove the false event-driven narrative, add missing message patterns |

**Testability:** Read-only review — no code changes, no build impact.

---

### Batch 2 — Race Condition Fix (critical business logic)

| Finding | Change |
|---------|--------|
| BUG-001 | Add `setLock('pessimistic_read')` to the stock balance query inside the transaction in `ProductStockOrderConfirmService` |

**Testability:** `yarn build` + `yarn test:e2e` — existing E2E tests cover order confirmation with stock checks.

---

### Batch 3 — Code Quality & Correctness (minor, surgical)

| Finding | Change |
|---------|--------|
| BUG-004 | Replace `!` assertion with explicit null check and error throw in `OrderConfirmService.getOrder()` |
| BUG-005 | Wrap the `RETAIL_ORDER_GET` payload to include `correlationId` (requires matching change in retail `OrderGetService`) |
| QUAL-001 | Add type guard in `throwRpcError` before destructuring |

**Testability:** `yarn build` + `yarn test:e2e` — all three touch the order confirmation flow which has E2E coverage.

---

### Batch 4 — Dead Code Cleanup

| Finding | Change |
|---------|--------|
| NAME-001 | Remove `MicroserviceEventPatternEnum` (unused enum) |
| NAME-002 | Remove `MicroserviceClientNotificationModule` (unused module) |
| ARCH-003 | Delete `libs/config/microservice-client/` (orphan empty file) |
| QUAL-002 | Delete `a.md` (scratch file) |

**Testability:** `yarn build` + `yarn lint` — removing unused code should not affect any imports.

---

### Batch 5 — Library Decoupling

| Finding | Change |
|---------|--------|
| ARCH-001 | Move `IOrderProductConfirm` (or a minimal subset) from `libs/retail` to `libs/common` so that `libs/inventory` no longer imports from `libs/retail` |

**Testability:** `yarn build` — type-only change, no runtime impact. Verify all imports resolve.

---

### Batch 6 — Configuration Fixes

| Finding | Change |
|---------|--------|
| CONF-003 | Remove or correct `tsConfigPath` in `nest-cli.json` root `compilerOptions` |
| CONF-005 | Move build-time packages (`@nestjs/cli`, `ts-loader`, `webpack`, etc.) from `dependencies` to `devDependencies` |
| CONF-007 | Add `LOG_LEVEL` to Joi validation schema (as optional) and `.env.local` |
| CONF-008 | Replace hardcoded env values in `jest.setup.ts` with `dotenv` loading from `.env.local` |
| CONF-009 | Fix leading slash in migration CLI path: `/migrations/...` → `./migrations/...` |

**Testability:** `yarn build` + `yarn test:unit` + `yarn test:e2e:run` (for jest.setup.ts change).

---

### Batch 7 — DTO Rename (nit)

| Finding | Change |
|---------|--------|
| NAME-003 | Rename `ProductStockGetDto` → `ProductStockGetQueryDto` |

**Testability:** `yarn build` — rename only, no logic change.

---

## Findings Recommended to SKIP

### CONF-001 (critical) — Dockerfiles incompatible with monorepo

**Reason to skip:** Fixing this requires rewriting all four Dockerfiles from scratch (new build context, multi-stage strategy with root-level COPY, updated docker-compose build sections). This is a >60% rewrite of the Docker setup and warrants a **dedicated follow-up task** rather than a cleanup batch. It should be its own PR with manual testing of `docker compose build` and `docker compose up`.

### CONF-002 (major) — docker-compose dev volumes exclude shared libs

**Reason to skip:** Tightly coupled to CONF-001 — fixing volumes without fixing Dockerfiles doesn't help. Should be addressed together in the Dockerfile rewrite task.

### CONF-004 (major) — source-map-support not in dependencies

**Reason to skip:** The constraint says "do not add new dependencies." Adding `source-map-support` to `package.json` would violate this. Alternatively, removing the webpack banner changes the runtime behavior of all services. Best addressed alongside the Dockerfile rewrite (Batch 7+).

### CONF-006 (minor) — Redis provisioned but unused

**Reason to skip:** Removing Redis from `docker-compose.yml` and the Joi schema is safe, but Redis may be intentionally reserved for an upcoming caching feature. This is a **product decision**, not a code fix. Should be confirmed before removal.

### ARCH-002 (minor) — Notification microservice is an empty shell

**Reason to skip:** Removing a service from the monorepo is a structural change. The service is likely a planned placeholder. Removal should be a conscious product decision.

---

## Execution Results

| Batch | Findings | Status | Notes |
|-------|----------|--------|-------|
| 1 | BUG-002, BUG-003 | **Applied** | CLAUDE.md updated |
| 2 | BUG-001 | **Applied** | pessimistic_write lock added; E2E 23/23 |
| 3 | BUG-004, QUAL-001 | **Applied** | Null check + type guard; E2E 23/23 |
| 3 | BUG-005 | **Reverted** | `Scope.REQUEST` on pipe caused 500s in E2E test harness — needs dedicated follow-up |
| 4 | NAME-001, NAME-002, ARCH-003, QUAL-002 | **Applied** | Dead code removed; build + lint clean |
| 5 | ARCH-001 | **Applied** | `OrderProductStatusEnum` + `IOrderProductConfirm` moved to common; retail re-exports |
| 6 | CONF-003, CONF-005, CONF-007, CONF-008, CONF-009 | **Applied** | E2E 23/23 |
| 7 | NAME-003 | **Applied** | `ProductStockGetDto` → `ProductStockGetQueryDto`; build clean |
| Skip | CONF-001, CONF-002, CONF-004, CONF-006, ARCH-002 | **Skipped** | See reasons above |
