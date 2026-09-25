import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';

export class EraseCustomerRequestDto {
  @ApiProperty({
    example: 'buyer@example.com',
    description: 'The customer’s current email, retyped to confirm the erase',
  })
  @IsString()
  @IsEmail()
  public confirmEmail: string;
}
