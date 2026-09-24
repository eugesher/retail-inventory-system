import { ApiResponseProperty } from '@nestjs/swagger';

export const CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA = 'CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA';

export class PublishWarningView {
  @ApiResponseProperty()
  public code: string;

  @ApiResponseProperty()
  public message: string;
}
