import { StockLowEvent, StockReservedEvent } from '../../domain';

export const STOCK_EVENTS_PUBLISHER = Symbol('STOCK_EVENTS_PUBLISHER');

export interface IStockEventsPublisherPort {
  // Wraps the cold-observable RxJS dance from `ClientProxy.emit()` (see
  // _carryover-07 §5 #3). Application code awaits a plain Promise; the
  // adapter is responsible for materializing the observable + broker ack.
  publishStockLow(event: StockLowEvent, correlationId?: string): Promise<void>;
  publishStockReserved(event: StockReservedEvent, correlationId?: string): Promise<void>;
}
