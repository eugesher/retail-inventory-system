import { PinoLogger } from 'nestjs-pino';

import {
  IAuditLogQueryFilters,
  IAuditLogQueryPayload,
  IPage,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { AuditLogEntry, IAuditLogEntryProps } from '../../../domain';
import { IAuditLogPageRequest, IAuditLogRepositoryPort } from '../../ports';
import { QueryAuditLogEntriesUseCase } from '../query-audit-log-entries.use-case';

// A fake audit repository that RECORDS the arguments `query` was called with — the filters
// (asserted to arrive verbatim) and the clamped page window — and returns whatever page the
// test programmed.
class RecordingAuditLogRepository implements IAuditLogRepositoryPort {
  public lastFilters: IAuditLogQueryFilters | null = null;
  public lastPage: IAuditLogPageRequest | null = null;
  public callCount = 0;
  private nextPage: IPage<AuditLogEntry> = { items: [], total: 0, page: 1, size: 20 };

  public program(page: IPage<AuditLogEntry>): void {
    this.nextPage = page;
  }

  public append(): Promise<void> {
    return Promise.reject(new Error('append is not exercised by the query spec'));
  }

  public query(
    filters: IAuditLogQueryFilters,
    page: IAuditLogPageRequest,
  ): Promise<IPage<AuditLogEntry>> {
    this.callCount += 1;
    this.lastFilters = filters;
    this.lastPage = page;
    return Promise.resolve(this.nextPage);
  }

  public listByCorrelationId(): Promise<AuditLogEntry[]> {
    return Promise.reject(new Error('the trace read is not exercised by the query spec'));
  }
}

const OCCURRED_AT = new Date('2026-06-27T10:00:00.000Z');

const makeEntry = (overrides: Partial<IAuditLogEntryProps> = {}): AuditLogEntry =>
  AuditLogEntry.reconstitute({
    id: 7,
    actorId: 'staff-1',
    actorType: 'staff-user',
    action: 'RefundIssued',
    entityType: 'refund',
    entityId: '11',
    before: null,
    after: { amount: 500 },
    occurredAt: OCCURRED_AT,
    ipAddress: null,
    correlationId: 'corr-1',
    ...overrides,
  });

const payload = (overrides: Partial<IAuditLogQueryPayload> = {}): IAuditLogQueryPayload => ({
  correlationId: 'request-trace-id',
  filters: {},
  ...overrides,
});

describe('QueryAuditLogEntriesUseCase', () => {
  let repository: RecordingAuditLogRepository;
  let logger: ReturnType<typeof makePinoLoggerMock>;
  let useCase: QueryAuditLogEntriesUseCase;

  beforeEach(() => {
    repository = new RecordingAuditLogRepository();
    logger = makePinoLoggerMock();
    useCase = new QueryAuditLogEntriesUseCase(repository, logger as unknown as PinoLogger);
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
    it.each<[string, IAuditLogQueryFilters]>([
      ['actorId', { actorId: 'staff-1' }],
      ['entityType', { entityType: 'refund' }],
      ['entityId', { entityId: '11' }],
      ['action', { action: 'RefundIssued' }],
      ['correlationId', { correlationId: 'corr-1' }],
      ['from', { from: '2026-06-01T00:00:00.000Z' }],
      ['to', { to: '2026-06-30T23:59:59.999Z' }],
    ])('passes the %s filter to the repository verbatim', async (_name, filters) => {
      await useCase.execute(payload({ filters }));

      expect(repository.lastFilters).toEqual(filters);
    });

    it('passes every filter combined to the repository verbatim', async () => {
      const filters: IAuditLogQueryFilters = {
        actorId: 'staff-1',
        entityType: 'refund',
        entityId: '11',
        action: 'RefundIssued',
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
      // `from > to` becomes `BETWEEN hi AND lo` at the repository, which selects nothing. The
      // use case pre-validates nothing and raises no domain exception.
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
    it('maps AuditLogEntry → AuditLogEntryView with occurredAt as an ISO-8601 string', async () => {
      repository.program({ items: [makeEntry()], total: 1, page: 1, size: 20 });

      const result = await useCase.execute(payload());

      expect(result.items).toEqual([
        {
          id: 7,
          actorId: 'staff-1',
          actorType: 'staff-user',
          action: 'RefundIssued',
          entityType: 'refund',
          entityId: '11',
          before: null,
          after: { amount: 500 },
          occurredAt: '2026-06-27T10:00:00.000Z',
          ipAddress: null,
          correlationId: 'corr-1',
        },
      ]);
      expect(typeof result.items[0].occurredAt).toBe('string');
    });

    it('preserves a null actorId and a null correlationId (a system-origin row)', async () => {
      repository.program({
        items: [makeEntry({ actorId: null, actorType: 'system', correlationId: null })],
        total: 1,
        page: 1,
        size: 20,
      });

      const result = await useCase.execute(payload());

      expect(result.items[0].actorId).toBeNull();
      expect(result.items[0].actorType).toBe('system');
      expect(result.items[0].correlationId).toBeNull();
    });

    it('preserves total / page / size as returned by the repository page', async () => {
      repository.program({ items: [makeEntry()], total: 137, page: 3, size: 50 });

      const result = await useCase.execute(payload({ page: 3, pageSize: 50 }));

      expect(result.total).toBe(137);
      expect(result.page).toBe(3);
      expect(result.size).toBe(50);
    });

    it('preserves the newest-first order the repository returned (it never re-sorts)', async () => {
      // The port's contract is `occurred_at DESC, id DESC`. The fake hands the rows back in
      // exactly that order; the use case must project them in place.
      const newer = makeEntry({ id: 9, occurredAt: new Date('2026-06-27T12:00:00.000Z') });
      const olderSameInstant = makeEntry({ id: 8 });
      const oldest = makeEntry({ id: 7 });
      repository.program({ items: [newer, olderSameInstant, oldest], total: 3, page: 1, size: 20 });

      const result = await useCase.execute(payload());

      expect(result.items.map((item) => item.id)).toEqual([9, 8, 7]);
    });
  });
});
