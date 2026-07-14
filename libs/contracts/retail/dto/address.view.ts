import { ApiResponseProperty } from '@nestjs/swagger';

import { AddressOwnerTypeEnum } from '../enums';

// `ownerType` + `ownerId` are a polymorphic discriminator (ADR-028 §5). The type admits `customer`
// as well as `order`, but **nothing writes a `customer`-owned address** — there is no address book
// in this system, and every row you will see is an `order` one.
//
// An order's address is an **immutable copy** taken at place-time, not a reference into anything.
// Editing a customer's details later cannot rewrite where a past order shipped, which is the whole
// point of copying it. `country` is a 2-char upper-case ISO code.
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
