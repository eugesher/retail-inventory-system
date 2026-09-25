import { ApiProperty } from '@nestjs/swagger';

import { TokenResponseDto } from './token.response.dto';

export class GuestSessionResponseDto extends TokenResponseDto {
  @ApiProperty({
    example: '00000000-0000-4000-a000-0000000000aa',
    description: 'The guest customer id this session was minted for',
  })
  public customerId: string;
}
