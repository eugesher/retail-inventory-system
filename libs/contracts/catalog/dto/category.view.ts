import { ApiResponseProperty } from '@nestjs/swagger';

// RPC response shape for the category write operations (`catalog.category.create`
// / `catalog.category.reparent`) — the persisted category after the operation.
//
// `parentId` is `null` for a root category (a top-level node with no parent).
// `path` is the materialized root-to-self slug chain (`/electronics/phones`) the
// hierarchy is built on. `status` is the lifecycle string (`active`/`archived`);
// the catalog domain owns the `CategoryStatusEnum`, so the wire carries its raw
// value rather than coupling transport to an internal domain enum (ADR-025).
//
// `@ApiResponseProperty` (the documented lib-contracts Swagger exception, the
// same `ProductView` uses) keeps the contract self-describing in the gateway's
// OpenAPI without pulling request-validation decorators onto a response shape.
export class CategoryView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public name: string;

  @ApiResponseProperty()
  public slug: string;

  @ApiResponseProperty()
  public parentId: number | null;

  @ApiResponseProperty()
  public path: string;

  @ApiResponseProperty()
  public sortOrder: number;

  @ApiResponseProperty()
  public status: string;
}
