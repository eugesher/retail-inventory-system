import { InventoryDomainException, InventoryErrorCodeEnum } from '../inventory.exception';
import {
  ICreateReservationProps,
  IReservationProps,
  Reservation,
  ReservationStatusEnum,
} from '../reservation.model';

// A point comfortably in the future / past so `create`'s strict-future guard and
// the `commit` / `isExpired` boundary checks are unambiguous.
const future = (msAhead = 60_000): Date => new Date(Date.now() + msAhead);
const past = (msBehind = 60_000): Date => new Date(Date.now() - msBehind);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const makeCreateProps = (
  overrides: Partial<ICreateReservationProps> = {},
): ICreateReservationProps => ({
  variantId: 1,
  stockLocationId: 'default-warehouse',
  quantity: 5,
  cartId: '11111111-1111-1111-1111-111111111111',
  expiresAt: future(),
  ...overrides,
});

// Reconstitution lets a spec place a hold in ANY status/version without driving it
// through the lifecycle — the load path the mappers use.
const reconstitute = (overrides: Partial<IReservationProps> = {}): Reservation =>
  Reservation.reconstitute({
    id: '22222222-2222-2222-2222-222222222222',
    variantId: 1,
    stockLocationId: 'default-warehouse',
    quantity: 5,
    cartId: '11111111-1111-1111-1111-111111111111',
    expiresAt: future(),
    status: ReservationStatusEnum.ACTIVE,
    version: 0,
    ...overrides,
  });

// Asserts a call throws an `InventoryDomainException` carrying the given typed
// code — never matching on the (human, unstable) message.
const expectCode = (fn: () => void, code: InventoryErrorCodeEnum): void => {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InventoryDomainException);
  expect((caught as InventoryDomainException).code).toBe(code);
};

