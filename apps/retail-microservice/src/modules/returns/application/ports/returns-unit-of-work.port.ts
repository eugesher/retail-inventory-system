import { IUnitOfWorkRunner } from '@retail-inventory-system/ddd';

import { IReturnRequestWriteRepositoryPort } from './return-request-write.repository.port';

export const RETURNS_UNIT_OF_WORK = Symbol('RETURNS_UNIT_OF_WORK');

export interface IReturnsUnitOfWork {
  readonly returnRequests: IReturnRequestWriteRepositoryPort;
}

export type IReturnsUnitOfWorkRunner = IUnitOfWorkRunner<IReturnsUnitOfWork>;
