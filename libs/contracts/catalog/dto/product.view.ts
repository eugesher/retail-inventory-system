import { ApiResponseProperty } from '@nestjs/swagger';

import { PublishWarningView } from './publish-warning.view';

// RPC response shape for the product write operations (`catalog.product.register`
// / `publish` / `archive`) — the persisted product after the operation. `status`
// is the lifecycle string (`draft`/`active`/`archived`); the catalog domain owns
// the enum, so the wire carries its raw value rather than coupling transport to
// an internal domain enum (ADR-025).
//
// `publishedAt` / `archivedAt` are the lifecycle-transition timestamps, populated
// only by the operation that performs the matching transition (publish sets
// `publishedAt`, archive sets `archivedAt`); both are absent on a plain register
// response. ISO-8601 strings — the wire is JSON.
export class ProductView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public name: string;

  @ApiResponseProperty()
  public slug: string;

  @ApiResponseProperty()
  public description: string;

  @ApiResponseProperty()
  public status: string;

  @ApiResponseProperty()
  public publishedAt?: string;

  @ApiResponseProperty()
  public archivedAt?: string;

  // Populated ONLY by the publish operation, and only when a recommended
  // (non-blocking) precondition is unmet — today, the "≥1 active media asset"
  // recommendation (`CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA`). Like
  // `publishedAt`/`archivedAt`, absent unless the producing transition sets it.
  // Absent means `undefined`, NEVER an empty `[]` — a present-but-empty array
  // would falsely read as "warnings were checked and there were none" on a
  // register/archive response that never ran the publish probe (ADR-029 §7).
  @ApiResponseProperty()
  public warnings?: PublishWarningView[];
}
