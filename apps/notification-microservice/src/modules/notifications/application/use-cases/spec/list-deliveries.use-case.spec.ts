import { PinoLogger } from 'nestjs-pino';

import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import { NotificationDelivery } from '../../../domain';
import { ListDeliveriesUseCase } from '../list-deliveries.use-case';
import { FakeLogger, InMemoryDeliveryRepo } from './test-doubles';

// `ListDeliveriesUseCase` is the paginated, filterable audit read of the delivery trail.
// Every filter field narrows the page; an absent field widens it. The result is the
// canonical `IPage<NotificationDeliveryView>` envelope.
describe('ListDeliveriesUseCase', () => {
  let repo: InMemoryDeliveryRepo;
  let useCase: ListDeliveriesUseCase;

  beforeEach(() => {
    repo = new InMemoryDeliveryRepo();
    useCase = new ListDeliveriesUseCase(repo, new FakeLogger() as unknown as PinoLogger);
  });

  // Opens + persists a delivery, optionally walking it to `sent` so a status filter has
  // something to discriminate on.
  const seed = async (overrides: {
    recipientCustomerId?: string | null;
    eventReferenceType?: string;
    eventReferenceId?: string;
    sent?: boolean;
  }): Promise<NotificationDelivery> => {
    const opened = NotificationDelivery.open({
      templateId: 1,
      recipientCustomerId: overrides.recipientCustomerId ?? 'cust-uuid-1',
      recipientAddress: 'ada@example.com',
      channel: NotificationChannelEnum.EMAIL,
      eventReferenceType: overrides.eventReferenceType ?? 'order',
      eventReferenceId: overrides.eventReferenceId ?? '99',
      renderedSubject: 'subj',
      renderedBody: 'body',
      correlationId: 'corr-seed',
    });
    const saved = await repo.save(opened);
    if (overrides.sent) {
      saved.markSent(new Date());
      return repo.save(saved);
    }
    return saved;
  };

  it('returns every delivery, newest-first, when no filter is supplied', async () => {
    await seed({ eventReferenceId: '1' });
    await seed({ eventReferenceId: '2' });
    await seed({ eventReferenceId: '3' });

    const page = await useCase.execute({ correlationId: 'corr-all' });

    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(3);
    // Newest-first: the last-seeded (highest id) row leads.
    expect(page.items[0].eventReferenceId).toBe('3');
    // Defaults applied (page 1, size 20).
    expect(page.page).toBe(1);
    expect(page.size).toBe(20);
  });

  it('narrows the page by customerId', async () => {
    await seed({ recipientCustomerId: 'cust-A' });
    await seed({ recipientCustomerId: 'cust-B' });
    await seed({ recipientCustomerId: 'cust-A' });

    const page = await useCase.execute({ customerId: 'cust-A', correlationId: 'corr-cust' });

    expect(page.total).toBe(2);
    expect(page.items.every((d) => d.recipientCustomerId === 'cust-A')).toBe(true);
  });

  it('narrows the page by status', async () => {
    await seed({ eventReferenceId: '10', sent: true });
    await seed({ eventReferenceId: '11' }); // stays queued

    const page = await useCase.execute({
      status: NotificationDeliveryStatusEnum.SENT,
      correlationId: 'corr-status',
    });

    expect(page.total).toBe(1);
    expect(page.items[0].status).toBe(NotificationDeliveryStatusEnum.SENT);
    expect(page.items[0].eventReferenceId).toBe('10');
  });

  it('narrows the page by event reference', async () => {
    await seed({ eventReferenceType: 'order', eventReferenceId: '99' });
    await seed({ eventReferenceType: 'refund', eventReferenceId: '7' });

    const page = await useCase.execute({
      eventReferenceType: 'refund',
      eventReferenceId: '7',
      correlationId: 'corr-event',
    });

    expect(page.total).toBe(1);
    expect(page.items[0].eventReferenceType).toBe('refund');
    expect(page.items[0].eventReferenceId).toBe('7');
  });

  it('honors an explicit page/pageSize', async () => {
    await seed({ eventReferenceId: '1' });
    await seed({ eventReferenceId: '2' });
    await seed({ eventReferenceId: '3' });

    const page = await useCase.execute({ page: 2, pageSize: 2, correlationId: 'corr-paged' });

    // 3 rows, page size 2 → page 2 carries the single remaining (oldest) row.
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    expect(page.page).toBe(2);
    expect(page.size).toBe(2);
    expect(page.items[0].eventReferenceId).toBe('1');
  });
});
