import { PinoLogger } from 'nestjs-pino';

import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

import {
  NotificationDelivery,
  NotificationDomainException,
  NotificationErrorCodeEnum,
} from '../../../domain';
import { GetDeliveryUseCase } from '../get-delivery.use-case';
import { FakeLogger, InMemoryDeliveryRepo } from './test-doubles';

// `GetDeliveryUseCase` loads one full delivery row by id (incl. the materialized
// `renderedBody`). An unknown id is a typed `DELIVERY_NOT_FOUND`.
describe('GetDeliveryUseCase', () => {
  let repo: InMemoryDeliveryRepo;
  let useCase: GetDeliveryUseCase;

  beforeEach(() => {
    repo = new InMemoryDeliveryRepo();
    useCase = new GetDeliveryUseCase(repo, new FakeLogger() as unknown as PinoLogger);
  });

  const seed = (): Promise<NotificationDelivery> =>
    repo.save(
      NotificationDelivery.open({
        templateId: 1,
        recipientCustomerId: 'cust-uuid-1',
        recipientAddress: 'ada@example.com',
        channel: NotificationChannelEnum.EMAIL,
        eventReferenceType: 'order',
        eventReferenceId: '99',
        renderedSubject: 'Order confirmed',
        renderedBody: 'Your order is on its way',
        correlationId: 'corr-seed',
      }),
    );

  it('returns the full delivery row, including the rendered body', async () => {
    const seeded = await seed();

    const view = await useCase.execute({ id: seeded.id!, correlationId: 'corr-get' });

    expect(view.id).toBe(seeded.id);
    expect(view.recipientAddress).toBe('ada@example.com');
    expect(view.renderedBody).toBe('Your order is on its way');
    expect(view.eventReferenceType).toBe('order');
    expect(view.eventReferenceId).toBe('99');
  });

  it('rejects an unknown id with DELIVERY_NOT_FOUND', async () => {
    await expect(
      useCase.execute({ id: 4242, correlationId: 'corr-missing' }),
    ).rejects.toMatchObject({ code: NotificationErrorCodeEnum.DELIVERY_NOT_FOUND });
    await expect(
      useCase.execute({ id: 4242, correlationId: 'corr-missing' }),
    ).rejects.toBeInstanceOf(NotificationDomainException);
  });
});
