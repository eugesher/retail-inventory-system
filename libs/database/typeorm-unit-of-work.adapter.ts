import { EntityManager } from 'typeorm';

import { IUnitOfWorkRunner } from '@retail-inventory-system/ddd';

// The one implementation of `IUnitOfWorkRunner` (ADR-063) — shared by every module that
// composes a multi-repository write, the same lift ADR-043 already made for
// `ITransactionPort` / `TypeormTransactionAdapter`, and for the identical reason: this
// class's body does not vary by module. `TRepositories` is generic precisely because
// nothing here needs to know what it is — only `build` does, and `build` is supplied by
// the module's own adapter.
//
// `build` constructs the module's write-repository bag bound to the transaction's OWN
// `EntityManager` — a fresh set of repository instances per `run()` call, never the
// module's default-connection-bound repositories. A module's `<Module>UnitOfWorkAdapter`
// constructs one of these (closing over its own injected default `EntityManager` for
// anything a write repository needs OUTSIDE the transaction — e.g. a post-conflict
// re-read on a fresh snapshot, ADR-036) and delegates `run` to it.
export class TypeormUnitOfWorkRunner<TRepositories> implements IUnitOfWorkRunner<TRepositories> {
  constructor(
    private readonly entityManager: EntityManager,
    private readonly build: (manager: EntityManager) => TRepositories,
  ) {}

  public run<T>(work: (repositories: TRepositories) => Promise<T>): Promise<T> {
    return this.entityManager.transaction((manager) => work(this.build(manager)));
  }
}
