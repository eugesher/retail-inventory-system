import { ApiProperty } from '@nestjs/swagger';
import { IsJWT, IsString } from 'class-validator';

export class RefreshRequestDto {
  @ApiProperty({ description: 'Refresh JWT issued by /auth/login' })
  @IsString()
  @IsJWT()
  public refreshToken: string;
}
