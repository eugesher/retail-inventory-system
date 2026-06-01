---
epic: epic-06
task_number: 2
title: Implement Create Category + Reparent Category use cases with subtree path recompute
depends_on: [epic-02, task-01]
doc_deliverable_primary: docs/implementation/06-catalog-category-and-media/01-category-hierarchy-and-materialized-path.md
---

# Task 02 — `Create Category` + `Reparent Category` use cases

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-004](../../../docs/adr/004-adopt-hexagonal-architecture-per-service.md) — `application/` imports `domain/` + injected ports only; never infrastructure adapters.
  - [ADR-019](../../../docs/adr/019-typeorm-and-mysql-for-persistence.md) §"Repository surface" + [ADR-017](../../../docs/adr/017-architecture-lint-via-eslint-boundaries.md) §6 — transactional work goes through `ITransactionPort` / opaque `ITransactionScope`; the application layer never sees `EntityManager`.
  - [ADR-001](../../../docs/adr/001-structured-logging-with-pino.md) / [ADR-011](../../../docs/adr/011-notifier-port-and-adapters.md) — `PinoLogger`; inside `@MessagePattern` handlers log `correlationId` **inline** (`PinoLogger.assign()` throws outside request scope).

## Goal

Implement the two category write use cases on top of task-01's port. `CreateCategoryUseCase` creates a root or child (path computed from the parent). `ReparentCategoryUseCase` changes a category's `parentId` and **recomputes the materialized `path` for the node and every descendant in one transaction** — the single non-trivial write in this epic. Both are exposed as `@MessagePattern` RPC handlers on the catalog-microservice's existing controller so the gateway (task-06) can drive them.

## Entry state assumed

`epic-02` merged; task-01 carryover present:

- `Category` aggregate with `createRoot`/`createChild`/`rehydrate`/`regeneratePath`/`reparentTo`; errors `CategoryNotFoundError`, `DuplicateCategorySlugError`, `CategoryCycleError`.
- `ICategoryRepositoryPort` + `CATEGORY_REPOSITORY` (with `findById`, `findBySlug`, `findDescendants`, `findChildren`, `save`, `saveMany(scope?)`).
- `TRANSACTION_PORT` (`ITransactionPort`) available in `CatalogModule`.
- `epic-02`'s `catalog.controller.ts` exists with the product/variant `@MessagePattern` handlers and the established RPC routing-key pattern.

## Scope

**In:**

- `application/use-cases/create-category.use-case.ts` + spec.
- `application/use-cases/reparent-category.use-case.ts` + spec.
- Command/view DTOs under `application/dto/` (`CreateCategoryCommand`, `ReparentCategoryCommand`, `CategoryView`).
- Two `@MessagePattern` handlers on `presentation/catalog.controller.ts`.
- Two RPC routing keys in `libs/messaging/routing-keys.constants.ts`: `CATALOG_CATEGORY_CREATE = 'catalog.category.create'`, `CATALOG_CATEGORY_REPARENT = 'catalog.category.reparent'`. (These are gateway↔catalog request/response patterns — **not** fan-out events; the epic adds no bus events.)
- Completing `01-category-hierarchy-and-materialized-path.md` with the reparent-recompute algorithm.

**Out:**

- `Reclassify`/`Browse` — task-03.
- `MediaAsset` — task-04.
- The api-gateway controller + DTOs — task-06.
- Any domain event emission.

## Use-case shapes

### `CreateCategoryUseCase`

Input `{ name: string; slug: string; parentSlug?: string; sortOrder?: number; correlationId: string }`. Steps:

1. `findBySlug(slug)` → if present, throw `DuplicateCategorySlugError`.
2. If `parentSlug` given: `findBySlug(parentSlug)` → if missing, throw `CategoryNotFoundError`; build via `Category.createChild({ name, slug, parent })`. Else `Category.createRoot({ name, slug })`.
3. `save(category)` → map to `CategoryView` (`{ id, name, slug, parentId, path, sortOrder, status }`).

No transaction needed (single insert). Log at `info` with inline `correlationId`.

### `ReparentCategoryUseCase`

Input `{ slug: string; newParentSlug?: string; correlationId: string }`. Steps:

