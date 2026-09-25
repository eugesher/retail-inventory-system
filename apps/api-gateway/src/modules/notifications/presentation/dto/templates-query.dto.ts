import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

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
