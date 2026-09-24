import { MediaAssetView } from '@retail-inventory-system/contracts';

import { MediaAsset } from '../../domain';

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
