import { AggregateRoot } from './aggregate-root.base';

export interface IRepositoryPort<TAggregate extends AggregateRoot<TId>, TId> {
  findById(id: TId): Promise<TAggregate | null>;
  save(aggregate: TAggregate): Promise<void>;
  delete(aggregate: TAggregate): Promise<void>;
}
