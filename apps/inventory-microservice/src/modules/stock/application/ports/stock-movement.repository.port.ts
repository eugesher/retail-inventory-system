import { StockMovementTypeEnum } from '@retail-inventory-system/contracts';

import { StockMovement } from '../../domain';
import { ITransactionScope } from '@retail-inventory-system/ddd';

export const STOCK_MOVEMENT_REPOSITORY = Symbol('STOCK_MOVEMENT_REPOSITORY');

export interface IStockMovementPage {
  items: StockMovement[];
  total: number;
}

export interface IStockMovementListQuery {
  variantId: number;
  page: number;
  size: number;
  type?: StockMovementTypeEnum;
  from?: Date;
  to?: Date;
}

export interface IStockMovementRepositoryPort {
  append(movement: StockMovement, scope?: ITransactionScope): Promise<StockMovement>;

  listByVariant(query: IStockMovementListQuery): Promise<IStockMovementPage>;
  existsByReference(
    referenceType: string,
    referenceId: string,
    scope?: ITransactionScope,
  ): Promise<boolean>;
}
