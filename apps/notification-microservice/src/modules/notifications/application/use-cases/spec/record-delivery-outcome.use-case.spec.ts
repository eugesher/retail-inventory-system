import { PinoLogger } from 'nestjs-pino';

import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import {
  NotificationDelivery,
  NotificationDomainException,
  NotificationErrorCodeEnum,
} from '../../../domain';
import { RecordDeliveryOutcomeUseCase } from '../record-delivery-outcome.use-case';
import { FakeLogger, InMemoryDeliveryRepo } from './test-doubles';

describe('RecordDeliveryOutcomeUseCase', () => {
  let repo: InMemoryDeliveryRepo;
  let useCase: RecordDeliveryOutcomeUseCase;

  beforeEach(() => {
    repo = new InMemoryDeliveryRepo();
    useCase = new RecordDeliveryOutcomeUseCase(repo, new FakeLogger() as unknown as PinoLogger);
  });

  const seed = async (status: NotificationDeliveryStatusEnum): Promise<NotificationDelivery> => {
    const opened = NotificationDelivery.open({
      templateId: 1,
      recipientCustomerId: 'cust-uuid-1',
      recipientAddress: 'ada@example.com',
      channel: NotificationChannelEnum.EMAIL,
      eventReferenceType: 'order',
      eventReferenceId: '99',
      renderedSubject: 'Order confirmed',
      renderedBody: 'Your order is on its way',
      correlationId: 'corr-seed',
    });
    const saved = await repo.save(opened);
    if (status === NotificationDeliveryStatusEnum.QUEUED) {
      return saved;
    }
    if (status === NotificationDeliveryStatusEnum.FAILED) {
      saved.markFailed(new Date(), 'smtp down');
      return repo.save(saved);
    }
    saved.markSent(new Date());
    return repo.save(saved);
  };

  it('flips a sent delivery to delivered', async () => {
    const sent = await seed(NotificationDeliveryStatusEnum.SENT);

    const view = await useCase.execute({
      deliveryId: sent.id!,
      outcome: 'delivered',
      correlationId: 'corr-delivered',
    });

    expect(view.status).toBe(NotificationDeliveryStatusEnum.DELIVERED);
    expect(view.id).toBe(sent.id);
    expect(view.attemptCount).toBe(1);
    const reloaded = await repo.findById(sent.id!);
    expect(reloaded?.status).toBe(NotificationDeliveryStatusEnum.DELIVERED);
  });

  it('flips a sent delivery to bounced, recording the reason', async () => {
    const sent = await seed(NotificationDeliveryStatusEnum.SENT);

    const view = await useCase.execute({
      deliveryId: sent.id!,
      outcome: 'bounced',
      failureReason: 'mailbox full',
      correlationId: 'corr-bounced',
    });

    expect(view.status).toBe(NotificationDeliveryStatusEnum.BOUNCED);
    expect(view.failureReason).toBe('mailbox full');
    expect(view.attemptCount).toBe(1);
  });

  it('rejects recording an outcome on a queued delivery with DELIVERY_INVALID_STATUS_TRANSITION', async () => {
    const queued = await seed(NotificationDeliveryStatusEnum.QUEUED);

    await expect(
      useCase.execute({ deliveryId: queued.id!, outcome: 'delivered', correlationId: 'corr-q' }),
    ).rejects.toMatchObject({
      code: NotificationErrorCodeEnum.DELIVERY_INVALID_STATUS_TRANSITION,
    });
  });

  it('rejects recording an outcome on a failed delivery with DELIVERY_INVALID_STATUS_TRANSITION', async () => {
    const failed = await seed(NotificationDeliveryStatusEnum.FAILED);

    await expect(
      useCase.execute({ deliveryId: failed.id!, outcome: 'bounced', correlationId: 'corr-f' }),
    ).rejects.toBeInstanceOf(NotificationDomainException);
    await expect(
      useCase.execute({ deliveryId: failed.id!, outcome: 'bounced', correlationId: 'corr-f' }),
    ).rejects.toMatchObject({
      code: NotificationErrorCodeEnum.DELIVERY_INVALID_STATUS_TRANSITION,
    });
  });

  it('rejects an unknown delivery id with DELIVERY_NOT_FOUND', async () => {
    await expect(
      useCase.execute({ deliveryId: 4242, outcome: 'delivered', correlationId: 'corr-missing' }),
    ).rejects.toMatchObject({ code: NotificationErrorCodeEnum.DELIVERY_NOT_FOUND });
  });
});
