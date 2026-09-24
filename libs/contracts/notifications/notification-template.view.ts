import { ApiResponseProperty } from '@nestjs/swagger';

import { NotificationChannelEnum } from './enums';

export class NotificationTemplateView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public eventType: string;

  @ApiResponseProperty()
  public channel: NotificationChannelEnum;

  @ApiResponseProperty()
  public locale: string;

  @ApiResponseProperty()
  public subject: string | null;

  @ApiResponseProperty()
  public body: string;

  @ApiResponseProperty()
  public version: number;

  @ApiResponseProperty()
  public active: boolean;

  @ApiResponseProperty()
  public createdAt: string | null;

  @ApiResponseProperty()
  public updatedAt: string | null;
}
