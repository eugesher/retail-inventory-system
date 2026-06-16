import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

// Request body for `POST /api/orders/:orderId/fulfillments/:fulfillmentId/ship`. Both
// fields are optional on the wire, but the retail use case **requires a
// `trackingNumber`** to mark a fulfillment shipped (the tracking-on-ship policy — a
// missing one is a 400 `FULFILLMENT_TRACKING_REQUIRED`). `carrier` is free-text
// shipment metadata. The `Idempotency-Key` is read from the header (not the body) —
// accepted + logged but not deduped (a non-`pending` re-ship is a 409).
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
