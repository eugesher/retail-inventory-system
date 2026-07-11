import { PinoLogger } from 'nestjs-pino';

import { ICorrelationTracePayload, IPage } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  AuditLogEntry,
  DomainEvent,
  IAuditLogEntryProps,
  IDomainEventProps,
} from '../../../domain';
import {
  IAuditLogRepositoryPort,
  IDomainEventAppendResult,
  IDomainEventRepositoryPort,
} from '../../ports';
import { TraceByCorrelationUseCase } from '../trace-by-correlation.use-case';

const TARGET = 'traced-correlation-id';
const REQUEST = 'request-trace-id';

// Both doubles HONOUR their port's ordering contract — `occurred_at ASC, id ASC` — exactly as
// the real seams do (the `InMemoryReservationRepository.listExpiredActive` precedent). Rows
// are stored in arbitrary insertion order; the read sorts them. That makes the ascending
// assertions below a real test of the contract rather than a tautology, and it proves the use
// case projects the two timelines in place instead of re-sorting or merging them.
const byOccurredAtThenId = <T extends { occurredAt: Date; id: number | null }>(
  a: T,
  b: T,
): number => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id ?? 0) - (b.id ?? 0);

class FakeAuditLogRepository implements IAuditLogRepositoryPort {
  public readonly rows: AuditLogEntry[] = [];
  public lastCorrelationId: string | null = null;

  public seed(...entries: AuditLogEntry[]): void {
    this.rows.push(...entries);
  }

  public append(): Promise<void> {
    return Promise.reject(new Error('append is not exercised by the trace spec'));
  }

  public query(): Promise<IPage<AuditLogEntry>> {
    return Promise.reject(new Error('the paginated query is not exercised by the trace spec'));
  }

  public listByCorrelationId(correlationId: string): Promise<AuditLogEntry[]> {
    this.lastCorrelationId = correlationId;
    return Promise.resolve(
      this.rows.filter((row) => row.correlationId === correlationId).sort(byOccurredAtThenId),
    );
  }
}

class FakeDomainEventRepository implements IDomainEventRepositoryPort {
  public readonly rows: DomainEvent[] = [];
  public lastCorrelationId: string | null = null;

  public seed(...rows: DomainEvent[]): void {
    this.rows.push(...rows);
  }

  public append(): Promise<IDomainEventAppendResult> {
    return Promise.reject(new Error('append is not exercised by the trace spec'));
  }

  public query(): Promise<IPage<DomainEvent>> {
    return Promise.reject(new Error('the paginated query is not exercised by the trace spec'));
  }

  public listByCorrelationId(correlationId: string): Promise<DomainEvent[]> {
    this.lastCorrelationId = correlationId;
    return Promise.resolve(
      this.rows.filter((row) => row.correlationId === correlationId).sort(byOccurredAtThenId),
    );
  }
}

const eventRow = (overrides: Partial<IDomainEventProps> = {}): DomainEvent =>
  DomainEvent.reconstitute({
    id: 1,
    eventType: 'retail.order.placed',
    aggregateType: 'order',
    aggregateId: '42',
    payload: { orderId: 42 },
    eventVersion: 'v1',
    producer: 'retail',
    correlationId: TARGET,
    occurredAt: new Date('2026-06-27T10:00:00.000Z'),
    ...overrides,
  });

const auditEntry = (overrides: Partial<IAuditLogEntryProps> = {}): AuditLogEntry =>
  AuditLogEntry.reconstitute({
    id: 1,
    actorId: 'staff-1',
    actorType: 'staff-user',
    action: 'RefundIssued',
    entityType: 'refund',
    entityId: '11',
    before: null,
    after: { amount: 500 },
    occurredAt: new Date('2026-06-27T10:00:00.000Z'),
    ipAddress: null,
    correlationId: TARGET,
    ...overrides,
  });

const payload = (overrides: Partial<ICorrelationTracePayload> = {}): ICorrelationTracePayload => ({
  correlationId: REQUEST,
  targetCorrelationId: TARGET,
  ...overrides,
});

