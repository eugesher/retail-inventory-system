import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

// Query string for `GET /api/notifications/templates` — the registry browse. Every
// parameter is optional and narrows the scan; omitting all of them lists every
// template version (active or not). The registry is small and staff-facing, so the
// read is unpaginated.
export class TemplatesQueryDto {
  @ApiPropertyOptional({
    example: 'retail.order.placed',
    description: 'Filter to one event type (the routing-key string)',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  public eventType?: string;

  @ApiPropertyOptional({
    enum: NotificationChannelEnum,
    description: 'Filter to one business channel',
  })
  @IsOptional()
  @IsEnum(NotificationChannelEnum)
  public channel?: NotificationChannelEnum;

  @ApiPropertyOptional({
    example: 'en-US',
    description: 'Filter to one locale',
    maxLength: 35,
  })
  @IsOptional()
  @IsString()
  @MaxLength(35)
  public locale?: string;
}
