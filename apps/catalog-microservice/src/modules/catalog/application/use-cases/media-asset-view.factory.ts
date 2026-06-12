import { MediaAssetView } from '@retail-inventory-system/contracts';

import { MediaAsset } from '../../domain';

// Pure mapping from the `MediaAsset` domain aggregate onto the wire
// `MediaAssetView`. Kept framework-free (no Nest decorators) and shared across
// every media use case (attach / detach return one; reorder / list return an
// array) so the projection lives in exactly one place — the
// `catalog-view.factory.ts` / `category-view.factory.ts` pattern.
//
// The aggregate is always persisted when it reaches the factory (the use cases
// map only post-`save`/post-`listByOwner` aggregates), so `id` is concrete — the
// `!` reflects that invariant. `status` is the `MediaAssetStatusEnum` value, whose
// raw string (`active`/`archived`) is exactly the wire representation.
export const toMediaAssetView = (media: MediaAsset): MediaAssetView => ({
  id: media.id!,
  ownerType: media.ownerType,
  ownerId: media.ownerId,
  uri: media.uri,
  type: media.type,
  altText: media.altText,
  sortOrder: media.sortOrder,
  status: media.status,
});
