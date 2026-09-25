import { ApiResponseProperty } from '@nestjs/swagger';

import { PublishWarningView } from './publish-warning.view';

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

  @ApiResponseProperty()
  public warnings?: PublishWarningView[];
}
