import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginRequestDto {
  @ApiProperty({ example: 'customer@example.com' })
  @IsEmail()
  @MaxLength(255)
  public email: string;

  @ApiProperty({ example: 'customer1234' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public password: string;
}
