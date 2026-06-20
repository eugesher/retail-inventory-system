import { PinoLogger } from 'nestjs-pino';

import {
  IRetailReturnAuthorizedEvent,
  IRetailReturnInspectedEvent,
  IRetailReturnReceivedEvent,
  IRetailReturnRequestedEvent,
  NotificationChannelEnum,
} from '@retail-inventory-system/contracts';

import { SendReturnNotificationUseCase } from '../send-return-notification.use-case';
import { FakeLogger, InMemoryNotifier } from './test-doubles';

describe('SendReturnNotificationUseCase', () => {
  let notifier: InMemoryNotifier;
  let logger: FakeLogger;
  let useCase: SendReturnNotificationUseCase;

  const customerId = 'cust-7b3e9a10-0000-4000-8000-000000000001';

  beforeEach(() => {
    notifier = new InMemoryNotifier();
    logger = new FakeLogger();
    useCase = new SendReturnNotificationUseCase(notifier, logger as unknown as PinoLogger);
  });

  const buildRequested = (
    overrides: Partial<IRetailReturnRequestedEvent> = {},
  ): IRetailReturnRequestedEvent => ({
    correlationId: 'corr-req-1',
    rmaId: 55,
    rmaNumber: 'RMA-2026-00000055',
    orderId: 4242,
    customerId,
    requestedAt: '2026-06-18T10:00:00.000Z',
    lineCount: 2,
    eventVersion: 'v1',
    occurredAt: '2026-06-18T10:00:01.000Z',
    ...overrides,
  });

  const buildAuthorized = (
    overrides: Partial<IRetailReturnAuthorizedEvent> = {},
  ): IRetailReturnAuthorizedEvent => ({
    correlationId: 'corr-auth-1',
    rmaId: 55,
    rmaNumber: 'RMA-2026-00000055',
    orderId: 4242,
    customerId,
    authorizedAt: '2026-06-18T11:00:00.000Z',
    eventVersion: 'v1',
    occurredAt: '2026-06-18T11:00:01.000Z',
    ...overrides,
  });

  const buildReceived = (
    overrides: Partial<IRetailReturnReceivedEvent> = {},
  ): IRetailReturnReceivedEvent => ({
    correlationId: 'corr-recv-1',
    rmaId: 55,
    rmaNumber: 'RMA-2026-00000055',
    orderId: 4242,
    customerId,
    receivedAt: '2026-06-19T09:00:00.000Z',
    eventVersion: 'v1',
    occurredAt: '2026-06-19T09:00:01.000Z',
    ...overrides,
  });

  const buildInspected = (
    overrides: Partial<IRetailReturnInspectedEvent> = {},
  ): IRetailReturnInspectedEvent => ({
    correlationId: 'corr-insp-1',
    rmaId: 55,
    rmaNumber: 'RMA-2026-00000055',
    orderId: 4242,
    customerId,
    inspectedAt: '2026-06-19T14:00:00.000Z',
    restockedLineCount: 1,
    eventVersion: 'v1',
    occurredAt: '2026-06-19T14:00:01.000Z',
    ...overrides,
  });

  describe('requested', () => {
    it('dispatches a return-requested notification to the customer carrying the RMA, order, and line count', async () => {
      await useCase.requested(buildRequested());

      expect(notifier.sent).toHaveLength(1);
      const sent = notifier.sent[0];

      expect(sent.recipient).toBe(`customer:${customerId}`);
      expect(sent.channel).toBe(NotificationChannelEnum.EMAIL);
      expect(sent.subject).toContain('RMA-2026-00000055');
      expect(sent.subject).toContain('4242');
      expect(sent.body).toContain('RMA-2026-00000055');
      expect(sent.body).toContain('4242');
      expect(sent.body).toContain('2');
      expect(sent.metadata).toEqual({
        rmaId: 55,
        rmaNumber: 'RMA-2026-00000055',
        orderId: 4242,
        customerId,
        requestedAt: '2026-06-18T10:00:00.000Z',
        lineCount: 2,
        occurredAt: '2026-06-18T10:00:01.000Z',
      });
    });

    it('logs the correlationId on the dispatch line', async () => {
      await useCase.requested(buildRequested({ correlationId: 'corr-req-9' }));

      expect(logger.logs[0].context).toMatchObject({ correlationId: 'corr-req-9' });
    });
  });

  describe('authorized', () => {
    it('dispatches a return-authorized notification carrying the RMA, order, and authorization time', async () => {
      await useCase.authorized(buildAuthorized());

      expect(notifier.sent).toHaveLength(1);
      const sent = notifier.sent[0];

      expect(sent.recipient).toBe(`customer:${customerId}`);
      expect(sent.channel).toBe(NotificationChannelEnum.EMAIL);
      expect(sent.subject).toContain('authorized');
      expect(sent.subject).toContain('RMA-2026-00000055');
      expect(sent.body).toContain('2026-06-18T11:00:00.000Z');
      expect(sent.metadata).toEqual({
        rmaId: 55,
        rmaNumber: 'RMA-2026-00000055',
        orderId: 4242,
        customerId,
        authorizedAt: '2026-06-18T11:00:00.000Z',
        occurredAt: '2026-06-18T11:00:01.000Z',
      });
    });

    it('logs the correlationId on the dispatch line', async () => {
      await useCase.authorized(buildAuthorized({ correlationId: 'corr-auth-9' }));

      expect(logger.logs[0].context).toMatchObject({ correlationId: 'corr-auth-9' });
    });
  });

  describe('received', () => {
    it('dispatches a return-received notification carrying the RMA, order, and receive time', async () => {
      await useCase.received(buildReceived());

      expect(notifier.sent).toHaveLength(1);
      const sent = notifier.sent[0];

      expect(sent.recipient).toBe(`customer:${customerId}`);
      expect(sent.channel).toBe(NotificationChannelEnum.EMAIL);
      expect(sent.subject).toContain('received');
      expect(sent.subject).toContain('RMA-2026-00000055');
      expect(sent.body).toContain('2026-06-19T09:00:00.000Z');
      expect(sent.metadata).toEqual({
        rmaId: 55,
        rmaNumber: 'RMA-2026-00000055',
        orderId: 4242,
        customerId,
        receivedAt: '2026-06-19T09:00:00.000Z',
        occurredAt: '2026-06-19T09:00:01.000Z',
      });
    });

    it('logs the correlationId on the dispatch line', async () => {
      await useCase.received(buildReceived({ correlationId: 'corr-recv-9' }));

      expect(logger.logs[0].context).toMatchObject({ correlationId: 'corr-recv-9' });
    });
  });

  describe('inspected', () => {
    it('dispatches a return-inspected notification carrying the RMA, order, inspection time, and restocked-line count', async () => {
      await useCase.inspected(buildInspected());

      expect(notifier.sent).toHaveLength(1);
      const sent = notifier.sent[0];

      expect(sent.recipient).toBe(`customer:${customerId}`);
      expect(sent.channel).toBe(NotificationChannelEnum.EMAIL);
      expect(sent.subject).toContain('inspected');
      expect(sent.subject).toContain('RMA-2026-00000055');
      expect(sent.body).toContain('2026-06-19T14:00:00.000Z');
      expect(sent.body).toContain('1');
      expect(sent.metadata).toEqual({
        rmaId: 55,
        rmaNumber: 'RMA-2026-00000055',
        orderId: 4242,
        customerId,
        inspectedAt: '2026-06-19T14:00:00.000Z',
        restockedLineCount: 1,
        occurredAt: '2026-06-19T14:00:01.000Z',
      });
    });

    it('logs the correlationId and restocked-line count on the dispatch line', async () => {
      await useCase.inspected(
        buildInspected({ correlationId: 'corr-insp-9', restockedLineCount: 3 }),
      );

      expect(logger.logs[0].context).toMatchObject({
        correlationId: 'corr-insp-9',
        restockedLineCount: 3,
      });
    });
  });
});
