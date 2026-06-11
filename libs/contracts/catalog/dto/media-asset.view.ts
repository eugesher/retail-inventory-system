import { ApiResponseProperty } from '@nestjs/swagger';

import { MediaAssetTypeEnum, MediaOwnerTypeEnum } from '../enums';

// RPC response shape for one media asset — the persisted row after an attach /
// reorder / detach, or one entry of a list. A **class** carrying
// `@ApiResponseProperty` (the documented lib-contracts Swagger exception, the
// same `CategoryView` / `ProductView` use), so the contract is self-describing in
// the gateway's OpenAPI without pulling request-validation decorators onto a
// response shape.
//
// `ownerType` + `ownerId` are the polymorphic discriminator: the asset hangs off
// a `product` or a `product-variant`, and `ownerId` is that owner's BIGINT id
// (there is no FK — ADR-029 §4). `uri` is an OPAQUE, already-uploaded reference
// (`https://…` / `s3://…`); the catalog neither uploads nor validates the scheme.
// `altText` is optional accessibility text (`null` when absent). `sortOrder` is
// the asset's position in the owner's strip (lower renders first). `status` is the
// lifecycle string (`active`/`archived`); the catalog domain owns the
// `MediaAssetStatusEnum`, so the wire carries its raw value rather than coupling
// transport to an internal domain enum (ADR-025 §7).
export class MediaAssetView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public ownerType: MediaOwnerTypeEnum;

  @ApiResponseProperty()
  public ownerId: number;

  @ApiResponseProperty()
  public uri: string;

  @ApiResponseProperty()
  public type: MediaAssetTypeEnum;

  @ApiResponseProperty()
  public altText: string | null;

  @ApiResponseProperty()
  public sortOrder: number;

  @ApiResponseProperty()
  public status: string;
}
