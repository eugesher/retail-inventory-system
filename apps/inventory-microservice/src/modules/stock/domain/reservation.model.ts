import { randomUUID } from 'crypto';

import { InventoryDomainException, InventoryErrorCodeEnum } from './inventory.exception';

export enum ReservationStatusEnum {
  ACTIVE = 'active',
  COMMITTED = 'committed',
  RELEASED = 'released',
  EXPIRED = 'expired',
}

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

  public static create(props: ICreateReservationProps): Reservation {
    Reservation.requirePositiveInt(props.quantity);

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

  public refresh(quantity: number, expiresAt: Date): void {
    this.requireActive('refresh');
    Reservation.requirePositiveInt(quantity);
    this._quantity = quantity;
    this._expiresAt = expiresAt;
    this.bumpVersion();
  }

  public release(): void {
    this.requireActive('release');
    this._status = ReservationStatusEnum.RELEASED;
    this.bumpVersion();
  }

  public expire(): void {
    this.requireActive('expire');
    this._status = ReservationStatusEnum.EXPIRED;
    this.bumpVersion();
  }

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
