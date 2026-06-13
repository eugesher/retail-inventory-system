import { PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_STOCK_LOCATION,
  ReservationView,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  Reservation,
  StockLevel,
  StockLocation,
  StockLocationTypeEnum,
} from '../../../domain';
import { ReserveStockUseCase } from '../reserve-stock.use-case';
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
const CORRELATION_ID = 'corr-reserve-1';
const TTL_MINUTES = 15;
const LOCATION = INVENTORY_DEFAULT_STOCK_LOCATION;

const activeLocation = (id = LOCATION): StockLocation =>
  new StockLocation({
    id,
    name: `Loc ${id}`,
    code: id.toUpperCase(),
    type: StockLocationTypeEnum.WAREHOUSE,
  });

const seedLevel = (
  repository: InMemoryStockRepository,
  { onHand = 10, allocated = 0, reserved = 0, version = 0 } = {},
): void => {
  repository.seedLevel(
    new StockLevel({
      variantId: VARIANT_ID,
      stockLocationId: LOCATION,
      quantityOnHand: onHand,
      quantityAllocated: allocated,
      quantityReserved: reserved,
      version,
    }),
  );
};

const futureDate = (): Date => new Date(Date.now() + 60 * 60_000);

describe('ReserveStockUseCase', () => {
  let repository: InMemoryStockRepository;
  let reservations: InMemoryReservationRepository;
  let movements: InMemoryStockMovementRepository;
  let cache: InMemoryStockCache;
  let publisher: RecordingStockEventsPublisher;
  let transaction: ImmediateTransactionPort;
  let useCase: ReserveStockUseCase;

  beforeEach(() => {
    repository = new InMemoryStockRepository();
    reservations = new InMemoryReservationRepository();
    movements = new InMemoryStockMovementRepository();
    cache = new InMemoryStockCache();
    publisher = new RecordingStockEventsPublisher();
    transaction = new ImmediateTransactionPort();
    repository.seedLocation(activeLocation());
    useCase = new ReserveStockUseCase(
      transaction,
      repository,
      reservations,
      cache,
      publisher,
      TTL_MINUTES,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
  });

  const reserve = (
    quantity: number,
    overrides: Partial<{ stockLocationId: string }> = {},
  ): Promise<ReservationView> =>
    useCase.execute({
      variantId: VARIANT_ID,
      quantity,
      cartId: CART_ID,
      correlationId: CORRELATION_ID,
      ...overrides,
    });

  it('creates a new hold, raises quantityReserved, returns the view, and emits stock.reserved (no movement)', async () => {
    seedLevel(repository, { onHand: 10 });

    const view = await reserve(4);

    expect(view.variantId).toBe(VARIANT_ID);
    expect(view.stockLocationId).toBe(LOCATION);
    expect(view.quantity).toBe(4);
    expect(view.cartId).toBe(CART_ID);
    expect(view.status).toBe('active');
    expect(typeof view.reservationId).toBe('string');
    expect(view.reservationId.length).toBeGreaterThan(0);

    // Counter moved on the persisted level.
    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityReserved).toBe(4);

    // Exactly one reservation row for the triple.
    expect(reservations.rows.size).toBe(1);

    // stock.reserved emitted post-commit with the absolute quantity; NO movement.
    expect(publisher.reserved).toHaveLength(1);
    expect(publisher.reserved[0].event.aggregateId).toBe(VARIANT_ID);
    expect(publisher.reserved[0].event.quantity).toBe(4);
    expect(publisher.reserved[0].event.cartId).toBe(CART_ID);
    expect(publisher.reserved[0].correlationId).toBe(CORRELATION_ID);
    expect(movements.appended).toHaveLength(0);
    expect(publisher.movementsRecorded).toHaveLength(0);

    // Invalidation fired post-commit with the mutated (variantId, stockLocationId).
    expect(cache.invalidations).toHaveLength(1);
    expect(cache.invalidations[0].items).toEqual([
      { variantId: VARIANT_ID, stockLocationId: LOCATION },
    ]);
    expect(cache.invalidations[0].opts).toMatchObject({ correlationId: CORRELATION_ID });
  });

  it('rejects OUT_OF_STOCK with details.available when the request exceeds availability — nothing persisted or emitted', async () => {
    seedLevel(repository, { onHand: 3 });

    const error = await reserve(5).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InventoryDomainException);
    expect((error as InventoryDomainException).code).toBe(InventoryErrorCodeEnum.OUT_OF_STOCK);
    expect((error as InventoryDomainException).details).toEqual({ available: 3 });

    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityReserved).toBe(0);
    expect(reservations.rows.size).toBe(0);
    expect(publisher.reserved).toHaveLength(0);
    expect(cache.invalidations).toHaveLength(0);
  });

  it('is idempotent on the triple — a re-reserve UP applies only the delta and never inserts a second row', async () => {
    seedLevel(repository, { onHand: 10 });

    await reserve(3);
    const firstId = [...reservations.rows.keys()][0];
    const view = await reserve(5); // delta +2

    expect(reservations.rows.size).toBe(1);
    expect(view.reservationId).toBe(firstId);
    expect(view.quantity).toBe(5);

    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityReserved).toBe(5);
  });

  it('is idempotent on the triple — a re-reserve DOWN releases the difference', async () => {
    seedLevel(repository, { onHand: 10 });

    await reserve(5);
    const view = await reserve(2); // delta −3

    expect(reservations.rows.size).toBe(1);
    expect(view.quantity).toBe(2);
    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityReserved).toBe(2);
  });

  it('refreshes the TTL on a re-reserve (expiresAt moves forward, version bumps)', async () => {
    seedLevel(repository, { onHand: 10 });

    const first = await reserve(3);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await reserve(3); // delta 0 — counters untouched, TTL refreshed

    expect(reservations.rows.size).toBe(1);
    expect(new Date(second.expiresAt).getTime()).toBeGreaterThan(
      new Date(first.expiresAt).getTime(),
    );
    // delta-zero leaves the counter untouched.
    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityReserved).toBe(3);
  });

  it('reactivates a released hold for the triple back to active (row reuse, not a duplicate)', async () => {
    seedLevel(repository, { onHand: 10 });
    const released = Reservation.create({
      variantId: VARIANT_ID,
      stockLocationId: LOCATION,
      quantity: 2,
      cartId: CART_ID,
      expiresAt: futureDate(),
    });
    released.release();
    reservations.seed(released);

    const view = await reserve(4);

    expect(reservations.rows.size).toBe(1);
    expect(view.reservationId).toBe(released.id);
    expect(view.status).toBe('active');
    expect(view.quantity).toBe(4);
    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityReserved).toBe(4);
  });

  it('rejects a committed hold for the triple with RESERVATION_INVALID_STATE', async () => {
    seedLevel(repository, { onHand: 10 });
    const committed = Reservation.create({
      variantId: VARIANT_ID,
      stockLocationId: LOCATION,
      quantity: 2,
      cartId: CART_ID,
      expiresAt: futureDate(),
    });
    committed.commit(new Date());
    reservations.seed(committed);

    await expect(reserve(4)).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.RESERVATION_INVALID_STATE,
    });
  });

  it('retries once on an optimistic conflict then succeeds (two attempts, applied once)', async () => {
    seedLevel(repository, { onHand: 10 });
    repository.conflictsBeforeSuccess = 1;

    const view = await reserve(4);

    expect(view.quantity).toBe(4);
    expect(transaction.calls).toBe(2);
    const level = await repository.findStockLevel(VARIANT_ID, LOCATION);
    expect(level?.quantityReserved).toBe(4);
    expect(reservations.rows.size).toBe(1);
  });

  it('exhausts the bounded retry budget and surfaces STOCK_WRITE_CONFLICT (409)', async () => {
    seedLevel(repository, { onHand: 10 });
    repository.conflictsBeforeSuccess = 99;

    const error = await reserve(4).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InventoryDomainException);
    expect((error as InventoryDomainException).code).toBe(
      InventoryErrorCodeEnum.STOCK_WRITE_CONFLICT,
    );
    expect(transaction.calls).toBe(5);
    expect(reservations.rows.size).toBe(0);
    expect(publisher.reserved).toHaveLength(0);
    expect(cache.invalidations).toHaveLength(0);
  });

  it.each([0, -2, 1.5])('rejects a non-positive / non-integer quantity (%p)', async (quantity) => {
    seedLevel(repository, { onHand: 10 });

    await expect(reserve(quantity)).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
    });
    expect(reservations.rows.size).toBe(0);
    expect(cache.invalidations).toHaveLength(0);
  });

  it('rejects when the target location does not exist', async () => {
    await expect(reserve(1, { stockLocationId: 'ghost' })).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.STOCK_LOCATION_NOT_FOUND,
    });
  });

  it('rejects when the target location is deactivated', async () => {
    const location = activeLocation('back-store');
    location.deactivate();
    repository.seedLocation(location);

    await expect(reserve(1, { stockLocationId: 'back-store' })).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.STOCK_LOCATION_INACTIVE,
    });
  });
});
