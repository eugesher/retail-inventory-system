---
epic: epic-00
task_number: 17
title: Reconcile ADR-019 — `TypeOrmModule.forFeature(...)` vs. `DatabaseModule.forFeature(...)` at the infrastructure module surface
depends_on: []
doc_deliverable: null
---

# Task 17 — Reconcile ADR-019's "never import `@nestjs/typeorm` directly" rule against the live code and pending tasks

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing. In particular, read [ADR-019](../../../docs/adr/019-typeorm-and-mysql-for-persistence.md) §"Decision" → "Module wiring" + "Repository surface"; [ADR-003](../../../docs/adr/003-record-architecture-decisions.md) §"Format" + §"Immutability"; [ADR-005](../../../docs/adr/005-split-shared-common-into-bounded-libs.md) §3 (where `libs/database` got `DatabaseModule.forRoot/forFeature`); and [ADR-017](../../../docs/adr/017-architecture-lint-via-eslint-boundaries.md) §"Per-source disallow lists" — the lint config decides what is *actually* forbidden vs. what ADR-019 prose says.

## ADR audited

[ADR-019 — TypeORM + MySQL as the persistence stack](../../../docs/adr/019-typeorm-and-mysql-for-persistence.md). Accepted (2026-05-14).

## Discrepancy

ADR-019 lays down two coupled binding rules on the persistence-import surface that are tighter than what the codebase actually practices:

1. **§"Module wiring", line 88-92.** "Apps consume the DB via `DatabaseModule.forRoot(entities)` at the AppModule level and `DatabaseModule.forFeature(entities)` per module. The factory inside `DatabaseModule.forRoot` is the single place that constructs `TypeOrmModuleOptions` from `ConfigService` — **applications never import `@nestjs/typeorm` directly**."
2. **§"Repository surface", line 99-101.** "(Repository implementations) live in `infrastructure/persistence/` and are the **only files allowed** to import `typeorm`, `@nestjs/typeorm`, or use `InjectRepository`."

Both rules are violated by one existing file in the live code, **and** instructed-as-pattern by eight decomposed tasks under `tmp/tasks/**`. The eslint boundary config (the de-facto authority per CLAUDE.md §"Architecture rules location") does **not** enforce either rule at the infrastructure-module layer — `@nestjs/typeorm` is only forbidden from `application-use-case`, `application-port`, `application-dto`, `presentation`, `lib-contracts`, and `lib-ddd`. The infrastructure module layer is permitted.

Surface:

