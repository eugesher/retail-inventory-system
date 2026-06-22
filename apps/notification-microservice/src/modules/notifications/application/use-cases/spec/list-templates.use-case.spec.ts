import { PinoLogger } from 'nestjs-pino';

import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

import { NotificationTemplate } from '../../../domain';
import { ListTemplatesUseCase } from '../list-templates.use-case';
import { FakeLogger, InMemoryTemplateRepo } from './test-doubles';

// `ListTemplatesUseCase` is the filtered registry browse: every filter field is
// optional and narrows the scan, an empty filter lists every template across versions
// (active or not).
describe('ListTemplatesUseCase', () => {
  let repo: InMemoryTemplateRepo;
  let useCase: ListTemplatesUseCase;

  const author = (
    eventType: string,
    channel: NotificationChannelEnum,
    locale: string,
    version: number,
  ): Promise<NotificationTemplate> =>
    repo.save(
      NotificationTemplate.create({
        eventType,
        channel,
        locale,
        subject: channel === NotificationChannelEnum.EMAIL ? 'subj' : null,
        body: 'body',
        version,
      }),
    );

  beforeEach(async () => {
    repo = new InMemoryTemplateRepo();
    useCase = new ListTemplatesUseCase(repo, new FakeLogger() as unknown as PinoLogger);
    await author('retail.order.placed', NotificationChannelEnum.EMAIL, 'en-US', 1);
    await author('retail.order.placed', NotificationChannelEnum.EMAIL, 'en-US', 2);
    await author('retail.order.placed', NotificationChannelEnum.SMS, 'en-US', 1);
    await author('retail.refund.issued', NotificationChannelEnum.EMAIL, 'fr-FR', 1);
  });

  it('returns every template across versions for an empty filter', async () => {
    const views = await useCase.execute({ correlationId: 'corr-list-all' });

    expect(views).toHaveLength(4);
  });

  it('narrows the list by eventType', async () => {
    const views = await useCase.execute({
      eventType: 'retail.order.placed',
      correlationId: 'corr-list-event',
    });

    expect(views).toHaveLength(3);
    expect(views.every((v) => v.eventType === 'retail.order.placed')).toBe(true);
  });

  it('narrows the list by channel and locale together', async () => {
    const views = await useCase.execute({
      eventType: 'retail.order.placed',
      channel: NotificationChannelEnum.EMAIL,
      locale: 'en-US',
      correlationId: 'corr-list-narrow',
    });

    // Both retained versions of the order-placed email template.
    expect(views).toHaveLength(2);
    expect(views.map((v) => v.version).sort()).toEqual([1, 2]);
  });

  it('returns an empty array when nothing matches', async () => {
    const views = await useCase.execute({
      eventType: 'retail.return.requested',
      correlationId: 'corr-list-empty',
    });

    expect(views).toEqual([]);
  });
});
