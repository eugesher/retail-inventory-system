import { ApiResponseProperty } from '@nestjs/swagger';

// RPC response shape for `catalog.product.register` — the persisted product
// after registration. `status` is the lifecycle string (`draft`/`active`/
// `archived`); the catalog domain owns the enum, so the wire carries its raw
// value rather than coupling transport to an internal domain enum (ADR-025).
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
}
