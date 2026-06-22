import { ApiResponseProperty } from '@nestjs/swagger';

import { NotificationChannelEnum } from './enums';

// RPC/HTTP response shape for one notification template — one versioned entry in the
// per `(eventType, channel, locale)` registry. A **class** carrying
// `@ApiResponseProperty` (not a plain interface) so the gateway can declare it as a
// Swagger response type — `@nestjs/swagger` is the documented lib-contracts exception
// (ADR-017), mirroring `ReturnRequestView` / `OrderView`.
//
// `version` is the **business** version (an INT that climbs on every edit — old
// versions are retained for audit/rollback), distinct from an OCC `@VersionColumn`.
// `active` is the soft-delete flag: a deactivated template is hidden from the "find
// latest active" resolution but kept on the row (never a `deletedAt` timestamp).
// `subject` is nullable — sms/push templates carry no subject.
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
