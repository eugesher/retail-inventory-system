import { IOrderProductConfirm } from '@retail-inventory-system/contracts';

export const INVENTORY_CONFIRM_GATEWAY = Symbol('INVENTORY_CONFIRM_GATEWAY');

// Application-side port for the cross-service call into the inventory
// microservice's `inventory.order.confirm` handler. Adapter wraps
// `ClientProxy.send()` + `firstValueFrom`; use cases mock this port directly
// to drive the "stock-confirmed / stock-insufficient / timeout" branches in
// the confirm flow without booting RabbitMQ in unit tests.
//
// Wire-format payload shape is `IProductStockOrderConfirmPayload` from
// `@retail-inventory-system/contracts/inventory`. The reply is the subset of
// `IOrderProductConfirm.id`s for which stock was successfully reserved.
export interface IInventoryConfirmGatewayPort {
  reserveOrderStock(payload: {
    products: IOrderProductConfirm[];
    correlationId: string;
  }): Promise<number[]>;
}
