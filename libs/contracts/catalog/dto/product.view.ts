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

  // Populated ONLY by publish, and only when a recommended (non-blocking) precondition is unmet —
  // the sole one being "≥1 active media asset" (`CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA`).
  //
  // **Absent means `undefined`, NEVER an empty `[]`.** A present-but-empty array would read as
  // "we checked and there were none" on a register or archive response that never ran the publish
  // probe at all (ADR-029 §7). The two are different answers and the type must not blur them.
  @ApiResponseProperty()
  public warnings?: PublishWarningView[];
}
