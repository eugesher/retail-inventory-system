---
epic: epic-06
task_number: 4
title: Add MediaAsset domain + persistence + attach/reorder/detach/browse use cases
depends_on: [epic-02, task-01, task-02, task-03]
doc_deliverable_primary: docs/implementation/06-catalog-category-and-media/03-media-asset-polymorphism.md
---

# Task 04 — `MediaAsset` domain + persistence + use cases

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-004](../../../docs/adr/004-adopt-hexagonal-architecture-per-service.md) / [ADR-009](../../../docs/adr/009-port-adapter-at-the-gateway.md) — `MediaAsset` lives inside the existing `catalog` module; it is a Product-side aggregate, not a new bounded context.
  - [ADR-019](../../../docs/adr/019-typeorm-and-mysql-for-persistence.md) — entity/migration conventions; composite index.
  - [ADR-017](../../../docs/adr/017-architecture-lint-via-eslint-boundaries.md) — bulk reorder runs through `ITransactionPort`, never raw `EntityManager`.
  - [ADR-001](../../../docs/adr/001-structured-logging-with-pino.md) — `PinoLogger`; inline `correlationId` in RMQ handlers.

## Goal

Add the polymorphic `MediaAsset` — an image/video/document attached to **either** a `Product` **or** a `ProductVariant`, discriminated by `ownerType` + `ownerId`. Implement the four media operations: Attach (append with `sortOrder = max+1` within the owner), Reorder (atomic bulk reorder), Detach (soft-delete via status flip), and browse-by-owner. The `uri` is an opaque already-uploaded URL — no upload pipeline, no S3 wiring (epic Non-Goals).

## Entry state assumed

`epic-02` merged; tasks 01–03 carryover present:

- The `catalog` module hosts the `Product`/`ProductVariant` aggregates, `Category`, the repository providers, `TRANSACTION_PORT`, and the `@MessagePattern` controller.
- `CatalogDomainError` base exists for new error subclasses.
- No `media_asset` table exists.

## Scope

**In:**

