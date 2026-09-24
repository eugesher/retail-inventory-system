import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { TypeormUnitOfWorkRunner } from '@retail-inventory-system/database';

import { IReturnsUnitOfWork, IReturnsUnitOfWorkRunner } from '../../application/ports';
import { ReturnRequestWriteTypeormRepository } from './return-request-write-typeorm.repository';

// The returns module's `IUnitOfWorkRunner` binding (ADR-063). `@InjectEntityManager()`
// resolves the DEFAULT connection — the same one `TypeormTransactionAdapter` used, and the
// one `ReturnRequestWriteTypeormRepository` needs for its post-conflict re-read (see that
// class's constructor note).
@Injectable()
export class ReturnsUnitOfWorkAdapter implements IReturnsUnitOfWorkRunner {
  private readonly runner: TypeormUnitOfWorkRunner<IReturnsUnitOfWork>;

  constructor(@InjectEntityManager() defaultManager: EntityManager) {
    this.runner = new TypeormUnitOfWorkRunner(defaultManager, (transactionManager) => ({
      returnRequests: new ReturnRequestWriteTypeormRepository(transactionManager, defaultManager),
    }));
  }

  public run<T>(work: (uow: IReturnsUnitOfWork) => Promise<T>): Promise<T> {
    return this.runner.run(work);
  }
}
