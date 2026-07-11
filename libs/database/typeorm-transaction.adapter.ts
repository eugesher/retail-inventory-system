import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { ITransactionPort, ITransactionScope } from '@retail-inventory-system/ddd';

// The one implementation of `ITransactionPort` (`libs/ddd`), shared by every module that
// composes a multi-repository write — inventory `stock`, retail `orders`, retail `returns`
// (ADR-043). Each of the three used to carry a byte-identical private copy, because
// cross-module isolation forbade sharing one; lifting it into a lib is what makes sharing
// legal.
//
// This file is one of the two sanctioned homes for the `EntityManager` downcast (ADR-017 §6):
// the scope the application layer passes around is opaque, and the cast back to the real
// manager happens here and in the repository adapters that receive it. Nothing above
// `infrastructure/` ever sees the TypeORM type.
//
// `@InjectEntityManager()` resolves the DEFAULT connection. The event store — the one service
// on a second connection (`EVENTSTORE_DATABASE_URL`, ADR-034) — has no multi-repository write
// and does not bind this port.
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
