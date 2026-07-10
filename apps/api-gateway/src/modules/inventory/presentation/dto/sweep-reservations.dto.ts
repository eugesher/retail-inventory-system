import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

// Request body for `POST /api/inventory/reservations/sweep`. Both the body and its
// single field are optional — an empty body sweeps up to the service's configured
// ceiling.
//
// There is deliberately **no** upper bound here. `RESERVATION_SWEEP_BATCH_SIZE` is an
// operational property of the inventory service, which clamps the request into
// `[1, ceiling]`; a maximum hardcoded at the gateway would drift from it the first
// time an operator retunes the service. So the edge guard rejects only what is
// *shape*-wrong — a non-integer or a value below 1 is a `400` — and lets a `10_000`
// through for the service to clamp.
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