- `docs/adr/019-typeorm-and-mysql-for-persistence.md` (the ADR prose itself) — **code-discrepancy** view (the ADR's rule disagrees with the code).
- `tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-01-…md` + `task-02-…md` + `task-05-…md`; `tmp/tasks/epic-02-catalog-product-and-variant/task-01-…md` + `task-02-…md`; `tmp/tasks/epic-03-pricing-price-and-tax-category/task-01-…md` + `task-02-…md` + `task-04-…md` — **task-contradiction** view (eight tasks instruct the disallowed pattern).

## Evidence

### Code-discrepancy (one file)

`apps/api-gateway/src/modules/auth/infrastructure/auth.module.ts` imports `TypeOrmModule` directly and calls `TypeOrmModule.forFeature(...)` twice — once at the module-imports level and once inside `AuthLibModule.forRootAsync({ imports: [...] })`:

```text
apps/api-gateway/src/modules/auth/infrastructure/auth.module.ts:2:import { TypeOrmModule } from '@nestjs/typeorm';
apps/api-gateway/src/modules/auth/infrastructure/auth.module.ts:33:    TypeOrmModule.forFeature([UserEntity]),
apps/api-gateway/src/modules/auth/infrastructure/auth.module.ts:35:      imports: [TypeOrmModule.forFeature([UserEntity])],
```

The other three live infrastructure modules **do** comply with ADR-019:

```text
apps/inventory-microservice/src/modules/stock/infrastructure/stock.module.ts:34:    DatabaseModule.forFeature([Product, ProductStock, ProductStockAction, Storage]),
apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts:31:    DatabaseModule.forFeature([Customer, Order, OrderProduct, OrderProductStatus, OrderStatus]),
```

The `infrastructure/persistence/index.ts` files import `TypeOrmModuleOptions` from `@nestjs/typeorm`, but those files live *inside* `infrastructure/persistence/` so ADR-019 already permits the import.

### Task-contradictions (eight files)

Eight pending tasks instruct the same `TypeOrmModule.forFeature(...)`-direct pattern, with `epic-03/task-01` going further by adding a fresh `import { TypeOrmModule } from '@nestjs/typeorm';` to a new module file:

```text
tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-01-add-role-permission-tables-and-seed-registry.md:116: register the new entities under `TypeOrmModule.forFeature([UserEntity, RoleEntity, PermissionEntity])`
tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-02-rename-user-to-staff-user-and-drop-simple-array-roles.md:79:  replace `UserEntity` → `StaffUserEntity` in `TypeOrmModule.forFeature`
tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-05-customer-table-and-customer-auth-endpoints.md:101:  Register `CustomerEntity` in `TypeOrmModule.forFeature([...])`.
tmp/tasks/epic-02-catalog-product-and-variant/task-01-scaffold-catalog-microservice.md:78: catalog.module.ts   # empty NestJS module — TypeOrmModule.forFeature([]) placeholder
tmp/tasks/epic-02-catalog-product-and-variant/task-02-product-and-variant-domain-and-persistence.md:201: register the two entities under `TypeOrmModule.forFeature([ProductEntity, ProductVariantEntity])`
tmp/tasks/epic-03-pricing-price-and-tax-category/task-01-pricing-module-scaffold.md:102: import { TypeOrmModule } from '@nestjs/typeorm';
tmp/tasks/epic-03-pricing-price-and-tax-category/task-01-pricing-module-scaffold.md:105:   imports: [TypeOrmModule.forFeature([])], // entities added in task-02
tmp/tasks/epic-03-pricing-price-and-tax-category/task-02-price-and-tax-category-domain-and-persistence.md:56: replace the empty `TypeOrmModule.forFeature([])` from task-01 with `TypeOrmModule.forFeature([PriceEntity, TaxCategoryEntity])`
tmp/tasks/epic-03-pricing-price-and-tax-category/task-02-price-and-tax-category-domain-and-persistence.md:229: imports: [TypeOrmModule.forFeature([PriceEntity, TaxCategoryEntity])],
tmp/tasks/epic-03-pricing-price-and-tax-category/task-04-update-publish-product-hard-fail-on-no-price.md:144:     imports: [TypeOrmModule.forFeature([ProductEntity, ProductVariantEntity])],
```

The eslint config does not catch any of this — the relevant blocks in `eslint.config.mjs:298-411` only forbid `@nestjs/typeorm` from `application-use-case` / `application-port` / `application-dto` / `presentation` / `lib-contracts` / `lib-ddd`. The infrastructure module layer is not in the `disallow` list.

### `DatabaseModule.forFeature(...)` is a thin wrapper

`libs/database/database.module.ts:31-33`:

```ts
public static forFeature(entities: EntityClassOrSchema[]): DynamicModule {
  return TypeOrmModule.forFeature(entities);
}
```

So mechanically, either form yields the same `DynamicModule` — the call-site choice is purely a question of which import surface the module file pulls in (`@retail-inventory-system/database` vs. `@nestjs/typeorm`).

## Why this matters

ADR-019 is the load-bearing record of the persistence-stack decision and its allowed import surface. The current state has three observable shapes pointing in three directions:

1. **ADR-019 prose** — `DatabaseModule.forFeature(...)` is the only allowed module-level wiring.
2. **eslint boundaries config** — the infrastructure module layer may import `@nestjs/typeorm` freely.
3. **Existing code + decomposed tasks** — the `auth.module.ts` precedent (set by ADR-010 work) and eight follow-on tasks treat `TypeOrmModule.forFeature(...)` as the working idiom.

Until those three are reconciled, an implementer landing on ADR-019 to learn the rule and then on a follow-on task to implement it will face a contradiction. The risk is not subtle: someone reading ADR-019 strictly will reject these eight tasks as out-of-spec, demand a rewrite, then discover the existing precedent in `auth.module.ts` and have to choose whether to also rewrite that. Conversely, an implementer following the task instructions and the lint will conclude ADR-019's rule is dead letter and quietly stop reading the ADR for guidance on future work. Either outcome erodes the ADR set's status as the authoritative reference.

## Proposed resolution

Two options. Recommend **option A**.

**Option A — Amend ADR-019 to acknowledge the infrastructure-module `TypeOrmModule.forFeature(...)` pattern (recommended).**

The carve-out is narrow, defensible, and matches what the lint already allows. The amended language clarifies that the *intent* of the original rule — keep `typeorm` and `@nestjs/typeorm` types out of the application layer (use cases, ports, DTOs, domain) — is preserved, while the *mechanism* the rule named ("apps never import `@nestjs/typeorm` directly") was over-broad: `TypeOrmModule.forFeature(...)` at the `infrastructure/<module>.module.ts` layer is operationally identical to `DatabaseModule.forFeature(...)` (the wrapper is a one-line passthrough) and is sometimes ergonomically required (e.g. `AuthLibModule.forRootAsync({ imports: [TypeOrmModule.forFeature([UserEntity])] })`, where the framework callee expects a `DynamicModule` value the caller is wiring in line).

The ADR-003 immutability rule reserves in-place edits for `Status` flips and one-line supersession pointers. An amendment that **clarifies the existing rule's scope without changing its decision** sits on the boundary. The safe path: write a short **§"Amendment (YYYY-MM-DD)"** block under §"Decision" that re-scopes the import rule, leaving the §"Decision" body untouched. This mirrors how ADR-007's example-log-shape correction was filed (`epic-00/task-06`). Specifically the amendment should:

1. State that the §"Module wiring" rule's binding intent is "no `@nestjs/typeorm` outside `infrastructure/`" (matching what the lint actually enforces), not "no `@nestjs/typeorm` outside `infrastructure/persistence/`".
2. Permit `TypeOrmModule.forFeature(entities)` at the `infrastructure/<module>.module.ts` layer, in addition to `DatabaseModule.forFeature(entities)`. Both are valid; the wrapper is preferred when the call site has no shared-imports requirement, the direct form is preferred when it does.
3. Keep the §"Repository surface" rule intact for the application layer — use cases, ports, DTOs, presentation, and domain still cannot import `typeorm` / `@nestjs/typeorm`. The lint enforces this.

Crucially: no rewrite of the eight task files. They become compliant by the amendment.

**Option B — Rewrite `auth.module.ts` + all eight tasks to use `DatabaseModule.forFeature(...)`.**

Listed for completeness. Requires: (a) edit `apps/api-gateway/src/modules/auth/infrastructure/auth.module.ts` to import `DatabaseModule` and replace the two `TypeOrmModule.forFeature([UserEntity])` calls — including the one inside `AuthLibModule.forRootAsync({ imports: [...] })`; (b) edit the eight task files to instruct `DatabaseModule.forFeature(...)` everywhere; (c) optionally tighten `eslint.config.mjs` to forbid `@nestjs/typeorm` from infrastructure-module files (with a carve-out for `infrastructure/persistence/`).

Rejected as the recommendation: the eight-task surface area is large, the existing `auth.module.ts` precedent has been stable since ADR-010 work, the linter does not flag the pattern, and the `DatabaseModule.forFeature(...)` wrapper currently offers zero behavioural value beyond import-surface preference. If the project later acquires a reason to centralise feature-level wiring (e.g. cross-cutting test fixtures injected at `forFeature` time), the rewrite becomes load-bearing and option B should be reopened.

## Scope

**In:**

- Amend `docs/adr/019-typeorm-and-mysql-for-persistence.md` with a single **§"Amendment (YYYY-MM-DD)"** block under §"Decision" that re-scopes the import rule per option A's three points. Reference the closing line "applications never import `@nestjs/typeorm` directly" explicitly so a reader of the original text knows where the amendment lands.
- Optionally: add a `## References` back-link from this corrections task in the amendment block, so a future reader sees the audit trail.

**Out:**

- Any edit to `apps/api-gateway/src/modules/auth/infrastructure/auth.module.ts` (the file is correct under the amended rule).
- Any edit to the eight follow-on tasks (they become compliant under the amended rule).
- Any tightening of `eslint.config.mjs` (the lint already enforces the correct invariant — no `@nestjs/typeorm` in `application-*` / `lib-contracts` / `lib-ddd`).
- Any change to ADR-019's other sections (the §"Repository surface" rule for the application layer, the `ARCH-LINT-EX-01` closure narrative, the alternatives considered — all match live code).

## Exit criteria

- [ ] ADR-019 carries an amendment block under §"Decision" that re-scopes the `@nestjs/typeorm` import rule per option A's three points (or, if the implementer chooses option B, the eight task files + `auth.module.ts` have been rewritten and `eslint.config.mjs` has been tightened correspondingly).
- [ ] A reader landing on ADR-019 and looking at `auth.module.ts` or any of the eight follow-on tasks sees no contradiction.
- [ ] `yarn lint` still passes. (No code changes under option A; under option B, the edits must keep lint green.)
- [ ] `tmp/adr-verification-progress.md` ADR-019 row is updated to `HAS-CORRECTIONS` with a pointer back to this task.
