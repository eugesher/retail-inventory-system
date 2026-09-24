import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IRestockFromReturnLine,
  IRestockFromReturnPayload,
  IRetailReturnInspectPayload,
  ReturnDispositionEnum,
  ReturnRequestView,
} from '@retail-inventory-system/contracts';
import { retryThenLogForReplay } from '@retail-inventory-system/common';

import {
  ReturnDomainException,
  ReturnErrorCodeEnum,
  ReturnLine,
  ReturnRequest,
} from '../../domain';
import {
  IInventoryRestockGatewayPort,
  IReturnCustomerContactReaderPort,
  IReturnEventsPublisherPort,
  IReturnOrderReaderPort,
  IReturnRequestRepositoryPort,
  IReturnsUnitOfWorkRunner,
  INVENTORY_RESTOCK_GATEWAY,
  OCC_RETRY_ATTEMPTS,
  RETURN_CUSTOMER_CONTACT_READER,
  RETURN_EVENTS_PUBLISHER,
  RETURN_ORDER_READER,
  RETURN_REQUEST_REPOSITORY,
  RETURNS_UNIT_OF_WORK,
} from '../ports';
import { loadReturnById } from './return-access';
import { resolveCustomerEmail } from './resolve-customer-email';
import { runWithReturnWriteRetry } from './return-write';
import { toReturnRequestView } from './return-view.factory';

const RESTOCK_MAX_ATTEMPTS = 3;

