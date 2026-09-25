import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

export class SweepReservationsRequestDto {
  @ApiPropertyOptional({
    example: 50,
    minimum: 1,
    description:
      'Rows to scan and expire in this invocation. Clamped by the inventory service to its configured RESERVATION_SWEEP_BATCH_SIZE ceiling; omit to use that ceiling.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  public batchSize?: number;
}
