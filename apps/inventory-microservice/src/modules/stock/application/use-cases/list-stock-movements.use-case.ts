import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IPage,
  IStockMovementListPayload,
  StockMovementView,
} from '@retail-inventory-system/contracts';

import { IStockMovementRepositoryPort, STOCK_MOVEMENT_REPOSITORY } from '../ports';
import { toStockMovementView } from './stock-movement-view.factory';

@Injectable()
export class ListStockMovementsUseCase {
  constructor(
    @Inject(STOCK_MOVEMENT_REPOSITORY)
    private readonly movementRepository: IStockMovementRepositoryPort,
    @InjectPinoLogger(ListStockMovementsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IStockMovementListPayload): Promise<IPage<StockMovementView>> {
    const { variantId, page, size, type, from, to, correlationId } = payload;

    this.logger.info(
      { correlationId, variantId, page, size, type, from, to },
      'Received RPC: list stock movements (audit read)',
    );

    const fromDate = this.parseInstant(from);
    const toDate = this.parseInstant(to);

    const movementsPage = await this.movementRepository.listByVariant({
      variantId,
      page,
      size,
      type,
      from: fromDate,
      to: toDate,
    });

    return {
      items: movementsPage.items.map((movement) => toStockMovementView(movement)),
      total: movementsPage.total,
      page,
      size,
    };
  }

  private parseInstant(value?: string): Date | undefined {
    if (value === undefined) {
      return undefined;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
}
