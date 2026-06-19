import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { ITransactionPort, ITransactionScope } from '../../application/ports';

// The returns context's `TRANSACTION_PORT` binding, mirroring the orders `modules/orders`
// and inventory `modules/stock` adapters exactly (ADR-017 §6 / ADR-019). It opens a
// TypeORM transaction and hands the use case an opaque `ITransactionScope` brand — the
// `EntityManager` downcast (`as unknown as`) lives only here and in the repositories (the
// one place ADR-017 §6 permits it), so the application layer never touches a `typeorm`
// type. Inspect & Disposition is the first returns operation to need it: it records each
// line's inspection outcome and walks the RMA to `inspected` in one unit of work (a later
// Close+Refund flow will join the `Refund` + `Payment` writes onto the same scope).
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
