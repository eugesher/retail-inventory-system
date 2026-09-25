import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CancelOrderRequestDto {
  @ApiPropertyOptional({
    example: 'Customer changed their mind',
    description: 'Optional human-readable cancellation reason',
  })
  @IsOptional()
  @IsString()
  public reason?: string;
}
