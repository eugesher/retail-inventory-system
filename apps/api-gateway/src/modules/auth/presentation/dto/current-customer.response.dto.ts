import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CurrentCustomerResponseDto {
  @ApiProperty()
  public id: string;

  @ApiProperty()
  public email: string;

  @ApiProperty({ enum: ['active', 'suspended', 'guest', 'deleted'] })
  public status: 'active' | 'suspended' | 'guest' | 'deleted';

  @ApiPropertyOptional({ nullable: true })
  public firstName: string | null;

  @ApiPropertyOptional({ nullable: true })
  public lastName: string | null;

  @ApiPropertyOptional({ nullable: true })
  public phone: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  public emailVerifiedAt: string | null;
}
