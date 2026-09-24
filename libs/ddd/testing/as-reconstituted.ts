import { AggregateRoot } from '../aggregate-root.base';

export const asReconstituted = <TId, T extends AggregateRoot<TId>>(aggregate: T): T => {
  const clone = Object.assign(
    Object.create(Object.getPrototypeOf(aggregate) as object) as T,
    aggregate,
  );
  clone.pullDomainEvents();
  return clone;
};
