import { ApiResponseProperty } from '@nestjs/swagger';

import { AddressOwnerTypeEnum } from '../enums';

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
