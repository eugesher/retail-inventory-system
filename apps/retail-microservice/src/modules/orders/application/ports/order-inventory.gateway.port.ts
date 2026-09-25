import {
  IAllocationCancelPayload,
  IAllocationResult,
  IReservationAllocatePayload,
} from '@retail-inventory-system/contracts';

export const ORDER_INVENTORY_GATEWAY = Symbol('ORDER_INVENTORY_GATEWAY');

export interface IOrderInventoryGatewayPort {
  allocateStock(payload: IReservationAllocatePayload): Promise<IAllocationResult>;
  cancelAllocation(payload: IAllocationCancelPayload): Promise<void>;
}
