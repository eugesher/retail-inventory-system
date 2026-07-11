import { DomainEvent, ICreateDomainEventProps } from '../domain-event.model';

const makeCreateProps = (
  overrides: Partial<ICreateDomainEventProps> = {},
): ICreateDomainEventProps => ({
  eventType: 'retail.order.placed',
  aggregateType: 'order',
  aggregateId: '42',
  payload: { orderId: 42, total: 1999 },
  eventVersion: 'v1',
  producer: 'retail-microservice',
  occurredAt: new Date('2026-06-27T10:00:00.000Z'),
  ...overrides,
});

describe('DomainEvent', () => {
  describe('construction populates the read-only getters', () => {
    it('exposes every field from create', () => {
      const occurredAt = new Date('2026-06-27T10:00:00.000Z');
      const event = DomainEvent.create(makeCreateProps({ correlationId: 'corr-1', occurredAt }));

      expect(event.id).toBeNull();
      expect(event.eventType).toBe('retail.order.placed');
      expect(event.aggregateType).toBe('order');
      expect(event.aggregateId).toBe('42');
      expect(event.payload).toEqual({ orderId: 42, total: 1999 });
      expect(event.eventVersion).toBe('v1');
      expect(event.producer).toBe('retail-microservice');
      expect(event.correlationId).toBe('corr-1');
      expect(event.occurredAt).toBe(occurredAt);
    });

    it('occurredAt is a Date', () => {
      const event = DomainEvent.create(makeCreateProps());
      expect(event.occurredAt).toBeInstanceOf(Date);
    });
  });

  describe('create (write path) defaults', () => {
    it('defaults id to null and correlationId to null when omitted', () => {
      const event = DomainEvent.create(makeCreateProps());
      expect(event.id).toBeNull();
      expect(event.correlationId).toBeNull();
    });

    it('passes correlationId through when supplied', () => {
      const event = DomainEvent.create(makeCreateProps({ correlationId: 'corr-9' }));
      expect(event.correlationId).toBe('corr-9');
    });
  });

  describe('shape invariants', () => {
    it('rejects an empty event type', () => {
      expect(() => DomainEvent.create(makeCreateProps({ eventType: '' }))).toThrow(Error);
      expect(() => DomainEvent.create(makeCreateProps({ eventType: '   ' }))).toThrow(Error);
    });

    it('rejects an empty producer', () => {
      expect(() => DomainEvent.create(makeCreateProps({ producer: '' }))).toThrow(Error);
      expect(() => DomainEvent.create(makeCreateProps({ producer: '   ' }))).toThrow(Error);
    });

    it('accepts an empty payload object (the firehose carries whatever the bus does)', () => {
      const event = DomainEvent.create(makeCreateProps({ payload: {} }));
      expect(event.payload).toEqual({});
    });
  });

  describe('immutability (append-only starts in the type system)', () => {
    it('a constructed event is frozen', () => {
      const event = DomainEvent.create(makeCreateProps());
      expect(Object.isFrozen(event)).toBe(true);
    });

    it('an attempted field write does not change the value (frozen at runtime)', () => {
      const event = DomainEvent.create(makeCreateProps({ eventType: 'retail.order.placed' }));
      try {
        // The cast defeats the compile-time `readonly`; the runtime freeze holds the line.
        (event as unknown as { eventType: string }).eventType = 'tampered';
      } catch {
        // A strict-mode write to a frozen property throws; either way the value is unchanged.
      }
      expect(event.eventType).toBe('retail.order.placed');
    });

    it('exposes no instance methods at all — no mutators, no getters', () => {
      // Every field is a public readonly data property, so the prototype carries ONLY
      // the constructor: nothing can change a recorded event.
      expect(Object.getOwnPropertyNames(DomainEvent.prototype)).toEqual(['constructor']);
    });
  });

  describe('reconstitute (load path)', () => {
    it('round-trips every field including the DB-assigned id', () => {
      const occurredAt = new Date('2026-06-27T09:30:00.000Z');
      const event = DomainEvent.reconstitute({
        id: 7,
        eventType: 'audit.staff.action',
        aggregateType: 'staff-user',
        aggregateId: 'staff-1',
        payload: { action: 'UserLoggedIn' },
        eventVersion: 'v1',
        producer: 'api-gateway',
        correlationId: null,
        occurredAt,
      });

      expect(event.id).toBe(7);
      expect(event.eventType).toBe('audit.staff.action');
      expect(event.aggregateType).toBe('staff-user');
      expect(event.aggregateId).toBe('staff-1');
      expect(event.payload).toEqual({ action: 'UserLoggedIn' });
      expect(event.eventVersion).toBe('v1');
      expect(event.producer).toBe('api-gateway');
      expect(event.correlationId).toBeNull();
      expect(event.occurredAt).toBe(occurredAt);
    });

    it('re-asserts the identity invariant on load (a corrupted stored row is rejected)', () => {
      expect(() =>
        DomainEvent.reconstitute({
          id: 1,
          eventType: '',
          aggregateType: 'order',
          aggregateId: '1',
          payload: {},
          eventVersion: 'v1',
          producer: 'retail-microservice',
          correlationId: null,
          occurredAt: new Date(),
        }),
      ).toThrow(Error);
    });
  });
});
