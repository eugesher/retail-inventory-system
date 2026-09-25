import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Post, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Response } from 'express';

import { CurrentUser, RequiresPermission } from '@retail-inventory-system/auth';
import { ICurrentUser, PermissionCodeEnum, RefundView } from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import { IdempotencyKey } from '../../../common/decorators';
import { IssueRefundUseCase, ListRefundsUseCase } from '../application/use-cases';
import { IssueRefundRequestDto } from './dto';

@ApiTags('Refund')
@ApiBearerAuth()
@Controller('orders')
export class RefundsController {
  constructor(
    private readonly issueRefundUseCase: IssueRefundUseCase,
    private readonly listRefundsUseCase: ListRefundsUseCase,
  ) {}

  @Post(':orderId/refunds')
  @RequiresPermission(PermissionCodeEnum.ORDER_REFUND)
  @ApiOperation({
    summary: 'Issue a refund against an order captured payment (staff order:refund)',
  })
  @ApiParam({ name: 'orderId', type: Number, example: 1 })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Required (ADR-036). Same key + same body replays the stored refund (200 + Idempotent-Replay: true); same key + different body → 422; a missing key → 400.',
  })
  @ApiCreatedResponse({ description: 'The issued (or failed) refund', type: RefundView })
  @ApiOkResponse({
    description:
      'A replayed refund (same Idempotency-Key + body) — carries Idempotent-Replay: true',
    type: RefundView,
  })
  @ApiProduces('application/json')
  public async issueRefund(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: IssueRefundRequestDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.issueRefundUseCase.execute(
      orderId,
      user,
      {
        paymentId: dto.paymentId,
        amountMinor: dto.amountMinor,
        reason: dto.reason,
        idempotencyKey,
      },
      correlationId,
    );

    if (result.replayed) {
      res.setHeader('Idempotent-Replay', 'true');
    }
    res.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED).json(result.view);
  }

  @Get(':orderId/refunds')
  @ApiOperation({ summary: 'List an order refunds (owner, or staff with order:read)' })
  @ApiParam({ name: 'orderId', type: Number, example: 1 })
  @ApiExtraModels(RefundView)
  @ApiOkResponse({
    description: 'The order refunds, newest-first',
    schema: { type: 'array', items: { $ref: getSchemaPath(RefundView) } },
  })
  @ApiProduces('application/json')
  public async listRefunds(
    @Param('orderId', ParseIntPipe) orderId: number,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<RefundView[]> {
    return this.listRefundsUseCase.execute(orderId, user, correlationId);
  }
}
