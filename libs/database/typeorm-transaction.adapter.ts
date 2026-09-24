import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { ITransactionPort, ITransactionScope } from '@retail-inventory-system/ddd';

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

export function entityManagerOf(scope: ITransactionScope): EntityManager {
  return scope as unknown as EntityManager;
}
