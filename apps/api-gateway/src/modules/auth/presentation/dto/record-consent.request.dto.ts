import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

// The `PUT /api/auth/customer/me/consent` body. Every field is optional — the
// write is an upsert-merge, so a caller sends only the preferences they are
// changing (the omitted ones keep their current value). `dataRetentionPolicy` is a
// free-form label bounded to a sane length; the channel fields are booleans.
export class RecordConsentRequestDto {
  @ApiPropertyOptional({ example: true, description: 'Consent to transactional email' })
  @IsOptional()
  @IsBoolean()
  public transactionalEmail?: boolean;

  @ApiPropertyOptional({ example: false, description: 'Consent to marketing email' })
  @IsOptional()
  @IsBoolean()
  public marketingEmail?: boolean;

  @ApiPropertyOptional({ example: false, description: 'Consent to marketing SMS' })
  @IsOptional()
  @IsBoolean()
  public marketingSms?: boolean;

  @ApiPropertyOptional({ example: 'default-7-years', description: 'Data-retention policy label' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public dataRetentionPolicy?: string;
}
