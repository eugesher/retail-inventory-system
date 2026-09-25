import { EntityManager } from 'typeorm';

import { IUnitOfWorkRunner } from '@retail-inventory-system/ddd';

export class TypeormUnitOfWorkRunner<TRepositories> implements IUnitOfWorkRunner<TRepositories> {
  constructor(
    private readonly entityManager: EntityManager,
    private readonly build: (manager: EntityManager) => TRepositories,
  ) {}

  public run<T>(work: (repositories: TRepositories) => Promise<T>): Promise<T> {
    return this.entityManager.transaction((manager) => work(this.build(manager)));
  }
}
