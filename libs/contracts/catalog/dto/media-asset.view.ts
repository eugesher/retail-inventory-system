import { ApiResponseProperty } from '@nestjs/swagger';

import { MediaAssetTypeEnum, MediaOwnerTypeEnum } from '../enums';

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
