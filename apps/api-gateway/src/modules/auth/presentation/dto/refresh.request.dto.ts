import { ApiProperty } from '@nestjs/swagger';
import { IsJWT, IsString } from 'class-validator';

export class RefreshRequestDto {
  @ApiProperty({ description: 'Refresh JWT issued by /auth/staff/login or /auth/customer/login' })
  @IsString()
  @IsJWT()
  public refreshToken: string;
}
