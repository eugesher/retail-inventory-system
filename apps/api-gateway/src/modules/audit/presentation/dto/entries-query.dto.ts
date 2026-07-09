import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

import { IsOnOrAfter } from './is-on-or-after.validator';

// Query string for `GET /api/audit/entries` — the operator read of the event store's
// append-only `audit_log_entry` staff trail. Every filter is optional and NARROWS the
// scan; an absent filter contributes no predicate, so a bare call lists the whole trail.
//
// `action` takes the stable EVENT-NAME string an audit row carries — `RefundIssued`,
// `StaffUserRolesAssigned` — never a permission code such as `iam:assign`. The ingest
// maps `action ← IAuditLogEvent.name` (ADR-035); a permission code matches nothing.
//
// `actorId` names a staff principal. Rows written with a null actor (a pre-auth failure,
// an unattributed background mutation) are matched by no value a caller can pass, since
// `audit_log_entry.actor_id` is nullable and `WHERE actor_id = ?` never matches a NULL.
// The same holds for `correlationId`, which is nullable here — unlike its `domain_event`
// sibling, this table has no dedupe key, so nothing forced the column non-null.
//
// The string filters are `@IsNotEmpty()`: an empty-string filter is a client bug.
// `from` / `to` bound `occurredAt` inclusively and are rejected here when transposed
// (`from > to` → 400) — the event store answers an inverted window with an empty page.
//
// `page` / `pageSize` are coerced via `@Type(() => Number)` and are neither defaulted nor
// capped here. The event store's use case clamps them (`page`→1, `pageSize`→20, ceiling
// 100) in one place, so every caller inherits the same bound (ADR-039).
//
// The response is `IPage<AuditLogEntryView>` — `{ items, total, page, size }`.
export class EntriesQueryDto {
  @ApiPropertyOptional({
    example: '00000000-0000-4000-a000-000000000001',
    description: 'Filter to one acting staff principal',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  public actorId?: string;

  @ApiPropertyOptional({
    example: 'staff_user',
    description: 'Filter to one audited entity kind',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  public entityType?: string;

  @ApiPropertyOptional({
    example: '00000000-0000-4000-a000-000000000003',
    description: 'Filter to one audited entity instance (paired with entityType)',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  public entityId?: string;

  @ApiPropertyOptional({
    example: 'StaffUserRolesAssigned',
    description: 'Filter to one event-name classifier — NOT a permission code',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  public action?: string;

  @ApiPropertyOptional({
    example: 'a3f1c9b6-4d2a-4f8e-9c1b-2a7d6e5f0a11',
    description: 'Filter to the audit rows one request produced (the id searched FOR)',
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
