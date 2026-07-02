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

// HTTP surface over the retail microservice's refund RPCs (ADR-009, ADR-032). The refund
// routes are **order-scoped** (`/api/orders/:orderId/refunds`) so they live next to the
// order capture/cancel surface — a separate controller on the same `orders` prefix keeps
// the orders controller focused (the catalog category/media multi-controller precedent).
// The two authorization shapes coexist (ADR-024 / ADR-028 §7):
//
//   - **Issue Refund** is **staff-only** — gated `@RequiresPermission('order:refund')` (a
//     customer cannot refund itself). The use case folds `@CurrentUser().id` into the
//     audit `actorId`.
//   - **List Refunds** is **owner-or-staff** `order:read` — it carries **no
//     `@RequiresPermission`** (that would block the owning customer). The owner-check is
//     enforced retail-side; the staff override is resolved at the gateway from
//     `@CurrentUser().permissions`. A non-owner non-staff caller is 403
//     (`REFUND_ACCESS_FORBIDDEN`).
//
// Typed upstream codes (`REFUND_*` / `ORDER_*`) surface as 400/403/404/409 via
// `throwRpcError`. `orderId` is a BIGINT id (numeric param via `ParseIntPipe`).
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
  // A fresh issue is `201 Created`; a replay returns the stored refund with `200 OK` + the
  // `Idempotent-Replay: true` marker header. Because the status is dynamic, this route owns
  // its response via `@Res` (the passthrough path would let Nest overwrite the status back to
  // the route default `201`) — errors thrown before `res.json` still flow through the
  // gateway's exception filters (ADR-036, the place-order precedent).
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
