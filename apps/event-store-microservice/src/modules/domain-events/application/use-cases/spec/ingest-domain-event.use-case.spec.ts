import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { DomainEvent } from '../../../domain';
import { IDomainEventAppendResult, IDomainEventRepositoryPort } from '../../ports';
import { IngestDomainEventUseCase } from '../ingest-domain-event.use-case';

// A fake firehose repository that records every appended event and lets a test program
// the next `append` outcome (inserted vs. duplicate) or make it throw.
class FakeDomainEventRepository implements IDomainEventRepositoryPort {
  public readonly appended: DomainEvent[] = [];
  private nextInserted = true;
  private throwOnAppend: Error | null = null;

  public programDuplicate(): void {
    this.nextInserted = false;
  }

  public programThrow(error: Error): void {
    this.throwOnAppend = error;
  }

  public append(event: DomainEvent): Promise<IDomainEventAppendResult> {
    if (this.throwOnAppend) {
      return Promise.reject(this.throwOnAppend);
    }
    this.appended.push(event);
    return Promise.resolve({ inserted: this.nextInserted });
  }

  public listByCorrelationId(): Promise<DomainEvent[]> {
    return Promise.resolve([]);
  }
}

const ROUTING_KEY = 'retail.order.placed';
const OCCURRED_AT = '2026-06-27T10:00:00.000Z';

const wirePayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  orderId: 42,
  eventVersion: 'v1',
  occurredAt: OCCURRED_AT,
  correlationId: 'corr-ingest-1',
  ...overrides,
});

describe('IngestDomainEventUseCase', () => {
  let repository: FakeDomainEventRepository;
  let logger: ReturnType<typeof makePinoLoggerMock>;
  let useCase: IngestDomainEventUseCase;

  beforeEach(() => {
    repository = new FakeDomainEventRepository();
    logger = makePinoLoggerMock();
    useCase = new IngestDomainEventUseCase(repository, logger as unknown as PinoLogger);
  });

  it('appends a domain_event with the resolved producer/aggregate fields (happy path)', async () => {
    await useCase.execute(ROUTING_KEY, wirePayload());

    expect(repository.appended).toHaveLength(1);
    const [event] = repository.appended;
    expect(event.eventType).toBe(ROUTING_KEY);
    expect(event.producer).toBe('retail-microservice');
    expect(event.aggregateType).toBe('order');
    expect(event.aggregateId).toBe('42');
    expect(event.eventVersion).toBe('v1');
    expect(event.correlationId).toBe('corr-ingest-1');
    expect(event.occurredAt.toISOString()).toBe(OCCURRED_AT);
    expect(event.payload).toMatchObject({ orderId: 42 });
  });

  it('defaults eventVersion to v1 when the wire payload carries none', async () => {
    await useCase.execute(ROUTING_KEY, wirePayload({ eventVersion: undefined }));

    expect(repository.appended[0].eventVersion).toBe('v1');
  });

  it('coalesces an absent correlationId to the empty string (so the UNIQUE dedups)', async () => {
    await useCase.execute(ROUTING_KEY, wirePayload({ correlationId: undefined }));

    expect(repository.appended[0].correlationId).toBe('');
  });

  it('is idempotent — a duplicate-key append is a silent no-op, not an error', async () => {
    repository.programDuplicate();

    await expect(useCase.execute(ROUTING_KEY, wirePayload())).resolves.toBeUndefined();

    // The append was attempted once; the repository reported `{ inserted: false }` and the
    // use case neither threw nor logged an error.
    expect(repository.appended).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('drops a payload with a missing occurredAt (warn, no append)', async () => {
    await useCase.execute(ROUTING_KEY, wirePayload({ occurredAt: undefined }));

    expect(repository.appended).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('drops a payload with an unparseable occurredAt (warn, no append)', async () => {
    await useCase.execute(ROUTING_KEY, wirePayload({ occurredAt: 'not-a-date' }));

    expect(repository.appended).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('swallows a thrown repository error — never rethrows from the consumer path', async () => {
    repository.programThrow(new Error('connection reset'));

    await expect(useCase.execute(ROUTING_KEY, wirePayload())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
