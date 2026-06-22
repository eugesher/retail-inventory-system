import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { NotificationDeliveryStatusEnum } from '@retail-inventory-system/contracts';

// Query string for `GET /api/notifications/deliveries` — the audit read of the
// `notification_delivery` trail. Every filter is optional and narrows the scan.
//
// `page` / `pageSize` arrive as strings and are coerced via `@Type(() => Number)`
// (the global `ValidationPipe` runs with `transform: true`); the controller defaults
// them at the edge (`page`→1, `pageSize`→20). The page-size ceiling is enforced here
// with `@Max(100)` (the inventory movements-query precedent). The wire payload's page
// length field is `pageSize`, so — unlike the movements read — no rename to `size` is
// needed; the controller forwards both verbatim.
export class DeliveriesQueryDto {
  @ApiPropertyOptional({
    example: 'a3f1c9b6-4d2a-4f8e-9c1b-2a7d6e5f0a11',
    description: 'Filter to one recipient customer (maps onto recipient_customer_id)',
    maxLength: 36,
  })
  @IsOptional()
  @IsString()
  @MaxLength(36)
  public customerId?: string;

  @ApiPropertyOptional({
    example: 'order',
    description: 'Filter to one business-event type (order / return-request / fulfillment / …)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public eventReferenceType?: string;

  @ApiPropertyOptional({
    example: '42',
    description: 'Filter to one business-event id (paired with eventReferenceType)',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  public eventReferenceId?: string;

  @ApiPropertyOptional({
    enum: NotificationDeliveryStatusEnum,
    description: 'Filter to one delivery lifecycle state',
  })
  @IsOptional()
  @IsEnum(NotificationDeliveryStatusEnum)
  public status?: NotificationDeliveryStatusEnum;

  @ApiPropertyOptional({ example: 1, minimum: 1, description: '1-based page index' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @ApiPropertyOptional({
    example: 20,
    minimum: 1,
    maximum: 100,
    description: 'Page size (max 100)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public pageSize?: number;
}