describe('Reservation', () => {
  describe('create', () => {
    it('opens an active hold at version 0 with a fresh UUID id and the given fields', () => {
      const expiresAt = future();
      const reservation = Reservation.create(
        makeCreateProps({ variantId: 7, stockLocationId: 'store-1', quantity: 3, expiresAt }),
      );

      expect(reservation.status).toBe(ReservationStatusEnum.ACTIVE);
      expect(reservation.version).toBe(0);
      expect(reservation.id).toMatch(UUID_RE);
      expect(reservation.variantId).toBe(7);
      expect(reservation.stockLocationId).toBe('store-1');
      expect(reservation.quantity).toBe(3);
      expect(reservation.cartId).toBe('11111111-1111-1111-1111-111111111111');
      expect(reservation.expiresAt).toBe(expiresAt);
    });

    it('mints a distinct id per call', () => {
      const a = Reservation.create(makeCreateProps());
      const b = Reservation.create(makeCreateProps());
      expect(a.id).not.toBe(b.id);
    });

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['non-integer', 1.5],
    ] as const)('rejects a %s quantity with RESERVATION_QUANTITY_INVALID', (_label, quantity) => {
      expectCode(
        () => Reservation.create(makeCreateProps({ quantity })),
        InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
      );
    });

    it('rejects a non-future expiresAt with a plain Error (an internal caller bug, not user input)', () => {
      expect(() => Reservation.create(makeCreateProps({ expiresAt: past() }))).toThrow(Error);
      // It is deliberately NOT a typed domain exception the filter would surface.
      expect(() => Reservation.create(makeCreateProps({ expiresAt: past() }))).not.toThrow(
        InventoryDomainException,
      );
    });
  });

  describe('transitions from active', () => {
    it('refresh adjusts quantity + TTL and stays active', () => {
      const reservation = reconstitute({ quantity: 5, version: 0 });
      const newExpiry = future(120_000);
      reservation.refresh(9, newExpiry);

      expect(reservation.status).toBe(ReservationStatusEnum.ACTIVE);
      expect(reservation.quantity).toBe(9);
      expect(reservation.expiresAt).toBe(newExpiry);
      expect(reservation.version).toBe(1);
    });

    it('refresh rejects a non-positive quantity with RESERVATION_QUANTITY_INVALID', () => {
      const reservation = reconstitute();
      expectCode(
        () => reservation.refresh(0, future()),
        InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
      );
    });

    it('release moves active → released (terminal)', () => {
      const reservation = reconstitute({ version: 0 });
      reservation.release();
      expect(reservation.status).toBe(ReservationStatusEnum.RELEASED);
      expect(reservation.version).toBe(1);
    });

    it('expire moves active → expired (terminal)', () => {
      const reservation = reconstitute({ version: 0 });
      reservation.expire();
      expect(reservation.status).toBe(ReservationStatusEnum.EXPIRED);
      expect(reservation.version).toBe(1);
    });

    it('commit moves active → committed when the hold is not wall-clock-expired', () => {
      const reservation = reconstitute({ expiresAt: future(), version: 0 });
      reservation.commit(new Date());
      expect(reservation.status).toBe(ReservationStatusEnum.COMMITTED);
      expect(reservation.version).toBe(1);
    });
  });

  describe('transitions rejected from a non-active state', () => {
    // The four active-only mutators, each wrapped so the table is uniform despite
    // their differing signatures (release/expire take no args).
    const activeOnlyMutators: readonly [string, (r: Reservation) => void][] = [
      ['refresh', (r): void => r.refresh(3, future())],
      ['release', (r): void => r.release()],
      ['expire', (r): void => r.expire()],
      ['commit', (r): void => r.commit(new Date())],
    ];

    it.each(activeOnlyMutators)(
      '%s on a released hold throws RESERVATION_INVALID_STATE',
      (_name, mutate) => {
        const reservation = reconstitute({ status: ReservationStatusEnum.RELEASED });
        expectCode(() => mutate(reservation), InventoryErrorCodeEnum.RESERVATION_INVALID_STATE);
      },
    );

    it.each(activeOnlyMutators)(
      '%s on a committed hold throws RESERVATION_INVALID_STATE',
      (_name, mutate) => {
        const reservation = reconstitute({ status: ReservationStatusEnum.COMMITTED });
        expectCode(() => mutate(reservation), InventoryErrorCodeEnum.RESERVATION_INVALID_STATE);
      },
    );
  });

  describe('reactivate', () => {
    it.each([
      ['released', ReservationStatusEnum.RELEASED],
      ['expired', ReservationStatusEnum.EXPIRED],
    ] as const)('reopens a %s hold back to active', (_label, status) => {
      const reservation = reconstitute({ status, quantity: 2, version: 4 });
      const newExpiry = future(120_000);
      reservation.reactivate(6, newExpiry);

      expect(reservation.status).toBe(ReservationStatusEnum.ACTIVE);
      expect(reservation.quantity).toBe(6);
      expect(reservation.expiresAt).toBe(newExpiry);
      expect(reservation.version).toBe(5);
    });

    it.each([
      ['active', ReservationStatusEnum.ACTIVE],
      ['committed', ReservationStatusEnum.COMMITTED],
    ] as const)('refuses to reactivate a %s hold (RESERVATION_INVALID_STATE)', (_label, status) => {
      const reservation = reconstitute({ status });
      expectCode(
        () => reservation.reactivate(6, future()),
        InventoryErrorCodeEnum.RESERVATION_INVALID_STATE,
      );
    });

    it('rejects a non-positive quantity with RESERVATION_QUANTITY_INVALID', () => {
      const reservation = reconstitute({ status: ReservationStatusEnum.RELEASED });
      expectCode(
        () => reservation.reactivate(0, future()),
        InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
      );
    });
  });

  describe('TTL semantics', () => {
    it('commit on a wall-clock-expired hold throws RESERVATION_EXPIRED', () => {
      const reservation = reconstitute({ expiresAt: past() });
      expectCode(() => reservation.commit(new Date()), InventoryErrorCodeEnum.RESERVATION_EXPIRED);
    });

    it('isExpired is true strictly after expiresAt, false at or before it', () => {
      const at = new Date('2026-06-13T12:00:00.000Z');
      const reservation = reconstitute({ expiresAt: at });

      // Equal timestamps are NOT expired (strict `<`).
      expect(reservation.isExpired(new Date(at.getTime()))).toBe(false);
      expect(reservation.isExpired(new Date(at.getTime() - 1))).toBe(false);
      expect(reservation.isExpired(new Date(at.getTime() + 1))).toBe(true);
    });
  });

  describe('version bump', () => {
    it.each<[string, (r: Reservation) => void, ReservationStatusEnum]>([
      ['refresh', (r): void => r.refresh(8, future()), ReservationStatusEnum.ACTIVE],
      ['release', (r): void => r.release(), ReservationStatusEnum.ACTIVE],
      ['expire', (r): void => r.expire(), ReservationStatusEnum.ACTIVE],
      ['commit', (r): void => r.commit(new Date()), ReservationStatusEnum.ACTIVE],
      ['reactivate', (r): void => r.reactivate(8, future()), ReservationStatusEnum.RELEASED],
    ])('%s increments version by exactly 1', (_name, mutate, status) => {
      const reservation = reconstitute({ status, version: 7, expiresAt: future() });
      mutate(reservation);
      expect(reservation.version).toBe(8);
    });
  });

  describe('reconstitute', () => {
    it('accepts a past expiresAt without throwing (the stale-active-row load path)', () => {
      const expiresAt = past();
      const reservation = reconstitute({ expiresAt, status: ReservationStatusEnum.ACTIVE });

      expect(reservation.status).toBe(ReservationStatusEnum.ACTIVE);
      expect(reservation.expiresAt).toBe(expiresAt);
      expect(reservation.isExpired(new Date())).toBe(true);
    });
  });
});
