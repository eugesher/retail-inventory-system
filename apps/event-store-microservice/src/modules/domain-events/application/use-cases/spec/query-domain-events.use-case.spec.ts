import { PinoLogger } from 'nestjs-pino';

import {
  IDomainEventQueryFilters,
  IDomainEventQueryPayload,
  IPage,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { DomainEvent, IDomainEventProps } from '../../../domain';
import {
  IDomainEventAppendResult,
  IDomainEventPageRequest,
  IDomainEventRepositoryPort,
} from '../../ports';
import { QueryDomainEventsUseCase } from '../query-domain-events.use-case';

// A fake firehose repository that RECORDS the arguments `query` was called with — the
// filters (asserted to arrive verbatim) and the clamped page window — and returns whatever
// page the test programmed. The default ordering is asserted at this seam: the fake records
// nothing about SQL, but the port's contract says `occurred_at DESC, id DESC` and the rows it
// hands back are in that order, so the use case must not reorder them.
class RecordingDomainEventRepository implements IDomainEventRepositoryPort {
  public lastFilters: IDomainEventQueryFilters | null = null;
  public lastPage: IDomainEventPageRequest | null = null;
  public callCount = 0;
  private nextPage: IPage<DomainEvent> = { items: [], total: 0, page: 1, size: 20 };

  public program(page: IPage<DomainEvent>): void {
    this.nextPage = page;
  }

  public append(): Promise<IDomainEventAppendResult> {
    return Promise.reject(new Error('append is not exercised by the query spec'));
  }

  public query(
    filters: IDomainEventQueryFilters,
    page: IDomainEventPageRequest,
  ): Promise<IPage<DomainEvent>> {
    this.callCount += 1;
    this.lastFilters = filters;
    this.lastPage = page;
    return Promise.resolve(this.nextPage);
  }
}

const OCCURRED_AT = new Date('2026-06-27T10:00:00.000Z');

const makeEvent = (overrides: Partial<IDomainEventProps> = {}): DomainEvent =>
  DomainEvent.reconstitute({
    id: 7,
    eventType: 'retail.order.placed',
    aggregateType: 'order',
    aggregateId: '42',
    payload: { orderId: 42 },
    eventVersion: 'v1',
    producer: 'retail',
    correlationId: 'corr-1',
    occurredAt: OCCURRED_AT,
    ...overrides,
  });

const payload = (overrides: Partial<IDomainEventQueryPayload> = {}): IDomainEventQueryPayload => ({
  correlationId: 'request-trace-id',
  filters: {},
  ...overrides,
});

describe('QueryDomainEventsUseCase', () => {
  let repository: RecordingDomainEventRepository;
  let logger: ReturnType<typeof makePinoLoggerMock>;
  let useCase: QueryDomainEventsUseCase;

  beforeEach(() => {
    repository = new RecordingDomainEventRepository();
    logger = makePinoLoggerMock();
    useCase = new QueryDomainEventsUseCase(repository, logger as unknown as PinoLogger);
  });

  describe('the page window', () => {
    it('passes an empty where-clause and the default page window when no filter is given', async () => {
      await useCase.execute(payload());

      expect(repository.callCount).toBe(1);
      expect(repository.lastFilters).toEqual({});
      expect(repository.lastPage).toEqual({ page: 1, size: 20 });
    });

    it('clamps an oversized pageSize down to the hard cap of 100', async () => {
      await useCase.execute(payload({ pageSize: 500 }));

      expect(repository.lastPage).toEqual({ page: 1, size: 100 });
    });

    it('falls back to the defaults for pageSize: 0 and page: 0', async () => {
      await useCase.execute(payload({ page: 0, pageSize: 0 }));

      expect(repository.lastPage).toEqual({ page: 1, size: 20 });
    });

    it('floors a fractional page (1.7 → 1) rather than letting it reach skip()', async () => {
      await useCase.execute(payload({ page: 1.7, pageSize: 25 }));

      expect(repository.lastPage).toEqual({ page: 1, size: 25 });
    });

    it('honours an in-range page and pageSize verbatim', async () => {
      await useCase.execute(payload({ page: 3, pageSize: 50 }));

      expect(repository.lastPage).toEqual({ page: 3, size: 50 });
    });
  });

  describe('the filters', () => {
    it.each<[string, IDomainEventQueryFilters]>([
      ['eventType', { eventType: 'retail.order.placed' }],
      ['aggregateType', { aggregateType: 'order' }],
      ['aggregateId', { aggregateId: '42' }],
      ['correlationId', { correlationId: 'corr-1' }],
      ['from', { from: '2026-06-01T00:00:00.000Z' }],
      ['to', { to: '2026-06-30T23:59:59.999Z' }],
    ])('passes the %s filter to the repository verbatim', async (_name, filters) => {
      await useCase.execute(payload({ filters }));

      expect(repository.lastFilters).toEqual(filters);
    });

    it('passes every filter combined to the repository verbatim', async () => {
      const filters: IDomainEventQueryFilters = {
        eventType: 'retail.order.placed',
        aggregateType: 'order',
        aggregateId: '42',
        correlationId: 'corr-1',
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-30T23:59:59.999Z',
      };

      await useCase.execute(payload({ filters }));

      expect(repository.lastFilters).toEqual(filters);
    });

    it('never confuses the request correlationId with the correlationId filter', async () => {
      await useCase.execute(
        payload({ correlationId: 'request-trace-id', filters: { correlationId: 'traced-id' } }),
      );

      expect(repository.lastFilters).toEqual({ correlationId: 'traced-id' });
    });

    it('returns an empty page for an inverted from/to range without throwing', async () => {
      // The repository turns `from > to` into `BETWEEN hi AND lo`, which selects nothing.
      // The use case does not pre-validate the ordering and raises no domain exception.
      repository.program({ items: [], total: 0, page: 1, size: 20 });

      const result = await useCase.execute(
        payload({
          filters: { from: '2026-06-30T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' },
        }),
      );

      expect(result).toEqual({ items: [], total: 0, page: 1, size: 20 });
    });
  });

  describe('the result', () => {
    it('maps DomainEvent → DomainEventView with occurredAt as an ISO-8601 string', async () => {
      repository.program({ items: [makeEvent()], total: 1, page: 1, size: 20 });

      const result = await useCase.execute(payload());

      expect(result.items).toEqual([
        {
          id: 7,
          eventType: 'retail.order.placed',
          aggregateType: 'order',
          aggregateId: '42',
          payload: { orderId: 42 },
          eventVersion: 'v1',
          producer: 'retail',
          correlationId: 'corr-1',
          occurredAt: '2026-06-27T10:00:00.000Z',
        },
      ]);
      expect(typeof result.items[0].occurredAt).toBe('string');
    });

    it('surfaces the empty-string correlationId of an event ingested without one', async () => {
      // `domain_event.correlation_id` is NOT NULL DEFAULT '' so the ingest dedupe UNIQUE
      // collides. The view reports the storage fact rather than rewriting it to null.
      repository.program({
        items: [makeEvent({ correlationId: '' })],
        total: 1,
        page: 1,
        size: 20,
      });

      const result = await useCase.execute(payload());

      expect(result.items[0].correlationId).toBe('');
    });

    it('preserves total / page / size as returned by the repository page', async () => {
      repository.program({ items: [makeEvent()], total: 137, page: 3, size: 50 });

      const result = await useCase.execute(payload({ page: 3, pageSize: 50 }));

      expect(result.total).toBe(137);
      expect(result.page).toBe(3);
      expect(result.size).toBe(50);
    });

    it('preserves the newest-first order the repository returned (it never re-sorts)', async () => {
      // The port's contract is `occurred_at DESC, id DESC`. The fake hands the rows back in
      // exactly that order; the use case must project them in place.
      const newer = makeEvent({ id: 9, occurredAt: new Date('2026-06-27T12:00:00.000Z') });
      const olderSameInstant = makeEvent({ id: 8 });
      const oldest = makeEvent({ id: 7 });
      repository.program({
        items: [newer, olderSameInstant, oldest],
        total: 3,
        page: 1,
        size: 20,
      });

      const result = await useCase.execute(payload());

      expect(result.items.map((item) => item.id)).toEqual([9, 8, 7]);
    });
  });
});
