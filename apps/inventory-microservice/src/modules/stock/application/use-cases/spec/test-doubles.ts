import { VariantStockView } from '@retail-inventory-system/contracts';

import {
  Reservation,
  ReservationStatusEnum,
  StockAdjustedEvent,
  StockAllocatedEvent,
  StockCommittedEvent,
  StockLevel,
  StockLevelInitializedEvent,
  StockLocation,
  StockLowEvent,
  StockMovement,
  StockReceivedEvent,
  StockReleasedEvent,
  StockReservedEvent,
  StockReturnedEvent,
} from '../../../domain';
import {
  IReservationRepositoryPort,
  IStockCacheGetPayload,
  IStockCacheGetResult,
  IStockCacheInvalidateItem,
  IStockCachePort,
  IStockCacheSetPayload,
  IStockEventsPublisherPort,
  IStockMovementListQuery,
  IStockMovementPage,
  IStockMovementRepositoryPort,
  IStockRepositoryPort,
  ITransactionPort,
  ITransactionScope,
  IStockWithInvalidationOptions,
} from '../../ports';
import { StockWriteConflictError } from '../stock-write-conflict.error';

export class InMemoryStockRepository implements IStockRepositoryPort {
  public readonly levels = new Map<string, StockLevel>();
  public readonly locations = new Map<string, StockLocation>();
  public conflictsBeforeSuccess = 0;

  private key(variantId: number, stockLocationId: string): string {
    return `${variantId}:${stockLocationId}`;
  }

  private clone(level: StockLevel): StockLevel {
    return new StockLevel({
      id: level.id,
      variantId: level.variantId,
      stockLocationId: level.stockLocationId,
      quantityOnHand: level.quantityOnHand,
      quantityAllocated: level.quantityAllocated,
      quantityReserved: level.quantityReserved,
      version: level.version,
      updatedAt: level.updatedAt,
    });
  }

  public seedLevel(level: StockLevel): void {
    this.levels.set(this.key(level.variantId, level.stockLocationId), level);
  }

  public seedLocation(location: StockLocation): void {
    this.locations.set(location.id, location);
  }

  public findLocation(id: string): Promise<StockLocation | null> {
    return Promise.resolve(this.locations.get(id) ?? null);
  }

  public listLocations(activeOnly = false): Promise<StockLocation[]> {
    const all = [...this.locations.values()];
    return Promise.resolve(activeOnly ? all.filter((location) => location.active) : all);
  }

  public findStockLevel(variantId: number, stockLocationId: string): Promise<StockLevel | null> {
    const stored = this.levels.get(this.key(variantId, stockLocationId));
    return Promise.resolve(stored ? this.clone(stored) : null);
  }

  public findStockLevelsByVariant(
    variantId: number,
    stockLocationIds?: string[],
  ): Promise<StockLevel[]> {
    const matching = [...this.levels.values()].filter(
      (level) =>
        level.variantId === variantId &&
        (!stockLocationIds ||
          stockLocationIds.length === 0 ||
          stockLocationIds.includes(level.stockLocationId)),
    );
    return Promise.resolve(matching);
  }

  public saveStockLevel(stockLevel: StockLevel): Promise<StockLevel> {
    this.seedLevel(stockLevel);
    return Promise.resolve(stockLevel);
  }

  public persistStockLevelChange(
    stockLevel: StockLevel,
    expectedVersion: number | null,
  ): Promise<StockLevel> {
    if (this.conflictsBeforeSuccess > 0) {
      this.conflictsBeforeSuccess -= 1;
      return Promise.reject(
        new StockWriteConflictError(stockLevel.variantId, stockLevel.stockLocationId),
      );
    }

    const stored = this.levels.get(this.key(stockLevel.variantId, stockLevel.stockLocationId));
    if (expectedVersion !== null && stored && stored.version !== expectedVersion) {
      return Promise.reject(
        new StockWriteConflictError(stockLevel.variantId, stockLevel.stockLocationId),
      );
    }

    const persisted = this.clone(stockLevel);
    this.seedLevel(persisted);
    return Promise.resolve(this.clone(persisted));
  }
}

export class InMemoryStockCache implements IStockCachePort {
  public readonly store = new Map<string, VariantStockView>();
  public readonly setCalls: IStockCacheSetPayload[] = [];
  public readonly invalidations: {
    items: IStockCacheInvalidateItem[];
    opts?: IStockWithInvalidationOptions;
  }[] = [];
  public available = true;

  private key(variantId: number, stockLocationIds?: string[]): string {
    const facet =
      stockLocationIds && stockLocationIds.length > 0
        ? [...stockLocationIds].sort((a, b) => a.localeCompare(b)).join(',')
        : '__all__';
    return `${variantId}:${facet}`;
  }

