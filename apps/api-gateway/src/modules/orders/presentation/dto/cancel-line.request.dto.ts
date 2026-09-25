import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

export class CancelLineRequestDto {
  @ApiPropertyOptional({
    example: 1,
    minimum: 1,
    description: 'Units to cancel; defaults to all the line remaining unshipped quantity',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  public quantity?: number;
}
