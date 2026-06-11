import { ApiResponseProperty } from '@nestjs/swagger';

// The greppable, assertable code for the "a published product should have ≥1
// active media asset" recommendation. It is a plain exported constant, NOT a
// member of `CatalogErrorCodeEnum`: nothing ever throws it and no HTTP status
// maps it — it is a soft warning carried in a successful (`200`/`201`) publish
// response, never an error. Folding a non-error into the error-code enum would
// poison the `CatalogRpcExceptionFilter`'s total `Record` (every enum member
// must map to a status). Keeping it here, next to the view it rides in, makes
// the live string the single source of truth a storefront/operator asserts on.
export const CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA = 'CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA';

// One soft warning attached to a publish response (`ProductView.warnings`). A
// structured `{ code, message }` pair rather than a bare string: `code` is the
// stable, machine-checkable discriminant (a UI can branch on it, a test can
// assert it — the `{ statusCode, message, code }` error-shape precedent), while
// `message` is the human-displayable sentence. A warning NEVER blocks the
// operation that produced it — it informs (ADR-029 §7).
export class PublishWarningView {
  @ApiResponseProperty()
  public code: string;

  @ApiResponseProperty()
  public message: string;
}
