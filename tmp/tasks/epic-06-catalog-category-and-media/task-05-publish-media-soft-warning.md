---
epic: epic-06
task_number: 5
title: Lift the Publish-Product "≥1 active MediaAsset" precondition to a non-blocking soft warning
depends_on: [epic-02, task-01, task-02, task-03, task-04]
doc_deliverable_primary: docs/implementation/06-catalog-category-and-media/04-publish-precondition-media-soft-warning.md
---

# Task 05 — Publish-product media soft warning

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-004](../../../docs/adr/004-adopt-hexagonal-architecture-per-service.md) — the use case may consult another aggregate's repository (media) without the `Product` domain model gaining media knowledge.
  - [ADR-013](../../../docs/adr/013-order-aggregate-and-cross-service-confirm.md) — precedent for "warn-and-proceed" vs "hard-fail" decisions made at the use-case layer.
  - [ADR-001](../../../docs/adr/001-structured-logging-with-pino.md) — `PinoLogger`; the warning is also surfaced in the response, not only logged.

## Goal

`epic-02`'s `PublishProductUseCase` enforces hard preconditions (≥1 variant, status transition). The Stage-1 report classifies "≥1 active MediaAsset" as **recommended, not strict**. This task lifts that comment-only note into a **non-blocking soft warning** surfaced in the publish response: publishing a product with no active media succeeds, but the response carries a `warnings: ['no-active-media']` entry so the UI can nudge the editor. The hard preconditions are unchanged.

## Entry state assumed

`epic-02` merged; tasks 01–04 carryover present:

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/publish-product.use-case.ts` exists (from `epic-02`) and currently returns a `ProductView` after flipping status `draft → active`. Per `epic-02`'s task-04, the "≥1 active Price" warning may already be logged here — this task follows the same warn-and-proceed pattern for media.
- `IMediaAssetRepositoryPort` + `MEDIA_ASSET_REPOSITORY` (task-04) can answer "active media for an owner".
- The publish response DTO is shared via `libs/contracts/catalog/` (or local to the microservice — verify against `epic-02`; if it is microservice-local, keep it there and add the field).

## Scope

**In:**

- Inject `MEDIA_ASSET_REPOSITORY` into `PublishProductUseCase`.
- After the successful status flip, compute media presence for the product (and/or its variants — see "Design note"); if none, append `'no-active-media'` to a `warnings: string[]` field on the response and log it at `warn` (inline `correlationId`).
- Extend the post-publish DTO (`ProductPublishedView` / `ProductView`) with `warnings: string[]` (default `[]`).
- Update the existing `publish-product.use-case.spec.ts` to cover the warning path.
- Doc deliverable `04-publish-precondition-media-soft-warning.md`.

**Out:**

- Making it a hard precondition — it is explicitly "recommended, not strict".
- Touching the ≥1-variant hard rule or the status-transition guard.
- Any media write — task-04 owns those.
- The api-gateway response passthrough — task-06 just forwards the new `warnings` field.

## Design note — which owner to check

A product publishes its variants too. The pragmatic check the epic implies: **a product has "active media" if the product itself has ≥1 active `MediaAsset` OR any of its variants does.** Implement the cheapest correct version: query active media for `ownerType='product', ownerId=productId`; if zero, also check the product's variant ids (`ownerType='product-variant'`). If still zero across both, emit the warning. Keep the media-presence helper inside the use case — the `Product` domain model stays media-unaware (it has no visibility into the media aggregate, mirroring how `epic-02` keeps it pricing-unaware).

```ts
// publish-product.use-case.ts — illustrative addition
const product = /* loaded + published as today */;
const warnings: string[] = [];

const hasProductMedia = (await this.media.findByOwner('product', product.id)).length > 0;
const hasVariantMedia =
  !hasProductMedia &&
  (await Promise.all(product.variants.map((v) => this.media.findByOwner('product-variant', v.id))))
    .some((list) => list.length > 0);

if (!hasProductMedia && !hasVariantMedia) {
  warnings.push('no-active-media');
  this.logger.warn(
    { correlationId: cmd.correlationId, productId: product.id },
    'product published without an active media asset (recommended, not required)',
  );
}

return { ...toView(product), warnings };
```

## Files to add

- `docs/implementation/06-catalog-category-and-media/04-publish-precondition-media-soft-warning.md`.

## Files to modify

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/publish-product.use-case.ts` — inject the media repo; compute + attach `warnings`.
- The publish response DTO (`…/application/dto/…` or `libs/contracts/catalog/…` — wherever `epic-02` put it) — add `warnings: string[]` (default `[]`).
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/publish-product.use-case.spec.ts` — add the warning-path cases.
- `apps/catalog-microservice/src/modules/catalog/infrastructure/catalog.module.ts` — only if the publish use case needs the media repo added to its provider deps (it should already be exported by task-04; confirm DI resolves).

## Files to delete

None.

## Tests

Extend `publish-product.use-case.spec.ts`:

- Publish with **no** media (neither product nor variant) → succeeds, status `active`, `warnings` contains `'no-active-media'`; a `warn` log is emitted.
- Publish with ≥1 active **product** media → succeeds, `warnings` empty.
- Publish with no product media but ≥1 active **variant** media → succeeds, `warnings` empty.
- The existing hard-precondition cases (no variants → error; wrong status → error) still pass unchanged — assert media is **not** consulted when a hard precondition fails (the warning computation runs only after a successful flip).

## Doc deliverable — `04-publish-precondition-media-soft-warning.md`

Target ~90 lines. Sections:

1. **Recommended vs strict.** The report classifies "≥1 active MediaAsset" as recommended; making it a hard gate would block legitimate publishes (e.g. a product whose media lands minutes later). So it is a soft warning.
2. **Where the check lives.** In the use case, not the `Product` domain model — the model has no visibility into the media aggregate (same separation `epic-02` uses for pricing). The use case is the integration point that may consult sibling aggregates.
3. **Response shape.** `warnings: string[]` (default `[]`); `'no-active-media'` is the only code today. Why a string-code array over a boolean: future soft preconditions (e.g. `'no-active-price'` from `epic-03`) append to the same channel without a response-shape change.
4. **Product-or-variant media.** The check passes if the product or any variant has active media — a variant-illustrated product is legitimately publishable.
5. **Logged and returned.** The warning is both `warn`-logged (ops visibility) and returned (UI nudge). Cross-Cutting logging conventions: `PinoLogger`, inline `correlationId`.
6. **What this task did NOT do.** It did not make the precondition strict; it did not touch the ≥1-variant hard rule; the gateway passthrough is task-06.

## Carryover produced (consumed by task-06)

- The publish response carries `warnings: string[]`; task-06's gateway DTO + e2e assert it.
- `04-publish-precondition-media-soft-warning.md` exists.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the extended publish spec is green (warning path + unchanged hard rules).
- [ ] `yarn start:dev:catalog-microservice` boots; publishing a media-less product returns `warnings: ['no-active-media']` and still flips status.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] `04-publish-precondition-media-soft-warning.md` exists with the sections above.
