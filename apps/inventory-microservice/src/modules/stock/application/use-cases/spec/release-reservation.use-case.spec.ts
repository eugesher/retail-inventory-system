import { PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_STOCK_LOCATION,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { InventoryErrorCodeEnum, Reservation, StockLevel } from '../../../domain';
import { ReleaseReservationUseCase } from '../release-reservation.use-case';
import {
  ImmediateTransactionPort,
  InMemoryReservationRepository,
  InMemoryStockCache,
  InMemoryStockMovementRepository,
  InMemoryStockRepository,
  RecordingStockEventsPublisher,
} from './test-doubles';

const CART_ID = 'cart-1';
const CORRELATION_ID = 'corr-release-1';
const LOCATION = INVENTORY_DEFAULT_STOCK_LOCATION;

const futureDate = (): Date => new Date(Date.now() + 60 * 60_000);

describe('ReleaseReservationUseCase', () => {
  let repository: InMemoryStockRepository;
  let reservations: InMemoryReservationRepository;
  let movements: InMemoryStockMovementRepository;
  let cache: InMemoryStockCache;
  let publisher: RecordingStockEventsPublisher;
  let transaction: ImmediateTransactionPort;
  let useCase: ReleaseReservationUseCase;

  beforeEach(() => {
    repository = new InMemoryStockRepository();
    reservations = new InMemoryReservationRepository();
    movements = new InMemoryStockMovementRepository();
    cache = new InMemoryStockCache();
    publisher = new RecordingStockEventsPublisher();
    transaction = new ImmediateTransactionPort();
    useCase = new ReleaseReservationUseCase(
      transaction,
      repository,
      reservations,
      movements,
      cache,
      publisher,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
  });

  // Seeds an active hold + a level whose reserved counter holds exactly it.
  const seedHold = (variantId: number, quantity: number, cartId = CART_ID): Reservation => {
    repository.seedLevel(
      new StockLevel({
        variantId,
        stockLocationId: LOCATION,
        quantityOnHand: 100,
        quantityAllocated: 0,
        quantityReserved: quantity,
        version: 0,
      }),
    );
    const hold = Reservation.create({
      variantId,
      stockLocationId: LOCATION,
      quantity,
      cartId,
      expiresAt: futureDate(),
    });
    reservations.seed(hold);
    return hold;
  };

  it('releases by reservationId: counter returned, one negative release movement, released + recorded events', async () => {
    const hold = seedHold(42, 3);

    const result = await useCase.execute({
      reservationId: hold.id ?? '',
      correlationId: CORRELATION_ID,
    });

    expect(result.released).toHaveLength(1);
    expect(result.released[0].status).toBe('released');
    expect(result.released[0].reservationId).toBe(hold.id);

    // Counter returned to available.
    const level = await repository.findStockLevel(42, LOCATION);
    expect(level?.quantityReserved).toBe(0);

    // Exactly one negative `release` movement referencing the cart.
    expect(movements.appended).toHaveLength(1);
    const movement = movements.appended[0];
    expect(movement.type).toBe(StockMovementTypeEnum.RELEASE);
    expect(movement.quantity).toBe(-3);
    expect(movement.referenceType).toBe('cart');
    expect(movement.referenceId).toBe(CART_ID);
    expect(movement.reasonCode).toBe('cart-removed'); // default

    // Both post-commit events fired.
    expect(publisher.released).toHaveLength(1);
    expect(publisher.released[0].event.quantity).toBe(3);
    expect(publisher.released[0].event.reason).toBe('cart-removed');
    expect(publisher.movementsRecorded).toHaveLength(1);

    // Invalidation item correct.
    expect(cache.invalidations).toHaveLength(1);
    expect(cache.invalidations[0].items).toEqual([{ variantId: 42, stockLocationId: LOCATION }]);
  });

  it('releases ALL active holds for a cart by cartId (multi-variant), one movement per row', async () => {
    seedHold(42, 3);
    seedHold(99, 2);

    const result = await useCase.execute({ cartId: CART_ID, correlationId: CORRELATION_ID });

    expect(result.released).toHaveLength(2);
    expect(movements.appended).toHaveLength(2);
    expect(publisher.released).toHaveLength(2);
    expect(publisher.movementsRecorded).toHaveLength(2);

    expect((await repository.findStockLevel(42, LOCATION))?.quantityReserved).toBe(0);
    expect((await repository.findStockLevel(99, LOCATION))?.quantityReserved).toBe(0);

    // Two distinct invalidation items.
    expect(cache.invalidations).toHaveLength(1);
    expect(cache.invalidations[0].items).toEqual(
      expect.arrayContaining([
        { variantId: 42, stockLocationId: LOCATION },
        { variantId: 99, stockLocationId: LOCATION },
      ]),
    );
    expect(cache.invalidations[0].items).toHaveLength(2);
  });

  it('releases only the matching pair when cartId + variantId narrows the selector', async () => {
    seedHold(42, 3);
    seedHold(99, 2);

    const result = await useCase.execute({
      cartId: CART_ID,
      variantId: 42,
      correlationId: CORRELATION_ID,
    });

    expect(result.released).toHaveLength(1);
    expect(result.released[0].variantId).toBe(42);
    expect((await repository.findStockLevel(42, LOCATION))?.quantityReserved).toBe(0);
    // Variant 99's hold is untouched.
    expect((await repository.findStockLevel(99, LOCATION))?.quantityReserved).toBe(2);
  });

  it('is an idempotent no-op when a by-cart selector matches nothing', async () => {
    const result = await useCase.execute({ cartId: 'cart-empty', correlationId: CORRELATION_ID });

    expect(result.released).toEqual([]);
    expect(movements.appended).toHaveLength(0);
    expect(publisher.released).toHaveLength(0);
    expect(cache.invalidations).toHaveLength(0);
  });

  it('404s an unknown reservationId', async () => {
    await expect(
      useCase.execute({ reservationId: 'does-not-exist', correlationId: CORRELATION_ID }),
    ).rejects.toMatchObject({ code: InventoryErrorCodeEnum.RESERVATION_NOT_FOUND });
  });

  it('409s an already-released reservationId (not a silent no-op)', async () => {
    const hold = seedHold(42, 3);
    await useCase.execute({ reservationId: hold.id ?? '', correlationId: CORRELATION_ID });

    await expect(
      useCase.execute({ reservationId: hold.id ?? '', correlationId: CORRELATION_ID }),
    ).rejects.toMatchObject({ code: InventoryErrorCodeEnum.RESERVATION_INVALID_STATE });
  });

  it('rejects a malformed selector — both families present', async () => {
    const hold = seedHold(42, 3);
    await expect(
      useCase.execute({
        reservationId: hold.id ?? '',
        cartId: CART_ID,
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toMatchObject({ code: InventoryErrorCodeEnum.RESERVATION_SELECTOR_INVALID });
  });

  it('rejects a malformed selector — neither family present', async () => {
    await expect(useCase.execute({ correlationId: CORRELATION_ID })).rejects.toMatchObject({
      code: InventoryErrorCodeEnum.RESERVATION_SELECTOR_INVALID,
    });
  });

  it('propagates reason and actorId into the movement row and the released event', async () => {
    const hold = seedHold(42, 3);

    await useCase.execute({
      reservationId: hold.id ?? '',
      reason: 'manual',
      actorId: 'ops-1',
      correlationId: CORRELATION_ID,
    });

    expect(movements.appended[0].reasonCode).toBe('manual');
    expect(movements.appended[0].actorId).toBe('ops-1');
    expect(publisher.released[0].event.reason).toBe('manual');
  });
});
