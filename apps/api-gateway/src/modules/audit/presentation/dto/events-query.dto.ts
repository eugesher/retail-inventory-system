import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

import { IsOnOrAfter } from './is-on-or-after.validator';

// Query string for `GET /api/audit/events` — the operator read of the event store's
// append-only `domain_event` firehose log. Every filter is optional and NARROWS the
// scan; an absent filter contributes no predicate, so a bare call lists the whole log.
//
// The string filters are `@IsNotEmpty()`. An empty-string filter is a client bug, and on
// this table it is a dangerous one: `domain_event.correlation_id` is `NOT NULL DEFAULT
// ''`, so `?correlationId=` would silently match every row ingested WITHOUT a correlation
// id rather than none.
//
// `from` / `to` bound `occurredAt` inclusively and are rejected here when transposed
// (`from > to` → 400). The event store treats an inverted window as an empty result, so
// this DTO is the only place an operator's typo surfaces as an error rather than as a
// silently empty page.
//
// `page` / `pageSize` arrive as strings and are coerced via `@Type(() => Number)` (the
// global `ValidationPipe` runs with `transform: true`). There is deliberately NO ceiling
// on `pageSize` here: the event store's use case clamps it into `[1, 100]` with
// `clampPageWindow`, in one place, so every caller — including a direct RPC client that
// never passes through this gateway — inherits the same bound (ADR-039). A second copy
// would be a number that drifts. Neither is defaulted here either; the same clamp
// supplies `page`→1 / `pageSize`→20 downstream.
//
// The response is `IPage<DomainEventView>` — `{ items, total, page, size }`. The request
// asks for `pageSize` and the page answers with `size`, exactly as
// `GET /api/inventory/variants/:variantId/movements` already does.
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
