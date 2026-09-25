import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ClaimCartRequestDto {
  @ApiProperty({
    example: '00000000-0000-4000-a000-0000000000aa',
    description: 'The guest customer id that currently owns the cart (the ownership proof)',
  })
  @IsUUID()
  public fromCustomerId: string;
}
