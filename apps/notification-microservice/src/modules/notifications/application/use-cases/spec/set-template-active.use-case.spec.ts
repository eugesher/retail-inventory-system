import { PinoLogger } from 'nestjs-pino';

import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

import {
  NotificationDomainException,
  NotificationErrorCodeEnum,
  NotificationTemplate,
} from '../../../domain';
import { SetTemplateActiveUseCase } from '../set-template-active.use-case';
import { FakeLogger, InMemoryTemplateRepo } from './test-doubles';

// `SetTemplateActiveUseCase` activates/deactivates one template version by id — the
// soft-delete (and rollback) lever. A deactivated row stays on disk and out of the
// "find latest active" resolution; an unknown id is a typed `TEMPLATE_NOT_FOUND`.
describe('SetTemplateActiveUseCase', () => {
  let repo: InMemoryTemplateRepo;
  let useCase: SetTemplateActiveUseCase;

  beforeEach(() => {
    repo = new InMemoryTemplateRepo();
    useCase = new SetTemplateActiveUseCase(repo, new FakeLogger() as unknown as PinoLogger);
  });

  const seed = async (active: boolean): Promise<NotificationTemplate> =>
    repo
      .save(
        NotificationTemplate.create({
          eventType: 'retail.order.placed',
          channel: NotificationChannelEnum.EMAIL,
          locale: 'en-US',
          subject: 'subj',
          body: 'body',
          version: 1,
        }),
      )
      .then((saved) => {
        if (!active) {
          saved.deactivate();
          return repo.save(saved);
        }
        return saved;
      });

  it('deactivates an active template, keeping the row', async () => {
    const seeded = await seed(true);

    const view = await useCase.execute({
      id: seeded.id!,
      active: false,
      correlationId: 'corr-deactivate',
    });

    expect(view.active).toBe(false);
    expect(view.id).toBe(seeded.id);
    // The row is retained (soft-delete via `active`, never removed).
    expect(repo.rows).toHaveLength(1);
  });

  it('re-activates a deactivated template', async () => {
    const seeded = await seed(false);

    const view = await useCase.execute({
      id: seeded.id!,
      active: true,
      correlationId: 'corr-activate',
    });

    expect(view.active).toBe(true);
  });

  it('rejects an unknown id with TEMPLATE_NOT_FOUND', async () => {
    await expect(
      useCase.execute({ id: 4242, active: false, correlationId: 'corr-missing' }),
    ).rejects.toMatchObject({ code: NotificationErrorCodeEnum.TEMPLATE_NOT_FOUND });
    await expect(
      useCase.execute({ id: 4242, active: false, correlationId: 'corr-missing' }),
    ).rejects.toBeInstanceOf(NotificationDomainException);
  });
});
