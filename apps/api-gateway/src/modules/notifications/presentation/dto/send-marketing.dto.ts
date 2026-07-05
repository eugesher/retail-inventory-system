import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

// Request body for `POST /api/notifications/marketing/send` (staff, notifications:write,
// ADR-037). The operator names a customer + supplies the recipient email; the gateway
// resolves the marketing `eventType` default and mints the per-request `campaignId`
// before dispatching the RPC. The notification service's consent-gate then decides send
// vs `skipped-no-consent` — the endpoint itself never inspects consent.
//
// `customerEmail` is a documented operator input rather than a server-side lookup of the
// gateway `auth` module's `customer` table: reading that table from the notifications
// gateway module would cross a module boundary for no functional gain here, so the
// simpler, boundary-clean shape carries the email on the request (ADR-037).
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
