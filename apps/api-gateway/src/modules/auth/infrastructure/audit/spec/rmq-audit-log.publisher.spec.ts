import { IAuditLogEvent, IAuditStaffActionEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS, RisEventsMirrorPublisher } from '@retail-inventory-system/messaging';

import { RmqAuditLogPublisher } from '../rmq-audit-log.publisher';

const buildEvent = (overrides: Partial<IAuditLogEvent> = {}): IAuditLogEvent => ({
  name: 'StaffUserRolesAssigned',
  actorId: 'staff-1',
  actorKind: 'staff',
  targetId: 'staff-9',
  targetKind: 'staff-user',
  payload: { roleNames: ['admin'] },
  correlationId: 'cid-test',
  ...overrides,
});

describe('RmqAuditLogPublisher (api-gateway auth)', () => {
  let mirror: jest.Mock;
  let risEvents: RisEventsMirrorPublisher;
  let publisher: RmqAuditLogPublisher;

  beforeEach(() => {
    // The shared mirror publisher owns the emit + best-effort swallow (covered by its own
    // spec); here we only assert this adapter maps + delegates to it.
    mirror = jest.fn().mockResolvedValue(undefined);
    risEvents = { mirror } as unknown as RisEventsMirrorPublisher;
    publisher = new RmqAuditLogPublisher(risEvents);
  });

  // Reads the first `mirror` call as a typed [routingKey, wirePayload] tuple.
  const firstMirror = (): [string, IAuditStaffActionEvent] =>
    mirror.mock.calls[0] as [string, IAuditStaffActionEvent];
  const mirroredWire = (): IAuditStaffActionEvent => firstMirror()[1];

  it('mirrors onto the audit.staff.action routing key', async () => {
    await publisher.publish(buildEvent());

    expect(mirror).toHaveBeenCalledTimes(1);
    expect(firstMirror()[0]).toBe(ROUTING_KEYS.AUDIT_STAFF_ACTION);
  });

  it('maps name → action, actorKind → actorType, targetKind/targetId → entityType/entityId', async () => {
    await publisher.publish(buildEvent());

    const wire = mirroredWire();
    expect(wire.action).toBe('StaffUserRolesAssigned');
    expect(wire.actorType).toBe('staff-user');
    expect(wire.actorId).toBe('staff-1');
    expect(wire.entityType).toBe('staff-user');
    expect(wire.entityId).toBe('staff-9');
    expect(wire.correlationId).toBe('cid-test');
    expect(wire.eventVersion).toBe('v1');
  });

  it('records null ipAddress (no IP captured at call sites today)', async () => {
    await publisher.publish(buildEvent());

    expect(mirroredWire().ipAddress).toBeNull();
  });

  it('maps a non-staff actorKind to the system actorType', async () => {
    await publisher.publish(buildEvent({ actorKind: 'customer', actorId: null }));

    const wire = mirroredWire();
    expect(wire.actorType).toBe('system');
    expect(wire.actorId).toBeNull();
  });

  it('records the whole payload as `after` (before null) when no before/after keys are supplied', async () => {
    await publisher.publish(buildEvent({ payload: { roleNames: ['admin'] } }));

    const wire = mirroredWire();
    expect(wire.before).toBeNull();
    expect(wire.after).toEqual({ roleNames: ['admin'] });
  });

  it('uses explicit before/after payload keys when the call site supplies them', async () => {
    const before = { roleNames: [] };
    const after = { roleNames: ['admin'] };
    await publisher.publish(buildEvent({ payload: { before, after } }));

    const wire = mirroredWire();
    expect(wire.before).toEqual(before);
    expect(wire.after).toEqual(after);
  });

  it('serializes occurredAt to ISO-8601, defaulting to now when the event omits it', async () => {
    const fixed = new Date('2026-06-27T10:11:12.000Z');
    await publisher.publish(buildEvent({ occurredAt: fixed }));

    expect(mirroredWire().occurredAt).toBe('2026-06-27T10:11:12.000Z');
  });

  it('falls back to an empty correlationId when the event carries none', async () => {
    await publisher.publish(buildEvent({ correlationId: null }));

    expect(mirroredWire().correlationId).toBe('');
  });
});