- Domain: `MediaAsset` model (`domain/media-asset.model.ts`), `MediaTypeEnum` (`image | video | document`), `MediaOwnerTypeEnum` (`product | product-variant`), `MediaStatus` (`active | archived`).
- New errors: `MediaAssetNotFoundError`, `InvalidMediaUriError` (extend `CatalogDomainError`).
- Persistence: `MediaAssetEntity`, `MediaAssetMapper`, `IMediaAssetRepositoryPort` + `MEDIA_ASSET_REPOSITORY`, `MediaAssetTypeormRepository`.
- Migration `CreateMediaAssetTable` (BIGINT PK; composite index `(owner_type, owner_id, sort_order)`).
- Use cases: `AttachMediaUseCase`, `ReorderMediaUseCase`, `DetachMediaUseCase`, `BrowseMediaByOwnerUseCase` + specs (the epic's Test Strategy names attach + reorder specs as required; detach/browse covered by e2e in task-06).
- `@MessagePattern` handlers + routing keys: `CATALOG_MEDIA_ATTACH`, `CATALOG_MEDIA_REORDER`, `CATALOG_MEDIA_DETACH`, `CATALOG_MEDIA_BROWSE` (request/response RPC, not bus events).
- Domain spec `domain/spec/media-asset.model.spec.ts`.
- Doc deliverable `03-media-asset-polymorphism.md`.

**Out:**

- Upload pipeline / S3 / signed URLs / CDN invalidation — epic Non-Goals.
- api-gateway controller/DTOs — task-06.
- Any event emission — media edits are not in the must-emit set.

## Domain shape

`apps/catalog-microservice/src/modules/catalog/domain/media-asset.model.ts`. Extends `AggregateRoot<number>` (or a plain `Entity` — match the lightest existing convention; `MediaAsset` has no children). Fields:

- `id: number` (BIGINT PK; in TS still `number`).
- `uri: string` — non-empty; must start with `https://` or `s3://` (loose check — `InvalidMediaUriError` otherwise; deep URL validation is out of scope).
- `type: MediaTypeEnum`.
- `altText: string | null`.
- `sortOrder: number` — non-negative integer.
- `ownerType: MediaOwnerTypeEnum`, `ownerId: number` — the polymorphic owner; `ownerId` is opaque per `ownerType` (no FK — a polymorphic FK can't point at two tables; integrity is enforced at the use-case layer by an owner-existence pre-check).
- `status: MediaStatus`.
- timestamps.

Factory `MediaAsset.create({ ownerType, ownerId, uri, type, altText?, sortOrder })` validates `uri` + non-negative `sortOrder`. Method `archive(): void` (guards `status === 'active'`, flips to `'archived'`). Method `moveTo(sortOrder: number): void` (non-negative).

Invariants: `uri` non-empty + scheme-prefixed; `type`/`ownerType` enum-valid; `sortOrder ≥ 0`.

## Persistence shape

### `MediaAssetEntity`

`…/infrastructure/persistence/media-asset.entity.ts`. PK is BIGINT (`@PrimaryGeneratedColumn('increment', { type: 'bigint' })` — note `BaseEntity`'s default INT PK does **not** fit; declare the PK explicitly on this entity and keep `createdAt`/`updatedAt`/`status` columns). Columns:

- `uri: varchar(1024) NOT NULL`.
- `type: enum('image','video','document') NOT NULL`.
- `altText: varchar(255) NULL`.
- `sortOrder: int NOT NULL DEFAULT 0`.
- `ownerType: enum('product','product-variant') NOT NULL`.
- `ownerId: int NOT NULL`.
- `status: enum('active','archived') NOT NULL DEFAULT 'active'`.
- Composite index `(owner_type, owner_id, sort_order)` — the browse query's exact access path.

### Migration

`migrations/<ts>-CreateMediaAssetTable.ts`. `up`: `CREATE TABLE media_asset` (columns above; BIGINT PK; composite index; charset `utf8mb4_unicode_ci`). `down`: `DROP TABLE media_asset`.

### Repository port + adapter

```ts
export const MEDIA_ASSET_REPOSITORY = Symbol('MEDIA_ASSET_REPOSITORY');

export interface IMediaAssetRepositoryPort {
  findById(id: number): Promise<MediaAsset | null>;
  /** Active assets for an owner, ordered by sortOrder asc. */
  findByOwner(ownerType: MediaOwnerTypeEnum, ownerId: number): Promise<MediaAsset[]>;
  /** Current max sortOrder for an owner (null when none) — Attach computes max+1. */
  maxSortOrderForOwner(ownerType: MediaOwnerTypeEnum, ownerId: number): Promise<number | null>;
  save(asset: MediaAsset): Promise<MediaAsset>;
  /** Persist new sortOrders for many assets in one transaction (Reorder). */
  saveMany(assets: MediaAsset[], scope?: ITransactionScope): Promise<void>;
}
```

## Use-case shapes

- **`AttachMediaUseCase`** `{ ownerType, ownerId, uri, type, altText?, correlationId }`: verify the owner exists (product or variant via the `epic-02` repos — `MediaAssetNotFoundError` is for the asset, use the existing `ProductNotFoundError`/`VariantNotFoundError` for an unknown owner); `sortOrder = (maxSortOrderForOwner(...) ?? -1) + 1`; `MediaAsset.create(...)`; `save`. Returns the created asset.
- **`ReorderMediaUseCase`** `{ ownerType, ownerId, mediaIdsInOrder: number[], correlationId }`: load `findByOwner`; assert the id set matches exactly (reject unknown/missing ids — bulk reorder is all-or-nothing); reassign `sortOrder` by array index; persist via `transactionPort.runInTransaction((scope) => saveMany(assets, scope))` so the reorder is atomic (no transient duplicate orderings visible). Returns the reordered list.
- **`DetachMediaUseCase`** `{ id, correlationId }`: `findById` → `MediaAssetNotFoundError` if missing; `asset.archive()`; `save`. Soft-delete preserves the row (defensive — the epic notes OrderLine snapshots may reference the uri historically via the event stream). Returns the archived asset.
- **`BrowseMediaByOwnerUseCase`** `{ ownerType, ownerId }` (public read): `findByOwner` (active only, sorted). Projection read.

All use `PinoLogger` with inline `correlationId`; none inject an events publisher.

## Files to add

- `apps/catalog-microservice/src/modules/catalog/domain/media-asset.model.ts`.
- `apps/catalog-microservice/src/modules/catalog/domain/errors/media-asset-not-found.error.ts`, `invalid-media-uri.error.ts`.
- `apps/catalog-microservice/src/modules/catalog/domain/spec/media-asset.model.spec.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/ports/media-asset.repository.port.ts` (+ barrel).
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/{attach-media,reorder-media,detach-media,browse-media-by-owner}.use-case.ts` + `spec/{attach-media,reorder-media}.use-case.spec.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/dto/{attach-media.command,reorder-media.command,detach-media.command,media-asset.view}.ts` (+ barrel).
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/{media-asset.entity,media-asset.mapper,media-asset-typeorm.repository}.ts`.
- `migrations/<ts>-CreateMediaAssetTable.ts`.
- `docs/implementation/06-catalog-category-and-media/03-media-asset-polymorphism.md`.

## Files to modify

- `apps/catalog-microservice/src/modules/catalog/infrastructure/catalog.module.ts` — register `MediaAssetEntity`, bind `MEDIA_ASSET_REPOSITORY`, register the four use cases; export the token (task-05 reads media in the publish path).
- `apps/catalog-microservice/src/app/app.module.ts` — append `MediaAssetEntity` to `DatabaseModule.forRoot([...])`.
- `apps/catalog-microservice/src/modules/catalog/presentation/catalog.controller.ts` — four `@MessagePattern` handlers.
- `libs/messaging/routing-keys.constants.ts` — add the four media routing keys.

## Files to delete

None.

## Tests

`media-asset.model.spec.ts`:

- `uri` empty → `InvalidMediaUriError`; `uri` without `https://`/`s3://` scheme → `InvalidMediaUriError`; `https://…` and `s3://…` accepted.
- `ownerType` enum honored; bad value rejected.
- `sortOrder` negative → rejected; `0` and positive accepted.
- `archive()` flips active → archived; second `archive()` rejected.

`attach-media.use-case.spec.ts`:

- First asset on an owner → `sortOrder === 0` (`maxSortOrderForOwner` null → -1 + 1).
- Second asset → `sortOrder === 1` (max+1); per-owner ordering preserved.
- Unknown owner → owner-not-found error; no `save`.

`reorder-media.use-case.spec.ts`:

- Reorder three assets → each `sortOrder` matches its index in `mediaIdsInOrder`; `saveMany` called once inside the transaction callback.
- `mediaIdsInOrder` missing an id / containing an unknown id → rejected; `saveMany` not called (all-or-nothing).

## Doc deliverable — `03-media-asset-polymorphism.md`

Target ~140 lines. Sections:

1. **Polymorphic ownership.** `ownerType` discriminator + `ownerId`; why **no** polymorphic FK (a single column can't FK two tables); integrity enforced by an owner-existence pre-check in `AttachMediaUseCase`. Composite index `(owner_type, owner_id, sort_order)` is the browse access path.
2. **Opaque-URI policy.** `uri` is an already-uploaded URL (`https://`/`s3://`); no upload pipeline, no signed URLs, no CDN invalidation (epic Non-Goals; a future upload service is referenced as future work). Validation is a loose scheme check, not deep URL parsing.
3. **`sortOrder` semantics.** Attach appends at `max+1` within the same owner; Reorder rewrites the whole owner's ordering atomically (one transaction — no transient duplicate orderings); browse returns active assets sorted ascending.
4. **Soft-delete via status flip.** Detach flips `status` to `archived`, preserving the row — defensive against historic references in the event stream (Order doesn't snapshot `uri` today, but the row stays referenceable). Cross-Cutting "Soft delete vs hard delete".
5. **BIGINT PK rationale.** Media rows are the highest-cardinality catalog table (many per product/variant); BIGINT headroom over INT, diverging from the INT-PK `BaseEntity` default — noted so a reader isn't surprised by the explicit PK declaration.
6. **No event emitted.** Same rationale as `02-…md` — media edits are read-side, not in the must-emit set.
7. **What this task did NOT do.** Forward refs to task-05 (publish soft-warning reads media) and task-06 (gateway endpoints).

## Carryover produced (consumed by task-05 / task-06)

- `IMediaAssetRepositoryPort` + `MEDIA_ASSET_REPOSITORY` exported (task-05 reads "≥1 active media for owner" through it).
- Four media operations reachable over RPC.
- `media_asset` table exists; `MediaAssetView` shape fixed for task-06.
- `03-media-asset-polymorphism.md` exists.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the model + attach + reorder specs are green.
- [ ] `yarn migration:run` applies cleanly; `yarn migration:revert` drops `media_asset`; re-run succeeds.
- [ ] `yarn start:dev:catalog-microservice` boots; the four media `@MessagePattern` handlers register.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] `03-media-asset-polymorphism.md` exists with the sections above.
