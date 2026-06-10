import { ApiProperty } from '@nestjs/swagger';

import { TokenResponseDto } from './token.response.dto';

// Response for `POST /auth/customer/guest-session`. It is the standard token pair
// plus the freshly-minted guest `customerId` — the client keeps it so it can
// later present it as the `fromCustomerId` ownership proof when claiming the
// guest cart into a registered account (Q1/Q7).
export class GuestSessionResponseDto extends TokenResponseDto {
  @ApiProperty({
    example: '00000000-0000-4000-a000-0000000000aa',
    description: 'The guest customer id this session was minted for',
  })
  public customerId: string;
}
