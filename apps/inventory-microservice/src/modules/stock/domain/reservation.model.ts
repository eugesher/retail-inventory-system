// A TTL-bounded, cart-scoped hold on stock (ADR-030). **It is the thing that stops two carts
// racing for the last item before either checks out:** while a hold is `active` its `quantity` sits
// in `StockLevel.quantityReserved` and is therefore subtracted from `available`.
//
// The typed-vs-plain-`Error` split is the same as `StockLevel`'s — a typed exception marks a state
// a caller can legitimately reach, a plain `Error` marks an internal bug. Every invariant below is
// pinned in `domain/spec/reservation.model.spec.ts`, including the ones that are easy to doubt: the
// strict-`<` expiry boundary, and that a `committed` hold refuses to reactivate.
//
// `variantId` and `cartId` are **opaque** links — inventory imports no catalog or retail type, and
// the only coupling is an FK in persistence.

import { randomUUID } from 'crypto';

import { InventoryDomainException, InventoryErrorCodeEnum } from './inventory.exception';

// **Deliberately in `domain/`, not `libs/contracts`** — the wire carries the raw string. A consumer
// that wants to switch on a hold's status is switching on a string it cannot import, and that is
// the point: the lifecycle is inventory's, not the wire's (ADR-025 §7).
export enum ReservationStatusEnum {
  ACTIVE = 'active',
  COMMITTED = 'committed',
  RELEASED = 'released',
  EXPIRED = 'expired',
}

// The load path's shape. `create` derives `id`, `status` and `version` itself, which is why its
// input is the narrower `ICreateReservationProps`.
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

  // The **id is minted in-app**, so a freshly created hold already has a concrete `id` — it is
  // never `null` the way a DB-sequenced aggregate's is before its insert.
  public static create(props: ICreateReservationProps): Reservation {
    Reservation.requirePositiveInt(props.quantity);

    // A past `expiresAt` at create time cannot come from a user: the TTL is always computed forward
    // from now. So it is an internal bug, and a plain `Error` — not a typed exception the filter
    // would dress up as a 4xx for a caller who did nothing wrong.
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

  // **Expiry is a wall-clock fact, not a stored transition.** This rebuilds a row in ANY state,
  // including an `active` one whose `expiresAt` has already passed — nothing flips a status by
  // itself, so a lapsed hold stays `active` in the table until the sweep gets to it. That is why
  // this path guards nothing: the row is already what it is.
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

  // The idempotent re-reserve (`active → active`). `quantity` is the **new absolute** held amount,
  // not an increment — re-adding a variant already in the cart lands here, and passing a delta
  // would silently shrink the hold.
  public refresh(quantity: number, expiresAt: Date): void {
    this.requireActive('refresh');
    Reservation.requirePositiveInt(quantity);
    this._quantity = quantity;
    this._expiresAt = expiresAt;
    this.bumpVersion();
  }

  // **This only flips the status. It does not return the counter.** Handing the held units back to
  // `available` is the Release use case's job, in the same transaction — a `release()` on its own
  // leaks the hold's quantity out of `available` forever. The row itself survives, because the
  // all-statuses UNIQUE triple keeps it addressable for a later `reactivate`.
  public release(): void {
    this.requireActive('release');
    this._status = ReservationStatusEnum.RELEASED;
    this.bumpVersion();
  }

  // Same as `release`: **the status moves, the counter does not.** Returning the units is the
  // sweep's job.
  public expire(): void {
    this.requireActive('expire');
    this._status = ReservationStatusEnum.EXPIRED;
    this.bumpVersion();
  }

  // The hold becomes a firm allocation at placement. **A wall-clock-expired hold is refused here**,
  // even though the row still says `active` — so a commit can never quietly convert something the
  // TTL had already given up on. When the allocate use case decides to honour a stale-but-unswept
  // hold, it must refresh the TTL first, in the open.
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

  // Row reuse. The UNIQUE triple `(cartId, variantId, stockLocationId)` spans **all** statuses, so a
  // shopper re-adding a line they removed cannot insert a second row — it revives the old one.
  //
  // **`committed` is terminal and never reactivates.** A placed order's allocation is not a hold to
  // be reopened, and the spec pins the refusal.
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
  // expires the instant the clock passes it). This boundary is the one every
  // TTL decision keys on.
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

  // The stored value is TypeORM's `@VersionColumn`; this in-memory bump exists so the domain is
  // testable without a database, and so the spec can assert the OCC token moves on every mutation.
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
