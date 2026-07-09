import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';

import { RequiresPermission } from '@retail-inventory-system/auth';
import {
  AuditLogEntryView,
  DomainEventView,
  ICorrelationTraceResult,
  IPage,
  PermissionCodeEnum,
} from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import {
  QueryEntriesUseCase,
  QueryEventsUseCase,
  TraceByCorrelationUseCase,
} from '../application/use-cases';
import { EntriesQueryDto, EventsQueryDto } from './dto';

// HTTP surface over the event store's three `audit.*` query RPCs (ADR-009 / ADR-039).
// The gateway holds no audit state of its own — each method is a thin port→adapter pass
// to `event_store_query_queue`, and this module has no `domain/`.
//
// Every route is **staff-only** by construction (ADR-024): each carries
// `@RequiresPermission(PermissionCodeEnum.AUDIT_READ)`, and a customer JWT carries no
// `permissions` claim, so a code-gated route needs no owner-check and has no customer
// path to design. `audit:read` was minted with the RBAC v2 work and seeded onto `admin`;
// this is the first capability that gates on it. A `warehouse-staff` token gets a `403`.
//
// Three operator questions, three routes:
//   - "what did the system do"       → GET /audit/events
//   - "what did a person do"         → GET /audit/entries
//   - "what did this request cause"  → GET /audit/trace/:correlationId
//
// EMPTY IS NOT MISSING. Both lists answer an unmatched filter set with a `200` empty
// page, and the trace answers an unknown correlation id with `200 { events: [],
// auditEntries: [] }`. There is no `404` anywhere in this controller: the absence of a
// trace is not the absence of a resource.
//
// Neither list caps `pageSize` here. The 100-row ceiling (and the `page`→1 /
// `pageSize`→20 defaults) live in the event store's use case, in one place, so a direct
// RPC caller inherits them too.
@ApiTags('Audit')
@Controller('audit')
export class AuditController {
  constructor(
    private readonly queryEventsUseCase: QueryEventsUseCase,
    private readonly queryEntriesUseCase: QueryEntriesUseCase,
    private readonly traceByCorrelationUseCase: TraceByCorrelationUseCase,
  ) {}

  @Get('events')
  @RequiresPermission(PermissionCodeEnum.AUDIT_READ)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Query the domain-event firehose log (staff, audit:read)',
  })
  // A paginated, NEWEST-FIRST page of `domain_event`. Every filter is optional and
  // narrows the scan; an unmatched filter set is a 200 empty page. `payload` is
  // returned verbatim but is NOT searchable — the filters name indexed columns only.
  @ApiExtraModels(DomainEventView)
  @ApiOkResponse({
    description: 'A paginated, newest-first page of captured domain events',
    schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: getSchemaPath(DomainEventView) } },
        total: { type: 'number' },
        page: { type: 'number' },
        size: { type: 'number' },
      },
    },
  })
  @ApiProduces('application/json')
  public async queryEvents(
    @Query() query: EventsQueryDto,
    @CorrelationId() correlationId: string,
  ): Promise<IPage<DomainEventView>> {
    // `query.correlationId` is a FILTER VALUE — the id being searched for. The
    // `correlationId` argument is this request's own trace id. They ride different
    // fields of the wire payload and must never be folded together.
    return this.queryEventsUseCase.execute(
      {
        filters: {
          eventType: query.eventType,
          aggregateType: query.aggregateType,
          aggregateId: query.aggregateId,
          correlationId: query.correlationId,
          from: query.from,
          to: query.to,
        },
        // Forwarded verbatim, `undefined` included: the event store clamps the window.
        page: query.page,
        pageSize: query.pageSize,
      },
      correlationId,
    );
  }

  @Get('entries')
  @RequiresPermission(PermissionCodeEnum.AUDIT_READ)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Query the staff audit-log trail (staff, audit:read)',
  })
  // A paginated, NEWEST-FIRST page of `audit_log_entry`. `action` takes an event-name
  // string (`StaffUserRolesAssigned`), never a permission code (ADR-035). The `before`
  // / `after` JSON snapshots are returned verbatim but are NOT searchable.
  @ApiExtraModels(AuditLogEntryView)
  @ApiOkResponse({
    description: 'A paginated, newest-first page of staff audit-log rows',
    schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: getSchemaPath(AuditLogEntryView) } },
        total: { type: 'number' },
        page: { type: 'number' },
        size: { type: 'number' },
      },
    },
  })
  @ApiProduces('application/json')
  public async queryEntries(
    @Query() query: EntriesQueryDto,
    @CorrelationId() correlationId: string,
  ): Promise<IPage<AuditLogEntryView>> {
    return this.queryEntriesUseCase.execute(
      {
        filters: {
          actorId: query.actorId,
          entityType: query.entityType,
          entityId: query.entityId,
          action: query.action,
          correlationId: query.correlationId,
          from: query.from,
          to: query.to,
        },
        page: query.page,
        pageSize: query.pageSize,
      },
      correlationId,
    );
  }

  @Get('trace/:correlationId')
  @RequiresPermission(PermissionCodeEnum.AUDIT_READ)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Trace one request across both event-store logs (staff, audit:read)',
  })
  @ApiParam({
    name: 'correlationId',
    type: String,
    example: 'a3f1c9b6-4d2a-4f8e-9c1b-2a7d6e5f0a11',
  })
  // Two independently-ordered timelines, both reading FORWARD (occurredAt ascending),
  // never merged into one stream: they answer different questions and their ids live in
  // different spaces. Unpaginated — a correlation id scopes one bounded causal chain.
  // An unknown id is a 200 with two empty arrays, never a 404.
  @ApiExtraModels(DomainEventView, AuditLogEntryView)
  @ApiOkResponse({
    description: 'Both event-store logs for one correlation id, each oldest-first',
    schema: {
      type: 'object',
      properties: {
        events: { type: 'array', items: { $ref: getSchemaPath(DomainEventView) } },
        auditEntries: { type: 'array', items: { $ref: getSchemaPath(AuditLogEntryView) } },
      },
    },
  })
  @ApiProduces('application/json')
  public async traceByCorrelation(
    @Param('correlationId') targetCorrelationId: string,
    @CorrelationId() correlationId: string,
  ): Promise<ICorrelationTraceResult> {
    // A bare `/audit/trace/` matches no route at all (Nest answers 404), but a
    // whitespace-only segment reaches here. Reject it: `domain_event.correlation_id` is
    // `NOT NULL DEFAULT ''`, so an empty target would ask for the bucket of every event
    // ingested WITHOUT a correlation id rather than for nothing (ADR-039 §6).
    if (targetCorrelationId.trim() === '') {
      throw new BadRequestException('correlationId must not be empty');
    }

    return this.traceByCorrelationUseCase.execute({ targetCorrelationId }, correlationId);
  }
}
