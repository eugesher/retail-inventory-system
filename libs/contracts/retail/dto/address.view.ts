import { ApiResponseProperty } from '@nestjs/swagger';

import { AddressOwnerTypeEnum } from '../enums';

// RPC/HTTP response shape for an address. A **class** carrying `@ApiResponseProperty`
// (the documented lib-contracts Swagger exception, ADR-017), mirroring the order
// and cart views.
//
// `ownerType` + `ownerId` are the polymorphic discriminator (ADR-028 §5): an
// address belongs either to a `customer` (a future address-book entry) or to an
// `order` (a place-time snapshot). For an order address `ownerId` is the order's
// id; the row is an **immutable copy**, not a reference into a customer address
// book. `country` is a 2-char upper-case ISO code; `line2` and `phone` are
// optional. `id` is the address's CHAR(36) UUID.
export class AddressView {
  @ApiResponseProperty()
  public id: string;

  @ApiResponseProperty()
  public ownerType: AddressOwnerTypeEnum;

  @ApiResponseProperty()
  public ownerId: string;

  @ApiResponseProperty()
  public recipientName: string;

  @ApiResponseProperty()
  public line1: string;

  @ApiResponseProperty()
  public line2: string | null;

  @ApiResponseProperty()
  public city: string;

  @ApiResponseProperty()
  public region: string;

  @ApiResponseProperty()
  public postalCode: string;

  @ApiResponseProperty()
  public country: string;

  @ApiResponseProperty()
  public phone: string | null;
}
