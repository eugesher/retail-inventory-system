import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { ITransactionPort, ITransactionScope } from '../../application/ports';

// The orders context's `TRANSACTION_PORT` binding, mirroring the inventory
// `modules/stock` adapter exactly (ADR-017 §6 / ADR-019). It opens a TypeORM
// transaction and hands the use case an opaque `ITransactionScope` brand — the
// `EntityManager` downcast (`as unknown as`) lives only here and in the repositories
// (the one place ADR-017 §6 permits it), so the application layer never touches a
// `typeorm` type. Each repository the use case calls with this scope re-derives the
// transactional manager and joins the same unit of work.
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
