import { ICommitSalePayload, ICommitSaleResult } from '@retail-inventory-system/contracts';

export const ORDER_COMMIT_SALE_GATEWAY = Symbol('ORDER_COMMIT_SALE_GATEWAY');

export interface IOrderCommitSaleGatewayPort {
  commitSale(payload: ICommitSalePayload): Promise<ICommitSaleResult>;
}
