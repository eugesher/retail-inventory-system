import { PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_STOCK_LOCATION,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  Reservation,
  ReservationStatusEnum,
  StockLevel,
} from '../../../domain';
import { CancelAllocationUseCase } from '../cancel-allocation.use-case';
import {
  ImmediateTransactionPort,
  InMemoryReservationRepository,
  InMemoryStockCache,
  InMemoryStockMovementRepository,
  InMemoryStockRepository,
  RecordingStockEventsPublisher,
} from './test-doubles';

const VARIANT_ID = 42;
const ORDER_ID = 7001;
const CORRELATION_ID = 'corr-cancel-1';
const LOCATION = INVENTORY_DEFAULT_STOCK_LOCATION;

const futureDate = (): Date => new Date(Date.now() + 60 * 60_000);

describe('CancelAllocationUseCase', () => {
  let repository: InMemoryStockRepository;
  let movements: InMemoryStockMovementRepository;
  let cache: InMemoryStockCache;
  let publisher: RecordingStockEventsPublisher;
  let transaction: ImmediateTransactionPort;
  let useCase: CancelAllocationUseCase;

  beforeEach(() => {
    repository = new InMemoryStockRepository();
    movements = new InMemoryStockMovementRepository();
    cache = new InMemoryStockCache();
    publisher = new RecordingStockEventsPublisher();
    transaction = new ImmediateTransactionPort();
    useCase = new CancelAllocationUseCase(
      transaction,
      repository,
      movements,
      cache,
      publisher,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
  });

  const seedLevel = ({
    variantId = VARIANT_ID,
    onHand = 10,
    allocated = 4,
    reserved = 0,
    version = 0,
  } = {}): void => {
    repository.seedLevel(
      new StockLevel({
        variantId,
        stockLocationId: LOCATION,
        quantityOnHand: onHand,
        quantityAllocated: allocated,
        quantityReserved: reserved,
        version,
      }),
    );
  };

  const cancel = (
    lines: { variantId: number; stockLocationId?: string; quantity: number }[],
    overrides: Partial<{ orderId: number; reason: string; actorId: string }> = {},
  ): Promise<{ cancelled: number }> =>
    useCase.execute({
      orderId: ORDER_ID,
      lines,
      correlationId: CORRELATION_ID,
      ...overrides,
    });

  it('returns allocated units to available with one negative release movement and the released + recorded events', async () => {
    seedLevel({ onHand: 10, allocated: 4 });

    const result = await cancel([{ variantId: VARIANT_ID, quantity: 4 }]);

    expect(result).toEqual({ cancelled: 1 });

    // Counter down; the units are back in available.
    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityAllocated).toBe(0);
    expect(level?.available).toBe(10);

    // Exactly one negative `release` movement referencing the order, default reason.
    expect(movements.appended).toHaveLength(1);
    const movement = movements.appended[0];
    expect(movement.type).toBe(StockMovementTypeEnum.RELEASE);
    expect(movement.quantity).toBe(-4);
    expect(movement.referenceType).toBe('order');
    expect(movement.referenceId).toBe(String(ORDER_ID));
    expect(movement.reasonCode).toBe('order-cancelled');
    expect(movement.actorId).toBeNull();

    // released event with null cart/reservation legs + the fixed order-cancelled reason.
    expect(publisher.released).toHaveLength(1);
    expect(publisher.released[0].event.aggregateId).toBe(VARIANT_ID);
    expect(publisher.released[0].event.quantity).toBe(4);
    expect(publisher.released[0].event.cartId).toBeNull();
    expect(publisher.released[0].event.reservationId).toBeNull();
    expect(publisher.released[0].event.reason).toBe('order-cancelled');
    expect(publisher.released[0].correlationId).toBe(CORRELATION_ID);
    expect(publisher.movementsRecorded).toHaveLength(1);

    expect(cache.invalidations).toHaveLength(1);
    expect(cache.invalidations[0].items).toEqual([
      { variantId: VARIANT_ID, stockLocationId: LOCATION },
    ]);
  });

  it('carries a custom reason + actorId onto the movement, but the event reason stays order-cancelled', async () => {
    seedLevel({ onHand: 10, allocated: 4 });

    await cancel([{ variantId: VARIANT_ID, quantity: 4 }], {
      reason: 'fraud-review',
      actorId: 'staff-9',
    });

    expect(movements.appended[0].reasonCode).toBe('fraud-review');
    expect(movements.appended[0].actorId).toBe('staff-9');
    // The typed event reason is fixed (the free-form reason only rides the ledger).
    expect(publisher.released[0].event.reason).toBe('order-cancelled');
  });

  it('rejects an over-cancel with STOCK_RESULT_NEGATIVE (409) and persists nothing', async () => {
    seedLevel({ onHand: 10, allocated: 2 });

    const error = await cancel([{ variantId: VARIANT_ID, quantity: 5 }]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InventoryDomainException);
    expect((error as InventoryDomainException).code).toBe(
      InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE,
    );

    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityAllocated).toBe(2);
    expect(movements.appended).toHaveLength(0);
    expect(publisher.released).toHaveLength(0);
    expect(cache.invalidations).toHaveLength(0);
  });

  it('does not touch reservation rows (an order cancel never resurrects a cart hold)', async () => {
    seedLevel({ onHand: 10, allocated: 4 });
    // A committed hold for the same triple — cancel must leave it untouched.
    const reservations = new InMemoryReservationRepository();
    const committed = Reservation.create({
      variantId: VARIANT_ID,
      stockLocationId: LOCATION,
      quantity: 4,
      cartId: 'cart-1',
      expiresAt: futureDate(),
    });
    committed.commit(new Date());
    reservations.seed(committed);

    await cancel([{ variantId: VARIANT_ID, quantity: 4 }]);

    const after = await reservations.findById(committed.id!);
    expect(after?.status).toBe(ReservationStatusEnum.COMMITTED);
  });

  it('cancels multiple lines atomically with a movement + event per line', async () => {
    seedLevel({ variantId: 1, onHand: 10, allocated: 3 });
    seedLevel({ variantId: 2, onHand: 10, allocated: 5 });

    const result = await cancel([
      { variantId: 1, quantity: 3 },
      { variantId: 2, quantity: 5 },
    ]);

    expect(result).toEqual({ cancelled: 2 });
    expect((await repository.findStockLevel(1, LOCATION))?.quantityAllocated).toBe(0);
    expect((await repository.findStockLevel(2, LOCATION))?.quantityAllocated).toBe(0);
    expect(movements.appended).toHaveLength(2);
    expect(publisher.released).toHaveLength(2);
    expect(publisher.movementsRecorded).toHaveLength(2);
    expect(cache.invalidations[0].items).toEqual([
      { variantId: 1, stockLocationId: LOCATION },
      { variantId: 2, stockLocationId: LOCATION },
    ]);
  });

  it('an over-cancel on a later line rolls the whole cancel back (atomicity)', async () => {
    seedLevel({ variantId: 1, onHand: 10, allocated: 3 }); // line A fits
    seedLevel({ variantId: 2, onHand: 10, allocated: 1 }); // line B over-cancels

    const error = await cancel([
      { variantId: 1, quantity: 3 },
      { variantId: 2, quantity: 5 },
    ]).catch((e: unknown) => e);

    expect((error as InventoryDomainException).code).toBe(
      InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE,
    );
    // The earlier line's would-be release never landed.
    expect((await repository.findStockLevel(1, LOCATION))?.quantityAllocated).toBe(3);
    expect(movements.appended).toHaveLength(0);
    expect(publisher.released).toHaveLength(0);
  });

  it('retries once on an optimistic conflict then succeeds', async () => {
    seedLevel({ onHand: 10, allocated: 4 });
    repository.conflictsBeforeSuccess = 1;

    await cancel([{ variantId: VARIANT_ID, quantity: 4 }]);

    expect(transaction.calls).toBe(2);
    expect((await repository.findStockLevel(VARIANT_ID, LOCATION))?.quantityAllocated).toBe(0);
    expect(movements.appended).toHaveLength(1);
  });

  it.each([0, -2, 1.5])(
    'rejects a non-positive / non-integer line quantity (%p)',
    async (quantity) => {
      seedLevel({ onHand: 10, allocated: 4 });

      await expect(cancel([{ variantId: VARIANT_ID, quantity }])).rejects.toMatchObject({
        code: InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
      });
      expect(cache.invalidations).toHaveLength(0);
    },
  );

  it('rejects an empty lines array', async () => {
    await expect(cancel([])).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
    });
  });
});
