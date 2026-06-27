import { ClientProxy } from '@nestjs/microservices';
import { PinoLogger } from 'nestjs-pino';
import { of, throwError } from 'rxjs';

import { IAuditLogEvent, IAuditStaffActionEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { RmqAuditLogPublisher } from '../rmq-audit-log.publisher';

// Mirrors the shape `IssueRefundUseCase.writeAudit` produces: a `RefundIssued`
// event with `targetKind` null (no audit target-kind member fits a refund, so the
// ids ride the payload) and the refund detail in the structured payload.
const buildRefundEvent = (overrides: Partial<IAuditLogEvent> = {}): IAuditLogEvent => ({
  name: 'RefundIssued',
  actorId: 'staff-7',
  actorKind: 'staff',
  targetId: '4321',
  targetKind: null,
  payload: {
    orderId: 4321,
    paymentId: 88,
    refundId: 12,
    amountMinor: 1500,
    currency: 'USD',
    reason: 'customer-request',
  },
  correlationId: 'cid-refund',
  ...overrides,
});

describe('RmqAuditLogPublisher (retail orders)', () => {
  let emit: jest.Mock;
  let client: ClientProxy;
  let logger: PinoLoggerMock;
  let publisher: RmqAuditLogPublisher;

  beforeEach(() => {
    emit = jest.fn().mockReturnValue(of(undefined));
    client = { emit } as unknown as ClientProxy;
    logger = makePinoLoggerMock();
    publisher = new RmqAuditLogPublisher(client, logger as unknown as PinoLogger);
  });

  const firstEmit = (): [string, IAuditStaffActionEvent] =>
    emit.mock.calls[0] as [string, IAuditStaffActionEvent];
  const emittedWire = (): IAuditStaffActionEvent => firstEmit()[1];

  it('emits a RefundIssued onto the audit.staff.action routing key', async () => {
    await publisher.publish(buildRefundEvent());

    expect(emit).toHaveBeenCalledTimes(1);
    expect(firstEmit()[0]).toBe(ROUTING_KEYS.AUDIT_STAFF_ACTION);
    expect(emittedWire().action).toBe('RefundIssued');
  });

  it('maps a null targetKind to a null entityType and keeps the targetId as entityId', async () => {
    await publisher.publish(buildRefundEvent());

    const wire = emittedWire();
    expect(wire.entityType).toBeNull();
    expect(wire.entityId).toBe('4321');
    expect(wire.actorType).toBe('staff-user');
    expect(wire.eventVersion).toBe('v1');
    expect(wire.ipAddress).toBeNull();
  });

  it('records the whole refund payload as `after` (before null)', async () => {
    await publisher.publish(buildRefundEvent());

    const wire = emittedWire();
    expect(wire.before).toBeNull();
    expect(wire.after).toMatchObject({ refundId: 12, amountMinor: 1500, currency: 'USD' });
  });

  it('maps the auto-refund-from-cancel system actor (null actorId) — still audited', async () => {
    await publisher.publish(buildRefundEvent({ name: 'RefundIssued', actorId: null }));

    const wire = emittedWire();
    // The refund use case audits with actorKind 'staff' even for the system path,
    // so the wire actorType stays 'staff-user'; the null actorId signals the origin.
    expect(wire.actorType).toBe('staff-user');
    expect(wire.actorId).toBeNull();
  });

  it('swallows a rejected emit (best-effort post-commit) and warn-logs it', async () => {
    emit.mockReturnValue(throwError(() => new Error('broker down')));

    await expect(publisher.publish(buildRefundEvent())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
