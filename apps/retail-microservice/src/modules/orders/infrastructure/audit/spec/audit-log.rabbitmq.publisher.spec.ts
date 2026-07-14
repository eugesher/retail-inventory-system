import { IAuditLogEvent, IAuditStaffActionEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS, RisEventsMirrorPublisher } from '@retail-inventory-system/messaging';

import { AuditLogRabbitmqPublisher } from '../audit-log.rabbitmq.publisher';

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

describe('AuditLogRabbitmqPublisher (retail orders)', () => {
  let mirror: jest.Mock;
  let risEvents: RisEventsMirrorPublisher;
  let publisher: AuditLogRabbitmqPublisher;

  beforeEach(() => {
    // The shared mirror publisher owns the emit + best-effort swallow (covered by its own
    // spec); here we only assert this adapter maps + delegates to it.
    mirror = jest.fn().mockResolvedValue(undefined);
    risEvents = { mirror } as unknown as RisEventsMirrorPublisher;
    publisher = new AuditLogRabbitmqPublisher(risEvents);
  });

  const firstMirror = (): [string, IAuditStaffActionEvent] =>
    mirror.mock.calls[0] as [string, IAuditStaffActionEvent];
  const mirroredWire = (): IAuditStaffActionEvent => firstMirror()[1];

  it('mirrors a RefundIssued onto the audit.staff.action routing key', async () => {
    await publisher.publish(buildRefundEvent());

    expect(mirror).toHaveBeenCalledTimes(1);
    expect(firstMirror()[0]).toBe(ROUTING_KEYS.AUDIT_STAFF_ACTION);
    expect(mirroredWire().action).toBe('RefundIssued');
  });

  it('maps a null targetKind to a null entityType and keeps the targetId as entityId', async () => {
    await publisher.publish(buildRefundEvent());

    const wire = mirroredWire();
    expect(wire.entityType).toBeNull();
    expect(wire.entityId).toBe('4321');
    expect(wire.actorType).toBe('staff-user');
    expect(wire.eventVersion).toBe('v1');
    expect(wire.ipAddress).toBeNull();
  });

  it('records the whole refund payload as `after` (before null)', async () => {
    await publisher.publish(buildRefundEvent());

    const wire = mirroredWire();
    expect(wire.before).toBeNull();
    expect(wire.after).toMatchObject({ refundId: 12, amountMinor: 1500, currency: 'USD' });
  });

  it('maps the auto-refund-from-cancel system actor (null actorId) — still audited', async () => {
    await publisher.publish(buildRefundEvent({ name: 'RefundIssued', actorId: null }));

    const wire = mirroredWire();
    // The refund use case audits with actorKind 'staff' even for the system path,
    // so the wire actorType stays 'staff-user'; the null actorId signals the origin.
    expect(wire.actorType).toBe('staff-user');
    expect(wire.actorId).toBeNull();
  });
});
