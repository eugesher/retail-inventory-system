import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

import { IsOnOrAfter } from './is-on-or-after.validator';

export class EventsQueryDto {
  @ApiPropertyOptional({
    example: 'retail.order.placed',
    description: 'Filter to one full dotted routing key',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  public eventType?: string;

  @ApiPropertyOptional({
    example: 'order',
    description: 'Filter to one aggregate kind — the second token of the routing key',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  public aggregateType?: string;

  @ApiPropertyOptional({
    example: '42',
    description: 'Filter to one aggregate instance (paired with aggregateType)',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  public aggregateId?: string;

  @ApiPropertyOptional({
    example: 'a3f1c9b6-4d2a-4f8e-9c1b-2a7d6e5f0a11',
    description: 'Filter to the events one request produced (the id searched FOR)',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  public correlationId?: string;

  @ApiPropertyOptional({
    example: '2026-06-01T00:00:00.000Z',
    description: 'Inclusive lower bound on occurredAt (ISO-8601)',
  })
  @IsOptional()
  @IsISO8601()
  public from?: string;

  @ApiPropertyOptional({
    example: '2026-06-30T23:59:59.999Z',
    description: 'Inclusive upper bound on occurredAt (ISO-8601); must not precede `from`',
  })
  @IsOptional()
  @IsISO8601()
  @IsOnOrAfter('from')
  public to?: string;

  @ApiPropertyOptional({
    example: 1,
    minimum: 1,
    description: '1-based page index (defaults to 1)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @ApiPropertyOptional({
    example: 20,
    minimum: 1,
    description: 'Page size (defaults to 20; the event store caps it at 100)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public pageSize?: number;
}
