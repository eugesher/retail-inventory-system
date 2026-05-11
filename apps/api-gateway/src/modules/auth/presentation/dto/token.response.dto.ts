import { ApiProperty } from '@nestjs/swagger';

export class TokenResponseDto {
  @ApiProperty()
  public accessToken: string;

  @ApiProperty()
  public refreshToken: string;

  @ApiProperty({ description: 'Access-token lifetime in seconds' })
  public expiresIn: number;
}
