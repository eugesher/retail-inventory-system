import { IUnitOfWorkRunner } from '@retail-inventory-system/ddd';

import { IReturnRequestWriteRepositoryPort } from './return-request-write.repository.port';

export const RETURNS_UNIT_OF_WORK = Symbol('RETURNS_UNIT_OF_WORK');

// The returns module's repository bag (ADR-063). One member today — `ReturnRequest` is the
// module's only aggregate, and returns cannot reach the orders module's `Refund` /
// `Payment` (the boundaries lint forbids the cross-module import), so no returns
// transaction has ever spanned more than this one repository.
export interface IReturnsUnitOfWork {
  readonly returnRequests: IReturnRequestWriteRepositoryPort;
}

export type IReturnsUnitOfWorkRunner = IUnitOfWorkRunner<IReturnsUnitOfWork>;
