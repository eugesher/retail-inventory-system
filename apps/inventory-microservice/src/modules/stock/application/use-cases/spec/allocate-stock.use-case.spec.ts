import { PinoLogger } from 'nestjs-pino';

import {
  IAllocationResult,
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
import { AllocateStockUseCase } from '../allocate-stock.use-case';
import {
  ImmediateTransactionPort,
  InMemoryReservationRepository,
  InMemoryStockCache,
  InMemoryStockMovementRepository,
  InMemoryStockRepository,
  RecordingStockEventsPublisher,
} from './test-doubles';

const VARIANT_ID = 42;
const CART_ID = 'cart-1';
const ORDER_ID = 7001;
const CORRELATION_ID = 'corr-allocate-1';
const TTL_MINUTES = 15;
const LOCATION = INVENTORY_DEFAULT_STOCK_LOCATION;

const futureDate = (): Date => new Date(Date.now() + 60 * 60_000);
const pastDate = (): Date => new Date(Date.now() - 60 * 60_000);

describe('AllocateStockUseCase', () => {
  let repository: InMemoryStockRepository;
  let reservations: InMemoryReservationRepository;
  let movements: InMemoryStockMovementRepository;
  let cache: InMemoryStockCache;
  let publisher: RecordingStockEventsPublisher;
  let transaction: ImmediateTransactionPort;
  let useCase: AllocateStockUseCase;

  beforeEach(() => {
    repository = new InMemoryStockRepository();
    reservations = new InMemoryReservationRepository();
    movements = new InMemoryStockMovementRepository();
    cache = new InMemoryStockCache();
    publisher = new RecordingStockEventsPublisher();
    transaction = new ImmediateTransactionPort();
    useCase = new AllocateStockUseCase(
      transaction,
      repository,
      reservations,
      movements,
      cache,
      publisher,
      TTL_MINUTES,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
  });

  const seedLevel = ({
    variantId = VARIANT_ID,
    onHand = 10,
    allocated = 0,
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

  const seedActiveHold = (quantity: number, variantId = VARIANT_ID): Reservation => {
    const hold = Reservation.create({
      variantId,
      stockLocationId: LOCATION,
      quantity,
      cartId: CART_ID,
      expiresAt: futureDate(),
    });
    reservations.seed(hold);
    return hold;
  };

  const allocate = (
    lines: { variantId: number; stockLocationId?: string; quantity: number }[],
    overrides: Partial<{ cartId: string; orderId: number }> = {},
  ): Promise<IAllocationResult> =>
    useCase.execute({
      cartId: CART_ID,
      orderId: ORDER_ID,
      lines,
      correlationId: CORRELATION_ID,
      ...overrides,
    });

  it('commits an active hold and moves the counter reserved → allocated, with one negative allocation movement and the reservationId on the event', async () => {
    seedLevel({ onHand: 10, reserved: 4 });
    const hold = seedActiveHold(4);

    const result = await allocate([{ variantId: VARIANT_ID, quantity: 4 }]);

    expect(result.allocated).toEqual([
      { variantId: VARIANT_ID, stockLocationId: LOCATION, quantity: 4, reservationId: hold.id },
    ]);

    // Counter moved reserved → allocated; available unchanged (both subtract).
    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityReserved).toBe(0);
    expect(level?.quantityAllocated).toBe(4);
    expect(level?.available).toBe(6);

    // The hold is now committed.
    const saved = await reservations.findById(hold.id!);
    expect(saved?.status).toBe(ReservationStatusEnum.COMMITTED);

    // Exactly one negative `allocation` movement referencing the order.
    expect(movements.appended).toHaveLength(1);
    const movement = movements.appended[0];
    expect(movement.type).toBe(StockMovementTypeEnum.ALLOCATION);
    expect(movement.quantity).toBe(-4);
    expect(movement.referenceType).toBe('order');
    expect(movement.referenceId).toBe(String(ORDER_ID));
    expect(movement.reasonCode).toBeNull();
    expect(movement.actorId).toBeNull();

    // The allocated event carries the reservationId + orderId; movement-recorded too.
    expect(publisher.allocated).toHaveLength(1);
    expect(publisher.allocated[0].event.aggregateId).toBe(VARIANT_ID);
    expect(publisher.allocated[0].event.quantity).toBe(4);
    expect(publisher.allocated[0].event.orderId).toBe(ORDER_ID);
    expect(publisher.allocated[0].event.reservationId).toBe(hold.id);
    expect(publisher.allocated[0].correlationId).toBe(CORRELATION_ID);
    expect(publisher.movementsRecorded).toHaveLength(1);

    // Invalidation fired post-commit with the mutated (variantId, stockLocationId).
    expect(cache.invalidations).toHaveLength(1);
    expect(cache.invalidations[0].items).toEqual([
      { variantId: VARIANT_ID, stockLocationId: LOCATION },
    ]);
  });

  it('refreshes a wall-clock-expired but still-active hold before committing — never surfaces RESERVATION_EXPIRED', async () => {
    seedLevel({ onHand: 10, reserved: 4 });
    const expired = Reservation.reconstitute({
      id: 'res-expired-1',
      variantId: VARIANT_ID,
      stockLocationId: LOCATION,
      quantity: 4,
      cartId: CART_ID,
      expiresAt: pastDate(),
      status: ReservationStatusEnum.ACTIVE,
      version: 0,
    });
    reservations.seed(expired);

    const result = await allocate([{ variantId: VARIANT_ID, quantity: 4 }]);

    expect(result.allocated[0].reservationId).toBe('res-expired-1');

    const saved = await reservations.findById('res-expired-1');
    expect(saved?.status).toBe(ReservationStatusEnum.COMMITTED);
    // The TTL was pushed forward (refresh-then-commit) — no longer in the past.
    expect(saved!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityAllocated).toBe(4);
    expect(level?.quantityReserved).toBe(0);
  });

  it('drift (hold 2, line 3): releases the held units then allocates the order quantity through available', async () => {
    seedLevel({ onHand: 10, reserved: 2 }); // available 8
    seedActiveHold(2);

    await allocate([{ variantId: VARIANT_ID, quantity: 3 }]);

    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityReserved).toBe(0);
    expect(level?.quantityAllocated).toBe(3);
    expect(level?.available).toBe(7);
  });

  it('drift (hold 3, line 2): the symmetric case returns the surplus held unit to available', async () => {
    seedLevel({ onHand: 10, reserved: 3 }); // available 7
    seedActiveHold(3);

    await allocate([{ variantId: VARIANT_ID, quantity: 2 }]);

    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityReserved).toBe(0);
    expect(level?.quantityAllocated).toBe(2);
    expect(level?.available).toBe(8);
  });

  it('drift where the larger ask no longer fits → OUT_OF_STOCK with details.available', async () => {
    // onHand 5, reserved 2 → available 3; after releasing the held 2, available 5.
    seedLevel({ onHand: 5, reserved: 2 });
    seedActiveHold(2);

    const error = await allocate([{ variantId: VARIANT_ID, quantity: 10 }]).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(InventoryDomainException);
    expect((error as InventoryDomainException).code).toBe(InventoryErrorCodeEnum.OUT_OF_STOCK);
    expect((error as InventoryDomainException).details).toEqual({ available: 5 });
    // Nothing committed.
    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityAllocated).toBe(0);
    expect(level?.quantityReserved).toBe(2);
    expect(movements.appended).toHaveLength(0);
    expect(publisher.allocated).toHaveLength(0);
  });

  it('fallback: no hold + sufficient available → direct allocation with reservationId null', async () => {
    seedLevel({ onHand: 10 });

    const result = await allocate([{ variantId: VARIANT_ID, quantity: 4 }]);

    expect(result.allocated).toEqual([
      { variantId: VARIANT_ID, stockLocationId: LOCATION, quantity: 4, reservationId: null },
    ]);
    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityAllocated).toBe(4);
    expect(reservations.rows.size).toBe(0);
    expect(publisher.allocated[0].event.reservationId).toBeNull();
    expect(movements.appended).toHaveLength(1);
  });

  it('fallback insufficient on a later line rolls the WHOLE allocate back — nothing persisted for any line (atomicity)', async () => {
    seedLevel({ variantId: VARIANT_ID, onHand: 10 }); // line A fits
    seedLevel({ variantId: 99, onHand: 1 }); // line B does not

    const error = await allocate([
      { variantId: VARIANT_ID, quantity: 2 },
      { variantId: 99, quantity: 5 },
    ]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InventoryDomainException);
    expect((error as InventoryDomainException).code).toBe(InventoryErrorCodeEnum.OUT_OF_STOCK);
    expect((error as InventoryDomainException).details).toEqual({ available: 1 });

    // The earlier line's would-be writes never landed (the compute-then-write
    // attempt threw before any persist — the same guarantee a rolled-back tx gives).
    expect((await repository.findStockLevel(VARIANT_ID, LOCATION))?.quantityAllocated).toBe(0);
    expect((await repository.findStockLevel(99, LOCATION))?.quantityAllocated).toBe(0);
    expect(movements.appended).toHaveLength(0);
    expect(publisher.allocated).toHaveLength(0);
    expect(cache.invalidations).toHaveLength(0);
  });

  it('rejects a committed hold for the triple with RESERVATION_INVALID_STATE (double-allocate defense)', async () => {
    seedLevel({ onHand: 10, allocated: 4 });
    const committed = Reservation.create({
      variantId: VARIANT_ID,
      stockLocationId: LOCATION,
      quantity: 4,
      cartId: CART_ID,
      expiresAt: futureDate(),
    });
    committed.commit(new Date());
    reservations.seed(committed);

    await expect(allocate([{ variantId: VARIANT_ID, quantity: 4 }])).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.RESERVATION_INVALID_STATE,
    });
    expect(movements.appended).toHaveLength(0);
    expect(publisher.allocated).toHaveLength(0);
  });

  it('loads a shared (variant, location) level once across multiple lines and emits per line', async () => {
    seedLevel({ onHand: 10 });
    const loadSpy = jest.spyOn(repository, 'findStockLevel');

    const result = await allocate([
      { variantId: VARIANT_ID, quantity: 2 },
      { variantId: VARIANT_ID, quantity: 3 },
    ]);

    // Two fallback lines on one level: loaded exactly once, persisted once (the
    // counter reflects both), but a movement + event per line.
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(result.allocated).toHaveLength(2);
    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    // 5 allocated (2 + 3); +1 read call here doesn't affect the assertion above.
    expect(level?.quantityAllocated).toBe(5);
    expect(movements.appended).toHaveLength(2);
    expect(publisher.allocated).toHaveLength(2);
    expect(publisher.movementsRecorded).toHaveLength(2);
    // One distinct invalidation item for the shared pair.
    expect(cache.invalidations[0].items).toEqual([
      { variantId: VARIANT_ID, stockLocationId: LOCATION },
    ]);
  });

  it('preserves request line order in the result', async () => {
    seedLevel({ variantId: 1, onHand: 10 });
    seedLevel({ variantId: 2, onHand: 10 });
    seedLevel({ variantId: 3, onHand: 10 });

    const result = await allocate([
      { variantId: 3, quantity: 1 },
      { variantId: 1, quantity: 1 },
      { variantId: 2, quantity: 1 },
    ]);

    expect(result.allocated.map((entry) => entry.variantId)).toEqual([3, 1, 2]);
  });

  it('retries once on an optimistic conflict then succeeds (two attempts, applied once)', async () => {
    seedLevel({ onHand: 10 });
    repository.conflictsBeforeSuccess = 1;

    const result = await allocate([{ variantId: VARIANT_ID, quantity: 4 }]);

    expect(result.allocated[0].quantity).toBe(4);
    expect(transaction.calls).toBe(2);
    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityAllocated).toBe(4);
    expect(movements.appended).toHaveLength(1);
  });

  it('exhausts the bounded retry budget and surfaces STOCK_WRITE_CONFLICT (409)', async () => {
    seedLevel({ onHand: 10 });
    repository.conflictsBeforeSuccess = 99;

    const error = await allocate([{ variantId: VARIANT_ID, quantity: 4 }]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InventoryDomainException);
    expect((error as InventoryDomainException).code).toBe(
      InventoryErrorCodeEnum.STOCK_WRITE_CONFLICT,
    );
    expect(transaction.calls).toBe(5);
    expect(movements.appended).toHaveLength(0);
    expect(publisher.allocated).toHaveLength(0);
    expect(cache.invalidations).toHaveLength(0);
  });

  it.each([0, -2, 1.5])(
    'rejects a non-positive / non-integer line quantity (%p)',
    async (quantity) => {
      seedLevel({ onHand: 10 });

      await expect(allocate([{ variantId: VARIANT_ID, quantity }])).rejects.toMatchObject({
        code: InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
      });
      expect(cache.invalidations).toHaveLength(0);
    },
  );

  it('rejects an empty lines array', async () => {
    await expect(allocate([])).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
    });
  });
});
