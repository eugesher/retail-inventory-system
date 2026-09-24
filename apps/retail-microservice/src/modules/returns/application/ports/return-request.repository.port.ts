import { ReturnRequest } from '../../domain';

export const RETURN_REQUEST_REPOSITORY = Symbol('RETURN_REQUEST_REPOSITORY');

export interface IReturnRequestRepositoryPort {
  findById(id: number): Promise<ReturnRequest | null>;
  listByOrderId(orderId: number): Promise<ReturnRequest[]>;
}
