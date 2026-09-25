import { ApiResponseProperty } from '@nestjs/swagger';

export class AuditLogEntryView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public actorId: string | null;

  @ApiResponseProperty()
  public actorType: 'staff-user' | 'system';

  @ApiResponseProperty()
  public action: string;

  @ApiResponseProperty()
  public entityType: string | null;

  @ApiResponseProperty()
  public entityId: string | null;

  @ApiResponseProperty({ type: Object })
  public before: Record<string, unknown> | null;

  @ApiResponseProperty({ type: Object })
  public after: Record<string, unknown> | null;

  @ApiResponseProperty()
  public occurredAt: string;

  @ApiResponseProperty()
  public ipAddress: string | null;

  @ApiResponseProperty()
  public correlationId: string | null;
}
