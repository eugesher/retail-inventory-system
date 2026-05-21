import { AggregateRoot } from '../aggregate-root.base';
import { DomainEvent } from '../domain-event.base';

class FakeEvent extends DomainEvent<number> {
  constructor(aggregateId: number) {
    super(aggregateId);
  }
}

class FakeAggregate extends AggregateRoot<number> {
  constructor(id: number) {
    super(id);
  }

  public emit(): void {
    this.addDomainEvent(new FakeEvent(this.id));
  }
}

// Pull semantics: after `pullDomainEvents()` the buffer is drained, so a
// repository can dispatch the events exactly once on save without risk of
// double-publishing on a subsequent `save`.
describe('AggregateRoot', () => {
  it('buffers added events and drains them on pull', () => {
    const aggregate = new FakeAggregate(1);
    aggregate.emit();
    aggregate.emit();

    expect(aggregate.pullDomainEvents()).toHaveLength(2);
    expect(aggregate.pullDomainEvents()).toHaveLength(0);
  });

  it('equates entities by id within the same subtype', () => {
    expect(new FakeAggregate(1).equals(new FakeAggregate(1))).toBe(true);
    expect(new FakeAggregate(1).equals(new FakeAggregate(2))).toBe(false);
  });
});
