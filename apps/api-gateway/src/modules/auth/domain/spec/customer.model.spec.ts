import { Customer } from '../customer.model';
import { IPasswordHasher } from '../staff-user.model';

const CUSTOMER_ID = 'cccccccc-cccc-4ccc-accc-cccccccccccc';

const makeCustomer = (overrides: Partial<Parameters<typeof Customer.register>[1]> = {}): Customer =>
  Customer.register(CUSTOMER_ID, {
    email: overrides.email ?? 'CUSTOMER@Example.com',
    // Use `in` so a caller-supplied `null` survives — distinguishing
    // "not specified, want the default" from "explicitly null, exercising
    // the guest/deleted branch."
    passwordHash:
      'passwordHash' in overrides ? (overrides.passwordHash as string | null) : 'argon2-hash',
    status: overrides.status,
    phone: overrides.phone,
    firstName: overrides.firstName,
    lastName: overrides.lastName,
    emailVerifiedAt: overrides.emailVerifiedAt,
    refreshTokenHash: overrides.refreshTokenHash,
  });

describe('Customer', () => {
  describe('construction invariants', () => {
    it('lowercases the email on register', () => {
      const customer = makeCustomer({ email: 'MixedCase@Example.COM' });
      expect(customer.email).toBe('mixedcase@example.com');
    });

    it('rejects a malformed email', () => {
      expect(() => makeCustomer({ email: 'not-an-email' })).toThrow(/email must be a valid email/);
    });

    it('rejects an unknown status', () => {
      expect(() =>
        makeCustomer({
          status: 'mystery' as unknown as Parameters<typeof Customer.register>[1]['status'],
        }),
      ).toThrow(/unknown status/);
    });

    it('defaults status to "active" and emailVerifiedAt to null', () => {
      const customer = makeCustomer();
      expect(customer.status).toBe('active');
      expect(customer.emailVerifiedAt).toBeNull();
      expect(customer.isActive).toBe(true);
    });

    it('rejects null passwordHash when status is "active"', () => {
      expect(() => makeCustomer({ passwordHash: null })).toThrow(/passwordHash may be null only/);
    });

    it('accepts null passwordHash when status is "guest"', () => {
      const customer = makeCustomer({ passwordHash: null, status: 'guest' });
      expect(customer.passwordHash).toBeNull();
      expect(customer.status).toBe('guest');
    });

    it('accepts null passwordHash when status is "deleted"', () => {
      const customer = makeCustomer({ passwordHash: null, status: 'deleted' });
      expect(customer.passwordHash).toBeNull();
      expect(customer.status).toBe('deleted');
    });
  });

  describe('tombstone rehydration (status="deleted")', () => {
    it('rehydrates a deleted row with null email + null PII without throwing', () => {
      const deletedAt = new Date('2026-07-04T09:30:00.000Z');
      const customer = Customer.rehydrate(CUSTOMER_ID, {
        email: null,
        passwordHash: null,
        status: 'deleted',
        phone: null,
        firstName: null,
        lastName: null,
        emailVerifiedAt: null,
        refreshTokenHash: null,
        deletedAt,
      });

      expect(customer.status).toBe('deleted');
      expect(customer.email).toBeNull();
      expect(customer.phone).toBeNull();
      expect(customer.firstName).toBeNull();
      expect(customer.lastName).toBeNull();
      expect(customer.deletedAt).toEqual(deletedAt);
      expect(customer.isActive).toBe(false);
    });

    it('still rejects a null email for a live (non-deleted) customer', () => {
      expect(() =>
        Customer.rehydrate(CUSTOMER_ID, {
          email: null,
          passwordHash: 'argon2-hash',
          status: 'active',
        }),
      ).toThrow(/email must be a valid email/);
    });

    it('defaults deletedAt to null for a live customer', () => {
      const customer = makeCustomer();
      expect(customer.deletedAt).toBeNull();
    });
  });

  describe('status transitions', () => {
    it('suspend → reactivate flips status and isActive', () => {
      const customer = makeCustomer();
      customer.suspend();
      expect(customer.status).toBe('suspended');
      expect(customer.isActive).toBe(false);

      customer.reactivate();
      expect(customer.status).toBe('active');
      expect(customer.isActive).toBe(true);
    });

    it('isActive is false for guest and deleted rows', () => {
      const guest = makeCustomer({ passwordHash: null, status: 'guest' });
      const deleted = makeCustomer({ passwordHash: null, status: 'deleted' });
      expect(guest.isActive).toBe(false);
      expect(deleted.isActive).toBe(false);
    });
  });

  describe('erase (tombstone)', () => {
    const eraseAt = new Date('2026-07-05T12:00:00.000Z');

    const makeLive = (): Customer =>
      makeCustomer({
        email: 'buyer@example.com',
        phone: '+1-555-0100',
        firstName: 'Buy',
        lastName: 'Er',
        emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        refreshTokenHash: 'live-token-hash',
      });

    it('nulls PII, flips status to "deleted", stamps deletedAt, clears refreshTokenHash', () => {
      const customer = makeLive();

      customer.erase(eraseAt);

      expect(customer.status).toBe('deleted');
      expect(customer.deletedAt).toEqual(eraseAt);
      expect(customer.email).toBeNull();
      expect(customer.phone).toBeNull();
      expect(customer.firstName).toBeNull();
      expect(customer.lastName).toBeNull();
      expect(customer.passwordHash).toBeNull();
      expect(customer.emailVerifiedAt).toBeNull();
      expect(customer.refreshTokenHash).toBeNull();
      expect(customer.isActive).toBe(false);
    });

    it('defaults the erase instant to now when omitted', () => {
      const customer = makeLive();
      const before = Date.now();

      customer.erase();

      expect(customer.deletedAt).not.toBeNull();
      expect(customer.deletedAt!.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('records no domain event (the aggregate stays event-light)', () => {
      const customer = makeLive();
      // Drain the CustomerRegisteredEvent from construction first.
      customer.pullDomainEvents();

      customer.erase(eraseAt);

      expect(customer.pullDomainEvents()).toHaveLength(0);
    });

    it('is idempotent — a second erase re-nulls the same fields without throwing', () => {
      const customer = makeLive();
      customer.erase(eraseAt);

      const secondAt = new Date('2026-08-01T00:00:00.000Z');
      expect(() => customer.erase(secondAt)).not.toThrow();

      expect(customer.status).toBe('deleted');
      expect(customer.email).toBeNull();
      expect(customer.deletedAt).toEqual(secondAt);
    });

    it('still omits PII hashes from JSON after erase', () => {
      const customer = makeLive();
      customer.erase(eraseAt);

      const serialized = JSON.stringify(customer);
      expect(serialized).not.toContain('passwordHash');
      expect(serialized).not.toContain('refreshTokenHash');
      expect(JSON.parse(serialized)).toMatchObject({ status: 'deleted', email: null });
    });
  });

  describe('markEmailVerified', () => {
    it('sets emailVerifiedAt', () => {
      const customer = makeCustomer();
      const at = new Date('2026-05-28T10:00:00.000Z');
      customer.markEmailVerified(at);
      expect(customer.emailVerifiedAt).toEqual(at);
    });
  });

  describe('toJSON / passwordHash leakage', () => {
    it('never serializes passwordHash via JSON.stringify', () => {
      const customer = makeCustomer({ passwordHash: 'argon2-very-secret' });
      const serialized = JSON.stringify(customer);

      expect(serialized).not.toContain('argon2-very-secret');
      expect(serialized).not.toContain('passwordHash');
    });

    it('never serializes refreshTokenHash via JSON.stringify', () => {
      const customer = makeCustomer({ refreshTokenHash: 'token-hash-secret' });
      const serialized = JSON.stringify(customer);

      expect(serialized).not.toContain('token-hash-secret');
      expect(serialized).not.toContain('refreshTokenHash');
    });
  });

  describe('validatePassword', () => {
    it('delegates to the supplied hasher when passwordHash is set', async () => {
      const verifyMock = jest.fn().mockResolvedValue(true);
      const hasher: IPasswordHasher = { verify: verifyMock };
      const customer = makeCustomer({ passwordHash: 'argon2-stored' });

      const result = await customer.validatePassword('candidate', hasher);

      expect(result).toBe(true);
      expect(verifyMock).toHaveBeenCalledWith('argon2-stored', 'candidate');
    });

    it('returns false without hashing when passwordHash is null (guest row)', async () => {
      const verifyMock = jest.fn().mockResolvedValue(true);
      const hasher: IPasswordHasher = { verify: verifyMock };
      const customer = makeCustomer({ passwordHash: null, status: 'guest' });

      const result = await customer.validatePassword('candidate', hasher);

      expect(result).toBe(false);
      expect(verifyMock).not.toHaveBeenCalled();
    });
  });

  describe('recordLoggedIn', () => {
    it('emits CustomerLoggedInEvent', () => {
      const customer = makeCustomer();
      customer.recordLoggedIn();
      const events = customer.pullDomainEvents();
      const loginEvent = events.find((e) => e.constructor.name === 'CustomerLoggedInEvent');
      expect(loginEvent).toBeDefined();
    });
  });
});
