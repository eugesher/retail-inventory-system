import { IOrderProductConfirm } from '@retail-inventory-system/contracts';

export const INVENTORY_CONFIRM_GATEWAY = Symbol('INVENTORY_CONFIRM_GATEWAY');

// Reply is the subset of line ids for which stock was successfully reserved.
export interface IInventoryConfirmGatewayPort {
  reserveOrderStock(payload: {
    products: IOrderProductConfirm[];
    correlationId: string;
  }): Promise<number[]>;
}
