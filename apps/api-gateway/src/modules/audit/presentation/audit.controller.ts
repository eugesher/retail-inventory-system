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
    if (targetCorrelationId.trim() === '') {
      throw new BadRequestException('correlationId must not be empty');
    }

    return this.traceByCorrelationUseCase.execute({ targetCorrelationId }, correlationId);
  }
}
