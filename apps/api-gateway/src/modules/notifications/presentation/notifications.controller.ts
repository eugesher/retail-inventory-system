import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
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
  IPage,
  NotificationDeliveryView,
  NotificationTemplateView,
  PermissionCodeEnum,
} from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import {
  AuthorTemplateUseCase,
  GetDeliveryUseCase,
  ListDeliveriesUseCase,
  ListTemplatesUseCase,
  RetryDeliveryUseCase,
  SetTemplateActiveUseCase,
} from '../application/use-cases';
import {
  AuthorTemplateRequestDto,
  DeliveriesQueryDto,
  SetTemplateActiveRequestDto,
  TemplatesQueryDto,
} from './dto';

// HTTP surface over the notification microservice's template + delivery RPCs
// (ADR-009). The gateway holds no notification state of its own — each method is a
// thin port→adapter pass to `notification_events`.
//
// Every route is **staff-only** by construction (ADR-024): they are admin/ops tools
// (template authoring + the delivery audit trail + manual retry), not customer-facing,
// so each carries an explicit `@RequiresPermission` and there is **no owner-check**.
// `notifications:write` gates the authoring/rollback writes AND the template registry
// browse (a write-side admin read — you list to decide what to edit/roll back);
// `notifications:read` gates the delivery audit reads. Customer tokens carry no
// `permissions` claim, so a code-gated route is staff-only without any extra guard.
//
// The `notification.delivery.record-outcome` RPC (the ESP-webhook seam) has **no
// route here** — real webhook ingestion is future work, so it stays RMQ-only.
@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly authorTemplateUseCase: AuthorTemplateUseCase,
    private readonly setTemplateActiveUseCase: SetTemplateActiveUseCase,
    private readonly listTemplatesUseCase: ListTemplatesUseCase,
    private readonly listDeliveriesUseCase: ListDeliveriesUseCase,
    private readonly getDeliveryUseCase: GetDeliveryUseCase,
    private readonly retryDeliveryUseCase: RetryDeliveryUseCase,
  ) {}

  @Get('templates')
  @RequiresPermission(PermissionCodeEnum.NOTIFICATIONS_WRITE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List notification templates (staff, notifications:write)',
  })
  // Every version, active or not — the staff registry browse. The optional
  // eventType / channel / locale query narrows the scan.
  @ApiOkResponse({
    description: 'The matching notification templates (every version)',
    type: NotificationTemplateView,
    isArray: true,
  })
  @ApiProduces('application/json')
  public async listTemplates(
    @Query() query: TemplatesQueryDto,
    @CorrelationId() correlationId: string,
  ): Promise<NotificationTemplateView[]> {
    return this.listTemplatesUseCase.execute(
      { eventType: query.eventType, channel: query.channel, locale: query.locale },
      correlationId,
    );
  }

  @Post('templates')
  @RequiresPermission(PermissionCodeEnum.NOTIFICATIONS_WRITE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Author (create-or-edit) a template version (staff, notifications:write)',
  })
  // Create-or-edit keyed on (eventType, channel, locale): the notification service
  // appends a fresh active version. A subject-less email/webhook is a 400; a
  // duplicate version a 409 — both surfaced from the notification domain filter.
  @ApiCreatedResponse({
    description: 'The newly authored template version',
    type: NotificationTemplateView,
  })
  @ApiProduces('application/json')
  public async authorTemplate(
    @Body() dto: AuthorTemplateRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<NotificationTemplateView> {
    return this.authorTemplateUseCase.execute(
      {
        eventType: dto.eventType,
        channel: dto.channel,
        locale: dto.locale,
        subject: dto.subject,
        body: dto.body,
      },
      correlationId,
    );
  }

  @Patch('templates/:id/active')
  @RequiresPermission(PermissionCodeEnum.NOTIFICATIONS_WRITE)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Activate / deactivate a template version — the rollback lever (staff, notifications:write)',
  })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  // An unknown id is a 404 (NOTIFICATION_TEMPLATE_NOT_FOUND), surfaced from the
  // notification domain via its RPC exception filter → the gateway.
  @ApiOkResponse({
    description: 'The template version with its updated active flag',
    type: NotificationTemplateView,
  })
  @ApiProduces('application/json')
  public async setTemplateActive(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetTemplateActiveRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<NotificationTemplateView> {
    return this.setTemplateActiveUseCase.execute({ id, active: dto.active }, correlationId);
  }

  @Get('deliveries')
  @RequiresPermission(PermissionCodeEnum.NOTIFICATIONS_READ)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List the notification delivery audit trail (staff, notifications:read)',
  })
  // A paginated, NEWEST-FIRST page of the notification_delivery trail. The optional
  // filters narrow the scan; an empty match is a 200 empty page.
  @ApiExtraModels(NotificationDeliveryView)
  @ApiOkResponse({
    description: 'A paginated, newest-first page of notification delivery rows',
    schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: getSchemaPath(NotificationDeliveryView) } },
        total: { type: 'number' },
        page: { type: 'number' },
        size: { type: 'number' },
      },
    },
  })
  @ApiProduces('application/json')
  public async listDeliveries(
    @Query() query: DeliveriesQueryDto,
    @CorrelationId() correlationId: string,
  ): Promise<IPage<NotificationDeliveryView>> {
    // Defaults applied at the edge (`page`→1, `pageSize`→20); the DTO already
    // enforced the 1..100 bounds. The wire payload's page-length field is `pageSize`,
    // so both forward verbatim (no rename to `size`).
    return this.listDeliveriesUseCase.execute(
      {
        customerId: query.customerId,
        eventReferenceType: query.eventReferenceType,
        eventReferenceId: query.eventReferenceId,
        status: query.status,
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 20,
      },
      correlationId,
    );
  }

  @Get('deliveries/:id')
  @RequiresPermission(PermissionCodeEnum.NOTIFICATIONS_READ)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Read one delivery row (incl. renderedBody) (staff, notifications:read)',
  })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  // An unknown id is a 404 (NOTIFICATION_DELIVERY_NOT_FOUND).
  @ApiOkResponse({
    description: 'The full delivery row, including the materialized renderedBody',
    type: NotificationDeliveryView,
  })
  @ApiProduces('application/json')
  public async getDelivery(
    @Param('id', ParseIntPipe) id: number,
    @CorrelationId() correlationId: string,
  ): Promise<NotificationDeliveryView> {
    return this.getDeliveryUseCase.execute({ id }, correlationId);
  }

  @Post('deliveries/:id/retry')
  @RequiresPermission(PermissionCodeEnum.NOTIFICATIONS_WRITE)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manually retry a failed delivery — forces past backoff (staff, notifications:write)',
  })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  // Only a `failed` delivery is retryable: an unknown id is a 404, a non-`failed`
  // source a 409 (NOTIFICATION_DELIVERY_INVALID_STATUS_TRANSITION). No request body.
  @ApiOkResponse({
    description: 'The re-dispatched delivery row (sent or failed-again)',
    type: NotificationDeliveryView,
  })
  @ApiProduces('application/json')
  public async retryDelivery(
    @Param('id', ParseIntPipe) id: number,
    @CorrelationId() correlationId: string,
  ): Promise<NotificationDeliveryView> {
    return this.retryDeliveryUseCase.execute({ deliveryId: id }, correlationId);
  }
}
