import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterCustomerRequestDto {
  @ApiProperty({ example: 'buyer@example.com' })
  @IsEmail()
  @MaxLength(255)
  public email: string;

  @ApiProperty({ example: 'buyer1234' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public password: string;

  @ApiPropertyOptional({ example: 'Buyer' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  public firstName?: string;

  @ApiPropertyOptional({ example: 'McShop' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  public lastName?: string;

  @ApiPropertyOptional({ example: '+15555550123' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  public phone?: string;
}
