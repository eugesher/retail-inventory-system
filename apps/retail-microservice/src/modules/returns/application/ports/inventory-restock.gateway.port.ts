import {
  IRestockFromReturnPayload,
  IRestockFromReturnResult,
} from '@retail-inventory-system/contracts';

export const INVENTORY_RESTOCK_GATEWAY = Symbol('INVENTORY_RESTOCK_GATEWAY');

export interface IInventoryRestockGatewayPort {
  restockFromReturn(payload: IRestockFromReturnPayload): Promise<IRestockFromReturnResult>;
}
