import { PinoLogger } from 'nestjs-pino';

import {
  ICustomerConsentUpdatedEvent,
  ICustomerErasedEvent,
} from '@retail-inventory-system/contracts';

import { IConsentCachePort, IConsentSnapshot } from '../../../application/ports';
import { ConsentEventsConsumer } from '../consent-events.consumer';
import { FakeLogger } from './test-doubles';

// Records the write-through / eviction calls the consumer makes, and can be told to
// throw so a spec can prove the consumer swallows (never rethrows from an @EventPattern).
class RecordingConsentCache implements IConsentCachePort {
  public readonly sets: { customerId: string; consent: IConsentSnapshot }[] = [];
  public readonly dels: string[] = [];
  public throwOnSet = false;
  public throwOnDel = false;

  public get(): Promise<IConsentSnapshot> {
    throw new Error('not used by the consumer');
  }
  public set(customerId: string, consent: IConsentSnapshot): Promise<void> {
    if (this.throwOnSet) {
      return Promise.reject(new Error('cache down'));
    }
    this.sets.push({ customerId, consent });
    return Promise.resolve();
  }
  public del(customerId: string): Promise<void> {
    if (this.throwOnDel) {
      return Promise.reject(new Error('cache down'));
    }
    this.dels.push(customerId);
    return Promise.resolve();
  }
}

describe('ConsentEventsConsumer', () => {
  let cache: RecordingConsentCache;
  let logger: FakeLogger;
  let consumer: ConsentEventsConsumer;

  beforeEach(() => {
    cache = new RecordingConsentCache();
    logger = new FakeLogger();
    consumer = new ConsentEventsConsumer(cache, logger as unknown as PinoLogger);
  });

  const updatedEvent = (
    overrides: Partial<ICustomerConsentUpdatedEvent> = {},
  ): ICustomerConsentUpdatedEvent => ({
    correlationId: 'corr-consent-1',
    customerId: '11111111-1111-4111-8111-111111111111',
    transactionalEmail: true,
    marketingEmail: true,
    marketingSms: false,
    dataRetentionPolicy: 'default-7-years',
    updatedAt: '2026-07-05T10:00:00.000Z',
    eventVersion: 'v1',
    occurredAt: '2026-07-05T10:00:00.000Z',
    ...overrides,
  });

  const erasedEvent = (overrides: Partial<ICustomerErasedEvent> = {}): ICustomerErasedEvent => ({
    correlationId: 'corr-erase-1',
    customerId: '22222222-2222-4222-8222-222222222222',
    erasedAt: '2026-07-05T11:00:00.000Z',
    actorStaffUserId: 'staff-1',
    eventVersion: 'v1',
    occurredAt: '2026-07-05T11:00:00.000Z',
    ...overrides,
  });

  it('write-throughs the full consent snapshot on customer.consent.updated', async () => {
    await consumer.onConsentUpdated(updatedEvent());

    expect(cache.sets).toHaveLength(1);
    expect(cache.sets[0]).toEqual({
      customerId: '11111111-1111-4111-8111-111111111111',
      consent: {
        transactionalEmail: true,
        marketingEmail: true,
        marketingSms: false,
        dataRetentionPolicy: 'default-7-years',
      },
    });
  });

  it('evicts the cached entry on customer.erased', async () => {
    await consumer.onCustomerErased(erasedEvent());

    expect(cache.dels).toEqual(['22222222-2222-4222-8222-222222222222']);
  });

  it('does not rethrow when the cache write-through fails', async () => {
    cache.throwOnSet = true;

    await expect(consumer.onConsentUpdated(updatedEvent())).resolves.toBeUndefined();
    expect(logger.warns.some((w) => w.message?.includes('Failed to refresh consent cache'))).toBe(
      true,
    );
  });

  it('does not rethrow when the cache eviction fails', async () => {
    cache.throwOnDel = true;

    await expect(consumer.onCustomerErased(erasedEvent())).resolves.toBeUndefined();
    expect(logger.warns.some((w) => w.message?.includes('Failed to evict consent cache'))).toBe(
      true,
    );
  });
});
