import { AuditActorType, AuditLogEntry, ICreateAuditLogEntryProps } from '../audit-log-entry.model';

const makeCreateProps = (
  overrides: Partial<ICreateAuditLogEntryProps> = {},
): ICreateAuditLogEntryProps => ({
  actorId: 'staff-1',
  actorType: 'staff-user',
  action: 'UserLoggedIn',
  occurredAt: new Date('2026-06-27T10:00:00.000Z'),
  ...overrides,
});

describe('AuditLogEntry', () => {
  describe('construction populates the read-only getters', () => {
    it('exposes every field from create', () => {
      const occurredAt = new Date('2026-06-27T10:00:00.000Z');
      const entry = AuditLogEntry.create(
        makeCreateProps({
          actorType: 'staff-user',
          action: 'StaffUserRolesAssigned',
          entityType: 'staff-user',
          entityId: 'staff-2',
          before: { roles: ['viewer'] },
          after: { roles: ['viewer', 'admin'] },
          ipAddress: '203.0.113.7',
          correlationId: 'corr-1',
          occurredAt,
        }),
      );

      expect(entry.id).toBeNull();
      expect(entry.actorId).toBe('staff-1');
      expect(entry.actorType).toBe('staff-user');
      expect(entry.action).toBe('StaffUserRolesAssigned');
      expect(entry.entityType).toBe('staff-user');
      expect(entry.entityId).toBe('staff-2');
      expect(entry.before).toEqual({ roles: ['viewer'] });
      expect(entry.after).toEqual({ roles: ['viewer', 'admin'] });
      expect(entry.ipAddress).toBe('203.0.113.7');
      expect(entry.correlationId).toBe('corr-1');
      expect(entry.occurredAt).toBe(occurredAt);
    });

    it('occurredAt is a Date', () => {
      const entry = AuditLogEntry.create(makeCreateProps());
      expect(entry.occurredAt).toBeInstanceOf(Date);
    });
  });

  describe('actorType is constrained to the two members', () => {
    const validTypes: readonly AuditActorType[] = ['staff-user', 'system'];

    it.each(validTypes)('accepts the %s actor type', (actorType) => {
      const entry = AuditLogEntry.create(makeCreateProps({ actorType }));
      expect(entry.actorType).toBe(actorType);
    });

    it('rejects an unknown actor type', () => {
      expect(() =>
        // The cast simulates a malformed wire value reaching the model.
        AuditLogEntry.create(makeCreateProps({ actorType: 'customer' as AuditActorType })),
      ).toThrow(Error);
    });
  });

  describe('shape invariants', () => {
    it('rejects an empty action', () => {
      expect(() => AuditLogEntry.create(makeCreateProps({ action: '' }))).toThrow(Error);
      expect(() => AuditLogEntry.create(makeCreateProps({ action: '   ' }))).toThrow(Error);
    });
  });

  describe('nullable fields accept null', () => {
    it('defaults every optional field to null when omitted (e.g. a LoginFailed with no actor)', () => {
      const entry = AuditLogEntry.create({
        actorType: 'system',
        action: 'LoginFailed',
        occurredAt: new Date('2026-06-27T10:00:00.000Z'),
      });

      expect(entry.actorId).toBeNull();
      expect(entry.entityType).toBeNull();
      expect(entry.entityId).toBeNull();
      expect(entry.before).toBeNull();
      expect(entry.after).toBeNull();
      expect(entry.ipAddress).toBeNull();
      expect(entry.correlationId).toBeNull();
    });

    it('passes explicit nulls through unchanged', () => {
      const entry = AuditLogEntry.create(
        makeCreateProps({
          actorId: null,
          actorType: 'system',
          before: null,
          after: null,
          ipAddress: null,
        }),
      );

      expect(entry.actorId).toBeNull();
      expect(entry.before).toBeNull();
      expect(entry.after).toBeNull();
      expect(entry.ipAddress).toBeNull();
    });
  });

  describe('immutability (audit integrity starts in the type system)', () => {
    it('a constructed entry is frozen', () => {
      const entry = AuditLogEntry.create(makeCreateProps());
      expect(Object.isFrozen(entry)).toBe(true);
    });

    it('an attempted field write does not change the value (frozen at runtime)', () => {
      const entry = AuditLogEntry.create(makeCreateProps({ action: 'UserLoggedIn' }));
      try {
        (entry as unknown as { action: string }).action = 'tampered';
      } catch {
        // A strict-mode write to a frozen property throws; either way the value is unchanged.
      }
      expect(entry.action).toBe('UserLoggedIn');
    });

    it('exposes no instance methods at all — no mutators, no getters', () => {
      expect(Object.getOwnPropertyNames(AuditLogEntry.prototype)).toEqual(['constructor']);
    });
  });

  describe('reconstitute (load path)', () => {
    it('round-trips every field including the DB-assigned id', () => {
      const occurredAt = new Date('2026-06-27T09:30:00.000Z');
      const entry = AuditLogEntry.reconstitute({
        id: 99,
        actorId: null,
        actorType: 'system',
        action: 'RefundIssued',
        entityType: 'order',
        entityId: '7',
        before: null,
        after: { amountMinor: 500 },
        occurredAt,
        ipAddress: null,
        correlationId: 'corr-7',
      });

      expect(entry.id).toBe(99);
      expect(entry.actorId).toBeNull();
      expect(entry.actorType).toBe('system');
      expect(entry.action).toBe('RefundIssued');
      expect(entry.entityType).toBe('order');
      expect(entry.entityId).toBe('7');
      expect(entry.before).toBeNull();
      expect(entry.after).toEqual({ amountMinor: 500 });
      expect(entry.occurredAt).toBe(occurredAt);
      expect(entry.ipAddress).toBeNull();
      expect(entry.correlationId).toBe('corr-7');
    });

    it('re-asserts the invariants on load (an unknown actor type is rejected)', () => {
      expect(() =>
        AuditLogEntry.reconstitute({
          id: 1,
          actorId: 'staff-1',
          actorType: 'robot' as AuditActorType,
          action: 'UserLoggedIn',
          entityType: null,
          entityId: null,
          before: null,
          after: null,
          occurredAt: new Date(),
          ipAddress: null,
          correlationId: null,
        }),
      ).toThrow(Error);
    });
  });
});
