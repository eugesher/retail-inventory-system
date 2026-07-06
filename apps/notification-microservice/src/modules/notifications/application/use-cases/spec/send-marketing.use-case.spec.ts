import { PinoLogger } from 'nestjs-pino';

import {
  INotificationMarketingSendPayload,
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import { NotificationDelivery } from '../../../domain';
import { IRenderAndDispatchInput, RenderAndDispatchUseCase } from '../render-and-dispatch.use-case';
import { SendMarketingUseCase } from '../send-marketing.use-case';
import { FakeLogger } from './test-doubles';

// Records the input handed to the pipeline and returns a canned persisted delivery so the
// spec can assert both the mapping AND the view projection.
class RecordingRenderAndDispatch {
  public readonly inputs: IRenderAndDispatchInput[] = [];
  public result: NotificationDelivery | null = null;

  public execute(input: IRenderAndDispatchInput): Promise<NotificationDelivery | null> {
    this.inputs.push(input);
    return Promise.resolve(this.result);
  }
}

describe('SendMarketingUseCase', () => {
  let renderAndDispatch: RecordingRenderAndDispatch;
  let logger: FakeLogger;
  let useCase: SendMarketingUseCase;

  beforeEach(() => {
    renderAndDispatch = new RecordingRenderAndDispatch();
    logger = new FakeLogger();
    useCase = new SendMarketingUseCase(
      renderAndDispatch as unknown as RenderAndDispatchUseCase,
      logger as unknown as PinoLogger,
    );
  });

  const payload = (
    overrides: Partial<INotificationMarketingSendPayload> = {},
  ): INotificationMarketingSendPayload => ({
    correlationId: 'corr-mkt-1',
    customerId: '11111111-1111-4111-8111-111111111111',
    customerEmail: 'buyer@example.com',
    eventType: 'marketing.email.promo',
    campaignId: 'camp-abc',
    context: { firstName: 'Ada' },
    ...overrides,
  });

  it('maps the marketing payload onto an email dispatch to the customer with the campaign reference', async () => {
    await useCase.execute(payload());

    expect(renderAndDispatch.inputs).toHaveLength(1);
    expect(renderAndDispatch.inputs[0]).toEqual({
      eventType: 'marketing.email.promo',
      channel: NotificationChannelEnum.EMAIL,
      recipientCustomerId: '11111111-1111-4111-8111-111111111111',
      recipientAddress: 'buyer@example.com',
      eventReferenceType: 'marketing',
      eventReferenceId: 'camp-abc',
      context: { firstName: 'Ada' },
      correlationId: 'corr-mkt-1',
    });
  });

  it('projects the resulting delivery onto the wire view', async () => {
    renderAndDispatch.result = NotificationDelivery.reconstitute({
      id: 77,
      templateId: 3,
      recipientCustomerId: '11111111-1111-4111-8111-111111111111',
      recipientAddress: 'buyer@example.com',
      channel: NotificationChannelEnum.EMAIL,
      eventReferenceType: 'marketing',
      eventReferenceId: 'camp-abc',
      status: NotificationDeliveryStatusEnum.SKIPPED_NO_CONSENT,
      attemptCount: 0,
      lastAttemptAt: null,
      failureReason: null,
      renderedSubject: 'Promo',
      renderedBody: 'Buy now',
      correlationId: 'corr-mkt-1',
    });

    const view = await useCase.execute(payload());

    expect(view).not.toBeNull();
    expect(view?.id).toBe(77);
    expect(view?.status).toBe(NotificationDeliveryStatusEnum.SKIPPED_NO_CONSENT);
  });

  it('returns null when no marketing template resolves', async () => {
    renderAndDispatch.result = null;

    const view = await useCase.execute(payload());

    expect(view).toBeNull();
  });
});
