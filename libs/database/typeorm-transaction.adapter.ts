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
// **Both directions of the `EntityManager` downcast live in this file** (ADR-054). The scope the
// application layer passes around is opaque: `runInTransaction` is the only place that mints one,
// and `entityManagerOf` below is the only place that un-opaques one. Nothing above
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

// Un-opaques a transaction scope for a repository that joins its caller's transaction.
//
// Every repository accepting an `ITransactionScope` used to cast it inline — 14 copies of the same
// `as unknown as EntityManager` in 11 files. They call this instead, and a `no-restricted-syntax`
// rule in `eslint.config.mjs` rejects a new inline cast anywhere in `apps/`.
//
// **The cast is no safer for living here.** The brand proves a scope came from `runInTransaction`;
// it does not prove it came from THIS transaction (ADR-054, Open). What moving it buys is one cast to
// audit instead of fourteen, and one line to change if the manager behind the scope ever does.
export function entityManagerOf(scope: ITransactionScope): EntityManager {
  return scope as unknown as EntityManager;
}
