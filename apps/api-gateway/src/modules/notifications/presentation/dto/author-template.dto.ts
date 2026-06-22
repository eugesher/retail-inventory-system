import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

// Request body for `POST /api/notifications/templates`. The notification domain has
// the final say (it derives the version, enforces the channel-specific subject rule,
// and rejects a duplicate version); these decorators are the gateway's edge guard so
// a malformed request fails fast with a 400 before an RPC is dispatched.
//
// `locale` is defaulted to `en-US` **at the edge** (the property initializer) — the
// notification consumers omit locale so the render-and-dispatch pipeline defaults the
// same value, keeping authored templates resolvable for the canonical `en-US` locale.
export class AuthorTemplateRequestDto {
  @ApiProperty({
    example: 'retail.order.placed',
    description: 'The event type the template renders for (the routing-key string)',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  public eventType: string;

  @ApiProperty({
    enum: NotificationChannelEnum,
    example: NotificationChannelEnum.EMAIL,
    description: 'The business channel the customer is reached over',
  })
  @IsEnum(NotificationChannelEnum)
  public channel: NotificationChannelEnum;

  @ApiPropertyOptional({
    example: 'en-US',
    default: 'en-US',
    description: 'The template locale; defaults to en-US when omitted',
    maxLength: 10,
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  public locale = 'en-US';

  @ApiPropertyOptional({
    example: 'Your order {{orderId}} is confirmed',
    description: 'Subject line — required for email/webhook, optional for sms/push',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public subject?: string;

  @ApiProperty({
    example: 'Hi! Order {{orderId}} totalling {{grandTotalMinor}} was placed.',
    description: 'The Handlebars template body (rendered against the event context)',
  })
  @IsString()
  @IsNotEmpty()
  public body: string;
}
