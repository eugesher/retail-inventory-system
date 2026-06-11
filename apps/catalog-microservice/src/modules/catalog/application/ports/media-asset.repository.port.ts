import { MediaOwnerTypeEnum } from '@retail-inventory-system/contracts';

import { MediaAsset } from '../../domain';

export const MEDIA_ASSET_REPOSITORY = Symbol('MEDIA_ASSET_REPOSITORY');

// Options for the per-owner list read. `activeOnly` keeps only `status = 'active'`
// rows; omitted/false returns every status (the reorder use case needs the active
// set, the list read needs active-only, a future admin view might want all).
export interface IMediaListByOwnerOptions {
  activeOnly?: boolean;
}

// The repository seam for the MediaAsset aggregate. It is a SEPARATE port from
// `CATALOG_REPOSITORY` / `CATEGORY_REPOSITORY` (one port per aggregate seam — the
// `ACTIVE_PRICE_PROBE` precedent; ADR-029 §8), so neither of the existing ports
// grows a media grab-bag.
//
// It returns domain types only — no TypeORM entity, `Repository`, or
// `EntityManager` type leaks here (ADR-017 forbids `typeorm` in
// `application/ports`). The TypeORM details live entirely in
// `MediaAssetTypeormRepository`. `MediaOwnerTypeEnum` is a wire contract, allowed
// here (the port layer may import `libs/contracts`).
export interface IMediaAssetRepositoryPort {
  // Inserts or updates one media row; re-reads for the concrete id + timestamps.
  save(media: MediaAsset): Promise<MediaAsset>;
  findById(id: number): Promise<MediaAsset | null>;
  // The owner's media, ordered `sortOrder ASC, id ASC` (id is the stable
  // tiebreak when two rows share a slot). `activeOnly` filters `status = 'active'`.
  listByOwner(
    ownerType: MediaOwnerTypeEnum,
    ownerId: number,
    opts?: IMediaListByOwnerOptions,
  ): Promise<MediaAsset[]>;
  // `MAX(sort_order)` across ALL rows for the owner — ARCHIVED INCLUDED, so the
  // default append slot stays monotonic and never collides with an archived row's
  // position. `null` when the owner has no media yet (the first asset then lands
  // at `(null ?? -1) + 1 = 0`).
  maxSortOrder(ownerType: MediaOwnerTypeEnum, ownerId: number): Promise<number | null>;
  // One-transaction bulk reorder: sets `sort_order = array index` for each id in
  // `orderedIds`. Returns the owner's refreshed ACTIVE list (sorted). All-or-
  // nothing — every UPDATE commits together or none does. The use case has
  // already validated `orderedIds` is an exact permutation of the active set.
  reorder(
    ownerType: MediaOwnerTypeEnum,
    ownerId: number,
    orderedIds: number[],
  ): Promise<MediaAsset[]>;
  // True when ANY of the `(ownerType, ownerId)` pairs has at least one ACTIVE
  // media asset. ONE query — an owner-pair tuple IN-list filtered to
  // `status = 'active'` with `LIMIT 1` — not a fan-out of per-owner `listByOwner`
  // calls. Backs the publish soft-warning probe, which asks "does the product OR
  // any of its variants have a picture?" across the whole owner set at once. An
  // empty `owners` list is `false` (vacuously no media).
  hasActiveForOwners(
    owners: { ownerType: MediaOwnerTypeEnum; ownerId: number }[],
  ): Promise<boolean>;
}
