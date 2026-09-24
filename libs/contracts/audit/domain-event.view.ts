import { ApiResponseProperty } from '@nestjs/swagger';

export class DomainEventView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public eventType: string;

  @ApiResponseProperty()
  public aggregateType: string;

  @ApiResponseProperty()
  public aggregateId: string;

  @ApiResponseProperty({ type: Object })
  public payload: Record<string, unknown>;

  @ApiResponseProperty()
  public eventVersion: string;

  @ApiResponseProperty()
  public producer: string;

  @ApiResponseProperty()
  public correlationId: string | null;

  @ApiResponseProperty()
  public occurredAt: string;
}
