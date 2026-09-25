import {
  IPage,
  IReservationReleasePayload,
  IReservationReleaseResult,
  IReservationSweepPayload,
  IReservationSweepResult,
  IStockMovementListPayload,
  IStockTransferResult,
  StockLevelView,
  StockLocationView,
  StockMovementView,
  VariantStockView,
} from '@retail-inventory-system/contracts';

export const INVENTORY_GATEWAY_PORT = Symbol('INVENTORY_GATEWAY_PORT');

export interface IGetVariantStockQuery {
  variantId: number;
  stockLocationIds?: string[];
}

export interface IListLocationsQuery {
  activeOnly?: boolean;
}

export interface IReceiveStockCommand {
  variantId: number;
  stockLocationId?: string;
  quantity: number;
  actorId?: string;
}

export interface IAdjustStockCommand {
  variantId: number;
  stockLocationId?: string;
  quantityDelta: number;
  reasonCode: string;
  actorId?: string;
}

export interface ITransferStockCommand {
  variantId: number;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  actorId?: string;
}

export interface IInventoryGatewayPort {
  getVariantStock(query: IGetVariantStockQuery, correlationId: string): Promise<VariantStockView>;
  listLocations(query: IListLocationsQuery, correlationId: string): Promise<StockLocationView[]>;
  receiveStock(command: IReceiveStockCommand, correlationId: string): Promise<StockLevelView>;
  adjustStock(command: IAdjustStockCommand, correlationId: string): Promise<StockLevelView>;
  transferStock(
    command: ITransferStockCommand,
    correlationId: string,
  ): Promise<IStockTransferResult>;

  listVariantMovements(payload: IStockMovementListPayload): Promise<IPage<StockMovementView>>;

  releaseReservation(payload: IReservationReleasePayload): Promise<IReservationReleaseResult>;

  sweepReservations(payload: IReservationSweepPayload): Promise<IReservationSweepResult>;
}