@Injectable()
export class InspectAndDispositionUseCase {
  constructor(
    @Inject(RETURNS_UNIT_OF_WORK)
    private readonly returnsUow: IReturnsUnitOfWorkRunner,
    @Inject(RETURN_REQUEST_REPOSITORY)
    private readonly repository: IReturnRequestRepositoryPort,
    @Inject(RETURN_ORDER_READER)
    private readonly orderReader: IReturnOrderReaderPort,
    @Inject(INVENTORY_RESTOCK_GATEWAY)
    private readonly restockGateway: IInventoryRestockGatewayPort,
    @Inject(RETURN_EVENTS_PUBLISHER)
    private readonly publisher: IReturnEventsPublisherPort,
    @Inject(RETURN_CUSTOMER_CONTACT_READER)
    private readonly customerContactReader: IReturnCustomerContactReaderPort,
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(InspectAndDispositionUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailReturnInspectPayload): Promise<ReturnRequestView> {
    const { rmaId, actorId, correlationId, lines } = payload;

    this.logger.info(
      { correlationId, rmaId, actorId, lineCount: lines.length },
      'Inspecting return request',
    );

    const request = await loadReturnById(this.repository, rmaId);

    const lineById = new Map<number, ReturnLine>(request.lines.map((line) => [line.id!, line]));
    this.assertInspectionCoversEveryLine(lines, lineById);

    const inspectedAt = new Date();

    const saved = await runWithReturnWriteRetry(
      { logger: this.logger, maxAttempts: this.maxAttempts },
      () =>
        this.returnsUow.run<ReturnRequest>(async (uow) => {
          const fresh = await uow.returnRequests.findById(rmaId);
          if (!fresh) {
            throw new ReturnDomainException(
              ReturnErrorCodeEnum.RETURN_NOT_FOUND,
              `Return request ${rmaId} vanished while inspecting`,
            );
          }
          const versionAtLoad = fresh.version;
          const freshLineById = new Map<number, ReturnLine>(
            fresh.lines.map((line) => [line.id!, line]),
          );
          for (const input of lines) {
            freshLineById.get(input.returnLineId)!.inspect({
              condition: input.condition,
              disposition: input.disposition,
              lineRefundAmountMinor: input.lineRefundAmountMinor,
            });
          }
          fresh.markInspected();
          return uow.returnRequests.save(fresh, versionAtLoad);
        }),
      { rmaId, correlationId },
    );

    const restockLines = saved.lines.filter(
      (line) => line.disposition === ReturnDispositionEnum.RESTOCK,
    );
    if (restockLines.length > 0) {
      await this.restockFitForResaleLines(saved, restockLines, actorId, correlationId);
    }

    await this.emitInspected(saved, restockLines.length, inspectedAt, correlationId);

    this.logger.info(
      { correlationId, rmaId, status: saved.status, restockedLineCount: restockLines.length },
      'Return request inspected',
    );
    return toReturnRequestView(saved);
  }

  private assertInspectionCoversEveryLine(
    inputLines: IRetailReturnInspectPayload['lines'],
    lineById: Map<number, ReturnLine>,
  ): void {
    for (const input of inputLines) {
      if (!lineById.has(input.returnLineId)) {
        throw new ReturnDomainException(
          ReturnErrorCodeEnum.RETURN_LINE_NOT_FOUND,
          `Return line ${input.returnLineId} is not part of this return request`,
        );
      }
    }

    const inspectedIds = new Set(inputLines.map((input) => input.returnLineId));
    if (inspectedIds.size !== inputLines.length) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_INSPECTION_INVALID,
        'Each return line may be inspected only once',
      );
    }
    for (const lineId of lineById.keys()) {
      if (!inspectedIds.has(lineId)) {
        throw new ReturnDomainException(
          ReturnErrorCodeEnum.RETURN_INSPECTION_INVALID,
          `Inspection must cover every line; line ${lineId} was not inspected`,
        );
      }
    }
  }

  private async restockFitForResaleLines(
    request: ReturnRequest,
    restockLines: readonly ReturnLine[],
    actorId: string,
    correlationId: string,
  ): Promise<void> {
    const snapshot = await this.orderReader.findOrderForReturn(request.orderId);
    if (!snapshot) {
      this.logger.error(
        { correlationId, rmaId: request.id, orderId: request.orderId },
        'Restock-from-Return skipped: order snapshot not found (inspection committed; awaits operator replay)',
      );
      return;
    }
    const variantByOrderLine = new Map(
      snapshot.lines.map((line) => [line.orderLineId, line.variantId]),
    );

    const restockPayloadLines: IRestockFromReturnLine[] = [];
    for (const line of restockLines) {
      const variantId = variantByOrderLine.get(line.orderLineId);
      if (variantId === undefined) {
        this.logger.error(
          { correlationId, rmaId: request.id, orderLineId: line.orderLineId },
          'Restock-from-Return: order line missing from order snapshot — skipping line (awaits operator replay)',
        );
        continue;
      }
      restockPayloadLines.push({
        returnLineId: line.id!,
        variantId,
        stockLocationId: INVENTORY_DEFAULT_STOCK_LOCATION,
        quantity: line.quantity,
      });
    }
    if (restockPayloadLines.length === 0) {
      return;
    }

    const payload: IRestockFromReturnPayload = {
      returnRequestId: request.id!,
      lines: restockPayloadLines,
      actorId,
      correlationId,
    };

    await retryThenLogForReplay(() => this.restockGateway.restockFromReturn(payload), {
      maxAttempts: RESTOCK_MAX_ATTEMPTS,
      logger: this.logger,
      correlationId,
      label: 'Restock-from-Return',
      context: { returnRequestId: payload.returnRequestId, lines: payload.lines },
      replayMessage:
        'Restock-from-Return failed after retries; the inspection is committed and the restock awaits operator replay (idempotent on returnRequestId)',
    });
  }

  private async emitInspected(
    request: ReturnRequest,
    restockedLineCount: number,
    inspectedAt: Date,
    correlationId: string,
  ): Promise<void> {
    const customerEmail = await resolveCustomerEmail(
      this.customerContactReader,
      request.customerId,
      this.logger,
      correlationId,
    );
    try {
      await this.publisher.publishReturnInspected({
        rmaId: request.id!,
        rmaNumber: request.rmaNumber!,
        orderId: request.orderId,
        customerId: request.customerId,
        customerEmail,
        customerLocale: null,
        inspectedAt: inspectedAt.toISOString(),
        restockedLineCount,
        eventVersion: 'v1',
        occurredAt: new Date().toISOString(),
        correlationId,
      });
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, rmaId: request.id },
        'Failed to publish retail.return.inspected (inspection already committed)',
      );
    }
  }
}
