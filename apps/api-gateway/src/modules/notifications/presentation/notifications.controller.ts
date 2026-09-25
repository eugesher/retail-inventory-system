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

import { randomUUID } from 'node:crypto';

import { RequiresPermission } from '@retail-inventory-system/auth';
import {
  IPage,
  NotificationDeliveryView,
  NotificationTemplateView,
  PermissionCodeEnum,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';
import { CorrelationId } from '@retail-inventory-system/observability';

import { MarketingSendResult } from '../application/ports';
import {
  AuthorTemplateUseCase,
  GetDeliveryUseCase,
  ListDeliveriesUseCase,
  ListTemplatesUseCase,
  RetryDeliveryUseCase,
  SendMarketingUseCase,
  SetTemplateActiveUseCase,
} from '../application/use-cases';
import {
  AuthorTemplateRequestDto,
  DeliveriesQueryDto,
  SendMarketingRequestDto,
  SetTemplateActiveRequestDto,
  TemplatesQueryDto,
} from './dto';

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
    private readonly sendMarketingUseCase: SendMarketingUseCase,
  ) {}

  @Get('templates')
  @RequiresPermission(PermissionCodeEnum.NOTIFICATIONS_WRITE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List notification templates (staff, notifications:write)',
  })
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

  @Post('marketing/send')
  @RequiresPermission(PermissionCodeEnum.NOTIFICATIONS_WRITE)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a marketing notification to a customer (staff, notifications:write)',
  })
  @ApiOkResponse({
    description:
      'The resulting delivery row (sent or skipped-no-consent); empty when no marketing template resolves',
    type: NotificationDeliveryView,
  })
  @ApiProduces('application/json')
  public async sendMarketing(
    @Body() dto: SendMarketingRequestDto,
    @CorrelationId() correlationId: string,
  ): Promise<MarketingSendResult> {
    return this.sendMarketingUseCase.execute(
      {
        customerId: dto.customerId,
        customerEmail: dto.customerEmail,
        eventType: dto.eventType ?? ROUTING_KEYS.MARKETING_EMAIL_PROMO,
        campaignId: dto.campaignId ?? randomUUID(),
        context: dto.context ?? {},
      },
      correlationId,
    );
  }
}
