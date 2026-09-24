import { ReturnRequest } from '../../domain';

export interface IReturnRequestWriteRepositoryPort {
  findById(id: number): Promise<ReturnRequest | null>;
  save(returnRequest: ReturnRequest, expectedVersion?: number): Promise<ReturnRequest>;
}
