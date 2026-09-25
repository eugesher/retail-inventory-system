import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class SendMarketingRequestDto {
  @ApiProperty({
    example: '11111111-1111-4111-8111-111111111111',
    description: 'The recipient customer id (the gateway CHAR(36) UUID)',
  })
  @IsUUID()
  public customerId: string;

  @ApiProperty({
    example: 'buyer@example.com',
    description: 'The recipient email address (operator-supplied)',
  })
  @IsEmail()
  public customerEmail: string;

  @ApiPropertyOptional({
    example: 'marketing.email.promo',
    description:
      'The marketing template eventType; defaults to marketing.email.promo when omitted. MUST NOT be a transactional event type.',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public eventType?: string;

  @ApiPropertyOptional({
    example: 'summer-sale-2026',
    description:
      'An optional campaign id used as the delivery reference; defaults to a fresh UUID per request so repeated sends are distinct rows.',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public campaignId?: string;

  @ApiPropertyOptional({
    example: { firstName: 'Ada', promoCode: 'SAVE20' },
    description: 'The Handlebars render context for the marketing template',
  })
  @IsOptional()
  @IsObject()
  public context?: Record<string, unknown>;
}
