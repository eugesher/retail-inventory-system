import { AggregateRoot } from './aggregate-root.base';

// Generic repository port. Domain code depends on subtypes of this interface
// (e.g. `OrderRepository extends IRepositoryPort<Order, number>`); concrete
// TypeORM implementations live under `apps/*/src/.../infrastructure/`.
export interface IRepositoryPort<TAggregate extends AggregateRoot<TId>, TId> {
  findById(id: TId): Promise<TAggregate | null>;
  save(aggregate: TAggregate): Promise<void>;
  delete(aggregate: TAggregate): Promise<void>;
}
