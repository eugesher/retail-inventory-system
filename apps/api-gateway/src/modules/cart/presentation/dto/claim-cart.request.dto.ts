import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

// Request body for `POST /api/cart/:cartId/claim`. `fromCustomerId` is the guest
// customer id the client received from the guest-session response — knowing it is
// the ownership proof that the caller owned the guest session (Q1/Q7). The
// registered customer (`newCustomerId`) is never sent — it is taken from
// `@CurrentUser().id`.
export class ClaimCartRequestDto {
  @ApiProperty({
    example: '00000000-0000-4000-a000-0000000000aa',
    description: 'The guest customer id that currently owns the cart (the ownership proof)',
  })
  @IsUUID()
  public fromCustomerId: string;
}