1. `findBySlug(slug)` → `CategoryNotFoundError` if missing. Call it `node`.
2. Resolve `newParent`: if `newParentSlug` given, `findBySlug(newParentSlug)` → `CategoryNotFoundError` if missing; else `null` (demote to root).
3. `findDescendants(node.path)` → `descendants` (the subtree under the old path).
4. `node.reparentTo(newParent, descendants.map(d => d.id))` — throws `CategoryCycleError` if `newParent` is the node or one of its descendants. This recomputes `node.path`.
5. **Recompute each descendant's path** relative to the node's *new* path. The old prefix is the node's pre-move path; rewrite each descendant's `path` by replacing the old prefix with the new one (each descendant keeps its own slug suffix). Do this by walking the descendant list (it is already a flat set) and, for each, `regeneratePath` driven from its computed new parent path — the simplest correct approach is a prefix-string rewrite: `newDescPath = node.path + desc.path.slice(oldNodePath.length)`. Capture `oldNodePath` **before** step 4 mutates the node.
6. Run steps 4–5's persistence inside `transactionPort.runInTransaction(async (scope) => { await repo.saveMany([node, ...descendants], scope); })` so the whole subtree commits atomically (ADR-017 / ADR-019).
7. Return `{ category: CategoryView; descendantsRewritten: number }` (the count is surfaced in the gateway response per the epic's API table).

Log at `info` inline `correlationId` with `{ slug, newParentSlug, descendantsRewritten }`.

```ts
// reparent-category.use-case.ts — illustrative skeleton (PinoLogger, never @nestjs/common Logger)
@Injectable()
export class ReparentCategoryUseCase {
  constructor(
    @Inject(CATEGORY_REPOSITORY) private readonly categories: ICategoryRepositoryPort,
    @Inject(TRANSACTION_PORT) private readonly tx: ITransactionPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReparentCategoryUseCase.name);
  }

  async execute(cmd: ReparentCategoryCommand): Promise<ReparentCategoryView> {
    const node = await this.categories.findBySlug(cmd.slug);
    if (!node) throw new CategoryNotFoundError(cmd.slug);

    const newParent = cmd.newParentSlug
      ? (await this.categories.findBySlug(cmd.newParentSlug)) ?? raise(new CategoryNotFoundError(cmd.newParentSlug))
      : null;

    const descendants = await this.categories.findDescendants(node.path);
    const oldNodePath = node.path;

    node.reparentTo(newParent, descendants.map((d) => d.id)); // throws CategoryCycleError on a cycle
    for (const desc of descendants) {
      desc.regeneratePath(node.path + parentSegmentOf(desc.path, oldNodePath));
    }

    await this.tx.runInTransaction(async (scope) => {
      await this.categories.saveMany([node, ...descendants], scope);
    });

    this.logger.info({ correlationId: cmd.correlationId, slug: cmd.slug, descendantsRewritten: descendants.length }, 'category reparented');
    return { category: toView(node), descendantsRewritten: descendants.length };
  }
}
```

(`raise`/`parentSegmentOf` are local helpers — the point is the prefix rewrite + single transaction, not these names.)

## Controller wiring (`presentation/catalog.controller.ts`)

Add two handlers next to the existing product/variant ones:

```ts
@MessagePattern(ROUTING_KEYS.CATALOG_CATEGORY_CREATE)
createCategory(@Payload() cmd: CreateCategoryCommand) {
  return this.createCategory.execute(cmd);
}

@MessagePattern(ROUTING_KEYS.CATALOG_CATEGORY_REPARENT)
reparentCategory(@Payload() cmd: ReparentCategoryCommand) {
  return this.reparentCategory.execute(cmd);
}
```

## Files to add

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/create-category.use-case.ts` + `spec/create-category.use-case.spec.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/reparent-category.use-case.ts` + `spec/reparent-category.use-case.spec.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/dto/create-category.command.ts`, `reparent-category.command.ts`, `category.view.ts` (+ barrel update).

## Files to modify

- `apps/catalog-microservice/src/modules/catalog/presentation/catalog.controller.ts` — two new `@MessagePattern` handlers.
- `apps/catalog-microservice/src/modules/catalog/infrastructure/catalog.module.ts` — register the two new use cases.
- `libs/messaging/routing-keys.constants.ts` — add `CATALOG_CATEGORY_CREATE`, `CATALOG_CATEGORY_REPARENT` (and keep `routing-keys.constants.spec.ts` value-for-value if it asserts the legacy enum — per ADR-008).
- `docs/implementation/06-catalog-category-and-media/01-category-hierarchy-and-materialized-path.md` — append the reparent-algorithm + transaction section.

## Files to delete

None.

## Tests

`create-category.use-case.spec.ts` (mock the repo port):

- Root create: no `parentSlug` → `path === '/electronics'`; `save` called once.
- Child create: `parentSlug` resolves → `path === '/electronics/phones'`.
- Duplicate slug → `DuplicateCategorySlugError`, no `save`.
- Unknown `parentSlug` → `CategoryNotFoundError`.

`reparent-category.use-case.spec.ts` (mock repo + a fake `ITransactionPort` that just runs the callback):

- Reparent a grandchild under a different root: node path + every descendant path recomputed; `saveMany` called once with the node + all descendants; result `descendantsRewritten` matches.
- Cycle: reparent a node under one of its own descendants → `CategoryCycleError`; `saveMany` **not** called.
- Root demotion: `newParentSlug` omitted → `parentId` becomes null, `path === '/' + slug`, descendants rewritten.
- Unknown node slug / unknown new-parent slug → `CategoryNotFoundError`.
- Assert the recompute + save run **inside** the transaction callback (the fake records call order).

## Doc deliverable — append to `01-category-hierarchy-and-materialized-path.md`

Add the sections task-01 forward-referenced. Target ~70 added lines:

7. **The reparent algorithm.** Capture `oldNodePath` before mutating; `findDescendants` is a single prefix scan; the node's new path drives a prefix-string rewrite of each descendant; everything persists in one `transactionPort.runInTransaction(...)`. Complexity O(subtree-size) row updates — acceptable because reparent is admin-rare.
8. **Why one transaction.** A partial rewrite would leave the tree with paths that don't match their `parentId` chain, breaking the `LIKE`-prefix browse. ADR-019/ADR-017: the use case never touches `EntityManager`; it passes the opaque `ITransactionScope` into `saveMany`.
9. **Cycle rejection at the use-case boundary.** The domain `reparentTo` is the guard; the use case feeds it the descendant id set. A cycle aborts before any write.

## Carryover produced (consumed by task-03 / task-06)

- `CreateCategoryUseCase` + `ReparentCategoryUseCase` are registered and reachable over RPC (`catalog.category.create`, `catalog.category.reparent`).
- `CategoryView` DTO shape is fixed (task-06's gateway response mirrors it).
- `01-…md` is complete.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`); the use cases import no TypeORM / `@nestjs/microservices` symbols (boundaries clean).
- [ ] `yarn test:unit` passes; both new use-case specs green.
- [ ] `yarn start:dev:catalog-microservice` boots; the two `@MessagePattern` handlers register on `catalog_queue`.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] `01-category-hierarchy-and-materialized-path.md` now contains the reparent-algorithm sections.
