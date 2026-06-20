import { ApiResponseProperty } from '@nestjs/swagger';

import { NotificationChannelEnum, NotificationDeliveryStatusEnum } from './enums';

// RPC/HTTP response shape for one notification delivery — the queryable audit trail of
// one outgoing notification (the answer to "did we already send this, and how did it
// go?"). A **class** carrying `@ApiResponseProperty` (the documented lib-contracts
// Swagger exception, ADR-017), mirroring `ReturnRequestView` / `OrderView`.
//
// `templateId` points back at the template the body/subject were rendered from.
// `recipientCustomerId` is null for system/ops notifications (e.g. a low-stock alert
// to the ops mailbox); `recipientAddress` is the concrete email/phone/url the message
// went to. `eventReferenceType` / `eventReferenceId` link the delivery to the business
// event that triggered it (`order`/`return-request`/`stock-low`/`fulfillment`/`refund`).
// `status` is the lifecycle axis; `attemptCount` is monotonic (climbs on each
// send/fail); `failureReason` carries the last error; `renderedSubject` (nullable) /
// `renderedBody` are the materialized content; `correlationId` ties it to the trace.
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