  public seed(variantId: number, data: VariantStockView, stockLocationIds?: string[]): void {
    this.store.set(this.key(variantId, stockLocationIds), data);
  }

  public get(payload: IStockCacheGetPayload): Promise<IStockCacheGetResult> {
    if (!this.available) {
      return Promise.resolve({ value: undefined, available: false });
    }
    const value = this.store.get(this.key(payload.variantId, payload.stockLocationIds));
    return Promise.resolve({ value, available: true });
  }

  public set(payload: IStockCacheSetPayload): Promise<void> {
    this.store.set(this.key(payload.variantId, payload.stockLocationIds), payload.data);
    this.setCalls.push(payload);
    return Promise.resolve();
  }

  public async getOrLoad(
    payload: IStockCacheGetPayload,
    loader: () => Promise<VariantStockView>,
  ): Promise<VariantStockView> {
    const { value, available } = await this.get(payload);
    if (value !== undefined) return value;
    const data = await loader();
    if (available) {
      await this.set({
        variantId: payload.variantId,
        stockLocationIds: payload.stockLocationIds,
        data,
        correlationId: payload.correlationId,
      });
    }
    return data;
  }

  public async withInvalidation<T>(
    work: () => Promise<T>,
    resolveItems: (result: T) => IStockCacheInvalidateItem[],
    opts?: IStockWithInvalidationOptions,
  ): Promise<T> {
    const result = await work();
    const items = resolveItems(result);
    if (items.length > 0) {
      this.invalidations.push({ items, opts });
    }
    return result;
  }
}

export class ImmediateTransactionPort implements ITransactionPort {
  public calls = 0;
  public lastScope: ITransactionScope | null = null;

  public runInTransaction<T>(work: (scope: ITransactionScope) => Promise<T>): Promise<T> {
    this.calls += 1;
    const scope = {} as unknown as ITransactionScope;
    this.lastScope = scope;
    return work(scope);
  }
}

export class RecordingStockEventsPublisher implements IStockEventsPublisherPort {
  public readonly low: { event: StockLowEvent; correlationId?: string }[] = [];
  public readonly received: { event: StockReceivedEvent; correlationId?: string }[] = [];
  public readonly adjusted: { event: StockAdjustedEvent; correlationId?: string }[] = [];
  public readonly initialized: { event: StockLevelInitializedEvent; correlationId?: string }[] = [];
  public readonly reserved: { event: StockReservedEvent; correlationId?: string }[] = [];
  public readonly allocated: { event: StockAllocatedEvent; correlationId?: string }[] = [];
  public readonly released: { event: StockReleasedEvent; correlationId?: string }[] = [];
  public readonly committed: { event: StockCommittedEvent; correlationId?: string }[] = [];
  public readonly returned: { event: StockReturnedEvent; correlationId?: string }[] = [];
  public readonly movementsRecorded: { movement: StockMovement; correlationId?: string }[] = [];

