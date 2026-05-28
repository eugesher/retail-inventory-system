import { PinoLogger } from 'nestjs-pino';

import { IAuditLogEvent } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { NoOpAuditLogPublisher } from '../no-op-audit-log.publisher';

const buildEvent = (overrides: Partial<IAuditLogEvent> = {}): IAuditLogEvent => ({
  name: 'UserLoggedIn',
  actorId: 'staff-1',
  actorKind: 'staff',
  targetId: 'staff-1',
  targetKind: 'staff-user',
  payload: { email: 'user@example.com' },
  correlationId: 'cid-test',
  ...overrides,
});

describe('NoOpAuditLogPublisher', () => {
  let logger: PinoLoggerMock;
  let publisher: NoOpAuditLogPublisher;

  beforeEach(() => {
    logger = makePinoLoggerMock();
    publisher = new NoOpAuditLogPublisher(logger as unknown as PinoLogger);
  });

  it('writes a Pino debug line carrying the event-name as the message', async () => {
    await publisher.publish(buildEvent());

    expect(logger.debug).toHaveBeenCalledTimes(1);
    const call = logger.debug.mock.calls[0] as [Record<string, unknown>, string];
    const [structured, message] = call;
    expect(message).toBe('UserLoggedIn');
    expect(structured).toMatchObject({
      actorId: 'staff-1',
      actorKind: 'staff',
      targetId: 'staff-1',
      targetKind: 'staff-user',
      correlationId: 'cid-test',
      payload: { email: 'user@example.com' },
    });
  });

  it('returns a resolved promise (the contract is async even though this adapter is sync)', async () => {
    const result = publisher.publish(buildEvent({ name: 'LogoutPerformed' }));
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it('uses info-only-level Pino — no warn/error/fatal calls on a normal publish', async () => {
    await publisher.publish(buildEvent({ name: 'RefreshFailed', actorId: null }));

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
  });
});
