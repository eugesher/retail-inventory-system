// A TTL-bounded, cart-scoped hold on stock for one variant at one location
// (ADR-030). It is the unit that lets two carts NOT race for the last item before
// either checks out: while a `Reservation` is `active`, its `quantity` is counted
// into `StockLevel.quantityReserved`, so it is subtracted from `available`.
//
// Framework-free per ADR-004, modelled in the `StockLevel` style: a plain class
// with private mutable fields + getters and invariants enforced in the factories /
// mutators — NOT an `AggregateRoot`. The inventory context emits events from its
// use cases, never pulls them from the model, so there is no `pullDomainEvents()`.
//
// `variantId` is an OPAQUE cross-service link to the catalog `product_variant`,
// and `cartId` an OPAQUE link to the retail `cart`; the inventory domain MUST NOT
// import the catalog or retail aggregates — the only coupling is the FKs in
// persistence (ADR-004 / ADR-017 / ADR-027 / ADR-028).

import { randomUUID } from 'crypto';

import { InventoryDomainException, InventoryErrorCodeEnum } from './inventory.exception';

// The hold's lifecycle. Lives in `domain/`, NOT in `libs/contracts`: the wire
// carries the raw string (the lifecycle-enum convention — `CategoryStatusEnum`
// stays in catalog `domain/` the same way, ADR-025 §7 / ADR-029).
export enum ReservationStatusEnum {
  ACTIVE = 'active',
  COMMITTED = 'committed',
  RELEASED = 'released',
  EXPIRED = 'expired',
}

// Full reconstruction shape (the load path). `create` derives `id`, `status`, and
// `version` itself, so its input is the narrower `ICreateReservationProps` below.
export interface IReservationProps {
  id: string | null;
  variantId: number;
  stockLocationId: string;
  quantity: number;
  cartId: string;
  expiresAt: Date;
  status: ReservationStatusEnum;
  version: number;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export interface ICreateReservationProps {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  cartId: string;
  expiresAt: Date;
}

export class Reservation {
  public readonly id: string | null;
  public readonly variantId: number;
  public readonly stockLocationId: string;
  private _quantity: number;
  public readonly cartId: string;
  private _expiresAt: Date;
  private _status: ReservationStatusEnum;
  private _version: number;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(props: IReservationProps) {
    this.id = props.id;
    this.variantId = props.variantId;
    this.stockLocationId = props.stockLocationId;
    this._quantity = props.quantity;
    this.cartId = props.cartId;
    this._expiresAt = props.expiresAt;
    this._status = props.status;
    this._version = props.version;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  // Opens a fresh `active` hold at `version 0`, generating the CHAR(36) UUID id
  // in-app (the `Cart.create` precedent — the id is concrete immediately, never
  // null on a created hold). Rejects a non-positive / non-integer `quantity` with
  // a typed `RESERVATION_QUANTITY_INVALID`.
  public static create(props: ICreateReservationProps): Reservation {
    Reservation.requirePositiveInt(props.quantity);

    // A past (or now) `expiresAt` at create time is an internal caller bug — the
    // TTL is always computed forward (`now + RESERVATION_TTL_MINUTES`) — not user
    // input, so it is a plain `Error`, deliberately NOT a typed domain exception
    // that the filter would surface as a client-facing 4xx.
    if (!(props.expiresAt instanceof Date) || Number.isNaN(props.expiresAt.getTime())) {
      throw new Error('Reservation.create: expiresAt must be a valid Date');
    }
    if (props.expiresAt.getTime() <= Date.now()) {
      throw new Error('Reservation.create: expiresAt must be strictly in the future');
    }

    return new Reservation({
      id: randomUUID(),
      variantId: props.variantId,
      stockLocationId: props.stockLocationId,
      quantity: props.quantity,
      cartId: props.cartId,
      expiresAt: props.expiresAt,
      status: ReservationStatusEnum.ACTIVE,
      version: 0,
    });
  }

  // The load path: rebuilds a persisted hold from storage in ANY state, including
  // a past `expiresAt` (a stale `active` row that no sweeper has acted on yet). No
  // guards beyond what the DB already enforced at write time.
  public static reconstitute(props: IReservationProps): Reservation {
    return new Reservation(props);
  }

  public get quantity(): number {
    return this._quantity;
  }

  public get expiresAt(): Date {
    return this._expiresAt;
  }

  public get status(): ReservationStatusEnum {
    return this._status;
  }

  public get version(): number {
    return this._version;
  }

  // The idempotent re-reserve path (`active → active`): adjust the held quantity
  // and push the TTL forward. Called when a shopper changes a cart line's quantity
  // or re-adds an already-held variant.
  public refresh(quantity: number, expiresAt: Date): void {
    this.requireActive('refresh');
    Reservation.requirePositiveInt(quantity);
    this._quantity = quantity;
    this._expiresAt = expiresAt;
    this.bumpVersion();
  }

  // active → released (terminal). The counter the hold occupied is returned to
  // `available` by the Release use case; the row survives (the UNIQUE triple keeps
  // it addressable for a later `reactivate`).
  public release(): void {
    this.requireActive('release');
    this._status = ReservationStatusEnum.RELEASED;
    this.bumpVersion();
  }

  // active → expired (terminal). No caller in this capability beyond symmetry —
  // the background sweeper that would flip stale holds is a later capability — but
  // it ships with the status machine so every state is reachable in the domain
  // spec.
  public expire(): void {
    this.requireActive('expire');
    this._status = ReservationStatusEnum.EXPIRED;
    this.bumpVersion();
  }

  // active → committed: the hold is converted into a firm allocation at order
  // placement. Rejects a wall-clock-expired hold with `RESERVATION_EXPIRED` — the
  // allocate use case refreshes the TTL first when it decides to honor a
  // stale-but-still-held reservation, so commit never silently converts an expired
  // hold.
  public commit(now: Date): void {
    this.requireActive('commit');
    if (this.isExpired(now)) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.RESERVATION_EXPIRED,
        `Reservation.commit: hold expired at ${this._expiresAt.toISOString()} (now ${now.toISOString()})`,
      );
    }
    this._status = ReservationStatusEnum.COMMITTED;
    this.bumpVersion();
  }