  public publishStockLow(event: StockLowEvent, correlationId?: string): Promise<void> {
    this.low.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishStockReceived(event: StockReceivedEvent, correlationId?: string): Promise<void> {
    this.received.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishStockAdjusted(event: StockAdjustedEvent, correlationId?: string): Promise<void> {
    this.adjusted.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishStockLevelInitialized(
    event: StockLevelInitializedEvent,
    correlationId?: string,
  ): Promise<void> {
    this.initialized.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishStockReserved(event: StockReservedEvent, correlationId?: string): Promise<void> {
    this.reserved.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishStockAllocated(event: StockAllocatedEvent, correlationId?: string): Promise<void> {
    this.allocated.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishStockReleased(event: StockReleasedEvent, correlationId?: string): Promise<void> {
    this.released.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishStockCommitted(event: StockCommittedEvent, correlationId?: string): Promise<void> {
    this.committed.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishStockReturned(event: StockReturnedEvent, correlationId?: string): Promise<void> {
    this.returned.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishStockMovementRecorded(
    movement: StockMovement,
    correlationId?: string,
  ): Promise<void> {
    this.movementsRecorded.push({ movement, correlationId });
    return Promise.resolve();
  }
}

export class InMemoryReservationRepository implements IReservationRepositoryPort {
  public readonly rows = new Map<string, Reservation>();

  private clone(reservation: Reservation): Reservation {
    return Reservation.reconstitute({
      id: reservation.id,
      variantId: reservation.variantId,
      stockLocationId: reservation.stockLocationId,
      quantity: reservation.quantity,
      cartId: reservation.cartId,
      expiresAt: reservation.expiresAt,
      status: reservation.status,
      version: reservation.version,
      createdAt: reservation.createdAt,
      updatedAt: reservation.updatedAt,
    });
  }

  public seed(reservation: Reservation): void {
    if (reservation.id === null) {
      throw new Error('InMemoryReservationRepository.seed: reservation id is null');
    }
    this.rows.set(reservation.id, this.clone(reservation));
  }

  public findById(id: string): Promise<Reservation | null> {
    const stored = this.rows.get(id);
    return Promise.resolve(stored ? this.clone(stored) : null);
  }

  public findByKey(
    cartId: string,
    variantId: number,
    stockLocationId: string,
  ): Promise<Reservation | null> {
    const match = [...this.rows.values()].find(
      (row) =>
        row.cartId === cartId &&
        row.variantId === variantId &&
        row.stockLocationId === stockLocationId,
    );
    return Promise.resolve(match ? this.clone(match) : null);
  }

  public listActiveByCart(cartId: string): Promise<Reservation[]> {
    const matching = [...this.rows.values()].filter(
      (row) => row.cartId === cartId && row.status === ReservationStatusEnum.ACTIVE,
    );
    return Promise.resolve(matching.map((row) => this.clone(row)));
  }

  public listActiveByCartAndVariant(cartId: string, variantId: number): Promise<Reservation[]> {
    const matching = [...this.rows.values()].filter(
      (row) =>
        row.cartId === cartId &&
        row.variantId === variantId &&
        row.status === ReservationStatusEnum.ACTIVE,
    );
    return Promise.resolve(matching.map((row) => this.clone(row)));
  }

  public listExpiredActive(now: Date, limit: number): Promise<Reservation[]> {
    const matching = [...this.rows.values()]
      .filter(
        (row) =>
          row.status === ReservationStatusEnum.ACTIVE && row.expiresAt.getTime() < now.getTime(),
      )
      .sort(
        (a, b) =>
          a.expiresAt.getTime() - b.expiresAt.getTime() || (a.id ?? '').localeCompare(b.id ?? ''),
      )
      .slice(0, limit);
    return Promise.resolve(matching.map((row) => this.clone(row)));
  }

  public save(reservation: Reservation): Promise<Reservation> {
    if (reservation.id === null) {
      throw new Error('InMemoryReservationRepository.save: reservation id is null');
    }
    this.rows.set(reservation.id, this.clone(reservation));
    return Promise.resolve(this.clone(reservation));
  }
}

export class InMemoryStockMovementRepository implements IStockMovementRepositoryPort {
  public readonly appended: StockMovement[] = [];
  public readonly appendScopes: (ITransactionScope | undefined)[] = [];
  private nextId = 1;
  private duplicateOnNextAppend = false;

  public failNextAppendWithDuplicateEntry(): void {
    this.duplicateOnNextAppend = true;
  }

  public append(movement: StockMovement, scope?: ITransactionScope): Promise<StockMovement> {
    if (this.duplicateOnNextAppend) {
      this.duplicateOnNextAppend = false;
      const error = new Error(
        'Duplicate entry for key stock_movement.UC_STOCK_MOVEMENT_DEDUPE',
      ) as Error & { driverError: { errno: number; code: string } };
      error.driverError = { errno: 1062, code: 'ER_DUP_ENTRY' };
      return Promise.reject(error);
    }
    this.appendScopes.push(scope);
    const persisted = StockMovement.reconstitute({
      id: this.nextId++,
      variantId: movement.variantId,
      stockLocationId: movement.stockLocationId,
      type: movement.type,
      quantity: movement.quantity,
      reasonCode: movement.reasonCode,
      referenceType: movement.referenceType,
      referenceId: movement.referenceId,
      actorId: movement.actorId,
      operationKey: movement.operationKey,
      occurredAt: movement.occurredAt,
    });
    this.appended.push(persisted);
    return Promise.resolve(persisted);
  }

  public listByVariant(query: IStockMovementListQuery): Promise<IStockMovementPage> {
    const matching = this.appended
      .filter((movement) => movement.variantId === query.variantId)
      .filter((movement) => query.type === undefined || movement.type === query.type)
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    const start = (query.page - 1) * query.size;
    return Promise.resolve({
      items: matching.slice(start, start + query.size),
      total: matching.length,
    });
  }

  public existsByReference(referenceType: string, referenceId: string): Promise<boolean> {
    return Promise.resolve(
      this.appended.some(
        (movement) =>
          movement.referenceType === referenceType && movement.referenceId === referenceId,
      ),
    );
  }
}
