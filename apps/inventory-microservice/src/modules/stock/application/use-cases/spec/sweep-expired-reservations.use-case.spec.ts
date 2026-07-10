import { PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_STOCK_LOCATION,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Reservation, ReservationStatusEnum, StockLevel } from '../../../domain';
import { IStockCacheInvalidateItem } from '../../ports';
import { StockWriteConflictError } from '../stock-write-conflict.error';
import { SweepExpiredReservationsUseCase } from '../sweep-expired-reservations.use-case';
import {
  ImmediateTransactionPort,
  InMemoryReservationRepository,
  InMemoryStockCache,
  InMemoryStockMovementRepository,
  InMemoryStockRepository,
  RecordingStockEventsPublisher,
} from './test-doubles';

const LOCATION = INVENTORY_DEFAULT_STOCK_LOCATION;
const CART_ID = 'cart-1';
const BATCH_SIZE = 200;
const TRANSACTION_SIZE = 25;

const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);
const minutesAhead = (minutes: number): Date => new Date(Date.now() + minutes * 60_000);

describe('SweepExpiredReservationsUseCase', () => {
  let repository: InMemoryStockRepository;
  let reservations: InMemoryReservationRepository;
  let movements: InMemoryStockMovementRepository;
  let cache: InMemoryStockCache;
  let publisher: RecordingStockEventsPublisher;
  let transaction: ImmediateTransactionPort;

  beforeEach(() => {
    repository = new InMemoryStockRepository();
    reservations = new InMemoryReservationRepository();
    movements = new InMemoryStockMovementRepository();
    cache = new InMemoryStockCache();
    publisher = new RecordingStockEventsPublisher();
    transaction = new ImmediateTransactionPort();
  });

  const makeUseCase = (
    batchSize = BATCH_SIZE,
    transactionSize = TRANSACTION_SIZE,
  ): SweepExpiredReservationsUseCase =>
    new SweepExpiredReservationsUseCase(
      transaction,
      repository,
      reservations,
      movements,
      cache,
      publisher,
      5, // OCC_RETRY_ATTEMPTS budget
      batchSize,
      transactionSize,
      makePinoLoggerMock() as unknown as PinoLogger,
    );

  // Seeds a stranded `active` hold — its TTL already elapsed — plus the level whose
  // reserved counter holds exactly it. `Reservation.create` refuses a past `expiresAt`
  // (a forward-computed TTL is an invariant), so the load path is the only way to build
  // one, exactly as the repository would return it.
  const seedExpiredHold = (
    id: string,
    variantId: number,
    quantity: number,
    expiresAt: Date = minutesAgo(5),
  ): Reservation => {
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
    const hold = Reservation.reconstitute({
      id,
      variantId,
      stockLocationId: LOCATION,
      quantity,
      cartId: CART_ID,
      expiresAt,
      status: ReservationStatusEnum.ACTIVE,
      version: 0,
    });
    reservations.seed(hold);
    return hold;
  };

  // A copy of `hold` in some other state — what a competing writer would have left behind.
  const variantOf = (
    hold: Reservation,
    overrides: { status?: ReservationStatusEnum; expiresAt?: Date },
  ): Reservation =>
    Reservation.reconstitute({
      id: hold.id,
      variantId: hold.variantId,
      stockLocationId: hold.stockLocationId,
      quantity: hold.quantity,
      cartId: hold.cartId,
      expiresAt: overrides.expiresAt ?? hold.expiresAt,
      status: overrides.status ?? hold.status,
      version: hold.version + 1,
    });

  it('scans once with the invocation clock and the configured batch size, and expires the candidate', async () => {
    seedExpiredHold('res-1', 42, 3);
    const scan = jest.spyOn(reservations, 'listExpiredActive');

    const result = await makeUseCase().execute({ correlationId: 'corr-sweep-1' });

    expect(scan).toHaveBeenCalledTimes(1);
    const [now, limit] = scan.mock.calls[0];
    expect(now).toBeInstanceOf(Date);
    expect(limit).toBe(BATCH_SIZE);

    expect(result).toMatchObject({ scanned: 1, expired: 1, skipped: 0 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(reservations.rows.get('res-1')?.status).toBe(ReservationStatusEnum.EXPIRED);
  });

  it('clamps an operator batch size into [1, configured] — the configured value is a ceiling', async () => {
    const scan = jest.spyOn(reservations, 'listExpiredActive');
    const useCase = makeUseCase();

    await useCase.execute({ batchSize: 10_000 });
    await useCase.execute({ batchSize: 0 });
    await useCase.execute();

    expect(scan.mock.calls.map(([, limit]) => limit)).toEqual([BATCH_SIZE, 1, BATCH_SIZE]);
  });

  it('falls back to the ceiling for a batch size that is not a finite number', async () => {
    const scan = jest.spyOn(reservations, 'listExpiredActive');
    const useCase = makeUseCase();

    // `null` reaches here through the gateway: `@IsOptional()` skips its validators for
    // `null` as well as `undefined`. The rest reach here through a direct RPC, which no
    // pipe guards. None of them may collapse to a one-row sweep (`Math.trunc(null) === 0`)
    // or to `take: NaN`.
    for (const batchSize of [null, 'abc', NaN, Infinity, {}, []] as unknown as number[]) {
      await useCase.execute({ batchSize });
    }

    expect(scan.mock.calls.map(([, limit]) => limit)).toEqual(
      new Array(6).fill(BATCH_SIZE) as number[],
    );
  });

  it('opens one transaction and one invalidation per transaction-sized chunk', async () => {
    for (let i = 1; i <= 7; i++) {
      seedExpiredHold(`res-${i}`, i, 1, minutesAgo(10 - i));
    }
    const withInvalidation = jest.spyOn(cache, 'withInvalidation');

    const result = await makeUseCase(BATCH_SIZE, 3).execute();

    // 7 candidates at 3 rows per transaction → 3 / 3 / 1.
    expect(transaction.calls).toBe(3);
    expect(withInvalidation).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ scanned: 7, expired: 7, skipped: 0 });
  });

  it('moves the counter and the row together: version captured pre-mutation, row saved expired', async () => {
    seedExpiredHold('res-1', 42, 3);
    const releaseReserved = jest.spyOn(StockLevel.prototype, 'releaseReserved');
    const persist = jest.spyOn(repository, 'persistStockLevelChange');

    await makeUseCase().execute();

    expect(releaseReserved).toHaveBeenCalledWith(3);
    // `expectedVersion` is the token read BEFORE `releaseReserved` bumped it to 1.
    const [persistedLevel, expectedVersion] = persist.mock.calls[0];
    expect(expectedVersion).toBe(0);
    expect(persistedLevel.version).toBe(1);
    expect(persistedLevel.quantityReserved).toBe(0);

    expect((await repository.findStockLevel(42, LOCATION))?.quantityReserved).toBe(0);
    expect(reservations.rows.get('res-1')?.status).toBe(ReservationStatusEnum.EXPIRED);

    releaseReserved.mockRestore();
  });

  it('appends exactly one strictly-negative `release` movement per expired hold', async () => {
    seedExpiredHold('res-1', 42, 3);

    await makeUseCase().execute({ actorId: 'ops-1' });

    expect(movements.appended).toHaveLength(1);
    const movement = movements.appended[0];
    expect(movement.type).toBe(StockMovementTypeEnum.RELEASE);
    expect(movement.quantity).toBe(-3);
    expect(movement.reasonCode).toBe('expired');
    expect(movement.referenceType).toBe('cart');
    expect(movement.referenceId).toBe(CART_ID);
    expect(movement.actorId).toBe('ops-1');
    // The ledger row joined the counter's transaction.
    expect(movements.appendScopes[0]).toBe(transaction.lastScope);
  });

  it('retries a lost compare-and-swap and skips the row the winner already released', async () => {
    const hold = seedExpiredHold('res-1', 42, 3);

    const realPersist = repository.persistStockLevelChange.bind(repository);
    let firstAttempt = true;
    jest
      .spyOn(repository, 'persistStockLevelChange')
      .mockImplementation((level, expectedVersion) => {
        if (firstAttempt) {
          firstAttempt = false;
          // The winning writer released the hold and returned the counter under us.
          reservations.rows.set(
            'res-1',
            variantOf(hold, { status: ReservationStatusEnum.RELEASED }),
          );
          return Promise.reject(
            new StockWriteConflictError(level.variantId, level.stockLocationId),
          );
        }
        return realPersist(level, expectedVersion);
      });

    const result = await makeUseCase().execute();

    expect(transaction.calls).toBe(2);
    expect(result).toMatchObject({ scanned: 1, expired: 0, skipped: 1 });
    // No double-decrement, and no orphaned ledger row from the losing attempt.
    expect(movements.appended).toHaveLength(0);
    expect(publisher.released).toHaveLength(0);
  });

  it('silently skips a vanished row, a non-active row, and a row whose TTL was pushed forward', async () => {
    const vanished = seedExpiredHold('res-1', 1, 1);
    const released = seedExpiredHold('res-2', 2, 1);
    const refreshed = seedExpiredHold('res-3', 3, 1);

    jest.spyOn(reservations, 'findById').mockImplementation((id) => {
      if (id === vanished.id) return Promise.resolve(null);
      if (id === released.id) {
        return Promise.resolve(variantOf(released, { status: ReservationStatusEnum.RELEASED }));
      }
      return Promise.resolve(variantOf(refreshed, { expiresAt: minutesAhead(15) }));
    });

    const result = await makeUseCase().execute();

    expect(result).toMatchObject({ scanned: 3, expired: 0, skipped: 3 });
    expect(movements.appended).toHaveLength(0);
    expect(publisher.released).toHaveLength(0);
    expect(cache.invalidations).toHaveLength(0);
  });

  it('invalidates through `withInvalidation`, resolving items only once the write has landed', async () => {
    seedExpiredHold('res-1', 42, 3);

    // Capture what the repository holds at the instant `resolveItems` runs — ADR-023's
    // ordering says the transaction has already resolved by then.
    let statusWhenResolved: ReservationStatusEnum | undefined;
    const realWithInvalidation = cache.withInvalidation.bind(cache);
    jest
      .spyOn(cache, 'withInvalidation')
      .mockImplementation(
        <T>(
          work: () => Promise<T>,
          resolveItems: (result: T) => IStockCacheInvalidateItem[],
          opts?: Parameters<typeof realWithInvalidation>[2],
        ) =>
          realWithInvalidation(
            work,
            (result: T) => {
              statusWhenResolved = reservations.rows.get('res-1')?.status;
              return resolveItems(result);
            },
            opts,
          ),
      );

    await makeUseCase().execute({ correlationId: 'corr-sweep-8' });

    expect(statusWhenResolved).toBe(ReservationStatusEnum.EXPIRED);
    expect(cache.invalidations).toHaveLength(1);
    expect(cache.invalidations[0].items).toEqual([{ variantId: 42, stockLocationId: LOCATION }]);
    expect(cache.invalidations[0].opts).toEqual({ correlationId: 'corr-sweep-8' });
  });

  it('emits one released event and one movement-recorded event per row, swallowing a publish failure', async () => {
    seedExpiredHold('res-1', 42, 3);

    const result = await makeUseCase().execute({ correlationId: 'corr-sweep-9' });

    expect(result.expired).toBe(1);
    expect(publisher.released).toHaveLength(1);
    expect(publisher.released[0].correlationId).toBe('corr-sweep-9');
    expect(publisher.released[0].event).toMatchObject({
      aggregateId: 42,
      quantity: 3,
      cartId: CART_ID,
      reservationId: 'res-1',
      reason: 'expired',
    });
    expect(publisher.movementsRecorded).toHaveLength(1);
  });

  it('resolves even when the released-event publish rejects (the expiry is already committed)', async () => {
    seedExpiredHold('res-1', 42, 3);
    jest.spyOn(publisher, 'publishStockReleased').mockRejectedValue(new Error('broker down'));

    const result = await makeUseCase().execute();

    expect(result).toMatchObject({ scanned: 1, expired: 1, skipped: 0 });
    expect(reservations.rows.get('res-1')?.status).toBe(ReservationStatusEnum.EXPIRED);
    // The movement announce still fires — a failed released-event never short-circuits it.
    expect(publisher.movementsRecorded).toHaveLength(1);
  });

  it('is a no-op on an empty scan: no transaction, no event, all zeroes', async () => {
    const result = await makeUseCase().execute();

    expect(result).toMatchObject({ scanned: 0, expired: 0, skipped: 0 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(transaction.calls).toBe(0);
    expect(movements.appended).toHaveLength(0);
    expect(publisher.released).toHaveLength(0);
    expect(cache.invalidations).toHaveLength(0);
  });
});
