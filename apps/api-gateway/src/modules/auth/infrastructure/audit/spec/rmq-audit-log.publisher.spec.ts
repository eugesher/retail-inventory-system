import { ClientProxy } from '@nestjs/microservices';
import { PinoLogger } from 'nestjs-pino';
import { of, throwError } from 'rxjs';

import { IAuditLogEvent, IAuditStaffActionEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

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

  // Reads the first `emit` call as a typed [routingKey, wirePayload] tuple.
  const firstEmit = (): [string, IAuditStaffActionEvent] =>
    emit.mock.calls[0] as [string, IAuditStaffActionEvent];
  const emittedWire = (): IAuditStaffActionEvent => firstEmit()[1];

  it('emits onto the audit.staff.action routing key', async () => {
    await publisher.publish(buildEvent());

    expect(emit).toHaveBeenCalledTimes(1);
    expect(firstEmit()[0]).toBe(ROUTING_KEYS.AUDIT_STAFF_ACTION);
  });

  it('maps name → action, actorKind → actorType, targetKind/targetId → entityType/entityId', async () => {
    await publisher.publish(buildEvent());

    const wire = emittedWire();
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

    expect(emittedWire().ipAddress).toBeNull();
  });

  it('maps a non-staff actorKind to the system actorType', async () => {
    await publisher.publish(buildEvent({ actorKind: 'customer', actorId: null }));

    const wire = emittedWire();
    expect(wire.actorType).toBe('system');
    expect(wire.actorId).toBeNull();
  });

  it('records the whole payload as `after` (before null) when no before/after keys are supplied', async () => {
    await publisher.publish(buildEvent({ payload: { roleNames: ['admin'] } }));

    const wire = emittedWire();
    expect(wire.before).toBeNull();
    expect(wire.after).toEqual({ roleNames: ['admin'] });
  });

  it('uses explicit before/after payload keys when the call site supplies them', async () => {
    const before = { roleNames: [] };
    const after = { roleNames: ['admin'] };
    await publisher.publish(buildEvent({ payload: { before, after } }));

    const wire = emittedWire();
    expect(wire.before).toEqual(before);
    expect(wire.after).toEqual(after);
  });

  it('serializes occurredAt to ISO-8601, defaulting to now when the event omits it', async () => {
    const fixed = new Date('2026-06-27T10:11:12.000Z');
    await publisher.publish(buildEvent({ occurredAt: fixed }));

    expect(emittedWire().occurredAt).toBe('2026-06-27T10:11:12.000Z');
  });

  it('falls back to an empty correlationId when the event carries none', async () => {
    await publisher.publish(buildEvent({ correlationId: null }));

    expect(emittedWire().correlationId).toBe('');
  });

  it('swallows a rejected emit (best-effort post-commit) and warn-logs it', async () => {
    emit.mockReturnValue(throwError(() => new Error('broker down')));

    await expect(publisher.publish(buildEvent())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
