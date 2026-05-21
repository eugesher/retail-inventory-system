import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { ITransactionPort, ITransactionScope } from '../../application/ports';

// TypeORM-backed implementation of ITransactionPort. The adapter is the
// single place that knows the concrete shape of an `ITransactionScope` — it
// hands the underlying `EntityManager` to the work callback under the
// opaque scope type. The repository adapter is the only other consumer that
// downcasts the scope back to `EntityManager`.
@Injectable()
export class TypeormTransactionAdapter implements ITransactionPort {
  constructor(
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
  ) {}

  public runInTransaction<T>(work: (scope: ITransactionScope) => Promise<T>): Promise<T> {
    return this.entityManager.transaction(async (em) => work(em as unknown as ITransactionScope));
  }
}