describe('TraceByCorrelationUseCase', () => {
  let repository: FakeAuditLogRepository;
  let eventRepository: FakeDomainEventRepository;
  let logger: ReturnType<typeof makePinoLoggerMock>;
  let useCase: TraceByCorrelationUseCase;

  beforeEach(() => {
    repository = new FakeAuditLogRepository();
    eventRepository = new FakeDomainEventRepository();
    logger = makePinoLoggerMock();
    useCase = new TraceByCorrelationUseCase(
      repository,
      eventRepository,
      logger as unknown as PinoLogger,
    );
  });

  it('issues both reads with the targetCorrelationId, not the request correlationId', async () => {
    await useCase.execute(payload());

    expect(eventRepository.lastCorrelationId).toBe(TARGET);
    expect(repository.lastCorrelationId).toBe(TARGET);
    expect(eventRepository.lastCorrelationId).not.toBe(REQUEST);
  });

  it('returns each log ascending by occurredAt, independently of the other', async () => {
    eventRepository.seed(
      eventRow({ id: 3, occurredAt: new Date('2026-06-27T10:00:03.000Z') }),
      eventRow({ id: 1, occurredAt: new Date('2026-06-27T10:00:01.000Z') }),
      eventRow({ id: 2, occurredAt: new Date('2026-06-27T10:00:02.000Z') }),
    );
    repository.seed(
      auditEntry({ id: 30, occurredAt: new Date('2026-06-27T10:00:30.000Z') }),
      auditEntry({ id: 10, occurredAt: new Date('2026-06-27T10:00:10.000Z') }),
    );

    const result = await useCase.execute(payload());

    expect(result.events.map((event) => event.id)).toEqual([1, 2, 3]);
    expect(result.auditEntries.map((entry) => entry.id)).toEqual([10, 30]);
  });

  it('breaks an occurredAt tie by ascending id, in both logs', async () => {
    const sameInstant = new Date('2026-06-27T10:00:00.000Z');
    eventRepository.seed(
      eventRow({ id: 9, occurredAt: sameInstant }),
      eventRow({ id: 4, occurredAt: sameInstant }),
      eventRow({ id: 6, occurredAt: sameInstant }),
    );
    repository.seed(
      auditEntry({ id: 8, occurredAt: sameInstant }),
      auditEntry({ id: 2, occurredAt: sameInstant }),
    );

    const result = await useCase.execute(payload());

    expect(result.events.map((event) => event.id)).toEqual([4, 6, 9]);
    expect(result.auditEntries.map((entry) => entry.id)).toEqual([2, 8]);
  });

  it('yields two empty arrays for an unknown correlation id, and does not throw', async () => {
    eventRepository.seed(eventRow({ correlationId: 'some-other-request' }));
    repository.seed(auditEntry({ correlationId: 'some-other-request' }));

    const result = await useCase.execute(payload({ targetCorrelationId: 'never-seen' }));

    expect(result).toEqual({ events: [], auditEntries: [] });
  });

  it('never issues a read for a blank target — a blank id names no request', async () => {
    eventRepository.seed(eventRow({ correlationId: '' }));
    repository.seed(auditEntry({ correlationId: 'some-request' }));

    // The gateway rejects these, but this RPC is directly reachable. `undefined` would be
    // DROPPED from a TypeORM `where`, turning the trace into an unbounded scan of the whole
    // audit trail; `''` is the stored sentinel for "ingested without a correlation id", so it
    // would return that entire bucket. Both must reach neither seam.
    for (const targetCorrelationId of [undefined, '', '   '] as unknown as string[]) {
      const result = await useCase.execute(payload({ targetCorrelationId }));

      expect(result).toEqual({ events: [], auditEntries: [] });
    }

    expect(eventRepository.lastCorrelationId).toBeNull();
    expect(repository.lastCorrelationId).toBeNull();
  });

  it('yields a populated auditEntries array and an empty events array', async () => {
    repository.seed(auditEntry({ id: 5 }));

    const result = await useCase.execute(payload());

    expect(result.events).toEqual([]);
    expect(result.auditEntries).toHaveLength(1);
    expect(result.auditEntries[0].id).toBe(5);
  });

  it('yields a populated events array and an empty auditEntries array', async () => {
    eventRepository.seed(eventRow({ id: 5 }));

    const result = await useCase.execute(payload());

    expect(result.auditEntries).toEqual([]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe(5);
  });

  it('projects the DomainEvent occurredAt Date to an ISO-8601 string in the view', async () => {
    eventRepository.seed(eventRow({ occurredAt: new Date('2026-06-27T10:00:00.123Z') }));

    const result = await useCase.execute(payload());

    expect(result.events[0]).toEqual({
      id: 1,
      eventType: 'retail.order.placed',
      aggregateType: 'order',
      aggregateId: '42',
      payload: { orderId: 42 },
      eventVersion: 'v1',
      producer: 'retail',
      correlationId: TARGET,
      occurredAt: '2026-06-27T10:00:00.123Z',
    });
    expect(typeof result.events[0].occurredAt).toBe('string');
  });

  it('projects the audit entry occurredAt Date to an ISO-8601 string in the view', async () => {
    repository.seed(auditEntry({ occurredAt: new Date('2026-06-27T10:00:00.456Z') }));

    const result = await useCase.execute(payload());

    expect(result.auditEntries[0].occurredAt).toBe('2026-06-27T10:00:00.456Z');
  });
});
