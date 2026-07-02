import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

// Request body for `POST /api/orders/:orderId/fulfillments/:fulfillmentId/ship`. Both
// fields are optional on the wire, but the retail use case **requires a
// `trackingNumber`** to mark a fulfillment shipped (the tracking-on-ship policy — a
// missing one is a 400 `FULFILLMENT_TRACKING_REQUIRED`). `carrier` is free-text
// shipment metadata. The `Idempotency-Key` is read from the header (not the body) — it is
// **required and deduped** (ADR-036, via the `@IdempotencyKey()` decorator): same key +
// same body replays the stored ship, a different body is 422, a missing key is 400 (a
// non-`pending` re-ship under a NEW key is still a 409).
export class ShipFulfillmentRequestDto {
  @ApiPropertyOptional({
    example: '1Z999AA10123456784',
    description: 'Carrier tracking number; required to mark the fulfillment shipped',
  })
  @IsOptional()
  @IsString()
  public trackingNumber?: string;

  @ApiPropertyOptional({ example: 'UPS', description: 'Shipping carrier name' })
  @IsOptional()
  @IsString()
  public carrier?: string;
}