  // released | expired → active: the row-reuse path that keeps the all-statuses
  // UNIQUE triple `(cartId, variantId, stockLocationId)` workable when a shopper
  // re-adds a previously removed (or lapsed) line. `committed` is terminal and is
  // NOT reactivatable — a placed order's allocation is never reopened as a hold.
  public reactivate(quantity: number, expiresAt: Date): void {
    if (
      this._status !== ReservationStatusEnum.RELEASED &&
      this._status !== ReservationStatusEnum.EXPIRED
    ) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.RESERVATION_INVALID_STATE,
        `Reservation.reactivate: only a released or expired hold can reactivate (current status: ${this._status})`,
      );
    }
    Reservation.requirePositiveInt(quantity);
    this._status = ReservationStatusEnum.ACTIVE;
    this._quantity = quantity;
    this._expiresAt = expiresAt;
    this.bumpVersion();
  }

  // Strict `<`: a hold whose `expiresAt` equals `now` is NOT yet expired (it
  // expires the instant the clock passes it). `commit` and the future sweeper both
  // key on this boundary.
  public isExpired(now: Date): boolean {
    return this._expiresAt.getTime() < now.getTime();
  }

  private requireActive(op: string): void {
    if (this._status !== ReservationStatusEnum.ACTIVE) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.RESERVATION_INVALID_STATE,
        `Reservation.${op}: expected an active hold (current status: ${this._status})`,
      );
    }
  }

  // Every successful mutation advances the OCC token so "version bumps on each
  // mutation" is observable in the unit spec. Persistence delegates the stored
  // value to TypeORM's `@VersionColumn`; this in-memory bump keeps the domain
  // self-describing (the `StockLevel` / `Cart` precedent).
  private bumpVersion(): void {
    this._version += 1;
  }

  private static requirePositiveInt(value: number): number {
    if (!Number.isInteger(value) || value <= 0) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
        `Reservation: quantity must be a positive integer, got ${value}`,
      );
    }
    return value;
  }
}
