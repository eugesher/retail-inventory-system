import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

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
