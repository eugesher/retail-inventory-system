import { ApiResponseProperty } from '@nestjs/swagger';

import { NotificationChannelEnum } from './enums';

// One versioned entry in the per-`(eventType, channel, locale)` registry.
//
// **`version` is the BUSINESS version, not an OCC token.** It climbs on every edit and old
// versions are kept for audit and rollback — it has nothing to do with the `@VersionColumn` that
// guards concurrent writes elsewhere in this repo. Two different things wear the same name; do
// not compare-and-swap on this one.
//
// `active` is the soft-delete flag: a deactivated template drops out of the "find latest active"
// resolution but stays on the row — there is no `deletedAt` here. `subject` is `null` for sms and
// push, which carry none.
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
