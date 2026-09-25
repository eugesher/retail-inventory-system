import { ApiResponseProperty } from '@nestjs/swagger';

import { NotificationChannelEnum, NotificationDeliveryStatusEnum } from './enums';

export class NotificationDeliveryView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public templateId: number;

  @ApiResponseProperty()
  public recipientCustomerId: string | null;

  @ApiResponseProperty()
  public recipientAddress: string;

  @ApiResponseProperty()
  public channel: NotificationChannelEnum;

  @ApiResponseProperty()
  public eventReferenceType: string;

  @ApiResponseProperty()
  public eventReferenceId: string;

  @ApiResponseProperty()
  public status: NotificationDeliveryStatusEnum;

  @ApiResponseProperty()
  public attemptCount: number;

  @ApiResponseProperty()
  public lastAttemptAt: string | null;

  @ApiResponseProperty()
  public failureReason: string | null;

  @ApiResponseProperty()
  public renderedSubject: string | null;

  @ApiResponseProperty()
  public renderedBody: string;

  @ApiResponseProperty()
  public correlationId: string;

  @ApiResponseProperty()
  public createdAt: string | null;

  @ApiResponseProperty()
  public updatedAt: string | null;
}
