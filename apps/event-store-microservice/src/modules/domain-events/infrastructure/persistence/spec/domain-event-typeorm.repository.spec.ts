import { Repository } from 'typeorm';

import { DomainEvent } from '../../../domain';
import { DomainEventEntity } from '../domain-event.entity';
import { DomainEventTypeormRepository } from '../domain-event-typeorm.repository';

// A minimal TypeORM `Repository` double — only the methods the repository touches
// (`insert` for append). The test proves the idempotency contract WITHOUT a database:
// the composite-UNIQUE `ER_DUP_ENTRY` is swallowed as `{ inserted: false }`, a clean
// insert reports `{ inserted: true }`, and an unrelated failure still propagates. The
// full end-to-end idempotency proof is the firehose-ingestion suite + e2e (later
// capabilities); this locks the repository's swallow in isolation.
// Returns the repository double alongside the `insert` mock, so assertions hold a
// reference to the jest function rather than reaching back through the repository
// object (which the unbound-method lint rule forbids).
const makeRepositoryDouble = (
  insertImpl: () => Promise<unknown>,
): { repository: Repository<DomainEventEntity>; insert: jest.Mock } => {
  const insert = jest.fn(insertImpl);
  return {
    repository: { insert } as unknown as Repository<DomainEventEntity>,
    insert,
  };
};

const makeEvent = (): DomainEvent =>
  DomainEvent.create({
    eventType: 'retail.order.placed',
    aggregateType: 'order',
    aggregateId: '42',
    payload: { orderId: 42 },
    eventVersion: 'v1',
    producer: 'retail-microservice',
    correlationId: 'corr-1',
    occurredAt: new Date('2026-06-27T10:00:00.000Z'),
  });

describe('DomainEventTypeormRepository.append', () => {
  it('reports { inserted: true } on a clean insert', async () => {
    const { repository: repoDouble, insert } = makeRepositoryDouble(() =>
      Promise.resolve({ identifiers: [{ id: 1 }] }),
    );
    const repository = new DomainEventTypeormRepository(repoDouble);

    await expect(repository.append(makeEvent())).resolves.toEqual({ inserted: true });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('swallows the composite-UNIQUE ER_DUP_ENTRY as { inserted: false } without throwing', async () => {
    // The shape the mysql2 driver surfaces on a UNIQUE collision (a RabbitMQ redelivery
    // of an already-captured event).
    const dupError = Object.assign(new Error('duplicate'), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
    });
    const { repository: repoDouble } = makeRepositoryDouble(() => Promise.reject(dupError));
    const repository = new DomainEventTypeormRepository(repoDouble);

    await expect(repository.append(makeEvent())).resolves.toEqual({ inserted: false });
  });

  it('swallows a duplicate nested under driverError too', async () => {
    const dupError = Object.assign(new Error('duplicate'), {
      driverError: { code: 'ER_DUP_ENTRY', errno: 1062 },
    });
    const { repository: repoDouble } = makeRepositoryDouble(() => Promise.reject(dupError));
    const repository = new DomainEventTypeormRepository(repoDouble);

    await expect(repository.append(makeEvent())).resolves.toEqual({ inserted: false });
  });

  it('propagates an unrelated insert failure (only duplicates are swallowed)', async () => {
    const otherError = Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
    const { repository: repoDouble } = makeRepositoryDouble(() => Promise.reject(otherError));
    const repository = new DomainEventTypeormRepository(repoDouble);

    await expect(repository.append(makeEvent())).rejects.toThrow('connection lost');
  });
});
